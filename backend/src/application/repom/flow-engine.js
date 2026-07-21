/**
 * Repom — motor de fluxo v1 do cadastro de motorista via WhatsApp (Fase 3a).
 *
 * Fluxo CODIFICADO (o editor visual da Fase 5 vai substituir): saudação →
 * pede CPF → deduplica (entidade única por CPF — PRD §7) → responde pelo caso
 * e avança para ask_cnh (a leitura da CNH/mídia chega na Fase 3b).
 *
 * Guardrails:
 *  - Flag `repom_flow_enabled` em app_settings, DEFAULT OFF — desligada, o
 *    motor não responde nada (mensagem fica só registrada no chat).
 *  - 100% REATIVO: só responde a mensagem recebida no número do Repom; nunca
 *    inicia conversa (baixo risco de ban).
 *  - Falha de envio → notificação ao operador (motorista nunca fica no vácuo
 *    sem ninguém saber).
 *  - Estado por telefone/CPF em repom_flow_sessions → retomar de onde parou
 *    (PRD §18).
 */

import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { getMediaBase64, getRepomInstance, sendWhatsappText } from "../../infrastructure/whatsapp/evolution-client.js";
import { ensureAppSettingsTable } from "../operator-admin/use-cases/angellira/auto-approve-vigentes.js";
import { canAgentAssist, orientarMotorista, tryReserveAgentCall } from "./agent-orientador.js";
import { evaluateCnhExtraction } from "./cnh-gates.js";
import { claimMessageOnce, stageCnhMedia, stageRepomMedia, tryReserveCnhCall } from "./cnh-media.js";
import { buildMotoristaFromCnhFields, renderObservacoes, upsertPendingCnh } from "./cnh-registration.js";
import { resolveCpfDedup } from "./dedup-cpf.js";
import { extractCnhFromMedia } from "./ocr-sidecar-client.js";
import { proximoPasso } from "./repom-flow.js";

const SETTING_KEY = "repom_flow_enabled";
const CNH_OCR_SETTING_KEY = "repom_cnh_ocr_enabled";
const CONTINUACAO_SETTING_KEY = "repom_continuacao_enabled";

// Anti-loop: após N tentativas frustradas no mesmo passo, avisa o operador (uma
// vez) — mas o bot segue PASSIVO (continua respondendo o pedido; não desiste).
const MAX_COLETA_FALHAS = 3;

const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");

