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
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

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
    expect(row.alloc_status).toBe("");
    // sheet_* segue intocado (a planilha continua com o valor original por baixo)
    expect(row.sheet_motorista).toBe("MOTORISTA DA PLANILHA");
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
    const lead = await seedPublicLead({ load_id: id, status: "APPROVED" });
    await query(
      `UPDATE public.cargas SET status = 'RESERVED', reserved_public_lead_id = $2 WHERE id = $1`,
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

  it("lança NotFoundError quando o LH não tem carga correspondente", async () => {
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
    expect(rows[0].alloc_status).toBe("Disponível");
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
});
