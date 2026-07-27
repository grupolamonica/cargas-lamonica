import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedCliente,
  withPgClient,
} from "../test-harness.js";
import { reconcileAspxStatus } from "./reconcile-aspx-status.js";
import { SpxAspNotConfigured } from "../../../infrastructure/torre/torre-spx-trips-client.js";

// Constrói uma linha crua da aba ASP (Torre) com os nomes de coluna reais.
const aspRow = (o) => ({
  "LH Trip Number": o.lh,
  "Status Operacional": o.status ?? "",
  "Driver ID": o.driver ?? "",
  "Vehicle Plate Number": o.plate ?? ",",
  "ETA ORIGEM PROGRAMADO": o.etaO ?? "",
  "ETA DESTINO PROGRAMADO": o.etaD ?? "",
  "Station_Origem": o.stO ?? "",
  "Station_Destino": o.stD ?? "",
});
const fakeTrips = (rows) => async () => ({ rows });
const baseDeps = (rows, extra = {}) => ({
  withPgClient,
  fetchSpxTrips: fakeTrips(rows),
  isSheetWritebackEnabled: () => true,
  writeAllocationsToSheet: async (u) => ({ ok: true, updated: u.length }),
  ...extra,
});

const rowOf = async (id) =>
  (await query(
    `SELECT sheet_status, sheet_motorista, sheet_cavalo, sheet_carreta,
            sheet_data_carregamento, sheet_data_descarga FROM public.cargas WHERE id = $1`,
    [id],
  )).rows[0];

async function setSheetFields(id, fields) {
  const cols = Object.keys(fields);
  const set = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
  await query(`UPDATE public.cargas SET ${set} WHERE id = $1`, [id, ...cols.map((c) => fields[c])]);
}

