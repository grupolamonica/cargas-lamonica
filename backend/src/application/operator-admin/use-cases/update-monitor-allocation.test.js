import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedPublicLead,
  seedSheetSnapshot,
  seedUser,
  withPgTransaction,
} from "../test-harness.js";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

// Write-back pra planilha (espelho) — só writeAllocationsToSheet é mockado (captura
// o valor EFETIVO espelhado); formatSheetDateLabel (puro) fica o real via importOriginal.
const { writeSpy } = vi.hoisted(() => ({ writeSpy: vi.fn(async () => {}) }));
vi.mock("../../google-sheets/sheet-writeback.js", async (importOriginal) => ({
  ...(await importOriginal()),
  writeAllocationsToSheet: writeSpy,
}));

const { updateMonitorAllocation } = await import("./update-monitor-allocation.js");

const LH = "LT-MONITOR-TEST-1";

async function seedSheetCargo() {
  // Carga oriunda da planilha: id determinístico = createSheetLoadId(lh).
  const id = createSheetLoadId(LH);
  await seedCargo({ id, sheet_lh: LH, status: "OPEN" });
  // seedCargo não insere sheet_motorista/sheet_status — setamos direto.
  await query(`UPDATE public.cargas SET sheet_motorista = $2, sheet_status = $3 WHERE id = $1`, [
    id,
    "MOTORISTA DA PLANILHA",
    "AGUARDANDO CARREGAMENTO",
  ]);
  return id;
}

async function getAlloc(id) {
  const { rows } = await query(
    `SELECT alloc_motorista, alloc_cavalo, alloc_carreta, alloc_status, alloc_source, alloc_updated_at,
            sheet_motorista, sheet_status
     FROM public.cargas WHERE id = $1`,
    [id],
  );
  return rows[0];
}

