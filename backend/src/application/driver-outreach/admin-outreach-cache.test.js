/**
 * Cache do OVERVIEW da tela de Mensagens (getOutreachOverview) — PONTO 9.
 *
 * Prova as duas coisas que importam nesta mudança de performance:
 *  - redução de queries/round trips no banco (proxy direto do egress do pooler):
 *    contamos o SQL realmente executado envolvendo o client do pg-mem;
 *  - preservação de comportamento: mesmo payload (mesmas chaves, mesma ordem,
 *    mesmos contadores, mesma resolução de nome), correlationId por REQUEST,
 *    read-your-write em todas as mutações da tela que vivem neste módulo e
 *    nenhum cache de erro.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedDriverOutreachOptout,
  seedMotoristaHistorico,
  seedOutreachLog,
  seedPendingOutreach,
  withPgClient as rawWithPgClient,
  withPgTransaction,
} from "../operator-admin/test-harness.js";

// ── Instrumentação: conta o SQL executado ────────────────────────────────────
// O pool do pg-mem REUSA clients, então o wrapper precisa ser idempotente
// (Symbol) senão a contagem dobra.
const sqlLog = [];
const INSTRUMENTED = Symbol("instrumented");
// SQL da chamada corrente (por withPgClient) — chamadas concorrentes se
// intercalam no sqlLog global, então o gate abaixo precisa de escopo próprio.
const callSql = new AsyncLocalStorage();

function instrument(client) {
  if (client[INSTRUMENTED]) return client;
  const original = client.query.bind(client);
  client.query = (...args) => {
    const first = args[0];
    const sql = typeof first === "string" ? first : String(first?.text ?? "");
    const params = Array.isArray(args[1]) ? args[1] : first?.values ?? [];
    sqlLog.push({ sql, params });
    callSql.getStore()?.push(sql);
    return original(...args);
  };
  client[INSTRUMENTED] = true;
  return client;
}

// Gate one-shot: atrasa a RESOLUÇÃO de uma leitura DEPOIS que o client já foi
// liberado (gatear a execução travaria o pool e a leitura veria o estado
// pós-mutação). Simula "a leitura pegou as linhas ANTES do write e resolveu
// DEPOIS".
let releaseGate = null;

const withPgClient = async (fn) => {
  const local = [];
  return callSql.run(local, async () => {
    const result = await rawWithPgClient((client) => fn(instrument(client)));
    if (releaseGate && local.some((sql) => releaseGate.pattern.test(sql))) {
      const gate = releaseGate;
      releaseGate = null;
      await gate.promise;
    }
    return result;
  });
};

vi.mock("../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));
vi.mock("../../infrastructure/whatsapp/evolution-client.js", () => ({
  sendWhatsappText: vi.fn(async () => ({ ok: true })),
  connectWhatsappInstance: vi.fn(async () => ({})),
  getWhatsappConnectionState: vi.fn(async () => ({ state: "open" })),
  logoutWhatsappInstance: vi.fn(async () => ({})),
}));
vi.mock("./scan-and-enqueue.js", () => ({
  scanAndEnqueueOutreach: vi.fn(async () => ({ enqueued: 0, scanned: 0 })),
}));
vi.mock("./angellira-check.js", () => ({
  checkAngelliraVigencia: vi.fn(async () => ({ checked: true, vigente: true, validUntil: "2027-01-01" })),
}));

const {
  __resetOutreachOverviewCache,
  addOutreachOptout,
  cancelQueuedOutreach,
  createManualOutreach,
  getOutreachOverview,
  removeOutreachOptout,
  revalidateOutreachQueueAgainstAngellira,
  saveOutreachSettings,
  sendOutreachQueueItemNow,
  triggerOutreachScan,
  updateOutreachQueueItem,
} = await import("./admin.js");

const countSql = (re) => sqlLog.filter((e) => re.test(e.sql)).length;
const paramsOf = (re) => sqlLog.filter((e) => re.test(e.sql)).map((e) => e.params);
const OV_QUEUE = /FROM public\.pending_driver_outreach ORDER BY created_at DESC/;
const OV_STATS = /GROUP BY status/;
const OV_LOG = /FROM public\.driver_outreach_log ORDER BY created_at DESC/;
const OV_OPTOUTS = /FROM public\.driver_outreach_optout ORDER BY created_at DESC/;
const TTL = "5000";

// Baseline: uma execução completa do overview = 8 queries com este seed
// (settings ×2, GROUP BY, count 24h, fila, nomes, log, opt-outs).
const BASELINE_QUERIES = 8;

const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

/** Seed padrão: 2 itens na fila (um por CPF, um por nome), log e opt-out. */
async function seedOverview() {
  await saveOutreachSettings({ enabled: true, dailyCap: 20 }, null);
  await seedMotoristaHistorico({ cpf: "12345678901", nome: "João Teste" });
  const { id: cpfItem } = await seedPendingOutreach({
    driver_key: "12345678901",
    trigger: "lost_registration",
    status: "pending",
    created_at: hoursAgo(1),
  });
  const { id: nameItem } = await seedPendingOutreach({
    driver_key: "maria da silva",
    trigger: "churn",
    status: "sent",
    created_at: hoursAgo(2),
  });
  await seedOutreachLog({ driver_key: "12345678901", channel: "evolution", status: "sent", created_at: hoursAgo(1) });
  await seedOutreachLog({ driver_key: "12345678901", channel: "evolution", status: "sent", created_at: hoursAgo(30) });
  await seedOutreachLog({ driver_key: "99999999999", channel: "wa_link", status: "sent", created_at: hoursAgo(1) });
  await seedDriverOutreachOptout({ driver_key: "55555555555", reason: "pediu para não receber" });
  return { cpfItem, nameItem };
}