/** Normaliza o JSONB `variables` (objeto no pg; pode vir string em alguns drivers). */
function asObj(v) {
  if (v && typeof v === "object") return v;
  if (typeof v === "string" && v.trim()) {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return {};
}

// Mensagens v1 (hardcoded; o editor visual da Fase 5 tornará configurável).
const MSG = {
  greeting:
    "Olá! 👋 Aqui é o cadastro de motoristas da *Lamônica Cargas*.\n" +
    "Vou te guiar passo a passo — leva poucos minutos.\n\n" +
    "Pra começar, me envia o seu *CPF* (só os números).",
  invalidCpf:
    "Hmm, não consegui identificar o CPF. 🤔\n" +
    "Me envia só os *11 números* do CPF, por favor (ex.: 12345678901).",
  createNew:
    "Perfeito! ✅ CPF recebido.\n\n" +
    "📷 Agora me envia uma *foto da sua CNH* (frente, aberta, bem iluminada).",
  resumeExisting:
    "Achei seu cadastro em andamento por aqui. 👍 Vamos continuar de onde parou.\n\n" +
    "📷 Me envia uma *foto da sua CNH* (frente, aberta, bem iluminada).",
  reopenRejected:
    "Encontrei um cadastro anterior seu que não foi aprovado. Sem problema — vamos corrigir juntos. 💪\n\n" +
    "📷 Me envia uma *foto da sua CNH* (frente, aberta, bem iluminada).",
  alreadyRegistered:
    "Boa notícia: você *já está cadastrado* com a gente! ✅\n" +
    "Não precisa fazer nada. Qualquer dúvida, é só chamar por aqui.",
  cnhParked:
    "Recebido! 🙌 A leitura automática da CNH está sendo ativada — em breve continuo seu cadastro por aqui.\n" +
    "Se preferir, um operador também pode te atender neste número.",
  cnhReceived:
    "Recebi sua CNH! ✅ Nossa equipe vai conferir os dados e continuar o seu cadastro.\n" +
    "Te aviso por aqui assim que tiver novidade. 🙌",
  cnhUnreadable:
    "Recebi o arquivo, mas não consegui ler os dados da CNH. 🤔\n" +
    "Pode reenviar uma *foto da frente da CNH, aberta e bem iluminada* (ou o PDF)?",
  cnhNotACnh:
    "Hmm, isso não parece ser uma CNH. 🤔\n" +
    "Me envia a *foto da sua CNH* (frente, aberta, bem iluminada), por favor.",
  cnhDownloadFailed:
    "Não consegui baixar o arquivo agora. 😕 Pode reenviar a *foto da sua CNH*, por favor?",
  cnhAskPhoto:
    "Pra continuar preciso de uma *foto* ou *PDF* da sua CNH (frente, aberta, bem iluminada). Pode enviar?",
  cnhBusy:
    "Recebi! 🙌 Já estou processando seu documento — só um instante, por favor.",
  coletaConcluida:
    "Prontinho! ✅ Recebi todos os seus documentos e dados.\n" +
    "Nossa equipe vai conferir e finalizar o seu cadastro. Te aviso por aqui assim que tiver novidade. 🙌",
  telefoneInvalido:
    "Não consegui entender o telefone. 🤔\n" +
    "Me manda um número *com DDD* (ex.: (71) 99999-8888).",
};

// Tipos de mensagem que tratamos como "documento da CNH" (foto ou PDF).
const CNH_MEDIA_TYPES = new Set(["image", "document"]);

/** Lê a flag do motor (default OFF). */
export async function isRepomFlowEnabled(client) {
  await ensureAppSettingsTable(client);
  const { rows } = await client.query(`SELECT value FROM public.app_settings WHERE key = $1`, [SETTING_KEY]);
  return Boolean(rows[0]?.value?.enabled);
}

/** Liga/desliga o motor (para a UI/operacional; reversível). */
export async function setRepomFlowEnabled({ enabled, actorId = null }) {
  return withPgClient(async (client) => {
    await ensureAppSettingsTable(client);
    await client.query(
      `INSERT INTO public.app_settings (key, value, updated_by)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [SETTING_KEY, JSON.stringify({ enabled: Boolean(enabled) }), actorId],
    );
    return { enabled: Boolean(enabled) };
  });
}

/** Lê a flag do OCR de CNH (Fase 3b; default OFF). */
export async function isRepomCnhOcrEnabled(client) {
  await ensureAppSettingsTable(client);
  const { rows } = await client.query(`SELECT value FROM public.app_settings WHERE key = $1`, [CNH_OCR_SETTING_KEY]);
  return Boolean(rows[0]?.value?.enabled);
}

/** Liga/desliga o processamento automático da CNH (OCR→cadastro); reversível. */
export async function setRepomCnhOcrEnabled({ enabled, actorId = null }) {
  return withPgClient(async (client) => {
    await ensureAppSettingsTable(client);
    await client.query(
      `INSERT INTO public.app_settings (key, value, updated_by)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [CNH_OCR_SETTING_KEY, JSON.stringify({ enabled: Boolean(enabled) }), actorId],
    );
    return { enabled: Boolean(enabled) };
  });
}

/** Lê a flag da continuação da coleta (Fase 3d; default OFF). */
export async function isRepomContinuacaoEnabled(client) {
  await ensureAppSettingsTable(client);
  const { rows } = await client.query(`SELECT value FROM public.app_settings WHERE key = $1`, [CONTINUACAO_SETTING_KEY]);
  return Boolean(rows[0]?.value?.enabled);
}

/** Liga/desliga a continuação da coleta (selfie→comprovante→telefone); reversível. */
export async function setRepomContinuacaoEnabled({ enabled, actorId = null }) {
  return withPgClient(async (client) => {
    await ensureAppSettingsTable(client);
    await client.query(
      `INSERT INTO public.app_settings (key, value, updated_by)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [CONTINUACAO_SETTING_KEY, JSON.stringify({ enabled: Boolean(enabled) }), actorId],
    );
    return { enabled: Boolean(enabled) };
  });
}

/** Extrai um CPF (11 dígitos) de texto livre; null se não achar. */
export function extractCpfFromText(text) {
  const digits = String(text || "").replace(/\D/g, "");
  return digits.length === 11 ? digits : null;
}

/** Envia pelo número do REPOM com fallback → notificação ao operador. */
async function replyRepom(client, { phone, text, correlationId }) {
  try {
    await sendWhatsappText({ to: phone, text, correlationId, instance: getRepomInstance() });
    return { ok: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[repom.flow] ${correlationId} send failed:`, errMsg);
    try {
      await client.query(
        `INSERT INTO public.operator_notifications (kind, title, body, metadata)
         VALUES ('reply_send_failed', $1, $2, $3::jsonb)`,
        [
          "Falha ao responder motorista (cadastro Repom)",
          `Não consegui entregar a resposta do cadastro. Motorista aguardando: ${errMsg.slice(0, 200)}`,
          JSON.stringify({ phone, correlation_id: correlationId, error: errMsg, source: "repom-flow" }),
        ],
      );
    } catch {
      // best-effort
    }
    return { ok: false };
  }
}

/**
 * Responde ao motorista no nó atual. Se o agente orientador (Fase 3c) puder
 * atuar (agente ON + chave presente), tenta gerar uma resposta contextual pra
 * quem fugiu do roteiro; QUALQUER falha — ou agente desligado — cai na mensagem
 * fixa determinística. O agente só troca o TEXTO da resposta: nunca decide o
 * estado do fluxo (quem valida CPF e avança nós é sempre o motor).
 */
async function replyForNode(client, { phone, node, driverText, messageType = "text", fallbackText, correlationId }) {
  let text = fallbackText;
  try {
    // Só aciona o agente quando o motorista mandou TEXTO de verdade. Mídia vem
    // com placeholder "[image]"/"[document]" no texto (messageType != 'text') —
    // NÃO é texto, então não gasta chamada de LLM à toa (idêntico ao pré-agente).
    const hasText = messageType === "text" && Boolean(driverText && String(driverText).trim());
    if (hasText && (await canAgentAssist(client)) && tryReserveAgentCall(phone)) {
      const r = await orientarMotorista({ node, driverText, correlationId });
      if (r?.text) text = r.text;
    }
  } catch (err) {
    // Degradação graciosa: mantém a mensagem fixa (fluxo idêntico ao sem agente).
    console.warn(`[repom.flow] ${correlationId} agent fallback:`, err instanceof Error ? err.message : String(err));
    text = fallbackText;
  }
  return replyRepom(client, { phone, text, correlationId });
}

async function loadActiveSession(client, phone) {
  const { rows } = await client.query(
    `SELECT id, cpf, current_node, variables, status, registration_id
       FROM public.repom_flow_sessions
      WHERE phone = $1 AND status = 'active'
      LIMIT 1`,
    [phone],
  );
  return rows[0] || null;
}

/** Marca a sessão como submetida/encerrada e confirma o recebimento (passivo). */
async function finishCnh(client, { session, phone, correlationId }) {
  await client.query(
    `UPDATE public.repom_flow_sessions SET current_node = 'submitted', status = 'done', updated_at = now() WHERE id = $1`,
    [session.id],
  );
  await replyRepom(client, { phone, text: MSG.cnhReceived, correlationId });
}

// ─── Fase 3d — continuação da coleta (selfie → comprovante → telefone) ──────────
// A CNH continua sendo o backbone; aqui, com a flag `repom_continuacao_enabled`
// ON, o bot segue pedindo os docs/dados que faltam, na ordem da spec (repom-flow),
// SEMPRE derivando o próximo passo do `dados.motorista` persistido (fonte da
// verdade) — nunca de um estado paralelo que possa divergir. Passivo: só responde.

/** Lê o `dados.motorista` já persistido no pending (fonte da verdade do progresso). */
async function loadPendingMotorista(client, { registrationId, cpf }) {
  const digits = onlyDigits(cpf);
  let row = null;
  if (registrationId) {
    const r = await client.query(`SELECT id, dados FROM public.pending_driver_registrations WHERE id = $1`, [registrationId]);
    row = r.rows[0] || null;
  }
  if (!row) {
    const r = await client.query(
      `SELECT id, dados FROM public.pending_driver_registrations WHERE id_cadastro = $1 LIMIT 1`,
      [`repom-${digits}`],
    );
    row = r.rows[0] || null;
  }
  const dados = row?.dados && typeof row.dados === "object" ? row.dados : {};
  return { rowId: row?.id || null, motorista: dados.motorista || { cpf: digits } };
}

/** Encerra a coleta COMPLETA (todos os passos satisfeitos): confirma e fecha a sessão. */
async function finishColetaCompleta(client, { session, phone, correlationId }) {
  await client.query(
    `UPDATE public.repom_flow_sessions SET current_node = 'complete', status = 'done', updated_at = now() WHERE id = $1`,
    [session.id],
  );
  await replyRepom(client, { phone, text: MSG.coletaConcluida, correlationId });
}

/** Coloca a sessão em 'coletando' no passo `step` e zera o contador de falhas. */
async function setColetaStep(client, { session, step }) {
  const vars = asObj(session.variables);
  await client.query(
    `UPDATE public.repom_flow_sessions SET current_node = 'coletando', variables = $2::jsonb, updated_at = now() WHERE id = $1`,
    [session.id, JSON.stringify({ ...vars, etapa: step.key, coleta_falhas: 0 })],
  );
}

/** Dado o motorista atual, pede o próximo passo (determinístico) ou conclui. */
async function askNextOrFinish(client, { session, phone, correlationId, motorista }) {
  const next = proximoPasso({ motorista });
  if (!next) {
    await finishColetaCompleta(client, { session, phone, correlationId });
    return { ok: true, node: "complete", action: "coleta_completa" };
  }
  await setColetaStep(client, { session, step: next });
  // Passo pedido de forma DETERMINÍSTICA: o motorista acabou de acertar o anterior,
  // não há confusão a resolver — não gasta o agente aqui.
  await replyRepom(client, { phone, text: next.ask, correlationId });
  return { ok: true, node: "coletando", action: `ask_${next.key}` };
}

/**
 * Chamado após a CNH ser gravada. Flag OFF → encerra como sempre (comportamento
 * idêntico à Fase 3b). Flag ON e CNH satisfeita → entra na coleta do próximo passo.
 * Se a CNH não ficou salva (staging falhou), NÃO fica pedindo CNH em loop: encerra.
 */
async function advanceAfterCnh(client, { session, phone, correlationId }) {
  if (!(await isRepomContinuacaoEnabled(client))) {
    await finishCnh(client, { session, phone, correlationId });
    return { node: "submitted", action: "submitted" };
  }
  const { motorista } = await loadPendingMotorista(client, { registrationId: session.registration_id, cpf: session.cpf });
  const next = proximoPasso({ motorista });
  if (!next || next.key === "cnh") {
    await finishCnh(client, { session, phone, correlationId });
    return { node: "submitted", action: next?.key === "cnh" ? "cnh_missing_finish" : "submitted" };
  }
  await setColetaStep(client, { session, step: next });
  await replyRepom(client, { phone, text: next.ask, correlationId });
  return { node: "coletando", action: `ask_${next.key}` };
}

/**
 * Registra uma tentativa frustrada no passo atual (motorista mandou o tipo errado
 * ou dado inválido). No limiar, avisa o operador UMA vez (best-effort). Segue
 * PASSIVO: reconduz ao passo (o agente ajuda se ligado).
 */
async function bumpColetaFalha(client, { session, phone, passo, correlationId, driverText, messageType, fallbackText }) {
  const vars = asObj(session.variables);
  const falhas = (Number(vars.coleta_falhas) || 0) + 1;
  const escalar = falhas >= MAX_COLETA_FALHAS && !vars.coleta_escalada;
  await client.query(
    `UPDATE public.repom_flow_sessions SET variables = $2::jsonb, updated_at = now() WHERE id = $1`,
    [session.id, JSON.stringify({ ...vars, etapa: passo.key, coleta_falhas: falhas, coleta_escalada: Boolean(vars.coleta_escalada) || escalar })],
  );
  if (escalar) {
    try {
      await client.query(
        `INSERT INTO public.operator_notifications (kind, title, body, metadata)
         VALUES ('repom_coleta_travada', $1, $2, $3::jsonb)`,
        [
          "Motorista travado no cadastro (WhatsApp)",
          `O motorista não conseguiu enviar "${passo.label}" após ${falhas} tentativas — talvez precise de ajuda humana. CPF final ${onlyDigits(session.cpf).slice(-4)}.`,
          JSON.stringify({ phone, cpf: onlyDigits(session.cpf), etapa: passo.key, tentativas: falhas, correlation_id: correlationId, source: "repom-coleta" }),
        ],
      );
    } catch {
      // best-effort
    }
  }
  await replyForNode(client, { phone, node: `ask_${passo.key}`, driverText, messageType, fallbackText: fallbackText || passo.ask, correlationId });
}

/**
 * Nó 'coletando': recebe UM passo (selfie/comprovante = mídia; telefone = texto),
 * valida, grava em `dados.motorista` (merge idempotente) e avança/conclui. Nunca
 * lança. Sempre deriva o passo atual do motorista PERSISTIDO.
 */
async function handleColeta(client, { session, msg, phone, correlationId }) {
  // Kill switch: continuação desligada no meio → encerra gentil (recebido).
  if (!(await isRepomContinuacaoEnabled(client))) {
    await finishCnh(client, { session, phone, correlationId });
    return { ok: true, node: "submitted", action: "continuacao_off" };
  }

  const cpf = session.cpf;
  const { motorista } = await loadPendingMotorista(client, { registrationId: session.registration_id, cpf });
  const passo = proximoPasso({ motorista });
  if (!passo) {
    await finishColetaCompleta(client, { session, phone, correlationId });
    return { ok: true, node: "complete", action: "already_complete" };
  }

  // ── Passo de TEXTO (telefone) ──
  if (passo.tipo === "texto") {
    const valor = passo.normalize ? passo.normalize(msg.text) : String(msg.text || "").trim() || null;
    if (!valor) {
      await bumpColetaFalha(client, { session, phone, passo, correlationId, driverText: msg.text, messageType: msg.messageType, fallbackText: MSG.telefoneInvalido });
      return { ok: true, node: "coletando", action: `invalid_${passo.key}` };
    }
    await upsertPendingCnh(client, {
      cpf,
      registrationId: session.registration_id,
      motorista: { cpf: onlyDigits(cpf), [passo.field]: valor },
      status: "pendente",
      observacoes: null, // COALESCE preserva os motivos de revisão da CNH
    });
    return askNextOrFinish(client, { session, phone, correlationId, motorista: { ...motorista, [passo.field]: valor } });
  }

  // ── Passo de DOC (selfie/comprovante) ──
  if (!CNH_MEDIA_TYPES.has(msg.messageType)) {
    // esperávamos foto/PDF e veio texto/áudio/sticker → reconduz + conta falha.
    await bumpColetaFalha(client, { session, phone, passo, correlationId, driverText: msg.text, messageType: msg.messageType });
    return { ok: true, node: "coletando", action: `await_${passo.key}` };
  }

  const first = await claimMessageOnce(client, { externalId: msg.externalId, phone, kind: `media_${passo.key}` });
  if (!first) return { skipped: "duplicate_media", node: "coletando" };

  // Freio de custo (download + upload) — compartilha o teto por telefone da CNH.
  if (!tryReserveCnhCall(phone)) {
    await replyRepom(client, { phone, text: MSG.cnhBusy, correlationId });
    return { ok: true, node: "coletando", action: "rate_limited" };
  }

  let media;
  try {
    media = await getMediaBase64({ message: msg.raw, instance: getRepomInstance() });
  } catch (err) {
    console.warn(`[repom.flow] ${correlationId} media download (${passo.key}):`, err instanceof Error ? err.message : String(err));
    await replyRepom(client, { phone, text: MSG.cnhDownloadFailed, correlationId });
    return { ok: true, node: "coletando", action: "media_download_failed" };
  }
  if (!media?.base64) {
    await replyRepom(client, { phone, text: MSG.cnhDownloadFailed, correlationId });
    return { ok: true, node: "coletando", action: "media_empty" };
  }

  try {
    const staged = await stageRepomMedia({ cpf, base64: media.base64, mimetype: media.mimetype, slot: passo.slot, correlationId });
    if (!staged.ok) {
      // não guardou → pede reenvio do MESMO passo (não avança, não conta como falha do motorista).
      await replyRepom(client, { phone, text: passo.ask, correlationId });
      return { ok: true, node: "coletando", action: "stage_failed" };
    }
    await upsertPendingCnh(client, {
      cpf,
      registrationId: session.registration_id,
      motorista: { cpf: onlyDigits(cpf), [passo.field]: staged.storagePath },
      status: "pendente",
      observacoes: null,
    });
    return askNextOrFinish(client, { session, phone, correlationId, motorista: { ...motorista, [passo.field]: staged.storagePath } });
  } catch (err) {
    console.warn(`[repom.flow] ${correlationId} coleta persist (${passo.key}) falhou:`, err instanceof Error ? err.message : String(err));
    try {
      await client.query(
        `INSERT INTO public.operator_notifications (kind, title, body, metadata)
         VALUES ('repom_coleta_persist_failed', $1, $2, $3::jsonb)`,
        [
          "Falha ao gravar doc do cadastro (WhatsApp)",
          `Recebi "${passo.label}" mas não consegui gravar — conferir manualmente. CPF final ${onlyDigits(cpf).slice(-4)}.`,
          JSON.stringify({ phone, cpf: onlyDigits(cpf), etapa: passo.key, correlation_id: correlationId, error: err instanceof Error ? err.message : String(err), source: "repom-coleta" }),
        ],
      );
    } catch {
      // best-effort
    }
    await replyRepom(client, { phone, text: MSG.cnhReceived, correlationId });
    return { ok: true, node: "coletando", action: "persist_failed" };
  }
}

/**
 * Fase 3b — processa a CNH (mídia) no nó ask_cnh: idempotência → baixa do
 * Evolution → OCR → gates → staging → grava o cadastro no pending. Nunca lança.
 * Só é chamada com a flag repom_cnh_ocr_enabled ON. Sempre grava status
 * 'pendente' (garante aparecer na fila); os motivos de revisão vão em
 * `observacoes` (o operador é quem decide — nunca aprova sozinho).
 */
async function handleCnhMedia(client, { session, msg, phone, correlationId }) {
  const first = await claimMessageOnce(client, { externalId: msg.externalId, phone, kind: "cnh_media" });
  if (!first) return { skipped: "duplicate_media", node: "ask_cnh" };

  // Freio anti denial-of-wallet: o caminho da CNH (download + OCR pago + upload)
  // é o mais caro e o número é público. Estourou o limite por telefone/global →
  // responde "aguarde" e NÃO dispara o pipeline pago.
  if (!tryReserveCnhCall(phone)) {
    await replyRepom(client, { phone, text: MSG.cnhBusy, correlationId });
    return { ok: true, node: "ask_cnh", action: "rate_limited" };
  }

  const cpf = session.cpf;

  // 1) baixa a mídia do Evolution (guarda própria — falha aqui = reenviar).
  let media;
  try {
    media = await getMediaBase64({ message: msg.raw, instance: getRepomInstance() });
  } catch (err) {
    console.warn(`[repom.flow] ${correlationId} media download:`, err instanceof Error ? err.message : String(err));
    await replyRepom(client, { phone, text: MSG.cnhDownloadFailed, correlationId });
    return { ok: true, node: "ask_cnh", action: "media_download_failed" };
  }
  if (!media?.base64) {
    await replyRepom(client, { phone, text: MSG.cnhDownloadFailed, correlationId });
    return { ok: true, node: "ask_cnh", action: "media_empty" };
  }

  // OCR → gates → staging → persistência, tudo sob try/catch: NUNCA lança. Uma
  // falha (OCR/rede/Storage/banco) vira notificação ao operador (o motorista
  // não fica no vácuo sem ninguém saber) + confirma o recebimento.
  try {
    const ocr = await extractCnhFromMedia({ imagemBase64: media.base64, idCadastro: `repom-${cpf}`, correlationId });

    // OCR indisponível/ilegível → SALVA a foto + pending p/ revisão manual
    // (decisão do Samuel: nunca perder o documento do motorista).
    if (!ocr.ok) {
      const staged = await stageCnhMedia({ cpf, base64: media.base64, mimetype: media.mimetype, correlationId });
      const motorista = { cpf: String(cpf).replace(/\D/g, "") };
      if (staged.ok) motorista.cnh_url = staged.storagePath;
      const obs = renderObservacoes(
        null,
        staged.ok
          ? "OCR indisponível no envio — ler a CNH manualmente."
          : "OCR indisponível e o arquivo não pôde ser guardado — pedir reenvio.",
      );
      await upsertPendingCnh(client, { cpf, registrationId: session.registration_id, motorista, status: "pendente", observacoes: obs });
      const adv = await advanceAfterCnh(client, { session, phone, correlationId });
      return { ok: true, node: adv.node, action: adv.node === "submitted" ? "ocr_unavailable" : adv.action };
    }

    // Doc trocado (abaixo do sinal mínimo) → pede reenvio, NÃO cria cadastro.
    const gate = evaluateCnhExtraction(ocr.fields, { sessionCpf: cpf });
    if (!gate.accepted) {
      await replyRepom(client, { phone, text: MSG.cnhNotACnh, correlationId });
      return { ok: true, node: "ask_cnh", action: "not_a_cnh" };
    }

    // Staging + monta dados.motorista (alinhado ao wizard) + grava o pending.
    const staged = await stageCnhMedia({ cpf, base64: media.base64, mimetype: media.mimetype, correlationId });
    const motorista = buildMotoristaFromCnhFields(ocr.fields, { cpf });
    if (staged.ok) motorista.cnh_url = staged.storagePath;
    const observacoes = renderObservacoes(gate.issues, staged.ok ? null : "Falha ao guardar o arquivo da CNH.");
    await upsertPendingCnh(client, { cpf, registrationId: session.registration_id, motorista, status: "pendente", observacoes });

    const adv = await advanceAfterCnh(client, { session, phone, correlationId });
    return { ok: true, node: adv.node, action: adv.node === "submitted" ? (gate.issues.length ? "submitted_review" : "submitted") : adv.action };
  } catch (err) {
    console.warn(`[repom.flow] ${correlationId} CNH persist falhou:`, err instanceof Error ? err.message : String(err));
    // Avisa o operador (best-effort) — o motorista mandou a CNH e ninguém pode ficar sem saber.
    try {
      await client.query(
        `INSERT INTO public.operator_notifications (kind, title, body, metadata)
         VALUES ('cnh_persist_failed', $1, $2, $3::jsonb)`,
        [
          "Falha ao gravar cadastro (CNH via WhatsApp)",
          `Recebi a CNH mas não consegui gravar o cadastro — conferir manualmente. CPF final ${String(cpf).slice(-4)}.`,
          JSON.stringify({ phone, cpf: String(cpf).replace(/\D/g, ""), correlation_id: correlationId, error: err instanceof Error ? err.message : String(err), source: "repom-cnh" }),
        ],
      );
    } catch {
      // best-effort
    }
    // Não deixa o motorista no vácuo (mesmo texto de recebido; o operador assume).
    await replyRepom(client, { phone, text: MSG.cnhReceived, correlationId });
    return { ok: true, node: "ask_cnh", action: "persist_failed" };
  }
}

/**
 * Entrada principal: reage a UMA mensagem IN recebida pelo número do Repom.
 * Chamada pelo webhook (a mensagem já foi persistida no chat pelo caller).
 * Nunca lança — devolve { ok | skipped, node?, action? } para log.
 */
export async function handleRepomIncomingMessage(msg) {
  if (msg?.direction !== "in") return { skipped: "not_in" };
  const phone = String(msg.phone || "").replace(/\D/g, "");
  if (!phone) return { skipped: "no_phone" };
  const correlationId = `repom-flow-${phone.slice(-4)}-${msg.externalId || "x"}`;

  return withPgClient(async (client) => {
    if (!(await isRepomFlowEnabled(client))) return { skipped: "disabled" };

    let session = await loadActiveSession(client, phone);

    // Primeira mensagem → cria a sessão e cumprimenta pedindo o CPF.
    if (!session) {
      await client.query(
        `INSERT INTO public.repom_flow_sessions (phone, current_node, status, last_inbound_at)
         VALUES ($1, 'ask_cpf', 'active', now())`,
        [phone],
      );
      await replyRepom(client, { phone, text: MSG.greeting, correlationId });
      return { ok: true, node: "ask_cpf", action: "greeted" };
    }

    await client.query(
      `UPDATE public.repom_flow_sessions SET last_inbound_at = now(), updated_at = now() WHERE id = $1`,
      [session.id],
    );

    if (session.current_node === "ask_cpf") {
      const cpf = extractCpfFromText(msg.text);
      if (!cpf) {
        // Motorista mandou algo que não é CPF (pergunta, "não sei", texto solto):
        // o agente orienta e reconduz; sem agente, a mensagem fixa de sempre.
        await replyForNode(client, {
          phone,
          node: "ask_cpf",
          driverText: msg.text,
          messageType: msg.messageType,
          fallbackText: MSG.invalidCpf,
          correlationId,
        });
        return { ok: true, node: "ask_cpf", action: "invalid_cpf" };
      }

      const dedup = await resolveCpfDedup({ cpf }, client);

      // Já é motorista oficial / cadastro aprovado → informa e encerra (PRD §7 caso 4).
      if (dedup.action === "inform_approved") {
        await client.query(
          `UPDATE public.repom_flow_sessions
              SET cpf = $2, status = 'done', updated_at = now()
            WHERE id = $1`,
          [session.id, cpf],
        );
        await replyRepom(client, { phone, text: MSG.alreadyRegistered, correlationId });
        return { ok: true, node: "done", action: "inform_approved" };
      }

      // create | continue | resume | reopen → grava o CPF na sessão (liga na
      // entidade central) e avança para a CNH. A diferença é só a mensagem.
      const text =
        dedup.action === "reopen"
          ? MSG.reopenRejected
          : dedup.action === "create"
            ? MSG.createNew
            : MSG.resumeExisting;
      // Atribuição direta (não `variables || $x`): v1 só carrega {cpf, dedupAction}
      // e o operador || de jsonb não existe no pg-mem dos testes.
      await client.query(
        `UPDATE public.repom_flow_sessions
            SET cpf = $2, registration_id = $3, current_node = 'ask_cnh',
                variables = $4::jsonb, updated_at = now()
          WHERE id = $1`,
        [session.id, cpf, dedup.registrationId || null, JSON.stringify({ cpf, dedupAction: dedup.action })],
      );
      await replyRepom(client, { phone, text, correlationId });
      return { ok: true, node: "ask_cnh", action: dedup.action };
    }

    if (session.current_node === "ask_cnh") {
      const ocrOn = await isRepomCnhOcrEnabled(client);
      // OCR ON + mídia (foto/PDF) → processa a CNH.
      if (ocrOn && CNH_MEDIA_TYPES.has(msg.messageType)) {
        return handleCnhMedia(client, { session, msg, phone, correlationId });
      }
      // OCR ON + não-mídia (texto/áudio/sticker) → pede a CNH explicitamente (o
      // agente ajuda se ligado). OCR OFF → comportamento antigo IDÊNTICO (cnhParked).
      await replyForNode(client, {
        phone,
        node: "ask_cnh",
        driverText: msg.text,
        messageType: msg.messageType,
        fallbackText: ocrOn ? MSG.cnhAskPhoto : MSG.cnhParked,
        correlationId,
      });
      return { ok: true, node: "ask_cnh", action: ocrOn ? "await_media" : "parked" };
    }

    // Fase 3d — coleta em andamento (selfie → comprovante → telefone).
    if (session.current_node === "coletando") {
      return handleColeta(client, { session, msg, phone, correlationId });
    }

    return { skipped: "unknown_node", node: session.current_node };
  });
}