describe("updateMonitorAllocation", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("grava a alocação do operador em alloc_* sem tocar nos campos sheet_*", async () => {
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor@teste.local" });

    const res = await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { motorista: "JOAO AGREGADO", cavalo: "ABC1D23", carreta: "DEF4G56", status: "DESCARREGADO" },
      requestIp: "203.0.113.10",
      correlationId: "corr-monitor-1",
    });

    expect(res.statusCode).toBe(200);
    const row = await getAlloc(id);
    // alloc_* recebe a decisão do operador
    expect(row.alloc_motorista).toBe("JOAO AGREGADO");
    expect(row.alloc_cavalo).toBe("ABC1D23");
    expect(row.alloc_carreta).toBe("DEF4G56");
    expect(row.alloc_status).toBe("DESCARREGADO");
    expect(row.alloc_source).toBe("operator");
    expect(row.alloc_updated_at).toBeTruthy();
    // sheet_* (espelho da planilha) permanece intocado
    expect(row.sheet_motorista).toBe("MOTORISTA DA PLANILHA");
    expect(row.sheet_status).toBe("AGUARDANDO CARREGAMENTO");
  });

  it("ECO do status exibido não cria override nem espelha status na planilha", async () => {
    // O modal vem pré-preenchido com o status EFETIVO; reenviá-lo ao salvar outro
    // campo criava um override que ninguém escolheu (congelamento) e sobrescrevia
    // na col L o valor que o robô ASPX havia gravado.
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor-eco@teste.local" });

    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { vinculo: "AGREGADO", status: "AGUARDANDO CARREGAMENTO" },
      correlationId: "corr-monitor-eco",
    });

    const row = await getAlloc(id);
    expect(row.alloc_status).toBeNull(); // segue "sem override" → reflete a planilha
    const update = writeSpy.mock.calls[0][0][0];
    expect(update.status).toBeUndefined(); // col L não é tocada
    expect(update.vinculo).toBe("AGREGADO"); // o campo realmente editado vai
  });

  it("editar só o vínculo (sem a chave status) preserva alloc_status e não espelha status", async () => {
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor-vinculo@teste.local" });
    await query(`UPDATE public.cargas SET alloc_status = 'CTE EM EMISSÃO' WHERE id = $1`, [id]);

    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { vinculo: "FROTA" },
      correlationId: "corr-monitor-vinculo",
    });

    expect((await getAlloc(id)).alloc_status).toBe("CTE EM EMISSÃO"); // preservado
    expect(writeSpy.mock.calls[0][0][0].status).toBeUndefined();
  });

  it("status vazio ('— sem status (usa a planilha) —') SOLTA o override e não toca a col L", async () => {
    // Gravar "" fazia COALESCE(alloc_*, sheet_*) devolver "" → a carga aparecia SEM
    // status apesar da planilha ter estágio, contrariando o próprio rótulo da opção.
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor-semstatus@teste.local" });
    await query(`UPDATE public.cargas SET alloc_status = 'CTE ENVIADO' WHERE id = $1`, [id]);

    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { status: "" },
      correlationId: "corr-monitor-semstatus",
    });

    const row = await getAlloc(id);
    expect(row.alloc_status).toBeNull(); // volta a seguir a planilha
    expect(row.sheet_status).toBe("AGUARDANDO CARREGAMENTO"); // planilha preservada
    expect(writeSpy.mock.calls[0][0][0].status).toBeUndefined(); // col L intocada
  });

  it("'Disponível' continua gravando vazio EXPLÍCITO e espelhando na planilha", async () => {
    // Distinção deliberada: "Disponível" é reabrir (zera o status na tela e na col L);
    // "sem status" é devolver a decisão para a planilha.
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor-disp@teste.local" });

    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { motorista: "", status: "Disponível" },
      correlationId: "corr-monitor-disp",
    });

    expect((await getAlloc(id)).alloc_status).toBe("");
    expect(writeSpy.mock.calls[0][0][0].status).toBe("");
  });

  it("mudança REAL de status grava o override e espelha na planilha", async () => {
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor-status@teste.local" });

    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { status: "CTE ENVIADO" },
      correlationId: "corr-monitor-status",
    });

    expect((await getAlloc(id)).alloc_status).toBe("CTE ENVIADO");
    expect(writeSpy.mock.calls[0][0][0].status).toBe("CTE ENVIADO");
  });

  it("limpar o campo grava vazio EXPLÍCITO (\"\") — não ressuscita o valor da planilha", async () => {
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor-clear@teste.local" });

    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { motorista: "", cavalo: "  ", carreta: null, status: "" },
      correlationId: "corr-monitor-clear",
    });

    const row = await getAlloc(id);
    // "" (vazio explícito), NÃO null: COALESCE(alloc, sheet, '') = '' → a carga
    // fica realmente sem motorista/veículo, sem voltar a refletir a planilha.
    expect(row.alloc_motorista).toBe("");
    expect(row.alloc_cavalo).toBe("");
    expect(row.alloc_carreta).toBe("");
    // STATUS é a EXCEÇÃO: limpar o status é "usa a planilha" (o próprio rótulo da
    // opção), então solta o override (null). Gravar "" ali fazia a carga aparecer
    // SEM status mesmo com a planilha em DESCARREGADO. Só "Disponível" grava "".
    expect(row.alloc_status).toBeNull();
    // sheet_* segue intocado (a planilha continua com o valor original por baixo)
    expect(row.sheet_motorista).toBe("MOTORISTA DA PLANILHA");
  });

  it("REMOVER de vez: clear explícito espelha VAZIO na planilha (não ressuscita o motorista)", async () => {
    await seedSheetCargo(); // sheet_motorista = "MOTORISTA DA PLANILHA"
    const operator = await seedUser({ email: "op-clear-wb@teste.local" });
    writeSpy.mockClear();

    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { motorista: "", cavalo: "", carreta: "", status: "Disponível" },
      correlationId: "corr-clear-wb",
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const arg = writeSpy.mock.calls[0][0][0];
    expect(arg.motorista).toBe(""); // vazio de verdade — limpa a célula, não volta o valor da planilha
    expect(arg.cavalo).toBe("");
    expect(arg.carreta).toBe("");
  });

  it("editar SÓ o status: write-back preserva o motorista da planilha (não apaga sem querer)", async () => {
    await seedSheetCargo();
    const operator = await seedUser({ email: "op-status-wb@teste.local" });
    writeSpy.mockClear();

    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { status: "AGUARDANDO DESCARGA" }, // motorista/veículo AUSENTES
      correlationId: "corr-status-wb",
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const arg = writeSpy.mock.calls[0][0][0];
    expect(arg.motorista).toBe("MOTORISTA DA PLANILHA"); // preservado (fallback `||` da planilha)
  });

  it("campo AUSENTE preserva o alloc_* atual — enviar só status não apaga motorista/veículo", async () => {
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor-partial@teste.local" });
    // Alocação já feita pelo operador (override em alloc_*).
    await query(
      `UPDATE public.cargas SET alloc_motorista = 'JOSE OVERRIDE', alloc_cavalo = 'OVR1A11', alloc_carreta = 'OVR2B22' WHERE id = $1`,
      [id],
    );

    // Payload SÓ com status (motorista/cavalo/carreta ausentes → preserva).
    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { status: "AGUARDANDO DESCARGA" },
      correlationId: "corr-monitor-partial",
    });

    const row = await getAlloc(id);
    expect(row.alloc_motorista).toBe("JOSE OVERRIDE"); // preservado (não veio no payload)
    expect(row.alloc_cavalo).toBe("OVR1A11");          // preservado
    expect(row.alloc_carreta).toBe("OVR2B22");         // preservado
    expect(row.alloc_status).toBe("AGUARDANDO DESCARGA"); // atualizado
  });

  it("carga FIXA: preserva motorista/veículo e deixa passar só o status", async () => {
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor-pin@teste.local" });
    // Aloca e fixa: alloc_motorista/cavalo definidos + alloc_pinned=true.
    await query(
      `UPDATE public.cargas SET alloc_motorista = 'FIXO JOSE', alloc_cavalo = 'PIN1A11', alloc_pinned = true WHERE id = $1`,
      [id],
    );

    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      // tenta trocar o motorista/veículo (deve ser IGNORADO) e mudar o status (deve passar)
      payload: { motorista: "OUTRO MOTORISTA", cavalo: "XXX9X99", carreta: "YYY8Y88", status: "DESCARREGADO" },
      correlationId: "corr-monitor-pin",
    });

    const row = await getAlloc(id);
    expect(row.alloc_motorista).toBe("FIXO JOSE");   // preservado
    expect(row.alloc_cavalo).toBe("PIN1A11");        // preservado
    expect(row.alloc_status).toBe("DESCARREGADO");   // status passou
  });

  it("setar status CANCELADO dispara a cascata da rota (motorista desce + gera reserva)", async () => {
    // Fila DESC: CASC-B(10h, topo) · CASC-A(08h, base). Cancela a do TOPO → desce.
    const idA = createSheetLoadId("CASC-A");
    const idB = createSheetLoadId("CASC-B");
    await seedCargo({ id: idA, sheet_lh: "CASC-A", status: "OPEN", origem: "Salvador / BA", destino: "Feira / BA", horario: "08:00:00" });
    await seedCargo({ id: idB, sheet_lh: "CASC-B", status: "OPEN", origem: "Salvador / BA", destino: "Feira / BA", horario: "10:00:00" });
    await query(`UPDATE public.cargas SET sheet_motorista = 'MOT A' WHERE id = $1`, [idA]);
    await query(`UPDATE public.cargas SET sheet_motorista = 'MOT B' WHERE id = $1`, [idB]);
    const operator = await seedUser({ email: "op-monitor-cascade@teste.local" });

    await updateMonitorAllocation({
      lh: "CASC-B",
      operatorId: operator.id,
      payload: { status: "CANCELADO" },
      correlationId: "corr-monitor-cancel",
    });

    // CASC-B (topo, cancelada): status CANCELADO + motorista esvaziado pela cascata.
    const b = await query(`SELECT alloc_motorista, alloc_status FROM public.cargas WHERE id = $1`, [idB]);
    expect(b.rows[0].alloc_status).toBe("CANCELADO");
    expect(b.rows[0].alloc_motorista).toBe("");
    // CASC-A (abaixo) recebeu MOT B (desceu); MOT A (que estava nela) sobrou → reserva.
    const a = await query(`SELECT alloc_motorista FROM public.cargas WHERE id = $1`, [idA]);
    expect(a.rows[0].alloc_motorista).toBe("MOT B");
    const r = await query(`SELECT motorista FROM public.monitor_reservas WHERE active = true`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].motorista).toBe("MOT A");
  });

  it("alocar um motorista que está em reserva baixa a reserva (não fica em dois lugares)", async () => {
    await seedSheetCargo();
    await query(
      `INSERT INTO public.monitor_reservas (motorista, route_key, origin_lh) VALUES ($1, $2, $3)`,
      ["RESERVADO X", "ROTA-QQ", "OLD-CANCEL"],
    );
    const operator = await seedUser({ email: "op-monitor-evict@teste.local" });

    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { motorista: "RESERVADO X", cavalo: "AAA1A11", carreta: "" },
      correlationId: "corr-monitor-evict",
    });

    const r = await query(`SELECT active FROM public.monitor_reservas WHERE motorista = 'RESERVADO X'`);
    expect(r.rows[0].active).toBe(false);
  });

  it("limpar o motorista de carga RESERVADA reabre a carga (status OPEN + lead cancelado)", async () => {
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor-reopen@teste.local" });
    // Motorista reservou pelo portal: lead APPROVED + carga RESERVED apontando pro lead.
    // Carga RESERVADA por lead do portal NÃO tem motorista na planilha (a reserva é
    // do nosso sistema, não do Shopee) — limpa o sheet_motorista do seedSheetCargo
    // p/ refletir o estado real; senão o motorista da planilha bloquearia a reabertura.
    const lead = await seedPublicLead({ load_id: id, status: "APPROVED" });
    await query(
      `UPDATE public.cargas SET status = 'RESERVED', reserved_public_lead_id = $2, sheet_motorista = NULL WHERE id = $1`,
      [id, lead.id],
    );

    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { motorista: "", cavalo: "", carreta: "" },
      correlationId: "corr-monitor-reopen",
    });

    // Carga volta a ficar ABERTA pro motorista e a reserva do portal cai.
    const carga = await query(
      `SELECT status, reserved_public_lead_id FROM public.cargas WHERE id = $1`,
      [id],
    );
    expect(carga.rows[0].status).toBe("OPEN");
    expect(carga.rows[0].reserved_public_lead_id).toBeNull();
    const leadRow = await query(`SELECT status FROM public.load_public_leads WHERE id = $1`, [lead.id]);
    expect(leadRow.rows[0].status).toBe("CANCELLED");
  });

  it("mudar SÓ o status de carga RESERVADA não reabre (não mexe na reserva do motorista)", async () => {
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor-noreopen@teste.local" });
    const lead = await seedPublicLead({ load_id: id, status: "APPROVED" });
    await query(
      `UPDATE public.cargas SET status = 'RESERVED', reserved_public_lead_id = $2 WHERE id = $1`,
      [id, lead.id],
    );

    // Só status operacional; motorista/veículo ausentes → preservados, sem reabrir.
    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { status: "AGUARDANDO DESCARGA" },
      correlationId: "corr-monitor-noreopen",
    });

    const carga = await query(
      `SELECT status, reserved_public_lead_id FROM public.cargas WHERE id = $1`,
      [id],
    );
    expect(carga.rows[0].status).toBe("RESERVED");
    expect(carga.rows[0].reserved_public_lead_id).toBe(lead.id);
  });

  it("grava a descrição da troca (motivo) em alloc_descricao e preserva quando não reenviada", async () => {
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor-desc@teste.local" });

    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { motorista: "NOVO JOAO", cavalo: "AAA1A11", carreta: "BBB2B22", descricao: "titular desistiu da carga" },
      correlationId: "corr-monitor-desc-1",
    });
    let res = await query(`SELECT alloc_descricao FROM public.cargas WHERE id = $1`, [id]);
    expect(res.rows[0].alloc_descricao).toBe("titular desistiu da carga");

    // Edição posterior só de status (sem descricao) preserva o motivo registrado.
    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { status: "DESCARREGADO" },
      correlationId: "corr-monitor-desc-2",
    });
    res = await query(`SELECT alloc_descricao FROM public.cargas WHERE id = $1`, [id]);
    expect(res.rows[0].alloc_descricao).toBe("titular desistiu da carga");
  });

  it("grava o vínculo do operador em alloc_vinculo", async () => {
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor-vinc@teste.local" });
    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { motorista: "JOAO", vinculo: "AGREGADO DEDICADO" },
      correlationId: "corr-monitor-vinc",
    });
    const { rows } = await query(`SELECT alloc_vinculo FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].alloc_vinculo).toBe("AGREGADO DEDICADO");
  });

  it("grava a observação de checklist (tratativas) em alloc_tratativas e preserva quando não reenviada", async () => {
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor-trat@teste.local" });

    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { tratativas: "aguardando 2a via do CRLV" },
      correlationId: "corr-monitor-trat-1",
    });
    let res = await query(`SELECT alloc_tratativas FROM public.cargas WHERE id = $1`, [id]);
    expect(res.rows[0].alloc_tratativas).toBe("aguardando 2a via do CRLV");

    // Edição posterior só de status (sem tratativas) preserva a observação registrada.
    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { status: "DESCARREGADO" },
      correlationId: "corr-monitor-trat-2",
    });
    res = await query(`SELECT alloc_tratativas FROM public.cargas WHERE id = $1`, [id]);
    expect(res.rows[0].alloc_tratativas).toBe("aguardando 2a via do CRLV");

    // "" limpa a observação (vazio explícito).
    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { tratativas: "" },
      correlationId: "corr-monitor-trat-3",
    });
    res = await query(`SELECT alloc_tratativas FROM public.cargas WHERE id = $1`, [id]);
    expect(res.rows[0].alloc_tratativas).toBe("");
  });

  it("grava o verdito do checklist por veículo e espelha em CheckList Cavalo/Carreta1 na planilha", async () => {
    const id = await seedSheetCargo();
    const operator = await seedUser({ email: "op-monitor-chk@teste.local" });

    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { checklistCavalo: "Aprovado", checklistCarreta: "Reprovado" },
      correlationId: "corr-monitor-chk-1",
    });
    let res = await query(
      `SELECT alloc_checklist_cavalo, alloc_checklist_carreta FROM public.cargas WHERE id = $1`,
      [id],
    );
    expect(res.rows[0].alloc_checklist_cavalo).toBe("Aprovado");
    expect(res.rows[0].alloc_checklist_carreta).toBe("Reprovado");

    // Write-back para a planilha carrega o verdito (colunas CheckList Cavalo/Carreta1).
    const lastCall = writeSpy.mock.calls.at(-1)?.[0]?.[0];
    expect(lastCall).toMatchObject({ lh: LH, checklistCavalo: "Aprovado", checklistCarreta: "Reprovado" });

    // Edição posterior sem os campos preserva o verdito registrado.
    await updateMonitorAllocation({
      lh: LH,
      operatorId: operator.id,
      payload: { status: "CARREGADO" },
      correlationId: "corr-monitor-chk-2",
    });
    res = await query(
      `SELECT alloc_checklist_cavalo, alloc_checklist_carreta FROM public.cargas WHERE id = $1`,
      [id],
    );
    expect(res.rows[0].alloc_checklist_cavalo).toBe("Aprovado");
    expect(res.rows[0].alloc_checklist_carreta).toBe("Reprovado");
    // ...e o write-back dessa edição NÃO reenvia os campos de checklist (não sobrescreve a célula).
    const lastCall2 = writeSpy.mock.calls.at(-1)?.[0]?.[0];
    expect(lastCall2).not.toHaveProperty("checklistCavalo");
    expect(lastCall2).not.toHaveProperty("checklistCarreta");
  });

  it("carga do SISTEMA (lh_manual) com motorista: CRIA-ou-preenche a linha na planilha (createIfMissing + rota/agenda)", async () => {
    // Viagem lançada na Programação: id ALEATÓRIO, sheet_lh nulo, lh_manual = LH.
    // A "linha-casca" só é criada no lançamento quando a viagem está ACEITA, então um
    // spot lançado-não-aceito (auto-lançamento DC-201) e depois alocado aqui NÃO tinha
    // linha na planilha e sumia. Agora, com um motorista efetivo, a alocação CRIA-ou-
    // preenche a linha (createIfMissing) com rota + agenda + motorista/veículo.
    const SYS_LH = "LT-SYS-LAUNCHED-1";
    const { id } = await seedCargo({ status: "OPEN", origem: "SJ Rio Preto / SP", destino: "Simoes Filho / BA" });
    await query(
      `UPDATE public.cargas SET lh_manual = $2, sheet_data_carregamento = $3, sheet_data_descarga = $4 WHERE id = $1`,
      [id, SYS_LH, "2026-08-01T14:00", "2026-08-03T09:00"],
    );
    const operator = await seedUser({ email: "op-sys-launched@teste.local" });
    writeSpy.mockClear();

    const res = await updateMonitorAllocation({
      lh: SYS_LH,
      operatorId: operator.id,
      payload: { motorista: "ABELARDO", cavalo: "CUA1123", carreta: "FDZ0B46" },
      correlationId: "corr-sys-launched",
    });

    expect(res.statusCode).toBe(200);
    const row = await getAlloc(id);
    expect(row.alloc_motorista).toBe("ABELARDO");
    expect(row.alloc_carreta).toBe("FDZ0B46");
    expect(row.alloc_source).toBe("operator");
    // Espelha CRIANDO-ou-preenchendo a linha (createIfMissing) com rota + agenda.
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const arg = writeSpy.mock.calls[0][0][0];
    expect(arg.lh).toBe(SYS_LH);
    expect(arg.motorista).toBe("ABELARDO");
    expect(arg.carreta).toBe("FDZ0B46");
    expect(arg.createIfMissing).toBe(true);
    expect(arg.origem).toBe("SJ Rio Preto / SP");
    expect(arg.destino).toBe("Simoes Filho / BA");
    // Datas denormalizadas ISO → formato da planilha (DD/MM/YYYY HH:MM).
    expect(arg.dataCarregamento).toBe("01/08/2026 14:00");
    expect(arg.dataDescarga).toBe("03/08/2026 09:00");
  });

  it("carga do SISTEMA SEM motorista: editar só o status é UPDATE-ONLY (não cria linha vazia)", async () => {
    // Sem motorista efetivo, a alocação NÃO cria linha na planilha (não polui com
    // spot vazio) — só o motorista alocado dispara o create-or-fill.
    const SYS_LH = "LT-SYS-LAUNCHED-2";
    const { id } = await seedCargo({ status: "OPEN" });
    await query(`UPDATE public.cargas SET lh_manual = $2 WHERE id = $1`, [id, SYS_LH]);
    const operator = await seedUser({ email: "op-sys-status@teste.local" });
    writeSpy.mockClear();

    await updateMonitorAllocation({
      lh: SYS_LH,
      operatorId: operator.id,
      payload: { status: "AGUARDANDO DESCARGA" },
      correlationId: "corr-sys-status",
    });

    const row = await getAlloc(id);
    expect(row.alloc_status).toBe("AGUARDANDO DESCARGA");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const arg = writeSpy.mock.calls[0][0][0];
    expect(arg.status).toBe("AGUARDANDO DESCARGA");
    expect("createIfMissing" in arg).toBe(false);
    expect("createOnly" in arg).toBe(false);
  });

  it("carga do SISTEMA com LH NÃO-SPX (não LT…) + motorista: NÃO cria linha (gate LT evita planilha errada)", async () => {
    // Carga lançada não persiste sheet_source (NULL → roteia p/ shopee). Um LH de
    // outra fonte (não SPX) não deve ser criado na planilha Shopee → gate LT….
    const SYS_LH = "NESTLE-9910";
    const { id } = await seedCargo({ status: "OPEN", origem: "A / SP", destino: "B / BA" });
    await query(`UPDATE public.cargas SET lh_manual = $2 WHERE id = $1`, [id, SYS_LH]);
    const operator = await seedUser({ email: "op-sys-nonlt@teste.local" });
    writeSpy.mockClear();

    await updateMonitorAllocation({
      lh: SYS_LH,
      operatorId: operator.id,
      payload: { motorista: "JOANA", cavalo: "AAA1B22", carreta: "CCC3D44" },
      correlationId: "corr-sys-nonlt",
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const arg = writeSpy.mock.calls[0][0][0];
    expect(arg.motorista).toBe("JOANA");
    expect("createIfMissing" in arg).toBe(false); // update-only: não cria
    expect("createOnly" in arg).toBe(false);
  });

  it("prefere a carga da PLANILHA quando o LH existe como planilha E como sistema (lh_manual)", async () => {
    // Corrida: viagem lançada (lh_manual) E depois trazida pelo sync (sheet_lh).
    // A edição por LH deve gravar na carga da PLANILHA (fonte de verdade) e ainda
    // fazer write-back — não na carga do sistema.
    const DUP_LH = "LT-DUP-1";
    const sheetId = createSheetLoadId(DUP_LH);
    await seedCargo({ id: sheetId, sheet_lh: DUP_LH, status: "OPEN" });
    const { id: sysId } = await seedCargo({ status: "OPEN", origem: "X / SP", destino: "Y / BA" });
    await query(`UPDATE public.cargas SET lh_manual = $2 WHERE id = $1`, [sysId, DUP_LH]);
    const operator = await seedUser({ email: "op-dup@teste.local" });
    writeSpy.mockClear();

    await updateMonitorAllocation({
      lh: DUP_LH,
      operatorId: operator.id,
      payload: { motorista: "PLANILHA VENCE", cavalo: "AAA1A11", carreta: "BBB2B22" },
      correlationId: "corr-dup",
    });

    const sheetRow = await getAlloc(sheetId);
    const sysRow = await getAlloc(sysId);
    expect(sheetRow.alloc_motorista).toBe("PLANILHA VENCE"); // gravou na da planilha
    expect(sysRow.alloc_motorista).toBeNull();               // sistema intocado
    expect(writeSpy).toHaveBeenCalledTimes(1);               // planilha → write-back normal
  });

  it("prefere a carga com alocação viva (alloc_updated_at) quando sistema E planilha coexistem", async () => {
    // Corrida lançamento↔sync: carga da PLANILHA sem alocação (alloc_updated_at NULL)
    // + carga LANÇADA (lh_manual) COM motorista alocado (alloc_updated_at set). O
    // overlay allocByLh exibe a lançada → editar por LH deve mirar a MESMA carga
    // (senão editar só o status escreveria na planilha vazia e "sumia" o motorista).
    const DUP_LH = "LT-PREF-1";
    const sheetId = createSheetLoadId(DUP_LH);
    await seedCargo({ id: sheetId, sheet_lh: DUP_LH, status: "OPEN" });
    const { id: sysId } = await seedCargo({ status: "OPEN", origem: "X / SP", destino: "Y / BA" });
    await query(
      `UPDATE public.cargas SET lh_manual = $2, alloc_motorista = 'ABELARDO', alloc_updated_at = now() WHERE id = $1`,
      [sysId, DUP_LH],
    );
    const operator = await seedUser({ email: "op-pref@teste.local" });

    await updateMonitorAllocation({
      lh: DUP_LH,
      operatorId: operator.id,
      payload: { status: "AGUARDANDO DESCARGA" }, // só status (motorista ausente)
      correlationId: "corr-pref",
    });

    const sys = await getAlloc(sysId);
    const sheet = await getAlloc(sheetId);
    expect(sys.alloc_status).toBe("AGUARDANDO DESCARGA"); // gravou na carga alocada
    expect(sys.alloc_motorista).toBe("ABELARDO");         // motorista preservado
    expect(sheet.alloc_status).toBeNull();                 // planilha vazia intocada
  });

  it("MATERIALIZA a carga da planilha a partir do snapshot quando ela ainda não existe (viagem já atribuída)", async () => {
    // Linha da planilha que entrou JÁ ATRIBUÍDA (motorista no sheet) → o sync nunca
    // criou carga p/ ela. Antes: editar dava "Carga da planilha não encontrada".
    // Agora: materializa a carga do snapshot e grava o override do operador.
    const SLH = "LT-SNAP-ONLY-1";
    await seedSheetSnapshot([
      {
        lh: SLH,
        origem: "SJ Rio Preto / SP",
        destino: "Simoes Filho / BA",
        data: "2026-08-01",
        horario: "14:00:00",
        motoristas: "ABELARDO",
        cavalo: "CUA1123",
        carreta: "FDZ0B46",
        status: "AGUARDANDO CARREGAMENTO",
        tipo: "Tendência",
        carregamentoLabel: "01/08/2026 14:00",
        descargaLabel: "03/08/2026 09:00",
      },
    ]);
    const operator = await seedUser({ email: "op-snap-only@teste.local" });
    writeSpy.mockClear();

    const id = createSheetLoadId(SLH);
    const pre = await query("SELECT id FROM public.cargas WHERE id = $1", [id]);
    expect(pre.rows).toHaveLength(0); // nenhuma carga ainda

    const res = await updateMonitorAllocation({
      lh: SLH,
      operatorId: operator.id,
      payload: { carreta: "NOVA1234" }, // operador troca só a carreta
      correlationId: "corr-snap-only",
    });
    expect(res.statusCode).toBe(200);

    const cargo = await query(
      "SELECT sheet_lh, origem, destino, sheet_motorista, alloc_carreta, sheet_synced_at, status FROM public.cargas WHERE id = $1",
      [id],
    );
    expect(cargo.rows).toHaveLength(1); // materializada
    expect(cargo.rows[0].sheet_lh).toBe(SLH);
    expect(cargo.rows[0].origem).toBe("SJ Rio Preto / SP");
    expect(cargo.rows[0].sheet_motorista).toBe("ABELARDO"); // veio do snapshot
    expect(cargo.rows[0].status).toBe("BOOKED"); // linha atribuída → não fica no portal
    expect(cargo.rows[0].alloc_carreta).toBe("NOVA1234"); // override do operador gravado
    expect(cargo.rows[0].sheet_synced_at).toBeTruthy(); // integrada ao ciclo do sync
    // Carga da PLANILHA (não sistema) → faz write-back; motorista preservado (||).
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0][0].motorista).toBe("ABELARDO");
  });

  it("lança NotFoundError quando o LH não tem carga NEM está no snapshot", async () => {
    const operator = await seedUser({ email: "op-monitor-404@teste.local" });
    await expect(
      updateMonitorAllocation({
        lh: "LH-INEXISTENTE",
        operatorId: operator.id,
        payload: { motorista: "X" },
        correlationId: "corr-monitor-404",
      }),
    ).rejects.toThrow();
  });

  it('status "Disponível" sem motorista reabre a carga pro painel (cargas.status → OPEN)', async () => {
    const id = createSheetLoadId("LT-DISP-1");
    await seedCargo({ id, sheet_lh: "LT-DISP-1", status: "BOOKED" }); // fechada pro portal
    const operator = await seedUser({ email: "op-disp@teste.local" });

    const res = await updateMonitorAllocation({
      lh: "LT-DISP-1",
      operatorId: operator.id,
      payload: { motorista: "", cavalo: "", carreta: "", status: "Disponível" },
      correlationId: "corr-disp-1",
    });

    expect(res.statusCode).toBe(200);
    const { rows } = await query(`SELECT status, alloc_status FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("OPEN"); // voltou pro painel
    // "Disponível" é a AÇÃO de reabrir, não um status operacional armazenável:
    // alloc_status fica vazio (o badge "Disponivel" vem da derivação OPEN+futura),
    // senão o literal ficava preso e a linha aparecia "Disponivel" mesmo com motorista.
    expect(rows[0].alloc_status ?? "").toBe("");
  });

  it('status "Disponível" COM motorista NÃO reabre (só sem motorista volta pro painel)', async () => {
    const id = createSheetLoadId("LT-DISP-2");
    await seedCargo({ id, sheet_lh: "LT-DISP-2", status: "BOOKED" });
    const operator = await seedUser({ email: "op-disp2@teste.local" });

    await updateMonitorAllocation({
      lh: "LT-DISP-2",
      operatorId: operator.id,
      payload: { motorista: "JOÃO", status: "Disponível" },
      correlationId: "corr-disp-2",
    });

    const { rows } = await query(`SELECT status FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("BOOKED"); // com motorista, não reabre
  });

  it('"Disponível" COM motorista NÃO apaga o status operacional (preserva o override)', async () => {
    // Produção: um save de OUTRO campo (troca de carreta) levou "Disponível" junto —
    // o backend gravava "" e o status efetivo ficava vazio, deixando o overlay ao vivo
    // do SPX rebaixar a viagem (CTE reaparecendo como CARREGADO). Com motorista,
    // "Disponível" não é reabertura: trata como campo AUSENTE.
    const id = createSheetLoadId("LT-DISP-KEEP");
    await seedCargo({ id, sheet_lh: "LT-DISP-KEEP", status: "BOOKED" });
    const operator = await seedUser({ email: "op-disp-keep@teste.local" });
    await query(
      `UPDATE public.cargas SET alloc_motorista = $2, alloc_status = $3, alloc_updated_at = now() WHERE id = $1`,
      [id, "JOÃO", "CTE EM EMISSÃO"],
    );

    await updateMonitorAllocation({
      lh: "LT-DISP-KEEP",
      operatorId: operator.id,
      payload: { carreta: "ABC1D23", status: "Disponível" },
      correlationId: "corr-disp-keep",
    });

    const { rows } = await query(`SELECT alloc_status, alloc_carreta FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].alloc_status).toBe("CTE EM EMISSÃO"); // preservado
    expect(rows[0].alloc_carreta).toBe("ABC1D23"); // o resto do save vale
  });

  it("outro status (não 'Disponível') sem motorista NÃO mexe em cargas.status", async () => {
    const id = createSheetLoadId("LT-DISP-3");
    await seedCargo({ id, sheet_lh: "LT-DISP-3", status: "BOOKED" });
    const operator = await seedUser({ email: "op-disp3@teste.local" });

    await updateMonitorAllocation({
      lh: "LT-DISP-3",
      operatorId: operator.id,
      payload: { motorista: "", status: "AGUARDANDO CARREGAMENTO" },
      correlationId: "corr-disp-3",
    });

    const { rows } = await query(`SELECT status FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("BOOKED");
  });

  // ── Fechar a carga ao alocar (bug: carga alocada continuava OPEN/candidatável) ──
  it("alocar um motorista FECHA a carga pro portal: cargas.status OPEN → RESERVED", async () => {
    const id = createSheetLoadId("LT-CLOSE-1");
    await seedCargo({ id, sheet_lh: "LT-CLOSE-1", status: "OPEN" }); // OPEN, sem motorista
    const operator = await seedUser({ email: "op-close@teste.local" });

    await updateMonitorAllocation({
      lh: "LT-CLOSE-1",
      operatorId: operator.id,
      payload: { motorista: "JOAO AGREGADO", cavalo: "ABC1D23", carreta: "DEF4G56" },
      correlationId: "corr-close",
    });

    const { rows } = await query(
      `SELECT status, reserved_at, reserved_public_lead_id, reserved_claim_id, reserved_driver_id
       FROM public.cargas WHERE id = $1`,
      [id],
    );
    expect(rows[0].status).toBe("RESERVED"); // candidatura pública bloqueada (gate status='OPEN')
    expect(rows[0].reserved_at).toBeTruthy();
    // Reserva de Monitor: SEM marcadores de reserva real (lead/claim/driver).
    expect(rows[0].reserved_public_lead_id).toBeNull();
    expect(rows[0].reserved_claim_id).toBeNull();
    expect(rows[0].reserved_driver_id).toBeNull();
  });

  it("limpar o motorista de carga fechada por Monitor reabre pro portal: RESERVED → OPEN", async () => {
    const id = createSheetLoadId("LT-CLOSE-2");
    await seedCargo({ id, sheet_lh: "LT-CLOSE-2", status: "OPEN" });
    const operator = await seedUser({ email: "op-reopen-mon@teste.local" });

    // aloca → fecha
    await updateMonitorAllocation({
      lh: "LT-CLOSE-2",
      operatorId: operator.id,
      payload: { motorista: "JOAO" },
      correlationId: "c-close",
    });
    expect((await query(`SELECT status FROM public.cargas WHERE id = $1`, [id])).rows[0].status).toBe("RESERVED");

    // limpa → reabre (SEM marcar "Disponível"; é a reserva sintética de Monitor)
    await updateMonitorAllocation({
      lh: "LT-CLOSE-2",
      operatorId: operator.id,
      payload: { motorista: "" },
      correlationId: "c-reopen",
    });
    const { rows } = await query(`SELECT status, reserved_at FROM public.cargas WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("OPEN");
    expect(rows[0].reserved_at).toBeNull();
  });
});
