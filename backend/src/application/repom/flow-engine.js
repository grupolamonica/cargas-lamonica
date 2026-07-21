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
import { getRepomInstance, sendWhatsappText } from "../../infrastructure/whatsapp/evolution-client.js";
import { ensureAppSettingsTable } from "../operator-admin/use-cases/angellira/auto-approve-vigentes.js";
import { resolveCpfDedup } from "./dedup-cpf.js";

const SETTING_KEY = "repom_flow_enabled";

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
};

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
        await replyRepom(client, { phone, text: MSG.invalidCpf, correlationId });
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
      // Fase 3b liga a mídia→OCR aqui. Por ora, confirma o recebimento sem
      // travar o motorista (flag OFF em produção; este caminho é p/ teste).
      await replyRepom(client, { phone, text: MSG.cnhParked, correlationId });
      return { ok: true, node: "ask_cnh", action: "parked" };
    }

    return { skipped: "unknown_node", node: session.current_node };
  });
}
