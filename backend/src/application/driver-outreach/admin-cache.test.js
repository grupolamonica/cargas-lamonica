/**
 * Cache do sino (operator_notifications) + do chat (whatsapp_messages).
 *
 * Prova as DUAS coisas que importam nesta mudança de performance:
 *  - redução de queries/round trips no banco (proxy direto do egress do pooler):
 *    contamos o SQL realmente executado envolvendo o client do pg-mem;
 *  - preservação de comportamento: mesmo payload, mesma ordem, mesmos contadores,
 *    read-your-write nas mutações e nenhum campo novo no payload.
 */
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

const {
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

  it("sino: TTL colapsa polls repetidos e a chave inclui o LIMIT efetivo", async () => {
    process.env.OPERATOR_NOTIFICATIONS_CACHE_TTL_MS = "5000";
    await seedNotification({ title: "a", seen: false, createdAt: "2026-07-30T10:00:00.000Z" });
    await seedNotification({ title: "b", seen: false, createdAt: "2026-07-30T11:00:00.000Z" });
    sqlLog.length = 0;

    const first = await listOperatorNotifications({});
    const second = await listOperatorNotifications({});
    expect(countSql(NOTIF_SELECT)).toBe(1); // 2º poll não foi ao banco
    expect(countSql(/public\.operator_notifications/)).toBe(2); // 2 queries no lugar de 4
    expect(second).toEqual(first);

    // Limite diferente NÃO pode ser servido do cache (senão devolveria 2 itens
    // para quem pediu 1).
    const capped = await listOperatorNotifications({ limit: 1 });
    expect(countSql(NOTIF_SELECT)).toBe(2);
    expect(capped.items).toHaveLength(1);
  });

  it("sino: single-flight colapsa polls concorrentes em uma query", async () => {
    process.env.OPERATOR_NOTIFICATIONS_CACHE_TTL_MS = "5000";
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
    process.env.OPERATOR_NOTIFICATIONS_CACHE_TTL_MS = "5000";
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
    process.env.OPERATOR_NOTIFICATIONS_CACHE_TTL_MS = "5000";
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

  it("chat: TTL + single-flight colapsam o poll de 20s; LIMIT entra na chave e busca não é cacheada", async () => {
    process.env.OPERATOR_CHAT_CONVERSATIONS_CACHE_TTL_MS = "5000";
    await seedMessage({ phone: "5511111111111", ts: "2026-07-30T10:00:00.000Z" });
    await seedMessage({ phone: "5522222222222", ts: "2026-07-30T11:00:00.000Z" });
    sqlLog.length = 0;

    const first = await listWhatsappConversations({});
    const second = await listWhatsappConversations({});
    expect(countSql(CONV_SELECT)).toBe(1);
    expect(second).toEqual(first);
    expect(first.items).toHaveLength(2);

    const [a, b] = await Promise.all([listWhatsappConversations({}), listWhatsappConversations({})]);
    expect(countSql(CONV_SELECT)).toBe(1); // ainda no TTL
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

  it("chat: single-flight colapsa duas listagens concorrentes em uma query", async () => {
    process.env.OPERATOR_CHAT_CONVERSATIONS_CACHE_TTL_MS = "5000";
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
    process.env.OPERATOR_CHAT_CONVERSATIONS_CACHE_TTL_MS = "5000";
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
    process.env.OPERATOR_CHAT_CONVERSATIONS_CACHE_TTL_MS = "5000";
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
