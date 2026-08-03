import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  withPgClient,
} from "../operator-admin/test-harness.js";
import { checkWritebackHealth, recordCreateAttempt } from "./check-writeback-health.js";

// Fecha o buraco silencioso: o Apps Script responde created:N e a linha não nasce.
// A verificação não confia na resposta — ela relê a planilha e compara.

const deps = { withPgClient };

async function setSnapshot({ lhs, syncedAt, source = "shopee", id = 1 }) {
  const rows = lhs.map((lh) => ({ lh, motoristas: "ALGUEM" }));
  await query(
    `INSERT INTO public.sheet_monitor_snapshot (id, rows_json, summary_json, synced_at, source)
     VALUES ($3, $1::jsonb, '{}'::jsonb, $2, $4)
     ON CONFLICT (id) DO UPDATE SET rows_json = EXCLUDED.rows_json, synced_at = EXCLUDED.synced_at,
                                    source = EXCLUDED.source`,
    [JSON.stringify(rows), syncedAt, id, source],
  );
}

const agoraMais = (ms) => new Date(Date.now() + ms).toISOString();

const avisos = async () =>
  (await query("SELECT kind, title, body, metadata FROM public.operator_notifications ORDER BY created_at")).rows;

describe("verificação automática do write-back da planilha", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    delete process.env.SHEET_WRITEBACK_HEALTH_ENABLED;
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("linha pedida NÃO chegou → avisa o operador no sino", async () => {
    await recordCreateAttempt(["LT-A", "LT-B"], { deps });
    // planilha relida DEPOIS da tentativa e sem os LHs
    await setSnapshot({ lhs: ["LT-OUTRA"], syncedAt: new Date(Date.now() + 1000).toISOString() });

    const r = await checkWritebackHealth({ deps });

    expect(r.pedidas).toBe(2);
    expect(r.faltando).toBe(2);
    expect(r.avisou).toBe(true);
    const [aviso] = await avisos();
    expect(aviso.kind).toBe("sheet_writeback_broken");
    expect(aviso.title).toContain("2 carga(s)");
    expect(aviso.metadata.lhs).toEqual(["LT-A", "LT-B"]);
  });

  it("linha chegou → nada de aviso", async () => {
    await recordCreateAttempt(["LT-A"], { deps });
    await setSnapshot({ lhs: ["LT-A"], syncedAt: new Date(Date.now() + 1000).toISOString() });

    const r = await checkWritebackHealth({ deps });

    expect(r.faltando).toBe(0);
    expect(r.avisou).toBe(false);
    expect(await avisos()).toHaveLength(0);
  });

  it("planilha lida ANTES da escrita → inconclusivo, não avisa (o erro dos 25 segundos)", async () => {
    await setSnapshot({ lhs: [], syncedAt: new Date(Date.now() - 60_000).toISOString() });
    await recordCreateAttempt(["LT-A"], { deps });

    const r = await checkWritebackHealth({ deps });

    expect(r.skipped).toBe("snapshot-anterior-a-tentativa");
    expect(r.avisou).toBe(false);
    expect(await avisos()).toHaveLength(0);
    // a tentativa NÃO é descartada — o próximo ciclo confere
    const { rows } = await query("SELECT 1 FROM public.app_settings WHERE key = 'sheet_writeback_pending_create'");
    expect(rows).toHaveLength(1);
  });

  it("não repete o aviso dentro da janela (o problema dura dias)", async () => {
    await recordCreateAttempt(["LT-A"], { deps });
    await setSnapshot({ lhs: [], syncedAt: new Date(Date.now() + 1000).toISOString() });
    await checkWritebackHealth({ deps });

    await recordCreateAttempt(["LT-B"], { deps });
    await setSnapshot({ lhs: [], syncedAt: new Date(Date.now() + 2000).toISOString() });
    const r2 = await checkWritebackHealth({ deps });

    expect(r2.faltando).toBe(1);
    expect(r2.avisou).toBe(false); // já avisou nesta janela
    expect(await avisos()).toHaveLength(1);
  });

  it("sem tentativa registrada → no-op", async () => {
    await setSnapshot({ lhs: [], syncedAt: new Date().toISOString() });
    const r = await checkWritebackHealth({ deps });
    expect(r.skipped).toBe("sem-tentativa-registrada");
  });

  it("kill-switch desliga a verificação", async () => {
    process.env.SHEET_WRITEBACK_HEALTH_ENABLED = "false";
    try {
      await recordCreateAttempt(["LT-A"], { deps });
      const r = await checkWritebackHealth({ deps });
      expect(r.skipped).toBe("disabled");
    } finally {
      delete process.env.SHEET_WRITEBACK_HEALTH_ENABLED;
    }
  });

  // As fontes sincronizam em momentos diferentes (medido em prod: 5min de defasagem
  // entre shopee e nestle). Olhar "o snapshot mais novo de qualquer fonte" daria
  // aviso FALSO quando a leitura da fonte da tentativa é a que ficou atrasada.
  it("snapshot da fonte da tentativa atrasado, outra fonte fresca → inconclusivo", async () => {
    await recordCreateAttempt(["LT-A"], { sources: ["shopee"], deps });
    await setSnapshot({ lhs: [], syncedAt: agoraMais(-60_000), source: "shopee", id: 1 });
    await setSnapshot({ lhs: [], syncedAt: agoraMais(1000), source: "nestle", id: 2 });

    const r = await checkWritebackHealth({ deps });

    expect(r.skipped).toBe("snapshot-anterior-a-tentativa");
    expect(r.fontesDesatualizadas).toEqual(["shopee"]);
    expect(await avisos()).toHaveLength(0);
  });

  it("fonte NÃO envolvida atrasada não segura a conferência", async () => {
    await recordCreateAttempt(["LT-A"], { sources: ["shopee"], deps });
    await setSnapshot({ lhs: [], syncedAt: agoraMais(1000), source: "shopee", id: 1 });
    await setSnapshot({ lhs: [], syncedAt: agoraMais(-600_000), source: "nestle", id: 2 });

    const r = await checkWritebackHealth({ deps });

    expect(r.faltando).toBe(1);
    expect(r.avisou).toBe(true);
  });

  it("linha presente só na planilha da OUTRA fonte não conta como chegada", async () => {
    await recordCreateAttempt(["LT-A"], { sources: ["shopee"], deps });
    await setSnapshot({ lhs: [], syncedAt: agoraMais(1000), source: "shopee", id: 1 });
    await setSnapshot({ lhs: ["LT-A"], syncedAt: agoraMais(1000), source: "nestle", id: 2 });

    const r = await checkWritebackHealth({ deps });

    expect(r.faltando).toBe(1);
    const [aviso] = await avisos();
    expect(aviso.metadata.fontes).toEqual(["shopee"]);
  });

  it("tentativa antiga sem o campo de fontes é tratada como shopee", async () => {
    await query(
      `INSERT INTO public.app_settings (key, value, updated_by)
       VALUES ('sheet_writeback_pending_create', $1::jsonb, 'teste')`,
      [JSON.stringify({ at: new Date().toISOString(), lhs: ["LT-A"] })],
    );
    await setSnapshot({ lhs: [], syncedAt: agoraMais(1000), source: "shopee", id: 1 });

    const r = await checkWritebackHealth({ deps });

    expect(r.faltando).toBe(1);
    expect(r.avisou).toBe(true);
  });

  it("tentativa conferida é descartada (não reavalia a mesma leva)", async () => {
    await recordCreateAttempt(["LT-A"], { deps });
    await setSnapshot({ lhs: ["LT-A"], syncedAt: new Date(Date.now() + 1000).toISOString() });
    await checkWritebackHealth({ deps });

    const segunda = await checkWritebackHealth({ deps });
    expect(segunda.skipped).toBe("sem-tentativa-registrada");
  });
});