describe("reconcileAspxStatus (DC-316 completo)", () => {
  let clienteId;
  beforeEach(async () => {
    await resetTestDatabase();
    clienteId = (await seedCliente({ nome: "Shopee" })).id;
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("no-op quando a Torre não está configurada (throw) ou não devolve linhas", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-1" });
    await setSheetFields(carga.id, { sheet_status: "AGUARDANDO CARREGAMENTO", sheet_source: "shopee" });

    const semChave = await reconcileAspxStatus({
      deps: baseDeps([], { fetchSpxTrips: async () => { throw new SpxAspNotConfigured(); } }),
    });
    expect(semChave).toMatchObject({ ok: true, skipped: true, reason: "no-index" });

    const vazio = await reconcileAspxStatus({ deps: baseDeps([]) });
    expect(vazio).toMatchObject({ ok: true, skipped: true, reason: "empty-index" });
    expect((await rowOf(carga.id)).sheet_status).toBe("AGUARDANDO CARREGAMENTO");
  });

  it("sob o gate (AGUARDANDO CARREGAMENTO): sincroniza status + motorista/placas + datas", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-100" });
    await setSheetFields(carga.id, {
      sheet_status: "AGUARDANDO CARREGAMENTO",
      sheet_source: "shopee",
      sheet_motorista: "ANTIGO",
      sheet_cavalo: "OLD0A00",
    });

    const writes = [];
    const r = await reconcileAspxStatus({
      deps: baseDeps(
        [aspRow({
          lh: "LT-100", status: "CARREGADO", driver: "[9] JOAO DA SILVA",
          plate: "ABC1D23,XYZ9Z88", etaO: "2026-07-27 08:00", etaD: "2026-07-28 10:00",
        })],
        { writeAllocationsToSheet: async (u) => { writes.push(...u); return { ok: true, updated: u.length }; } },
      ),
    });

    expect(r).toMatchObject({ ok: true, checked: 1, updated: 1, sheetWrites: 1 });
    const row = await rowOf(carga.id);
    expect(row.sheet_status).toBe("CARREGADO");
    expect(row.sheet_motorista).toBe("JOAO DA SILVA");
    expect(row.sheet_cavalo).toBe("ABC1D23");
    expect(row.sheet_carreta).toBe("XYZ9Z88");
    expect(row.sheet_data_carregamento).toBe("2026-07-27 08:00");
    expect(row.sheet_data_descarga).toBe("2026-07-28 10:00");
    expect(writes[0]).toMatchObject({
      lh: "LT-100", source: "shopee", status: "CARREGADO",
      motorista: "JOAO DA SILVA", cavalo: "ABC1D23", carreta: "XYZ9Z88",
      dataCarregamento: "2026-07-27 08:00", dataDescarga: "2026-07-28 10:00",
    });
  });

  it("gate FECHADO (AGUARDANDO DESCARGA): só o status muda; motorista/datas NÃO; write-back não apaga motorista", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-DE" });
    await setSheetFields(carga.id, {
      sheet_status: "AGUARDANDO DESCARGA",
      sheet_source: "shopee",
      sheet_motorista: "MOTORISTA VIVO",
      sheet_cavalo: "VIV0A00",
    });

    const writes = [];
    const r = await reconcileAspxStatus({
      deps: baseDeps(
        [aspRow({ lh: "LT-DE", status: "DESCARREGANDO", driver: "[1] OUTRO", plate: "NEW1A11,NEW2B22", etaO: "2026-07-27 09:00" })],
        { writeAllocationsToSheet: async (u) => { writes.push(...u); return { ok: true, updated: u.length }; } },
      ),
    });

    expect(r).toMatchObject({ ok: true, updated: 1 });
    const row = await rowOf(carga.id);
    expect(row.sheet_status).toBe("DESCARREGANDO"); // descarga permitida a partir de descarga
    expect(row.sheet_motorista).toBe("MOTORISTA VIVO"); // gate fechado → não troca motorista
    // write-back manda o motorista EFETIVO atual (não vazio) + status; sem chaves de data
    expect(writes[0]).toMatchObject({ lh: "LT-DE", status: "DESCARREGANDO", motorista: "MOTORISTA VIVO", cavalo: "VIV0A00" });
    expect(writes[0].dataCarregamento).toBeUndefined();
  });

  it("CTE ENVIADO vem da planilha: ASPX não regride para CARREGADO (nada muda, sem write)", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-CTE" });
    await setSheetFields(carga.id, { sheet_status: "CTE ENVIADO", sheet_source: "shopee", sheet_motorista: "M" });

    const writes = [];
    const r = await reconcileAspxStatus({
      deps: baseDeps(
        [aspRow({ lh: "LT-CTE", status: "CARREGADO", driver: "[1] X", plate: "AAA1A11," })],
        { writeAllocationsToSheet: async (u) => { writes.push(...u); return { ok: true, updated: u.length }; } },
      ),
    });

    expect(r).toMatchObject({ ok: true, checked: 1, updated: 0, sheetWrites: 0 });
    expect((await rowOf(carga.id)).sheet_status).toBe("CTE ENVIADO");
    expect(writes).toHaveLength(0);
  });

  it("CTE ENVIADO → AGUARDANDO DESCARGA: quando 'não é CTE', vem do ASPX", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-CTE2" });
    await setSheetFields(carga.id, { sheet_status: "CTE ENVIADO", sheet_source: "shopee", sheet_motorista: "M" });

    const r = await reconcileAspxStatus({
      deps: baseDeps([aspRow({ lh: "LT-CTE2", status: "AGUARDANDO DESCARGA" })]),
    });
    expect(r).toMatchObject({ ok: true, updated: 1 });
    expect((await rowOf(carga.id)).sheet_status).toBe("AGUARDANDO DESCARGA");
  });

  it("write-back desligado: sistema atualiza, planilha não é chamada", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-OFF" });
    await setSheetFields(carga.id, { sheet_status: "AGUARDANDO CARREGAMENTO", sheet_source: "shopee" });

    let called = false;
    const r = await reconcileAspxStatus({
      deps: baseDeps([aspRow({ lh: "LT-OFF", status: "CARREGADO" })], {
        isSheetWritebackEnabled: () => false,
        writeAllocationsToSheet: async () => { called = true; return { ok: true }; },
      }),
    });

    expect(r).toMatchObject({ ok: true, updated: 1, sheetWrites: 0 });
    expect((await rowOf(carga.id)).sheet_status).toBe("CARREGADO");
    expect(called).toBe(false);
  });

  it("ignora LHs do ASPX sem carga no sistema", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-EX" });
    await setSheetFields(carga.id, { sheet_status: "AGUARDANDO CARREGAMENTO", sheet_source: "shopee" });

    const r = await reconcileAspxStatus({
      deps: baseDeps([
        aspRow({ lh: "LT-EX", status: "CARREGADO" }),
        aspRow({ lh: "LT-FANTASMA", status: "CARREGADO" }),
      ]),
    });
    expect(r).toMatchObject({ ok: true, checked: 1, updated: 1 });
  });
});
