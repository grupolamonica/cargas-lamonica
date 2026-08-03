import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedPublicLead,
  seedUser,
  withPgTransaction,
} from "../test-harness.js";

const writeSpy = vi.fn(async () => ({ ok: true, updated: 1 }));
vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));
vi.mock("../../google-sheets/sheet-writeback.js", async (importOriginal) => ({
  ...(await importOriginal()),
  writeAllocationsToSheet: writeSpy,
}));

const { updateMonitorCargo } = await import("./update-monitor-cargo.js");

async function getCargo(id) {
  const { rows } = await query(
    `SELECT origem, destino, data, horario, lh_manual, sheet_data_carregamento, sheet_data_descarga,
            alloc_motorista, alloc_cavalo, alloc_carreta, alloc_status, alloc_source, alloc_pinned
     FROM public.cargas WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe("updateMonitorCargo", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("alocar motorista na carga do sistema FECHA (OPEN → RESERVED); limpar REABRE (→ OPEN)", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    const op = await seedUser({ email: "op-sys-close@teste.local" });

    // aloca → fecha (sai da fila pública, para de aceitar candidatura)
    await updateMonitorCargo({ cargoId: id, operatorId: op.id, payload: { motorista: "João Silva" }, correlationId: "c-close" });
    let { rows } = await query(`SELECT status, reserved_at, reserved_public_lead_id FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("RESERVED");
    expect(rows[0].reserved_at).toBeTruthy();
    expect(rows[0].reserved_public_lead_id).toBeNull();

    // limpa → reabre (reserva sintética de Monitor, sem lead)
    await updateMonitorCargo({ cargoId: id, operatorId: op.id, payload: { motorista: "" }, correlationId: "c-reopen" });
    ({ rows } = await query(`SELECT status, reserved_at FROM public.cargas WHERE id = $1`, [id]));
    expect(rows[0].status).toBe("OPEN");
    expect(rows[0].reserved_at).toBeNull();
  });

  it("grava a descrição da troca de motorista/veículo em alloc_descricao", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    const op = await seedUser({ email: "op-sys-desc@teste.local" });
    await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { motorista: "Maria", cavalo: "AAA1A11", descricao: "troca por indisponibilidade do titular" },
      correlationId: "c-desc",
    });
    const { rows } = await query(`SELECT alloc_descricao FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].alloc_descricao).toBe("troca por indisponibilidade do titular");
  });

  it("grava a observação de checklist (tratativas) em alloc_tratativas e preserva quando não reenviada", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    const op = await seedUser({ email: "op-sys-trat@teste.local" });

    await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { origem: "A", destino: "B", data: "2026-07-01", horario: "09:30", tratativas: "liberado pela torre" },
      correlationId: "c-trat-1",
    });
    let res = await query(`SELECT alloc_tratativas FROM public.cargas WHERE id = $1`, [id]);
    expect(res.rows[0].alloc_tratativas).toBe("liberado pela torre");

    // Edição posterior sem tratativas preserva a observação registrada.
    await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { origem: "A", destino: "B", data: "2026-07-01", horario: "09:30", status: "CARREGADO" },
      correlationId: "c-trat-2",
    });
    res = await query(`SELECT alloc_tratativas FROM public.cargas WHERE id = $1`, [id]);
    expect(res.rows[0].alloc_tratativas).toBe("liberado pela torre");
  });

  it("grava o verdito do checklist por veículo em alloc_checklist_cavalo/carreta", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    const op = await seedUser({ email: "op-sys-chk@teste.local" });

    await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { origem: "A", destino: "B", data: "2026-07-01", horario: "09:30", checklistCavalo: "Aprovado", checklistCarreta: "Reprovado" },
      correlationId: "c-chk-1",
    });
    let res = await query(`SELECT alloc_checklist_cavalo, alloc_checklist_carreta FROM public.cargas WHERE id = $1`, [id]);
    expect(res.rows[0].alloc_checklist_cavalo).toBe("Aprovado");
    expect(res.rows[0].alloc_checklist_carreta).toBe("Reprovado");

    // Edição posterior sem os campos preserva o verdito.
    await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { origem: "A", destino: "B", data: "2026-07-01", horario: "09:30", status: "CARREGADO" },
      correlationId: "c-chk-2",
    });
    res = await query(`SELECT alloc_checklist_cavalo, alloc_checklist_carreta FROM public.cargas WHERE id = $1`, [id]);
    expect(res.rows[0].alloc_checklist_cavalo).toBe("Aprovado");
    expect(res.rows[0].alloc_checklist_carreta).toBe("Reprovado");
  });

  it("edita carga do sistema: rota, agenda, LH, status e motorista persistem", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    const op = await seedUser({ email: "op-sys@teste.local" });

    const res = await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: {
        lh: "MINHA-LH",
        status: "CARREGADO",
        motorista: "João Silva",
        cavalo: "ABC1234",
        carreta: "XYZ9876",
        origem: "São Paulo/SP",
        destino: "Salvador/BA",
        data: "2026-07-01",
        horario: "09:30",
      },
      correlationId: "c1",
    });

    expect(res.statusCode).toBe(200);
    const row = await getCargo(id);
    expect(row.lh_manual).toBe("MINHA-LH");
    expect(row.alloc_status).toBe("CARREGADO");
    expect(row.alloc_motorista).toBe("João Silva");
    expect(row.alloc_cavalo).toBe("ABC1234");
    expect(row.alloc_carreta).toBe("XYZ9876");
    expect(row.origem).toBe("São Paulo/SP");
    expect(row.destino).toBe("Salvador/BA");
    expect(row.alloc_source).toBe("operator");
    // data volta como Date (UTC) no pg-mem — confere o ano/mês/dia
    expect(new Date(row.data).toISOString().slice(0, 10)).toBe("2026-07-01");
    // rótulo denormalizado de carregamento acompanha a nova data+horário
    expect(row.sheet_data_carregamento).toBe("2026-07-01T09:30");
  });

  it("preserva NULL em sheet_data_carregamento (carga sem rótulo) ao editar a agenda", async () => {
    const { id } = await seedCargo({ sheet_lh: null });
    // seedCargo preenche o campo por padrão; força NULL p/ simular carga criada
    // pelo Monitor (que não grava o rótulo e cai no fallback data+horário).
    await query(`UPDATE public.cargas SET sheet_data_carregamento = NULL WHERE id = $1`, [id]);
    const op = await seedUser({ email: "op-carreg-null@teste.local" });
    await updateMonitorCargo({ cargoId: id, operatorId: op.id, payload: { data: "2026-07-01", horario: "09:30" } });
    const row = await getCargo(id);
    expect(row.sheet_data_carregamento).toBeNull();
  });

  it("descarga (datetime-local) é gravada em sheet_data_descarga como 'YYYY-MM-DD HH:MM'", async () => {
    const { id } = await seedCargo({ sheet_lh: null });
    const op = await seedUser({ email: "op-descarga@teste.local" });
    await updateMonitorCargo({ cargoId: id, operatorId: op.id, payload: { descarga: "2026-07-02T16:45" } });
    let row = await getCargo(id);
    expect(row.sheet_data_descarga).toBe("2026-07-02 16:45");
    // "" limpa
    await updateMonitorCargo({ cargoId: id, operatorId: op.id, payload: { descarga: "" } });
    row = await getCargo(id);
    expect(row.sheet_data_descarga).toBeNull();
  });

  it("atualização parcial: só status — rota/origem intactas", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "Orig X", destino: "Dest Y" });
    const op = await seedUser({ email: "op-partial@teste.local" });

    await updateMonitorCargo({ cargoId: id, operatorId: op.id, payload: { status: "NO SHOW" } });

    const row = await getCargo(id);
    expect(row.alloc_status).toBe("NO SHOW");
    expect(row.origem).toBe("Orig X");
    expect(row.destino).toBe("Dest Y");
  });

  it("'' limpa motorista/veículo/status (volta a null)", async () => {
    const { id } = await seedCargo({ sheet_lh: null });
    const op = await seedUser({ email: "op-clear@teste.local" });
    await updateMonitorCargo({ cargoId: id, operatorId: op.id, payload: { motorista: "Fulano", status: "CARREGADO" } });

    await updateMonitorCargo({ cargoId: id, operatorId: op.id, payload: { motorista: "", status: "" } });

    const row = await getCargo(id);
    expect(row.alloc_motorista).toBeNull();
    expect(row.alloc_status).toBeNull();
  });

  it("rejeita carga da PLANILHA (sheet_lh preenchido)", async () => {
    const { id } = await seedCargo({ sheet_lh: "LH-PLAN-1" });
    const op = await seedUser({ email: "op-sheet@teste.local" });
    await expect(
      updateMonitorCargo({ cargoId: id, operatorId: op.id, payload: { status: "CARREGADO" } }),
    ).rejects.toThrow(/planilha/i);
  });

  it("carga FIXA: motorista/veículo travados; status ainda muda", async () => {
    const { id } = await seedCargo({ sheet_lh: null });
    const op = await seedUser({ email: "op-pin@teste.local" });
    await updateMonitorCargo({ cargoId: id, operatorId: op.id, payload: { motorista: "Original", cavalo: "AAA1111" } });
    await query(`UPDATE public.cargas SET alloc_pinned = true WHERE id = $1`, [id]);

    await updateMonitorCargo({ cargoId: id, operatorId: op.id, payload: { motorista: "Trocado", cavalo: "BBB2222", status: "DESCARREGADO" } });

    const row = await getCargo(id);
    expect(row.alloc_motorista).toBe("Original"); // travado
    expect(row.alloc_cavalo).toBe("AAA1111"); // travado
    expect(row.alloc_status).toBe("DESCARREGADO"); // status passa
  });

  it("limpar o motorista de carga do sistema RESERVADA reabre a carga (status OPEN + lead cancelado)", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    const op = await seedUser({ email: "op-sys-reopen@teste.local" });
    // Motorista reservou pelo portal: lead APPROVED + carga RESERVED apontando pro lead.
    const lead = await seedPublicLead({ load_id: id, status: "APPROVED" });
    await query(
      `UPDATE public.cargas SET status = 'RESERVED', reserved_public_lead_id = $2 WHERE id = $1`,
      [id, lead.id],
    );

    await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { motorista: "", cavalo: "", carreta: "" },
      correlationId: "c-sys-reopen",
    });

    const { rows } = await query(
      `SELECT status, reserved_public_lead_id FROM public.cargas WHERE id = $1`,
      [id],
    );
    expect(rows[0].status).toBe("OPEN");
    expect(rows[0].reserved_public_lead_id).toBeNull();
    const leadRow = await query(`SELECT status FROM public.load_public_leads WHERE id = $1`, [lead.id]);
    expect(leadRow.rows[0].status).toBe("CANCELLED");
  });

  it("editar só a rota de carga do sistema RESERVADA NÃO reabre (não mexe na reserva)", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    const op = await seedUser({ email: "op-sys-noreopen@teste.local" });
    const lead = await seedPublicLead({ load_id: id, status: "APPROVED" });
    await query(
      `UPDATE public.cargas SET status = 'RESERVED', reserved_public_lead_id = $2 WHERE id = $1`,
      [id, lead.id],
    );

    // Edita só a rota (motorista ausente no payload) → preserva a reserva.
    await updateMonitorCargo({ cargoId: id, operatorId: op.id, payload: { origem: "Nova Origem" } });

    const { rows } = await query(
      `SELECT status, reserved_public_lead_id FROM public.cargas WHERE id = $1`,
      [id],
    );
    expect(rows[0].status).toBe("RESERVED");
    expect(rows[0].reserved_public_lead_id).toBe(lead.id);
  });

  it("status 'Disponível' sem motorista reabre a carga do sistema pro painel (status → OPEN, alloc_status vazio)", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "BOOKED" }); // fechada pro portal
    const op = await seedUser({ email: "op-sys-disp@teste.local" });

    await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { motorista: "", cavalo: "", carreta: "", status: "Disponível" },
      correlationId: "c-sys-disp",
    });

    const row = await getCargo(id);
    const { rows } = await query(`SELECT status FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("OPEN"); // voltou pro painel
    // "Disponível" é a ação de reabrir, não um status operacional armazenável.
    expect(row.alloc_status ?? "").toBe("");
  });

  it("status 'Disponível' COM motorista NÃO reabre a carga do sistema", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "BOOKED" });
    const op = await seedUser({ email: "op-sys-disp2@teste.local" });

    await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { motorista: "João", status: "Disponível" },
      correlationId: "c-sys-disp2",
    });

    const { rows } = await query(`SELECT status FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("BOOKED"); // com motorista, não reabre
  });

  it("status 'Disponível' sem motorista numa carga do sistema RESERVED reabre e cancela o lead", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    const op = await seedUser({ email: "op-sys-disp3@teste.local" });
    const lead = await seedPublicLead({ load_id: id, status: "APPROVED" });
    await query(
      `UPDATE public.cargas SET status = 'RESERVED', reserved_public_lead_id = $2 WHERE id = $1`,
      [id, lead.id],
    );

    await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { status: "Disponível" },
      correlationId: "c-sys-disp3",
    });

    const { rows } = await query(
      `SELECT status, reserved_public_lead_id FROM public.cargas WHERE id = $1`,
      [id],
    );
    expect(rows[0].status).toBe("OPEN");
    expect(rows[0].reserved_public_lead_id).toBeNull();
    const leadRow = await query(`SELECT status FROM public.load_public_leads WHERE id = $1`, [lead.id]);
    expect(leadRow.rows[0].status).toBe("CANCELLED");
  });

  it("código de viagem duplicado (colide com sheet_lh de outra carga) → erro", async () => {
    await seedCargo({ sheet_lh: "LT-DUP-1", status: "OPEN" }); // carga da planilha com esse LH
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    const op = await seedUser({ email: "op-dup1@teste.local" });
    await expect(
      updateMonitorCargo({ cargoId: id, operatorId: op.id, payload: { lh: "LT-DUP-1" }, correlationId: "c-dup1" }),
    ).rejects.toThrow(/código de viagem/i);
  });

  it("código de viagem duplicado (colide com lh_manual de outra carga do sistema) → erro", async () => {
    const other = await seedCargo({ sheet_lh: null, origem: "X", destino: "Y", status: "OPEN" });
    await query(`UPDATE public.cargas SET lh_manual = 'SYS-DUP' WHERE id = $1`, [other.id]);
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    const op = await seedUser({ email: "op-dup2@teste.local" });
    await expect(
      updateMonitorCargo({ cargoId: id, operatorId: op.id, payload: { lh: "SYS-DUP" }, correlationId: "c-dup2" }),
    ).rejects.toThrow(/código de viagem/i);
  });

  it("código de viagem que existe só no snapshot da planilha (knownSheetLhs) → erro", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    const op = await seedUser({ email: "op-dup3@teste.local" });
    await expect(
      updateMonitorCargo({
        cargoId: id,
        operatorId: op.id,
        payload: { lh: "LT-SNAP-ONLY" },
        correlationId: "c-dup3",
        knownSheetLhs: new Set(["LT-SNAP-ONLY"]),
      }),
    ).rejects.toThrow(/código de viagem/i);
  });

  it("re-salvar o MESMO código de viagem (inalterado) NÃO bloqueia — mesmo já estando no snapshot", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    await query(`UPDATE public.cargas SET lh_manual = 'LT-KEEP' WHERE id = $1`, [id]);
    const op = await seedUser({ email: "op-dup4@teste.local" });
    // A viagem entrou na planilha DEPOIS de lançada (LT-KEEP no snapshot); ainda
    // assim o operador precisa poder editar a própria carga (LH não mudou).
    const res = await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { lh: "LT-KEEP", motorista: "Novo" },
      correlationId: "c-dup4",
      knownSheetLhs: new Set(["LT-KEEP"]),
    });
    expect(res.statusCode).toBe(200);
    const row = await getCargo(id);
    expect(row.alloc_motorista).toBe("Novo");
  });

  it("código de viagem novo e único → grava lh_manual normalmente", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    const op = await seedUser({ email: "op-dup5@teste.local" });
    const res = await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { lh: "LT-UNICA-123" },
      correlationId: "c-dup5",
      knownSheetLhs: new Set(["OUTRO-LH"]),
    });
    expect(res.statusCode).toBe(200);
    const row = await getCargo(id);
    expect(row.lh_manual).toBe("LT-UNICA-123");
  });

  // PARIDADE com update-monitor-allocation: salvar a linha "sistema" no modal do
  // Monitor gravava alloc_* e NÃO espelhava nada na planilha — a carga lançada com
  // motorista alocado aqui nunca chegava à Shopee (32 cargas em prod).
  it("alocar motorista em carga lançada ESPELHA na planilha, criando a linha se faltar", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "Simoes Filho/BA", destino: "Jaboatão dos Guararapes/PE", status: "OPEN" });
    await query("UPDATE public.cargas SET lh_manual = 'LT1Q8302D4IK2' WHERE id = $1", [id]);
    const op = await seedUser({ email: "op-mirror1@teste.local" });

    const res = await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { motorista: "PAULO ERIVALDO ROSA COSTA", cavalo: "ABC1D23" },
      correlationId: "c-mirror1",
    });

    expect(res.statusCode).toBe(200);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const [[updates]] = writeSpy.mock.calls;
    expect(updates[0].lh).toBe("LT1Q8302D4IK2");
    expect(updates[0].motorista).toBe("PAULO ERIVALDO ROSA COSTA");
    expect(updates[0].cavalo).toBe("ABC1D23");
    // com motorista + LH "LT…" → cria-ou-preenche a linha, com rota e agenda
    expect(updates[0].createIfMissing).toBe(true);
    expect(updates[0].origem).toBe("Simoes Filho/BA");
    expect(updates[0].destino).toBe("Jaboatão dos Guararapes/PE");
    // status NÃO vai quando o payload não informou (não re-estampa a coluna STATUS)
    expect(updates[0].status).toBeUndefined();
  });

  it("SEM motorista efetivo não cria linha (não polui a planilha com spot vazio)", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    await query("UPDATE public.cargas SET lh_manual = 'LT-SEM-MOT-1' WHERE id = $1", [id]);
    const op = await seedUser({ email: "op-mirror2@teste.local" });

    await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { status: "AGUARDANDO CARREGAMENTO" },
      correlationId: "c-mirror2",
    });

    const [[updates]] = writeSpy.mock.calls;
    expect(updates[0].createIfMissing).toBeUndefined();
    expect(updates[0].status).toBe("AGUARDANDO CARREGAMENTO"); // informado → vai
  });

  it("LH que não é linehaul SPX não cria linha (evita gravar na planilha errada)", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    await query("UPDATE public.cargas SET lh_manual = 'NESTLE-B101472757' WHERE id = $1", [id]);
    const op = await seedUser({ email: "op-mirror3@teste.local" });

    await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { motorista: "FULANO" },
      correlationId: "c-mirror3",
    });

    const [[updates]] = writeSpy.mock.calls;
    expect(updates[0].createIfMissing).toBeUndefined();
  });

  it("edição que NÃO toca alocação (só rota/agenda) não dispara write-back", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    await query("UPDATE public.cargas SET lh_manual = 'LT-ROTA-1' WHERE id = $1", [id]);
    const op = await seedUser({ email: "op-mirror4@teste.local" });

    await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { origem: "Salvador/BA" },
      correlationId: "c-mirror4",
    });

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("carga SEM LH não dispara write-back (não há chave na planilha)", async () => {
    const { id } = await seedCargo({ sheet_lh: null, origem: "A", destino: "B", status: "OPEN" });
    const op = await seedUser({ email: "op-mirror5@teste.local" });

    await updateMonitorCargo({
      cargoId: id,
      operatorId: op.id,
      payload: { motorista: "FULANO" },
      correlationId: "c-mirror5",
    });

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("lança NotFound quando o id não existe", async () => {
    const op = await seedUser({ email: "op-404@teste.local" });
    await expect(
      updateMonitorCargo({ cargoId: "99999999-9999-9999-9999-999999999999", operatorId: op.id, payload: { status: "X" } }),
    ).rejects.toThrow();
  });
});
