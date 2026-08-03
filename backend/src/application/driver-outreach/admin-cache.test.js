/**
 * Cache do sino (operator_notifications) + do chat (whatsapp_messages).
 *
 * Prova as DUAS coisas que importam nesta mudança de performance:
 *  - redução de queries/round trips no banco (proxy direto do egress do pooler):
 *    contamos o SQL realmente executado envolvendo o client do pg-mem;
 *  - preservação de comportamento: mesmo payload, mesma ordem, mesmos contadores,
 *    read-your-write nas mutações e nenhum campo novo no payload.
 *
 * ⚠ A contagem tem que ser feita na CADÊNCIA REAL DO POLL, não em chamadas
 * colada-a-colada. Duas chamadas seguidas caem dentro de qualquer TTL > 0 e
 * passam mesmo com o TTL quebrado: foi assim que o sino foi para produção com
 * TTL de 15s contra um poll de 30s e mediu ZERO cache hit (35 execuções em
 * 1091s de pg_stat_statements = uma por poll). Por isso os testes abaixo avançam
 * um relógio falso pelo intervalo do poll entre as chamadas.
 */
import { readFileSync } from "node:fs";

import { AsyncLocalStorage } from "node:async_hooks";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedMotoristaHistorico,
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
    sqlLog.push(sql);
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

// ── Relógio controlável ──────────────────────────────────────────────────────
// Os caches só olham Date.now(), então avançar um offset simula o tempo REAL
// entre polls (30s no sino, 20s no chat) sem sleep. O tempo real decorrido nos
// testes é de milissegundos, então o offset domina.
let clockSkewMs = 0;
const realDateNow = Date.now.bind(Date);
vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + clockSkewMs);
const advanceClock = (ms) => {
  clockSkewMs += ms;
};

const {
  __chatConversationsCacheTiming,
  __notificationsCacheTiming,
  __resetOperatorNotificationsCache,
  __resetWhatsappConversationsCache,
  createTestSpotNotifications,
  deleteOperatorNotifications,
  listOperatorNotifications,
  listWhatsappConversations,
  listWhatsappMessages,
  markAllNotificationsSeen,
  markNotificationsSeen,
  sendManualChatMessage,
} = await import("./admin.js");

const countSql = (re) => sqlLog.filter((sql) => re.test(sql)).length;
const NOTIF_SELECT = /FROM public\.operator_notifications\s+ORDER BY created_at DESC/;
const CONV_SELECT = /WITH last_msgs AS/;
const MSG_UPDATE = /UPDATE public\.whatsapp_messages/;

// TTLs de PRODUÇÃO (não números inventados de teste): é o valor real que precisa
// ser maior que o poll real.
const NOTIF_TTL = String(__notificationsCacheTiming.ttlMs);
const CONV_TTL = String(__chatConversationsCacheTiming.ttlMs);

/**
 * Lê o `refetchInterval` de um componente do front. Guarda anti-deriva: o TTL do
 * servidor só é útil enquanto for maior que o poll — se alguém mexer no poll sem
 * olhar o TTL, o cache volta a dar zero hit (o bug medido em produção).
 * O backend também roda isolado (imagem Docker só com backend/), então quando o
 * arquivo não existe o teste é pulado em vez de falhar.
 */
function readRefetchInterval(relPath) {
  try {
    const src = readFileSync(new URL(`../../../../${relPath}`, import.meta.url), "utf8");
    const m = src.match(/refetchInterval:\s*([\d_]+)/);
    return m ? Number(m[1].replace(/_/g, "")) : null;
  } catch {
    return undefined; // arquivo indisponível (checkout só do backend)
  }
}

async function seedNotification({ title, seen = false, createdAt }) {
  await query(
    `INSERT INTO public.operator_notifications (kind, title, body, metadata, seen, created_at)
     VALUES ('new_spot', $1, '', $2::jsonb, $3, $4)`,
    [title, JSON.stringify({ lh: `LT-${title}` }), seen, createdAt],
  );
}