/** Payload sem os campos por-request (p/ comparar hit e miss). */
const body = (ov) => {
  const { meta: _meta, ...rest } = ov;
  return rest;
};

describe("driver-outreach admin — cache do overview da tela de Mensagens (integração pg-mem)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    sqlLog.length = 0;
    releaseGate = null;
    delete process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS;
    delete process.env.EVOLUTION_API_TOKEN;
    __resetOutreachOverviewCache();
  });

  afterAll(async () => {
    await closeTestDatabase();
    delete process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS;
    delete process.env.EVOLUTION_API_TOKEN;
  });

  // ── Comportamento preservado ───────────────────────────────────────────────
  it("payload preservado: chaves, fila em created_at DESC, nome resolvido, contadores e meta", async () => {
    await seedOverview();
    sqlLog.length = 0;

    const ov = await getOutreachOverview({ correlationId: "corr-1" });

    expect(Object.keys(ov)).toEqual([
      "settings",
      "timing",
      "evolutionConfigured",
      "queueStats",
      "sentLast24h",
      "queue",
      "log",
      "optouts",
      "meta",
    ]);
    expect(ov.settings.enabled).toBe(true);
    expect(ov.settings.dailyCap).toBe(20);
    expect(ov.settings.updatedAt).toBeTruthy();
    expect(ov.queueStats).toEqual({ pending: 1, sent: 1, failed: 0, skipped: 0 });
    // Só canal 'evolution' + status 'sent' + últimas 24h (2 dos 3 logs caem fora).
    expect(ov.sentLast24h).toBe(1);
    expect(ov.queue.map((q) => q.driver_key)).toEqual(["12345678901", "maria da silva"]);
    expect(ov.queue[0].driver_name).toBe("João Teste"); // CPF → nome do histórico
    expect(ov.queue[1].driver_name).toBe("maria da silva"); // não-CPF → a própria chave
    expect(Object.keys(ov.queue[0]).sort()).toEqual([
      "created_at", "driver_key", "driver_name", "id", "last_error", "message",
      "phone", "retry_count", "sent_at", "status", "trigger",
    ]);
    expect(ov.log).toHaveLength(3);
    expect(ov.optouts.map((o) => o.driver_key)).toEqual(["55555555555"]);
    expect(ov.evolutionConfigured).toBe(false);
    expect(Object.keys(ov.meta)).toEqual(["correlationId", "generatedAt"]);
    expect(ov.meta.correlationId).toBe("corr-1");

    // Custo de UMA execução (o cache é quem corta as repetições).
    expect(sqlLog).toHaveLength(BASELINE_QUERIES);
    expect(countSql(OV_QUEUE)).toBe(1);
  });

  it("os LIMITs que a chave do cache codifica são os que vão para o SQL (200 / 25 / 100)", async () => {
    await seedOverview();
    sqlLog.length = 0;

    await getOutreachOverview({});

    expect(paramsOf(OV_QUEUE)).toEqual([[200]]);
    expect(paramsOf(OV_LOG)).toEqual([[25]]);
    expect(paramsOf(OV_OPTOUTS)).toEqual([[100]]);
  });

  it("sem o knob, o cache fica DESLIGADO em teste (cada chamada vai ao banco)", async () => {
    await seedOverview();
    sqlLog.length = 0;

    await getOutreachOverview({});
    await getOutreachOverview({});

    expect(sqlLog).toHaveLength(BASELINE_QUERIES * 2);
    expect(countSql(OV_QUEUE)).toBe(2);
  });

  // ── Redução de queries ─────────────────────────────────────────────────────
  it("TTL colapsa o poll de 15s: 2 chamadas = 1 execução (8 queries no lugar de 16)", async () => {
    process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS = TTL;
    await seedOverview();
    sqlLog.length = 0;

    const first = await getOutreachOverview({ correlationId: "a" });
    const second = await getOutreachOverview({ correlationId: "b" });

    expect(sqlLog).toHaveLength(BASELINE_QUERIES); // 8, não 16
    expect(countSql(OV_QUEUE)).toBe(1);
    expect(countSql(OV_STATS)).toBe(1);
    expect(countSql(OV_LOG)).toBe(1);
    expect(countSql(OV_OPTOUTS)).toBe(1);
    // Mesmo payload; só os campos por-request mudam.
    expect(body(second)).toEqual(body(first));
    expect(second.meta.correlationId).toBe("b");
    expect(second.meta.generatedAt).toBe(first.meta.generatedAt);
    expect(second.meta.cached).toBe(true);
  });

  it("single-flight colapsa polls concorrentes (3 chamadas = 8 queries no lugar de 24)", async () => {
    process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS = TTL;
    await seedOverview();
    sqlLog.length = 0;

    const [a, b, c] = await Promise.all([
      getOutreachOverview({ correlationId: "x" }),
      getOutreachOverview({ correlationId: "y" }),
      getOutreachOverview({ correlationId: "z" }),
    ]);

    expect(sqlLog).toHaveLength(BASELINE_QUERIES); // 8, não 24
    expect(countSql(OV_QUEUE)).toBe(1);
    expect(body(b)).toEqual(body(a));
    expect(body(c)).toEqual(body(a));
    // Cada chamador continua recebendo o SEU correlationId (nunca o do vizinho).
    expect([a.meta.correlationId, b.meta.correlationId, c.meta.correlationId]).toEqual(["x", "y", "z"]);
  });

  it("evolutionConfigured continua sendo lido por chamada (não envelhece no cache)", async () => {
    process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS = TTL;
    await seedOverview();

    expect((await getOutreachOverview({})).evolutionConfigured).toBe(false);
    process.env.EVOLUTION_API_TOKEN = "token-de-teste";
    expect((await getOutreachOverview({})).evolutionConfigured).toBe(true);
  });

  // ── Read-your-write das mutações deste módulo ──────────────────────────────
  it("salvar settings invalida na hora (o toggle aparece no refetch)", async () => {
    process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS = TTL;
    await seedOverview();

    expect((await getOutreachOverview({})).settings.enabled).toBe(true);
    await saveOutreachSettings({ enabled: false }, null);
    expect((await getOutreachOverview({})).settings.enabled).toBe(false);
  });

  it("adicionar/remover opt-out invalida na hora", async () => {
    process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS = TTL;
    await seedOverview();

    expect((await getOutreachOverview({})).optouts.map((o) => o.driver_key)).toEqual(["55555555555"]);

    await addOutreachOptout({ cpf: "123.456.789-01", reason: "pediu" }, null);
    expect((await getOutreachOverview({})).optouts.some((o) => o.driver_key === "12345678901")).toBe(true);

    await removeOutreachOptout("12345678901");
    expect((await getOutreachOverview({})).optouts.some((o) => o.driver_key === "12345678901")).toBe(false);
  });

  it("cancelar item da fila invalida na hora", async () => {
    process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS = TTL;
    const { cpfItem } = await seedOverview();

    expect((await getOutreachOverview({})).queueStats).toEqual({ pending: 1, sent: 1, failed: 0, skipped: 0 });
    await cancelQueuedOutreach(cpfItem);
    expect((await getOutreachOverview({})).queueStats).toEqual({ pending: 0, sent: 1, failed: 0, skipped: 1 });
  });

  it("editar item da fila invalida na hora", async () => {
    process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS = TTL;
    const { cpfItem } = await seedOverview();

    expect((await getOutreachOverview({})).queue[0].message).toBe("Olá! Mensagem de teste.");
    await updateOutreachQueueItem(cpfItem, { message: "Texto novo do operador" });
    expect((await getOutreachOverview({})).queue[0].message).toBe("Texto novo do operador");
  });

  it("inserir item manual invalida na hora", async () => {
    process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS = TTL;
    await seedOverview();

    expect((await getOutreachOverview({})).queue).toHaveLength(2);
    await createManualOutreach({
      cpf: "98765432100",
      nome: "Pedro Novo",
      phone: "71988887777",
      trigger: "abandonment",
      message: "Vamos finalizar?",
    });
    const after = await getOutreachOverview({});
    expect(after.queue).toHaveLength(3);
    expect(after.queueStats.pending).toBe(2);
  });

  it("enviar agora invalida na hora (fila e estatísticas mudam)", async () => {
    process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS = TTL;
    process.env.EVOLUTION_API_TOKEN = "token-de-teste";
    const { cpfItem } = await seedOverview();

    expect((await getOutreachOverview({})).queueStats.pending).toBe(1);
    await sendOutreachQueueItemNow(cpfItem);
    const after = await getOutreachOverview({});
    expect(after.queueStats).toEqual({ pending: 0, sent: 2, failed: 0, skipped: 0 });
  });

  it("rodar varredura invalida na hora", async () => {
    process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS = TTL;
    await seedOverview();
    sqlLog.length = 0;

    await getOutreachOverview({});
    expect(countSql(OV_QUEUE)).toBe(1);

    await triggerOutreachScan();

    await getOutreachOverview({});
    expect(countSql(OV_QUEUE)).toBe(2); // foi ao banco de novo
  });

  it("revalidação Angellira que cancela itens invalida na hora", async () => {
    process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS = TTL;
    await seedOverview();

    expect((await getOutreachOverview({})).queueStats.pending).toBe(1);
    const res = await revalidateOutreachQueueAgainstAngellira();
    expect(res.cancelled).toBe(1);
    expect((await getOutreachOverview({})).queueStats).toEqual({
      pending: 0, sent: 1, failed: 0, skipped: 1,
    });
  });

  it("leitura em voo durante a mutação não repovoa o cache (epoch)", async () => {
    process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS = TTL;
    const { cpfItem } = await seedOverview();
    sqlLog.length = 0;

    let release;
    releaseGate = { pattern: OV_QUEUE, promise: new Promise((r) => { release = r; }) };
    const pending = getOutreachOverview({}); // leitura que resolve DEPOIS do write
    await cancelQueuedOutreach(cpfItem); // mutação no meio do voo
    release();
    await pending; // o que essa leitura viu depende do intercalamento — não é o ponto

    expect(countSql(OV_QUEUE)).toBe(1);
    // O ponto: o resultado dessa leitura NÃO ficou no cache. Sem a guarda de
    // epoch, o refetch abaixo seria servido do cache (0 queries novas) e poderia
    // mostrar o item ainda como 'pending' por até um TTL inteiro.
    const after = await getOutreachOverview({});
    expect(countSql(OV_QUEUE)).toBe(2); // foi ao banco de novo
    expect(after.queueStats).toEqual({ pending: 0, sent: 1, failed: 0, skipped: 1 });
  });

  // ── Erro nunca é cacheado ──────────────────────────────────────────────────
  it("falha de schema não gruda no cache (a próxima chamada vai ao banco de novo)", async () => {
    process.env.OPERATOR_OUTREACH_OVERVIEW_CACHE_TTL_MS = TTL;
    await seedOverview();
    await query(`DROP TABLE public.pending_driver_outreach`);
    sqlLog.length = 0;

    await expect(getOutreachOverview({})).rejects.toThrow();
    const afterFirst = sqlLog.length;
    expect(afterFirst).toBeGreaterThan(0);

    await expect(getOutreachOverview({})).rejects.toThrow();
    expect(sqlLog.length).toBeGreaterThan(afterFirst); // não devolveu erro/payload do cache
  });
});
