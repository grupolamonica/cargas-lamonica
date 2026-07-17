/**
 * driver-outreach — persistência de mensagens WhatsApp (IN/OUT) para o chat do
 * operador. Aceita eventos do Evolution (messages.upsert) e envios internos
 * (mensagem OUT registrada pelo próprio backend após sendWhatsappText).
 *
 * Dedupe por (instance, external_id) — o Evolution reenvia webhooks em retry.
 */

import { withPgClient } from "../../infrastructure/pg/postgres.js";

const onlyDigits = (v) => String(v || "").replace(/\D/g, "");

/**
 * Extrai o telefone (dígitos) do remoteJid do Evolution/Baileys.
 * Só aceita formatos com telefone REAL:
 *   - "5571988887777@s.whatsapp.net"  (individual)
 *   - "5571988887777@c.us"            (individual, legado)
 * Descarta: "@g.us" (grupo), "@lid" (Linked ID / número oculto do WhatsApp
 * Business — NÃO é telefone), "@newsletter", "@broadcast". Retorna "" se
 * o número não é resolvível.
 */
export function phoneFromRemoteJid(remoteJid) {
  const raw = String(remoteJid || "");
  if (!raw) return "";
  const at = raw.indexOf("@");
  const suffix = at >= 0 ? raw.slice(at + 1).toLowerCase() : "";
  // Só aceita sufixos de número individual.
  if (suffix && !["s.whatsapp.net", "c.us"].includes(suffix)) return "";
  const digits = onlyDigits(raw.split("@")[0] || "");
  return digits.length >= 10 ? digits : "";
}

/** Texto de uma mensagem Baileys (conversation | extendedTextMessage | etc.). */
export function extractMessageText(m = {}) {
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.buttonsResponseMessage?.selectedDisplayText ||
    m?.listResponseMessage?.title ||
    ""
  );
}

/**
 * Classifica o tipo da mensagem quando não tem texto útil.
 * Retorna 'audio' | 'image' | 'video' | 'sticker' | 'document' | 'location' | 'unknown'.
 */
export function classifyMessageType(m = {}) {
  const msg = m?.message || m;
  if (msg?.audioMessage || msg?.pttMessage) return "audio";
  if (msg?.imageMessage) return "image";
  if (msg?.videoMessage) return "video";
  if (msg?.stickerMessage) return "sticker";
  if (msg?.documentMessage || msg?.documentWithCaptionMessage) return "document";
  if (msg?.locationMessage) return "location";
  return "unknown";
}

/** Resolve driver_key (CPF em dígitos) a partir do telefone via motoristas_historico. */
async function resolveDriverKeyByPhone(client, phone) {
  if (!phone) return null;
  try {
    // motoristas_historico armazena telefone SEM DDI; tentamos o número completo e
    // também sem o "55" para maximizar hits.
    const candidates = [phone];
    if (phone.startsWith("55") && phone.length >= 12) candidates.push(phone.slice(2));
    const { rows } = await client.query(
      `SELECT cpf FROM public.motoristas_historico
        WHERE regexp_replace(coalesce(telefone,''),'\\D','','g') = ANY($1::text[])
        LIMIT 1`,
      [candidates],
    );
    return rows[0]?.cpf || null;
  } catch {
    return null;
  }
}

/**
 * Persiste uma mensagem (IN ou OUT) no chat. Idempotente por
 * (instance, external_id): se o Evolution reenviar o webhook, não duplica.
 * Retorna a linha (inclusive `id`), ou null se foi duplicata.
 */
