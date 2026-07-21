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
import { claimMessageOnce, stageCnhMedia } from "./cnh-media.js";
import { buildMotoristaFromCnhFields, renderObservacoes, upsertPendingCnh } from "./cnh-registration.js";
import { resolveCpfDedup } from "./dedup-cpf.js";
import { extractCnhFromMedia } from "./ocr-sidecar-client.js";

const SETTING_KEY = "repom_flow_enabled";
const CNH_OCR_SETTING_KEY = "repom_cnh_ocr_enabled";

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
async function replyForNode(client, { phone, node, driverText, fallbackText, correlationId }) {
  let text = fallbackText;
  try {
    // Só aciona o agente quando o motorista mandou TEXTO (mídia/vazio → mensagem
    // fixa, idêntico ao pré-agente e sem gastar chamada) e sob o rate limit
    // (freio de custo do número público). Qualquer condição falsa → fixa.
    const hasText = Boolean(driverText && String(driverText).trim());
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

  const cpf = session.cpf;

  // 1) baixa a mídia do Evolution
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

  // 2) OCR
  const ocr = await extractCnhFromMedia({ imagemBase64: media.base64, idCadastro: `repom-${cpf}`, correlationId });

  // 2a) OCR indisponível/ilegível → SALVA a foto + cria pending p/ revisão manual
  //     (decisão do Samuel: nunca perder o documento do motorista).
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
    await upsertPendingCnh(client, {
      cpf,
      registrationId: session.registration_id,
      motorista,
      status: "pendente",
      observacoes: obs,
    });
    await finishCnh(client, { session, phone, correlationId });
    return { ok: true, node: "submitted", action: "ocr_unavailable" };
  }

  // 3) gates: doc trocado (abaixo do sinal mínimo) → pede reenvio, NÃO cria cadastro
  const gate = evaluateCnhExtraction(ocr.fields, { sessionCpf: cpf });
  if (!gate.accepted) {
    await replyRepom(client, { phone, text: MSG.cnhNotACnh, correlationId });
    return { ok: true, node: "ask_cnh", action: "not_a_cnh" };
  }

  // 4) staging + 5) monta dados.motorista (alinhado ao wizard) + cnh_url
  const staged = await stageCnhMedia({ cpf, base64: media.base64, mimetype: media.mimetype, correlationId });
  const motorista = buildMotoristaFromCnhFields(ocr.fields, { cpf });
  if (staged.ok) motorista.cnh_url = staged.storagePath;

  // 6) grava/atualiza o pending
  const observacoes = renderObservacoes(gate.issues, staged.ok ? null : "Falha ao guardar o arquivo da CNH.");
  await upsertPendingCnh(client, {
    cpf,
    registrationId: session.registration_id,
    motorista,
    status: "pendente",
    observacoes,
  });

  // 7) encerra (passivo) — o operador assume
  await finishCnh(client, { session, phone, correlationId });
  return { ok: true, node: "submitted", action: gate.issues.length ? "submitted_review" : "submitted" };
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
      // Fase 3b: se veio MÍDIA (foto/PDF) e o OCR está ligado, processa a CNH.
      if (CNH_MEDIA_TYPES.has(msg.messageType) && (await isRepomCnhOcrEnabled(client))) {
        return handleCnhMedia(client, { session, msg, phone, correlationId });
      }
      // OCR desligado (flag OFF) ou texto solto: o agente pede a CNH; sem agente,
      // a mensagem fixa (não trava o motorista).
      await replyForNode(client, {
        phone,
        node: "ask_cnh",
        driverText: msg.text,
        fallbackText: MSG.cnhParked,
        correlationId,
      });
      return { ok: true, node: "ask_cnh", action: "parked" };
    }

    return { skipped: "unknown_node", node: session.current_node };
  });
}