async function seedMessage({ phone, direction = "in", text = "oi", status = "received", ts, driverKey = null }) {
  await query(
    `INSERT INTO public.whatsapp_messages (instance, direction, phone, driver_key, text, message_type, status, timestamp)
     VALUES ('cargas', $1, $2, $3, $4, 'text', $5, $6)`,
    [direction, phone, driverKey, text, status, ts],
  );
}

describe("driver-outreach admin — cache do sino e do chat (integração pg-mem)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    sqlLog.length = 0;
    releaseGate = null;
    clockSkewMs = 0;
    delete process.env.OPERATOR_NOTIFICATIONS_CACHE_TTL_MS;
    delete process.env.OPERATOR_CHAT_CONVERSATIONS_CACHE_TTL_MS;
    __resetOperatorNotificationsCache();
    __resetWhatsappConversationsCache();
  });

  afterAll(async () => {
    await closeTestDatabase();
    delete process.env.OPERATOR_NOTIFICATIONS_CACHE_TTL_MS;
    delete process.env.OPERATOR_CHAT_CONVERSATIONS_CACHE_TTL_MS;
  });

  // ── Sino ──────────────────────────────────────────────────────────────────
  it("sino: payload preservado (unseenCount + itens em created_at DESC, sem campo novo)", async () => {
    await seedNotification({ title: "a", seen: false, createdAt: "2026-07-30T10:00:00.000Z" });
    await seedNotification({ title: "b", seen: true, createdAt: "2026-07-30T11:00:00.000Z" });
    await seedNotification({ title: "c", seen: false, createdAt: "2026-07-30T12:00:00.000Z" });
    sqlLog.length = 0;

    const res = await listOperatorNotifications({});

    expect(res.unseenCount).toBe(2);
    expect(res.items.map((i) => i.title)).toEqual(["c", "b", "a"]);
    expect(Object.keys(res).sort()).toEqual(["items", "unseenCount"]);
    expect(Object.keys(res.items[0]).sort()).toEqual(
      ["body", "created_at", "id", "kind", "metadata", "seen", "seen_at", "title"],
    );
    // Custo de UMA execução: count + SELECT (o cache é quem corta as repetições).
    expect(countSql(/public\.operator_notifications/)).toBe(2);
  });

  it("sino: unseenCount é global (não é o count da janela do LIMIT)", async () => {
    await seedNotification({ title: "a", seen: false, createdAt: "2026-07-30T10:00:00.000Z" });
    await seedNotification({ title: "b", seen: false, createdAt: "2026-07-30T11:00:00.000Z" });
    await seedNotification({ title: "c", seen: false, createdAt: "2026-07-30T12:00:00.000Z" });

    const res = await listOperatorNotifications({ limit: 1 });

    expect(res.items.map((i) => i.title)).toEqual(["c"]);
    expect(res.unseenCount).toBe(3);
  });

  it("sino: tabela vazia devolve { unseenCount: 0, items: [] }", async () => {
    const res = await listOperatorNotifications({});
    expect(res).toEqual({ unseenCount: 0, items: [] });
  });

  it("sino: TTL de produção > poll do front (a relação que o cache exige para existir)", () => {
    const { ttlMs, pollMs } = __notificationsCacheTiming;
    // Sem isso o cache é decoração: no instante do poll seguinte a entrada já
    // expirou e TODA chamada vai ao banco (35/1091s medidos em produção).
    expect(ttlMs).toBeGreaterThan(pollMs);
    expect(ttlMs).toBeGreaterThanOrEqual(pollMs * 1.5); // margem p/ jitter (medido: 31s)
  });

  it("sino: o poll do front (30s) continua vindo do cache — dedupe na cadência REAL", async () => {
    const { pollMs } = __notificationsCacheTiming;
    process.env.OPERATOR_NOTIFICATIONS_CACHE_TTL_MS = NOTIF_TTL; // TTL de produção
    await seedNotification({ title: "a", seen: false, createdAt: "2026-07-30T10:00:00.000Z" });
    await seedNotification({ title: "b", seen: false, createdAt: "2026-07-30T11:00:00.000Z" });
    sqlLog.length = 0;

    const first = await listOperatorNotifications({});
    advanceClock(pollMs); // 30s depois: é ISTO que a tela faz, não duas chamadas coladas
    const second = await listOperatorNotifications({});

    expect(countSql(NOTIF_SELECT)).toBe(1); // o 2º poll NÃO foi ao banco
    expect(countSql(/public\.operator_notifications/)).toBe(2); // 2 queries no lugar de 4
    expect(second).toEqual(first);

    // E o dado não gruda para sempre: passado o TTL, o poll seguinte relê.
    advanceClock(pollMs); // t = 60s > TTL de 45s
    await listOperatorNotifications({});
    expect(countSql(NOTIF_SELECT)).toBe(2);

    // Limite diferente NÃO pode ser servido do cache (senão devolveria 2 itens
    // para quem pediu 1).
    const capped = await listOperatorNotifications({ limit: 1 });
    expect(countSql(NOTIF_SELECT)).toBe(3);
    expect(capped.items).toHaveLength(1);
  });

  it("sino: 6 polls de 30s (2,5 min de tela aberta) = 3 execuções, não 6", async () => {
    const { pollMs } = __notificationsCacheTiming;
    process.env.OPERATOR_NOTIFICATIONS_CACHE_TTL_MS = NOTIF_TTL;
    await seedNotification({ title: "a", seen: false, createdAt: "2026-07-30T10:00:00.000Z" });
    sqlLog.length = 0;

    const seen = [];
    for (let i = 0; i < 6; i += 1) {
      if (i > 0) advanceClock(pollMs);
      seen.push(await listOperatorNotifications({}));
    }

    // TTL 45s × poll 30s → miss/hit alternados: uma leitura a cada 60s.
    expect(countSql(NOTIF_SELECT)).toBe(3);
    expect(countSql(/public\.operator_notifications/)).toBe(6); // 6 queries no lugar de 12
    for (const payload of seen) expect(payload).toEqual(seen[0]);
  });

  it("sino: TTL ABAIXO do poll (o bug medido em produção: 15s × 30s) dá ZERO hit", async () => {
    // Guarda de regressão do defeito real: com o TTL antigo, os mesmos 6 polls
    // custam 6 execuções — o cache não serve NADA. É por isso que o TTL não pode
    // voltar a ser "metade do poll".
    process.env.OPERATOR_NOTIFICATIONS_CACHE_TTL_MS = "15000";
    await seedNotification({ title: "a", seen: false, createdAt: "2026-07-30T10:00:00.000Z" });
    sqlLog.length = 0;

    for (let i = 0; i < 6; i += 1) {
      if (i > 0) advanceClock(__notificationsCacheTiming.pollMs);
      await listOperatorNotifications({});
    }

    expect(countSql(NOTIF_SELECT)).toBe(6);
  });

  it("sino: o poll do front é o que o TTL do servidor assume (guarda anti-deriva)", () => {
    const front = readRefetchInterval("frontend/src/components/operator/NotificationsBell.tsx");
    if (front === undefined) return; // front fora do checkout
    expect(front).toBe(__notificationsCacheTiming.pollMs);
    expect(__notificationsCacheTiming.ttlMs).toBeGreaterThan(front);
  });

  it("sino: single-flight colapsa polls concorrentes em uma query", async () => {
    process.env.OPERATOR_NOTIFICATIONS_CACHE_TTL_MS = NOTIF_TTL;
    await seedNotification({ title: "a", seen: false, createdAt: "2026-07-30T10:00:00.000Z" });
    sqlLog.length = 0;

    const [a, b, c] = await Promise.all([
      listOperatorNotifications({}),
      listOperatorNotifications({}),
      listOperatorNotifications({}),
    ]);

    expect(countSql(NOTIF_SELECT)).toBe(1);
    expect(countSql(/public\.operator_notifications/)).toBe(2); // 2 no lugar de 6
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("sino: marcar visto / limpar / criar invalidam o cache na hora", async () => {
    process.env.OPERATOR_NOTIFICATIONS_CACHE_TTL_MS = NOTIF_TTL;
    await seedNotification({ title: "a", seen: false, createdAt: "2026-07-30T10:00:00.000Z" });
    await seedNotification({ title: "b", seen: false, createdAt: "2026-07-30T11:00:00.000Z" });

    expect((await listOperatorNotifications({})).unseenCount).toBe(2);

    const { rows } = await query(`SELECT id FROM public.operator_notifications ORDER BY created_at ASC`);
    await markNotificationsSeen([rows[0].id]);
    expect((await listOperatorNotifications({})).unseenCount).toBe(1);

    await markAllNotificationsSeen();
    expect((await listOperatorNotifications({})).unseenCount).toBe(0);

    await createTestSpotNotifications({ count: 1 });
    const withTest = await listOperatorNotifications({});
    expect(withTest.items).toHaveLength(3);
    expect(withTest.unseenCount).toBe(1);

    await deleteOperatorNotifications({ all: true });
    expect(await listOperatorNotifications({})).toEqual({ unseenCount: 0, items: [] });
  });

  it("sino: leitura iniciada antes da mutação não repovoa o cache (epoch)", async () => {
    process.env.OPERATOR_NOTIFICATIONS_CACHE_TTL_MS = NOTIF_TTL;
    await seedNotification({ title: "a", seen: false, createdAt: "2026-07-30T10:00:00.000Z" });

    let release;
    releaseGate = { pattern: NOTIF_SELECT, promise: new Promise((r) => { release = r; }) };
    const pending = listOperatorNotifications({}); // já leu as linhas, não resolveu
    await markAllNotificationsSeen(); // mutação no meio do voo
    release();

    // A leitura devolve o que leu (pré-mutação) — igual ao comportamento sem cache.
    expect((await pending).unseenCount).toBe(1);
    // Mas isso NÃO ficou grudado no cache: o próximo poll vê o estado real.
    expect((await listOperatorNotifications({})).unseenCount).toBe(0);
  });

  // ── Chat: lista de conversas ───────────────────────────────────────────────
  it("chat: lista de conversas mantém última mensagem, não lidas e nome do motorista", async () => {
    await seedMotoristaHistorico({ cpf: "12345678901", nome: "João Teste" });
    await seedMessage({ phone: "5511111111111", direction: "in", text: "oi", ts: "2026-07-30T10:00:00.000Z", driverKey: "12345678901" });
    await seedMessage({ phone: "5511111111111", direction: "out", text: "bom dia", status: "sent", ts: "2026-07-30T10:05:00.000Z", driverKey: "12345678901" });
    await seedMessage({ phone: "5522222222222", direction: "in", text: "tem carga?", ts: "2026-07-30T11:00:00.000Z" });
    sqlLog.length = 0;

    const res = await listWhatsappConversations({});

    expect(res.items.map((i) => i.phone)).toEqual(["5522222222222", "5511111111111"]);
    expect(res.items[0].last_text).toBe("tem carga?");
    expect(Number(res.items[0].unread_count)).toBe(1);
    expect(res.items[1].last_text).toBe("bom dia");
    expect(Number(res.items[1].unread_count)).toBe(1); // a IN antiga segue não lida
    expect(res.items[1].driver_name).toBe("João Teste");
    expect(countSql(CONV_SELECT)).toBe(1);
  });

  it("chat: TTL de produção > poll do ChatPanel (relação obrigatória + guarda anti-deriva)", () => {
    const { ttlMs, pollMs } = __chatConversationsCacheTiming;
    expect(ttlMs).toBeGreaterThan(pollMs);
    const front = readRefetchInterval("frontend/src/components/operator/ChatPanel.tsx");
    if (front === undefined) return; // front fora do checkout
    expect(front).toBe(pollMs); // primeiro refetchInterval do arquivo = lista de conversas
    expect(ttlMs).toBeGreaterThan(front);
  });

  it("chat: o poll de 20s vem do cache; LIMIT entra na chave e busca não é cacheada", async () => {
    const { pollMs } = __chatConversationsCacheTiming;
    process.env.OPERATOR_CHAT_CONVERSATIONS_CACHE_TTL_MS = CONV_TTL; // TTL de produção
    await seedMessage({ phone: "5511111111111", ts: "2026-07-30T10:00:00.000Z" });
    await seedMessage({ phone: "5522222222222", ts: "2026-07-30T11:00:00.000Z" });
    sqlLog.length = 0;

    const first = await listWhatsappConversations({});
    advanceClock(pollMs); // 20s — cadência real do painel
    const second = await listWhatsappConversations({});
    expect(countSql(CONV_SELECT)).toBe(1);
    expect(second).toEqual(first);
    expect(first.items).toHaveLength(2);

    advanceClock(pollMs); // t = 40s, ainda dentro do TTL de 45s
    const [a, b] = await Promise.all([listWhatsappConversations({}), listWhatsappConversations({})]);
    expect(countSql(CONV_SELECT)).toBe(1);
    expect(a).toEqual(b);

    // Limite diferente vai ao banco (senão entregaria 2 itens a quem pediu 1).
    const capped = await listWhatsappConversations({ limit: 1 });
    expect(countSql(CONV_SELECT)).toBe(2);
    expect(capped.items).toHaveLength(1);

    // Busca é digitada (nunca faz poll) → sempre ao banco, nunca do cache.
    await listWhatsappConversations({ search: "5522" });
    await listWhatsappConversations({ search: "5522" });
    expect(countSql(CONV_SELECT)).toBe(4);
  });

  it("chat: 6 polls de 20s (2 min com a aba aberta) = 2 execuções, não 6", async () => {
    const { pollMs } = __chatConversationsCacheTiming;
    process.env.OPERATOR_CHAT_CONVERSATIONS_CACHE_TTL_MS = CONV_TTL;
    await seedMessage({ phone: "5511111111111", ts: "2026-07-30T10:00:00.000Z" });
    sqlLog.length = 0;

    const seen = [];
    for (let i = 0; i < 6; i += 1) {
      if (i > 0) advanceClock(pollMs);
      seen.push(await listWhatsappConversations({}));
    }

    // TTL 45s × poll 20s → hit,hit,miss: uma leitura a cada 60s (t=0 e t=60).
    expect(countSql(CONV_SELECT)).toBe(2);
    for (const payload of seen) expect(payload).toEqual(seen[0]);
  });

  it("chat: TTL ABAIXO do poll (10s × 20s, o valor antigo) dá ZERO hit", async () => {
    process.env.OPERATOR_CHAT_CONVERSATIONS_CACHE_TTL_MS = "10000";
    await seedMessage({ phone: "5511111111111", ts: "2026-07-30T10:00:00.000Z" });
    sqlLog.length = 0;

    for (let i = 0; i < 6; i += 1) {
      if (i > 0) advanceClock(__chatConversationsCacheTiming.pollMs);
      await listWhatsappConversations({});
    }

    expect(countSql(CONV_SELECT)).toBe(6);
  });

  it("chat: single-flight colapsa duas listagens concorrentes em uma query", async () => {
    process.env.OPERATOR_CHAT_CONVERSATIONS_CACHE_TTL_MS = CONV_TTL;
    await seedMessage({ phone: "5511111111111", ts: "2026-07-30T10:00:00.000Z" });
    sqlLog.length = 0;

    const [a, b] = await Promise.all([listWhatsappConversations({}), listWhatsappConversations({})]);

    expect(countSql(CONV_SELECT)).toBe(1);
    expect(a).toEqual(b);
  });

  // ── Chat: mensagens de uma conversa ────────────────────────────────────────
  it("chat: não reescreve status quando a conversa já está toda lida (poll de 8s)", async () => {
    const phone = "5511111111111";
    await seedMessage({ phone, direction: "in", text: "oi", ts: "2026-07-30T10:00:00.000Z" });
    await seedMessage({ phone, direction: "out", text: "opa", status: "sent", ts: "2026-07-30T10:01:00.000Z" });
    await seedMessage({ phone, direction: "in", text: "tem carga?", ts: "2026-07-30T10:02:00.000Z" });
    sqlLog.length = 0;

    const first = await listWhatsappMessages({ phone });
    expect(first.items.map((i) => i.text)).toEqual(["oi", "opa", "tem carga?"]);
    // Comportamento preservado: as linhas devolvidas trazem o status ANTES da
    // marcação (a marcação vale para o próximo fetch).
    expect(first.items.filter((i) => i.direction === "in").map((i) => i.status)).toEqual([
      "received",
      "received",
    ]);
    expect(countSql(MSG_UPDATE)).toBe(1);

    const second = await listWhatsappMessages({ phone });
    expect(second.items).toHaveLength(3);
    expect(second.items.filter((i) => i.direction === "in").every((i) => i.status === "read")).toBe(true);
    expect(countSql(MSG_UPDATE)).toBe(1); // nada por marcar → nenhum write novo

    await listWhatsappMessages({ phone });
    expect(countSql(MSG_UPDATE)).toBe(1);
  });

  it("chat: janela truncada ainda marca as lidas (as não lidas são as MAIS NOVAS)", async () => {
    const phone = "5511111111111";
    await seedMessage({ phone, direction: "in", text: "v1", status: "read", ts: "2026-07-30T10:00:00.000Z" });
    await seedMessage({ phone, direction: "in", text: "v2", status: "read", ts: "2026-07-30T10:01:00.000Z" });
    await seedMessage({ phone, direction: "in", text: "nova", status: "received", ts: "2026-07-30T10:02:00.000Z" });
    sqlLog.length = 0;

    const res = await listWhatsappMessages({ phone, limit: 2 });

    expect(res.items.map((i) => i.text)).toEqual(["v1", "v2"]); // janela = mais ANTIGAS
    expect(countSql(MSG_UPDATE)).toBe(1); // roda mesmo sem não lida na janela
    const { rows } = await query(
      `SELECT status FROM public.whatsapp_messages WHERE phone = $1 AND text = 'nova'`,
      [phone],
    );
    expect(rows[0].status).toBe("read");
  });

  it("chat: marcar como lida invalida a lista de conversas (badge zera na hora)", async () => {
    process.env.OPERATOR_CHAT_CONVERSATIONS_CACHE_TTL_MS = CONV_TTL;
    const phone = "5511111111111";
    await seedMessage({ phone, direction: "in", text: "oi", ts: "2026-07-30T10:00:00.000Z" });
    sqlLog.length = 0;

    expect(Number((await listWhatsappConversations({})).items[0].unread_count)).toBe(1);
    expect(countSql(CONV_SELECT)).toBe(1);

    await listWhatsappMessages({ phone }); // marca como lida → busta o cache

    const after = await listWhatsappConversations({});
    expect(countSql(CONV_SELECT)).toBe(2);
    expect(Number(after.items[0].unread_count)).toBe(0);
  });

  it("chat: envio manual invalida a lista de conversas", async () => {
    process.env.OPERATOR_CHAT_CONVERSATIONS_CACHE_TTL_MS = CONV_TTL;
    process.env.EVOLUTION_API_TOKEN = "token-de-teste";
    try {
      const phone = "5511111111111";
      await seedMessage({ phone, direction: "in", text: "oi", ts: "2026-07-30T10:00:00.000Z" });
      sqlLog.length = 0;

      await listWhatsappConversations({});
      expect(countSql(CONV_SELECT)).toBe(1);

      await sendManualChatMessage({ phone, text: "resposta do operador" });

      await listWhatsappConversations({});
      expect(countSql(CONV_SELECT)).toBe(2);
    } finally {
      delete process.env.EVOLUTION_API_TOKEN;
    }
  });
});