export async function saveWhatsappMessage(client, msg = {}) {
  const {
    instance,
    direction,
    externalId,
    phone,
    driverKey = null,
    text = "",
    messageType = "text",
    status,
    timestamp,
    raw = {},
  } = msg;
  if (!instance || !direction || !phone) return null;
  const finalStatus = status || (direction === "in" ? "received" : "sent");
  const ts = timestamp instanceof Date ? timestamp : timestamp ? new Date(timestamp) : new Date();
  const validTs = Number.isNaN(ts.getTime()) ? new Date() : ts;

  // Resolve driver_key se não veio explícito.
  let resolvedDriverKey = driverKey;
  if (!resolvedDriverKey) resolvedDriverKey = await resolveDriverKeyByPhone(client, phone);

  // Dedupe manual para external_id presente — o índice UNIQUE é parcial
  // (WHERE external_id IS NOT NULL), e Postgres não aceita ON CONFLICT sobre
  // índice parcial. Fazemos SELECT antes; se já existe, retorna null.
  if (externalId) {
    const { rows: exists } = await client.query(
      `SELECT id FROM public.whatsapp_messages WHERE instance = $1 AND external_id = $2 LIMIT 1`,
      [instance, externalId],
    );
    if (exists.length) return null;
  }

  const { rows } = await client.query(
    `INSERT INTO public.whatsapp_messages
       (instance, direction, external_id, phone, driver_key, text, message_type, status, timestamp, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING id, phone, driver_key, direction, text, timestamp`,
    [
      instance,
      direction,
      externalId || null,
      phone,
      resolvedDriverKey,
      String(text || "").slice(0, 4000),
      messageType,
      finalStatus,
      validTs.toISOString(),
      JSON.stringify(raw || {}),
    ],
  );
  return rows[0] || null;
}

/** Wrapper `withPgClient` — usado pelo webhook e pelo evolution-client. */
export async function saveWhatsappMessageStandalone(msg) {
  return withPgClient((client) => saveWhatsappMessage(client, msg));
}

/**
 * Extrai um array de mensagens {external_id, phone, direction, text, ts, raw}
 * de um payload messages.upsert do Evolution v2. O payload pode vir com uma
 * única mensagem em `data` ou com um array em `data.messages`. Ignora grupos e
 * mensagens sem texto útil.
 */
/**
 * Resolve o telefone da mensagem: tenta remoteJid; se for @lid (oculto),
 * tenta campos alternativos que o Evolution v2 passou a incluir:
 *   - key.senderPn         (participant phone number)
 *   - key.remoteJidAlt     (número real quando remoteJid é LID)
 *   - key.previousRemoteJid (fallback histórico)
 * Retorna { phone, unresolvedLid } — quando é LID e não achamos alternativo,
 * `unresolvedLid` é a string do LID para a notificação do operador.
 */
export function resolveMessagePhone(m = {}) {
  const key = m?.key || {};
  const jid = String(key.remoteJid || m?.remoteJid || "");
  const primary = phoneFromRemoteJid(jid);
  if (primary) return { phone: primary, unresolvedLid: null };
  // Se remoteJid é LID (número oculto), procurar alternativas.
  if (jid.endsWith("@lid")) {
    for (const alt of [key.senderPn, key.remoteJidAlt, key.previousRemoteJid, m?.remoteJidAlt]) {
      const p = phoneFromRemoteJid(alt);
      if (p) return { phone: p, unresolvedLid: null };
    }
    return { phone: "", unresolvedLid: jid };
  }
  return { phone: "", unresolvedLid: null };
}

export function parseUpsertPayload(body) {
  const arr = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.data?.messages)
    ? body.data.messages
    : body?.data
    ? [body.data]
    : [];
  const instance = body?.instance || body?.instanceName || body?.data?.instance || "";
  const out = [];
  const unresolved = [];
  for (const m of arr) {
    const key = m?.key || {};
    const { phone, unresolvedLid } = resolveMessagePhone(m);
    const text = extractMessageText(m?.message || m);
    // Se não tem texto, classifica (áudio, imagem…). Vamos guardar mesmo assim
    // — o motorista mandou algo e precisa de resposta.
    const nonTextType = text ? null : classifyMessageType(m);
    if (!phone) {
      if (unresolvedLid && (text || nonTextType)) {
        unresolved.push({
          lid: unresolvedLid,
          text: text || `(${nonTextType || "sem texto"})`,
          pushName: m?.pushName || null,
        });
      }
      continue;
    }
    const fromMe = Boolean(key.fromMe);
    out.push({
      instance,
      direction: fromMe ? "out" : "in",
      externalId: key.id || null,
      phone,
      // Placeholder textual quando é mídia sem legenda — vira o "texto" no chat
      // do operador. O `messageType` guarda a categoria real.
      text: text || (nonTextType ? `[${nonTextType}]` : ""),
      messageType: nonTextType || m?.messageType || "text",
      timestamp: m?.messageTimestamp
        ? new Date(Number(m.messageTimestamp) * 1000)
        : m?.date_time
        ? new Date(m.date_time)
        : new Date(),
      raw: m,
    });
  }
  return { items: out, unresolved };
}
