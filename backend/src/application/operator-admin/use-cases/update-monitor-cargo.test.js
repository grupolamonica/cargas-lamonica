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

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

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

  it("lança NotFound quando o id não existe", async () => {
    const op = await seedUser({ email: "op-404@teste.local" });
    await expect(
      updateMonitorCargo({ cargoId: "99999999-9999-9999-9999-999999999999", operatorId: op.id, payload: { status: "X" } }),
    ).rejects.toThrow();
  });
});
