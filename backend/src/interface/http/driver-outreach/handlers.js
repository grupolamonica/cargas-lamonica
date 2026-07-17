import { requireOperatorSession } from "../../../application/load-claims/auth.js";
import { createCorrelationId } from "../../../application/load-claims/helpers.js";
import { assertOperatorPermission } from "../../../application/load-claims/operator-access.js";
import { ForbiddenError, UnauthorizedError, ValidationError } from "../../../domain/load-claims/errors.js";
import { getDriverOpportunities } from "../../../application/driver-outreach/get-driver-opportunities.js";
import {
  addOutreachOptout,
  cancelQueuedOutreach,
  connectWhatsapp,
  createManualOutreach,
  disconnectWhatsapp,
  getOutreachOverview,
  getOutreachQueueItem,
  getWhatsappStatus,
  deleteOperatorNotifications,
  listOperatorNotifications,
  listWhatsappConversations,
  listWhatsappMessages,
  markAllNotificationsSeen,
  markNotificationsSeen,
  sendManualChatMessage,
  startReconcileRegistrationsInBackground,
  removeOutreachOptout,
  revalidateOutreachQueueAgainstAngellira,
  saveOutreachSettings,
  sendOutreachQueueItemNow,
  sendWhatsappTestMessage,
  triggerOutreachScan,
  updateOutreachQueueItem,
} from "../../../application/driver-outreach/admin.js";
import {
  cacheInstanceQr,
  clearInstanceQr,
  sendWhatsappText,
} from "../../../infrastructure/whatsapp/evolution-client.js";
import {
  parseUpsertPayload,
  saveWhatsappMessageStandalone,
} from "../../../application/driver-outreach/whatsapp-messages.js";
import {
  composeThankYouMessage,
  findReturnLoadForDriver,
  handleDriverReplyForReservation,
} from "../../../application/driver-outreach/reservation-flow.js";
import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import {
  checkRegistrationPending,
  composeMassCandidaturaConfirmMessage,
  composeMassFollowUpMessage,
  composeMassNoLoadMessage,
  createLeadFromMassAccept,
  enqueueMassOutreach,
  findAwaitingCandidatura,
  findMassContextAndLoad,
  listMassOutreachRoutes,
  markDetailedOfferSent,
  markMassConvertedToCandidatura,
  previewMassAudience,
  validateDriverAgainstExternal,
} from "../../../application/driver-outreach/mass-outreach.js";
import { parseAcceptanceIntent } from "../../../application/driver-outreach/reservation-flow.js";
import { registerReturnInterest } from "../../../application/driver-outreach/return-interest.js";
import {
  findRouteNeedConversation,
  updateRouteNeedStage,
  findClosestLoadForSchedule,
  composeAskSchedule,
  composeScheduleOffer,
  composeNoLoadForSchedule,
  composeRouteNeedConfirm,
} from "../../../application/driver-outreach/route-need.js";
import { parseSchedulePreference } from "../../../domain/driver-outreach/schedule-nlp.js";
import {
  renderMessage,
  listMessageTemplates,
  saveMessageTemplate,
} from "../../../application/driver-outreach/message-templates.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";
import { toIsoDate } from "../../../domain/recurrence.js";
import { extractUf } from "../../../domain/driver-outreach/detection.js";
import { buildHttpErrorResponse } from "../error-mapping.js";
import { getAuthorizationHeader, getHeaderValue, parseJsonBody } from "../http-utils.js";

function getCorrelationId(request) {
  return getHeaderValue(request, "X-Correlation-Id") || createCorrelationId();
}

function toErrorResponse(error, correlationId) {
  const status =
    error instanceof UnauthorizedError
      ? 401
      : error instanceof ForbiddenError
      ? 403
      : typeof error?.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : 500;

  return buildHttpErrorResponse(
    status,
    {
      error: error?.name || "DriverOutreachError",
      code: error?.code || "DRIVER_OUTREACH_ERROR",
      message: error instanceof Error ? error.message : String(error),
    },
    correlationId,
  );
}

/**
 * GET /api/operator/driver-opportunities?cpf=&nome=&phone=
 * Read-model: oportunidades de contato detectadas para um motorista + link
 * wa.me pronto (Wave A — o operador dispara manualmente).
 */
export async function resolveDriverOpportunitiesResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(
      user,
      "operator:read",
      "Somente operadores autorizados podem consultar oportunidades de contato.",
    );
    const query = request.query || {};
    const payload = await getDriverOpportunities({
      cpf: query.cpf,
      nome: query.nome,
      phone: query.phone,
      correlationId,
    });
    return { statusCode: 200, payload };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

// ─── Tela de controle do operador ─────────────────────────────────────────────

/** GET /api/operator/outreach/overview */
export async function resolveOutreachOverviewResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "operator:read", "Somente operadores autorizados podem ver o outreach.");
    const payload = await getOutreachOverview({ correlationId });
    return { statusCode: 200, payload };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** PATCH /api/operator/outreach/settings */
export async function resolveOutreachSettingsUpdateResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem alterar o outreach.");
    const body = (await parseJsonBody(request)) || {};
    const settings = await saveOutreachSettings(body, user?.id ?? null);
    return { statusCode: 200, payload: { ok: true, settings, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** GET /api/operator/outreach/message-templates — lista as mensagens editáveis. */
export async function resolveMessageTemplatesListResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "operator:read", "Somente operadores podem ver as mensagens.");
    const templates = await listMessageTemplates();
    return { statusCode: 200, payload: { ok: true, templates, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** PATCH /api/operator/outreach/message-templates — salva texto/enabled de uma mensagem. */
export async function resolveMessageTemplateUpdateResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem editar as mensagens.");
    const body = (await parseJsonBody(request)) || {};
    if (!body.key) throw new ValidationError("Informe a mensagem (key).");
    await saveMessageTemplate({
      key: body.key,
      template: body.template,
      enabled: body.enabled,
      updatedBy: user?.id ?? null,
    });
    const templates = await listMessageTemplates();
    return { statusCode: 200, payload: { ok: true, templates, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** POST /api/operator/outreach/scan */
export async function resolveOutreachScanResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem rodar a varredura.");
    const result = await triggerOutreachScan();
    return { statusCode: 200, payload: { ok: true, ...result, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** POST /api/operator/outreach/optout  { cpf?, nome?, phone?, reason? } */
export async function resolveOutreachOptoutAddResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem gerenciar opt-out.");
    const body = (await parseJsonBody(request)) || {};
    const result = await addOutreachOptout(body, user?.id ?? null);
    return { statusCode: 200, payload: { ok: true, ...result, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** DELETE /api/operator/outreach/optout/:driverKey */
export async function resolveOutreachOptoutRemoveResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem gerenciar opt-out.");
    const driverKey = (request.query || {}).driverKey;
    const result = await removeOutreachOptout(driverKey);
    return { statusCode: 200, payload: { ...result, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** POST /api/operator/outreach/queue/:id/cancel */
export async function resolveOutreachQueueCancelResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem cancelar envios.");
    const id = (request.query || {}).id;
    const result = await cancelQueuedOutreach(id);
    return { statusCode: 200, payload: { ...result, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** POST /api/operator/outreach/queue — inserção manual de um item na fila. */
export async function resolveOutreachQueueCreateResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem inserir na fila.");
    const body = (await parseJsonBody(request)) || {};
    const result = await createManualOutreach(body);
    return { statusCode: 201, payload: { ...result, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** POST /api/operator/outreach/queue/revalidate — revalida a fila contra o Angellira. */
export async function resolveOutreachQueueRevalidateResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem revalidar a fila.");
    const result = await revalidateOutreachQueueAgainstAngellira();
    return { statusCode: 200, payload: { ok: true, ...result, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** POST /api/operator/outreach/reconcile-registrations — concilia cadastros com o Angellira. */
export async function resolveReconcileRegistrationsResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem conciliar cadastros.");
    // Roda em background (Angellira é lento) — retorna já; resultado vai pro sino.
    const result = await startReconcileRegistrationsInBackground();
    return { statusCode: 202, payload: { ok: true, ...result, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** GET /api/operator/outreach/queue/:id — detalhe + contexto do motorista. */
export async function resolveOutreachQueueItemResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "operator:read", "Somente operadores autorizados podem ver a fila.");
    const id = (request.query || {}).id;
    const payload = await getOutreachQueueItem(id);
    return { statusCode: 200, payload: { ...payload, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** PATCH /api/operator/outreach/queue/:id  { trigger?, phone?, message? } */
export async function resolveOutreachQueueUpdateResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem editar envios.");
    const id = (request.query || {}).id;
    const body = (await parseJsonBody(request)) || {};
    const result = await updateOutreachQueueItem(id, body);
    return { statusCode: 200, payload: { ...result, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** POST /api/operator/outreach/queue/:id/send — envia agora via Evolution. */
export async function resolveOutreachQueueSendResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem enviar.");
    const id = (request.query || {}).id;
    const result = await sendOutreachQueueItemNow(id);
    return { statusCode: 200, payload: { ...result, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

// ─── Conexão do WhatsApp ──────────────────────────────────────────────────────

/** GET /api/operator/outreach/whatsapp/status */
export async function resolveWhatsappStatusResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "operator:read", "Somente operadores autorizados podem ver o WhatsApp.");
    const payload = await getWhatsappStatus();
    return { statusCode: 200, payload: { ...payload, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** POST /api/operator/outreach/whatsapp/connect */
export async function resolveWhatsappConnectResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem conectar o WhatsApp.");
    const body = (await parseJsonBody(request)) || {};
    const payload = await connectWhatsapp({ number: body.number });
    return { statusCode: 200, payload: { ...payload, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** POST /api/operator/outreach/whatsapp/disconnect */
export async function resolveWhatsappDisconnectResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem desconectar o WhatsApp.");
    const payload = await disconnectWhatsapp();
    return { statusCode: 200, payload: { ...payload, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** POST /api/operator/outreach/whatsapp/test  { phone, text? } */
export async function resolveWhatsappTestResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem enviar teste.");
    const body = (await parseJsonBody(request)) || {};
    const payload = await sendWhatsappTestMessage(body);
    return { statusCode: 200, payload: { ...payload, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/**
 * POST /api/webhooks/evolution — recebe eventos do Evolution (QR, conexão).
 * SEM autenticação de operador: é um webhook interno chamado pelo gateway.
 * Cacheia o QR (QRCODE_UPDATED) para a tela buscar; limpa ao conectar.
 */
export async function resolveEvolutionWebhookResponse(request) {
  try {
    const body = (await parseJsonBody(request)) || {};
    const event = String(body.event || body.type || "").toLowerCase().replace(/_/g, ".");
    const instance = body.instance || body.instanceName || body.data?.instance || "";
    const d = body.data || {};
    const base64 = d.qrcode?.base64 || d.base64 || body.qrcode?.base64 || d.qr?.base64 || null;
    console.info(
      `[evolution.webhook] event=${event || "?"} instance=${instance || "?"} keys=[${Object.keys(d).join(",")}] hasBase64=${Boolean(base64)}`,
    );
    if (event.includes("qrcode")) {
      const pairing = d.qrcode?.pairingCode || d.pairingCode || null;
      if (instance && base64) cacheInstanceQr(instance, base64, pairing);
    } else if (event.includes("connection")) {
      const state = d.state || body.state;
      if (instance && state === "open") clearInstanceQr(instance);
    } else if (event.includes("messages.upsert") || event === "messages.upsert") {
      // Mensagens recebidas/enviadas. Persistimos TUDO no chat, e reagimos às
      // mensagens de entrada do motorista (aceite/recusa de reserva).
      const parsed = parseUpsertPayload(body);
      const items = Array.isArray(parsed) ? parsed : parsed.items;
      const unresolved = Array.isArray(parsed) ? [] : parsed.unresolved;
      for (const msg of items) {
        try {
          const saved = await saveWhatsappMessageStandalone(msg);
          if (msg.direction === "in" && saved) {
            handleIncomingDriverMessage(msg, saved).catch((err) =>
              console.warn("[evolution.webhook] handleIncoming error:", err?.message),
            );
          }
        } catch (err) {
          console.warn("[evolution.webhook] persist error:", err?.message);
        }
      }
      // Cria notificação para o operador quando chega msg IN em @lid sem número
      // resolvível (WhatsApp Business Linked ID). O operador precisa ver a
      // resposta no WhatsApp Web/Manager e agir manualmente.
      for (const u of unresolved) {
        try {
          await withPgClient((client) =>
            client.query(
              `INSERT INTO public.operator_notifications (kind, title, body, metadata)
               VALUES ('driver_reply_unresolved', $1, $2, $3::jsonb)`,
              [
                u.pushName ? `Resposta de ${u.pushName} (número oculto)` : "Resposta com número oculto",
                `Motorista escreveu: "${String(u.text).slice(0, 200)}". O WhatsApp não expôs o número — verifique manualmente.`,
                JSON.stringify({ lid: u.lid, pushName: u.pushName || null, text: String(u.text).slice(0, 500) }),
              ],
            ),
          );
        } catch (err) {
          console.warn("[evolution.webhook] unresolved notify error:", err?.message);
        }
      }
    }
    return { statusCode: 200, payload: { ok: true } };
  } catch (error) {
    console.warn("[evolution.webhook] erro:", error?.message);
    return { statusCode: 200, payload: { ok: true } };
  }
}

/**
 * Reage a uma mensagem IN do motorista: se ele tinha reserva pendente e a
 * mensagem indica aceite → confirma + envia agradecimento (com oferta de retorno
 * se houver carga OPEN casando com a região de descarregamento). Recusa → volta
 * OPEN + notifica operador.
 */
/**
 * Envia uma mensagem OUT ao motorista com fallback: se `sendWhatsappText`
 * falhar (Evolution down, número inválido, circuit open), cria uma notificação
 * `reply_send_failed` para o operador retomar manualmente no chat. Assim o
 * motorista nunca fica em silêncio silencioso — ou recebe a mensagem, ou o
 * operador é avisado que precisa responder.
 */
async function sendReplyWithFallback({ phone, text, correlationId, contextTitle, meta = {} }) {
  // text null/vazio = mensagem DESLIGADA na central de templates → não envia.
  if (!text || !String(text).trim()) {
    return { ok: true, skipped: "disabled" };
  }
  try {
    await sendWhatsappText({ to: phone, text, correlationId });
    return { ok: true };
  } catch (sendErr) {
    const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
    console.warn(`[evolution.webhook] ${correlationId} send failed:`, errMsg);
    try {
      await withPgClient((client) =>
        client.query(
          `INSERT INTO public.operator_notifications (kind, title, body, metadata)
           VALUES ('reply_send_failed', $1, $2, $3::jsonb)`,
          [
            contextTitle || "Falha ao responder motorista",
            `Não consegui entregar a resposta automática. Motorista aguardando: ${errMsg.slice(0, 200)}`,
            JSON.stringify({ phone, correlation_id: correlationId, error: errMsg, ...meta }),
          ],
        ),
      );
    } catch (nErr) {
      console.warn("[evolution.webhook] reply_send_failed notify error:", nErr?.message);
    }
    return { ok: false, error: errMsg };
  }
}

/** Nome amigável (primeiro nome) — se ausente, cumprimento sem nome. */
function greeting(nomeMap) {
  const f = String(nomeMap || "").trim().split(/\s+/)[0] || "";
  return f ? `${f.charAt(0).toUpperCase() + f.slice(1).toLowerCase()}` : "amigo";
}

/**
 * route-need — motorista respondeu com a preferência de dia/horário. Parseia,
 * acha a carga da rota mais próxima do que ele pediu e oferta.
 */
async function handleRouteNeedSchedule(msg, saved, conv, nomeMap) {
  const { origem, destino } = conv.metadata || {};
  const todayIso = getSaoPauloWallClock().dateIso;
  const pref = parseSchedulePreference(msg.text, { todayIso });

  if (pref.kind === "unknown") {
    await sendReplyWithFallback({
      phone: msg.phone,
      text: `Não peguei a data, ${greeting(nomeMap)}. 😅 Me diz assim: *amanhã*, *sexta*, *dia 20* ou *o quanto antes*.`,
      correlationId: "route-need-reask-schedule",
      contextTitle: "Não entendi a data (route-need)",
      meta: { load_id: conv.metadata?.loadId },
    });
    return;
  }

  const { load, exact } = await withPgClient((client) =>
    findClosestLoadForSchedule(client, { origem, destino, pref, todayIso }),
  );

  if (!load) {
    await sendReplyWithFallback({
      phone: msg.phone,
      text: composeNoLoadForSchedule({ nome: nomeMap, origem, destino }),
      correlationId: "route-need-no-load",
      contextTitle: "Sem carga na data pedida (route-need)",
      meta: { load_id: conv.metadata?.loadId },
    });
    return;
  }

  await sendReplyWithFallback({
    phone: msg.phone,
    text: composeScheduleOffer({ nome: nomeMap, load, requested: pref, exact }),
    correlationId: "route-need-offer",
    contextTitle: "Oferta de carga (route-need)",
    meta: { offered_load_id: load.id },
  });
  await withPgClient((client) =>
    updateRouteNeedStage(client, {
      id: conv.id,
      patch: {
        stage: "offered",
        offeredLoadId: load.id,
        requestedRaw: msg.text,
        requestedDateIso: pref.dateIso || pref.dateFrom || null,
      },
    }),
  );
  console.info(`[evolution.webhook] route-need awaiting_schedule→offered load=${load.id} exact=${exact}`);
}

/**
 * route-need — motorista respondeu à oferta. Se aceitar, cria a candidatura;
 * se recusar (ou mandar outra data), volta a procurar.
 */
async function handleRouteNeedOffer(msg, saved, conv, nomeMap) {
  const offeredLoadId = conv.metadata?.offeredLoadId;
  const intent = parseAcceptanceIntent(msg.text);

  if (intent === "accept" && offeredLoadId) {
    const created = await withPgClient(async (client) => {
      const { rows } = await client.query(
        `SELECT id, origem, destino, data, horario FROM public.cargas WHERE id = $1 AND status = 'OPEN'`,
        [offeredLoadId],
      );
      const cargo = rows[0];
      if (!cargo) return { gone: true };
      const { lead, duplicate } = await createLeadFromMassAccept(client, {
        loadId: offeredLoadId,
        cpf: saved?.driver_key || null,
        phone: msg.phone,
      });
      await updateRouteNeedStage(client, {
        id: conv.id,
        patch: { stage: "converted", leadId: lead.id },
      });
      await client.query(
        `INSERT INTO public.operator_notifications (kind, title, body, metadata)
         VALUES ('route_need_converted', $1, $2, $3::jsonb)`,
        [
          duplicate ? "Candidatura já existia (chamado de carga)" : "Nova candidatura via chamado de carga",
          `${cargo.origem} → ${cargo.destino}`,
          JSON.stringify({
            phone: msg.phone,
            driver_key: saved?.driver_key || null,
            load_id: offeredLoadId,
            lead_id: lead.id,
            duplicate,
          }),
        ],
      );
      return { cargo, duplicate };
    });

    if (created?.gone) {
      // Carga saiu no meio — volta a procurar.
      await sendReplyWithFallback({
        phone: msg.phone,
        text: `Poxa, ${greeting(nomeMap)}, essa acabou de sair. 😕 Quer que eu veja outra data pra você?`,
        correlationId: "route-need-offer-gone",
        contextTitle: "Carga ofertada saiu (route-need)",
        meta: { offered_load_id: offeredLoadId },
      });
      await withPgClient((client) =>
        updateRouteNeedStage(client, { id: conv.id, patch: { stage: "awaiting_schedule" } }),
      );
      return;
    }

    await sendReplyWithFallback({
      phone: msg.phone,
      text: composeRouteNeedConfirm({ nome: nomeMap, load: created.cargo, duplicate: created.duplicate }),
      correlationId: "route-need-confirm",
      contextTitle: "Candidatura confirmada (route-need)",
      meta: { load_id: offeredLoadId },
    });
    console.info(`[evolution.webhook] route-need offered→converted load=${offeredLoadId}`);
    return;
  }

  if (intent === "reject") {
    await sendReplyWithFallback({
      phone: msg.phone,
      text: `Sem problema, ${greeting(nomeMap)}. Quer outra data? Me fala outro dia que eu procuro. 🙂`,
      correlationId: "route-need-offer-reject",
      contextTitle: "Motorista recusou oferta (route-need)",
      meta: { offered_load_id: offeredLoadId },
    });
    await withPgClient((client) =>
      updateRouteNeedStage(client, { id: conv.id, patch: { stage: "awaiting_schedule" } }),
    );
    return;
  }

  // Não foi sim/não claro: talvez seja outra DATA. Tenta reinterpretar.
  const todayIso = getSaoPauloWallClock().dateIso;
  const pref = parseSchedulePreference(msg.text, { todayIso });
  if (pref.kind !== "unknown") {
    await withPgClient((client) =>
      updateRouteNeedStage(client, { id: conv.id, patch: { stage: "awaiting_schedule" } }),
    );
    await handleRouteNeedSchedule(msg, saved, { ...conv, stage: "awaiting_schedule" }, nomeMap);
    return;
  }

  await sendReplyWithFallback({
    phone: msg.phone,
    text: `${greeting(nomeMap)}, é só responder *SIM* pra eu garantir essa carga — ou me manda outra data. 🙌`,
    correlationId: "route-need-offer-nudge",
    contextTitle: "Aguardando confirmação da oferta (route-need)",
    meta: { offered_load_id: offeredLoadId },
  });
}

async function handleIncomingDriverMessage(msg, saved) {
  try {
    // Áudio / mídia sem texto: sem transcrição automática ainda. Avisa o
    // motorista de forma amigável + notifica o operador escutar/responder.
    if (["audio", "image", "video", "document", "sticker", "location"].includes(String(msg.messageType))) {
      const nomeMap = await withPgClient(async (client) => {
        try {
          const { rows } = await client.query(
            `SELECT nome FROM public.motoristas_historico WHERE cpf = $1 LIMIT 1`,
            [saved?.driver_key || ""],
          );
          return rows[0]?.nome || null;
        } catch {
          return null;
        }
      });
      const mediaLabel =
        {
          audio: "áudio",
          image: "foto",
          video: "vídeo",
          document: "documento",
          sticker: "figurinha",
          location: "localização",
        }[String(msg.messageType)] || "mensagem";
      const text = renderMessage("media_reply", { nome: greeting(nomeMap), midia: mediaLabel });
      await sendReplyWithFallback({
        phone: msg.phone,
        text,
        correlationId: `reply-media-${msg.messageType}`,
        contextTitle: `Motorista mandou ${mediaLabel}`,
        meta: {
          message_type: msg.messageType,
          driver_key: saved?.driver_key || null,
        },
      });
      await withPgClient((client) =>
        client.query(
          `INSERT INTO public.operator_notifications (kind, title, body, metadata)
           VALUES ('driver_media_reply', $1, $2, $3::jsonb)`,
          [
            `Motorista mandou ${mediaLabel}`,
            `Precisa ouvir/ver e responder manualmente pelo chat.`,
            JSON.stringify({
              phone: msg.phone,
              driver_key: saved?.driver_key || null,
              message_type: msg.messageType,
              nome: nomeMap,
            }),
          ],
        ),
      );
      return; // não passa pelo parser de intenção (não tem texto)
    }

    // ── Conversa do CHAMADO de carga órfã (route-need) ───────────────────────
    // Precisa vir ANTES do parser de aceite: uma resposta de data ("amanhã de
    // manhã") não é accept/reject.
    const routeConv = await withPgClient((client) =>
      findRouteNeedConversation(client, { phone: msg.phone, driverKey: saved?.driver_key || null }),
    );
    const routeNomeMap = await withPgClient(async (client) => {
      try {
        const { rows } = await client.query(
          `SELECT nome FROM public.motoristas_historico WHERE cpf = $1 LIMIT 1`,
          [saved?.driver_key || ""],
        );
        return rows[0]?.nome || null;
      } catch {
        return null;
      }
    });

    if (routeConv && routeConv.stage === "awaiting_schedule") {
      await handleRouteNeedSchedule(msg, saved, routeConv, routeNomeMap);
      return;
    }
    if (routeConv && routeConv.stage === "offered") {
      await handleRouteNeedOffer(msg, saved, routeConv, routeNomeMap);
      return;
    }

    const result = await handleDriverReplyForReservation({
      phone: msg.phone,
      text: msg.text,
      driverKey: saved?.driver_key || null,
    });

    // Convite de carga órfã ainda não respondido: aceite → pergunta horário.
    if (routeConv && routeConv.stage === "invited" && result.action === "no_reservation") {
      if (result.intent === "accept") {
        const { origem, destino } = routeConv.metadata || {};
        await sendReplyWithFallback({
          phone: msg.phone,
          text: composeAskSchedule({ nome: routeNomeMap, origem, destino }),
          correlationId: "route-need-ask-schedule",
          contextTitle: "Motorista topou carga órfã (route-need)",
          meta: { load_id: routeConv.metadata?.loadId },
        });
        await withPgClient((client) =>
          updateRouteNeedStage(client, { id: routeConv.id, patch: { stage: "awaiting_schedule" } }),
        );
        await withPgClient((client) =>
          client.query(
            `INSERT INTO public.operator_notifications (kind, title, body, metadata)
             VALUES ('route_need_accept', $1, $2, $3::jsonb)`,
            [
              "Motorista topou chamado de carga",
              `${origem} → ${destino} · perguntando dia/horário`,
              JSON.stringify({ phone: msg.phone, driver_key: saved?.driver_key || null, ...routeConv.metadata }),
            ],
          ),
        );
        console.info("[evolution.webhook] route-need invited→awaiting_schedule");
        return;
      }
      if (result.intent === "reject") {
        await sendReplyWithFallback({
          phone: msg.phone,
          text: `Tranquilo, ${greeting(routeNomeMap)}. 👍 Se mudar de ideia é só me chamar. Boa viagem!`,
          correlationId: "route-need-decline",
          contextTitle: "Motorista recusou chamado de carga",
          meta: { load_id: routeConv.metadata?.loadId },
        });
        await withPgClient((client) =>
          updateRouteNeedStage(client, { id: routeConv.id, patch: { stage: "declined" } }),
        );
        return;
      }
    }

    if (result.action === "confirmed" && result.lead) {
      // Busca carga de retorno + compõe agradecimento.
      const returnLoad = await withPgClient((client) =>
        findReturnLoadForDriver(client, {
          fromUf: extractUf(result.lead.destino),
          loadIdToExclude: result.lead.load_id,
          todayIso: new Date().toISOString().slice(0, 10),
        }),
      );
      const nomeMap = await withPgClient(async (client) => {
        try {
          const { rows } = await client.query(
            `SELECT nome FROM public.motoristas_historico WHERE cpf = $1 LIMIT 1`,
            [result.lead.cpf || ""],
          );
          return rows[0]?.nome || null;
        } catch {
          return null;
        }
      });
      const text = composeThankYouMessage({
        nome: nomeMap,
        load: {
          origem: result.lead.origem,
          destino: result.lead.destino,
          dateIso: result.lead.data ? toIsoDate(result.lead.data) : null,
          horario: result.lead.horario,
        },
        returnLoad,
      });
      await sendReplyWithFallback({
        phone: msg.phone,
        text,
        correlationId: "reservation-thankyou",
        contextTitle: "Falha ao enviar agradecimento de reserva",
        meta: { lead_id: result.lead.lead_id, load_id: result.lead.load_id },
      });
    }

    // Fix 1: motorista recusou uma reserva ativa → confirma que entendeu.
    if (result.action === "rejected" && result.lead) {
      const nomeMap = await withPgClient(async (client) => {
        try {
          const { rows } = await client.query(
            `SELECT nome FROM public.motoristas_historico WHERE cpf = $1 LIMIT 1`,
            [result.lead.cpf || ""],
          );
          return rows[0]?.nome || null;
        } catch {
          return null;
        }
      });
      const text = [
        `Entendido, ${greeting(nomeMap)}. 👍`,
        "",
        "A carga voltou para a fila e a equipe já foi avisada.",
        "Se aparecer alguma outra que combine, eu te chamo. Fica na paz! 🙌",
      ].join("\n");
      await sendReplyWithFallback({
        phone: msg.phone,
        text,
        correlationId: "reservation-reject-ack",
        contextTitle: "Falha ao confirmar recusa",
        meta: { lead_id: result.lead.lead_id, load_id: result.lead.load_id },
      });
    }

    console.info(`[evolution.webhook] driver-reply intent=${result.intent} action=${result.action}`);

    // Fluxo pós-reserva: motorista aceitou (intent=accept) mas sem reserva
    // ativa. Duas possibilidades:
    //   (a) Ele já recebeu os detalhes de uma carga do envio em massa e agora
    //       está CONFIRMANDO → cria candidatura em load_public_leads +
    //       responde com o link do portal (troca de cavalo/carreta).
    //   (b) Primeira vez que ele responde → envia os detalhes (follow-up).
    if (result.intent === "accept" && result.action === "no_reservation") {
      try {
        // Nome do motorista (para personalizar) via motoristas_historico.
        const nomeMap = await withPgClient(async (client) => {
          try {
            const { rows } = await client.query(
              `SELECT nome FROM public.motoristas_historico WHERE cpf = $1 LIMIT 1`,
              [saved?.driver_key || ""],
            );
            return rows[0]?.nome || null;
          } catch {
            return null;
          }
        });

        // (a) Já enviou os detalhes → tenta criar candidatura.
        const awaiting = await withPgClient((client) =>
          findAwaitingCandidatura(client, {
            phone: msg.phone,
            driverKey: saved?.driver_key || null,
          }),
        );
        if (awaiting) {
          const loadId = awaiting.metadata?.detailedOffer?.loadId;
          if (loadId) {
            try {
              const created = await withPgClient(async (client) => {
                // Busca info da carga p/ compor a resposta.
                const { rows: cargoRows } = await client.query(
                  `SELECT id, origem, destino, data, horario FROM public.cargas WHERE id = $1`,
                  [loadId],
                );
                const cargo = cargoRows[0];
                if (!cargo) return { skip: true };

                const { lead, duplicate } = await createLeadFromMassAccept(client, {
                  loadId,
                  cpf: saved?.driver_key || null,
                  phone: msg.phone,
                });

                // Consulta externa (Angellira + ASPX) — não bloqueia a criação
                // do lead: grava resultado em validation_summary_json.
                let validation = null;
                try {
                  // Placas do próprio lead recém-criado/existente.
                  const { rows: leadRows } = await client.query(
                    `SELECT horse_plate, trailer_plate FROM public.load_public_leads WHERE id = $1`,
                    [lead.id],
                  );
                  const placas = leadRows[0] || {};
                  validation = await validateDriverAgainstExternal(client, {
                    cpf: saved?.driver_key || null,
                    horsePlate: placas.horse_plate || null,
                    trailerPlate: placas.trailer_plate || null,
                  });
                  const overall =
                    validation.angellira.motorista.vigente ? "VIGENTE" : "PENDENTE";
                  await client
                    .query(
                      `UPDATE public.load_public_leads
                          SET validation_status = $2,
                              validation_checked_at = now(),
                              validation_summary_json = $3::jsonb,
                              updated_at = now()
                        WHERE id = $1`,
                      [lead.id, overall, JSON.stringify(validation)],
                    )
                    .catch(() => {});
                } catch (vErr) {
                  console.warn("[evolution.webhook] mass-candidatura validation error:", vErr?.message);
                }

                // Cadastro pendente?
                const angVigente = Boolean(validation?.angellira?.motorista?.vigente);
                const regCheck = await checkRegistrationPending(client, {
                  cpf: saved?.driver_key || null,
                  angelliraVigente: angVigente,
                });

                await markMassConvertedToCandidatura(client, {
                  pendingId: awaiting.id,
                  leadId: lead.id,
                });
                await client.query(
                  `INSERT INTO public.operator_notifications (kind, title, body, metadata)
                   VALUES ('mass_candidatura_criada', $1, $2, $3::jsonb)`,
                  [
                    duplicate ? "Candidatura já existia (mass)" : "Nova candidatura via WhatsApp (mass)",
                    `${cargo.origem} → ${cargo.destino}` +
                      (angVigente ? " · Angellira ✅" : " · Angellira ⚠️") +
                      (regCheck.pending ? " · cadastro pendente" : ""),
                    JSON.stringify({
                      phone: msg.phone,
                      driver_key: saved?.driver_key || null,
                      load_id: loadId,
                      lead_id: lead.id,
                      duplicate,
                      angellira_vigente: angVigente,
                      aspx_found: Boolean(validation?.aspx?.found),
                      registration_pending: regCheck.pending,
                      registration_reason: regCheck.reason,
                    }),
                  ],
                );
                return {
                  duplicate,
                  cargo,
                  registrationPending: regCheck.pending,
                  registrationReason: regCheck.reason,
                };
              });
              if (!created.skip) {
                const text = composeMassCandidaturaConfirmMessage({
                  nome: nomeMap,
                  load: {
                    id: loadId,
                    origem: created.cargo.origem,
                    destino: created.cargo.destino,
                    dateIso: created.cargo.data
                      ? (created.cargo.data instanceof Date
                          ? created.cargo.data.toISOString().slice(0, 10)
                          : String(created.cargo.data).slice(0, 10))
                      : null,
                    horario: created.cargo.horario,
                  },
                  duplicate: created.duplicate,
                  registrationPending: created.registrationPending,
                  reason: created.registrationReason,
                });
                await sendReplyWithFallback({
                  phone: msg.phone,
                  text,
                  correlationId: "mass-candidatura",
                  contextTitle: "Falha ao confirmar candidatura",
                  meta: { load_id: loadId },
                });
                console.info(`[evolution.webhook] mass-candidatura ${created.duplicate ? "duplicate" : "created"} load=${loadId}`);
                return; // encerra: não passa para o fluxo (b)
              }
              // Fix 3: skip=true (carga da oferta detalhada sumiu — cancelada/deletada).
              const skipText = [
                `Poxa, ${greeting(nomeMap)}… essa carga não está mais disponível 😕`,
                "",
                "Mas fica tranquilo: assim que aparecer outra parecida, eu te chamo.",
                "Se preferir, me responde aqui contando a rota que você quer.",
              ].join("\n");
              await sendReplyWithFallback({
                phone: msg.phone,
                text: skipText,
                correlationId: "mass-candidatura-skip",
                contextTitle: "Carga do envio em massa não está mais disponível",
                meta: { attempted_load_id: loadId },
              });
              return;
            } catch (candErr) {
              console.warn("[evolution.webhook] mass-candidatura error:", candErr?.message);
            }
          }
        }

        // (b) Primeira resposta ao envio em massa → envia detalhes.
        const ctx = await withPgClient((client) =>
          findMassContextAndLoad(client, {
            phone: msg.phone,
            driverKey: saved?.driver_key || null,
          }),
        );
        if (ctx) {
          const text = ctx.load
            ? composeMassFollowUpMessage({ nome: nomeMap, load: ctx.load })
            : composeMassNoLoadMessage({ nome: nomeMap, rota: ctx.rota });
          const followUpResult = await sendReplyWithFallback({
            phone: msg.phone,
            text,
            correlationId: "mass-followup",
            contextTitle: "Falha ao enviar detalhes da carga",
            meta: { load_id: ctx.load?.id || null, rota: ctx.rota },
          });
          if (followUpResult.ok) {
            // Marca o envio como "detalhes enviados" — a próxima resposta SIM
            // dispara a criação da candidatura no fluxo (a).
            if (ctx.load && ctx.pendingId) {
              await withPgClient((client) =>
                markDetailedOfferSent(client, { pendingId: ctx.pendingId, loadId: ctx.load.id }),
              );
            }
            await withPgClient((client) =>
              client.query(
                `INSERT INTO public.operator_notifications (kind, title, body, metadata)
                 VALUES ('mass_reply_accept', $1, $2, $3::jsonb)`,
                [
                  ctx.load ? "Motorista topou carga do envio em massa" : "Interessado sem carga disponível",
                  ctx.load
                    ? `${ctx.load.origem} → ${ctx.load.destino}${ctx.load.dateIso ? ` · ${ctx.load.dateIso}` : ""}`
                    : `Rota: ${ctx.rota || "?"}`,
                  JSON.stringify({
                    phone: msg.phone,
                    driver_key: saved?.driver_key || null,
                    rota: ctx.rota,
                    load_id: ctx.load?.id || null,
                  }),
                ],
              ),
            );
            console.info("[evolution.webhook] mass-followup sent load=" + Boolean(ctx.load));
          }
          // Se não havia carga OPEN casando no ato, registra interesse pra
          // gente avisar depois assim que aparecer.
          if (!ctx.load && ctx.meta) {
            await registerReturnInterest({
              driverKey: saved?.driver_key || null,
              phone: msg.phone,
              nome: nomeMap,
              origem: ctx.meta.origem,
              destino: ctx.meta.destino,
              source: "mass_no_load",
            }).catch(() => {});
          }
          return;
        }

        // Fix 4: motorista disse "sim" mas não há reserva ativa NEM envio em
        // massa recente. Não deixar em silêncio — resposta genérica.
        const orphanText = [
          `Oi, ${greeting(nomeMap)}! 👋`,
          "",
          "Obrigado pela mensagem! Não achei aqui nenhum convite pendente para você agora.",
          "Se quiser saber sobre alguma rota específica, me conta que a equipe verifica pra você. 🚚",
        ].join("\n");
        await sendReplyWithFallback({
          phone: msg.phone,
          text: orphanText,
          correlationId: "reply-accept-orphan",
          contextTitle: "Motorista respondeu SIM sem contexto",
          meta: { driver_key: saved?.driver_key || null },
        });
      } catch (fuErr) {
        console.warn("[evolution.webhook] mass-followup error:", fuErr?.message);
      }
    }

    // Fix 5: motorista recusou mas sem reserva ativa e sem envio em massa.
    if (result.intent === "reject" && result.action === "no_reservation") {
      const nomeMap = await withPgClient(async (client) => {
        try {
          const { rows } = await client.query(
            `SELECT nome FROM public.motoristas_historico WHERE phone = $1 OR phone = $2 LIMIT 1`,
            [msg.phone, msg.phone.startsWith("55") ? msg.phone.slice(2) : msg.phone],
          ).catch(() => ({ rows: [] }));
          return rows[0]?.nome || null;
        } catch {
          return null;
        }
      });
      const text = [
        `Tudo bem, ${greeting(nomeMap)}. 👍`,
        "",
        "Obrigado por avisar! Se aparecer alguma carga que combine com você, eu te chamo.",
      ].join("\n");
      await sendReplyWithFallback({
        phone: msg.phone,
        text,
        correlationId: "reply-reject-orphan",
        contextTitle: "Motorista recusou sem contexto ativo",
        meta: { driver_key: saved?.driver_key || null },
      });
    }
  } catch (err) {
    console.warn("[evolution.webhook] handleDriverReply error:", err?.message);
  }
}

// ─── Notificações do operador ────────────────────────────────────────────────

/** GET /api/operator/notifications */
export async function resolveOperatorNotificationsListResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "operator:read", "Somente operadores podem ver notificações.");
    const payload = await listOperatorNotifications({ limit: (request.query || {}).limit });
    return { statusCode: 200, payload: { ...payload, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** POST /api/operator/notifications/clear  { ids?: string[], all?: true } */
export async function resolveOperatorNotificationsClearResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "operator:read", "Somente operadores podem limpar notificações.");
    const body = (await parseJsonBody(request)) || {};
    const payload = await deleteOperatorNotifications({ ids: body.ids, all: body.all });
    return { statusCode: 200, payload: { ok: true, ...payload, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** POST /api/operator/notifications/seen  { ids?: string[], all?: true } */
export async function resolveOperatorNotificationsSeenResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "operator:read", "Somente operadores podem marcar notificações.");
    const body = (await parseJsonBody(request)) || {};
    const payload = body.all ? await markAllNotificationsSeen() : await markNotificationsSeen(body.ids);
    return { statusCode: 200, payload: { ok: true, ...payload, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

// ─── Chat WhatsApp ───────────────────────────────────────────────────────────

/** GET /api/operator/chat/conversations?search=... */
export async function resolveChatConversationsResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "operator:read", "Somente operadores podem ver o chat.");
    const q = request.query || {};
    const payload = await listWhatsappConversations({ search: q.search, limit: q.limit });
    return { statusCode: 200, payload: { ...payload, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** GET /api/operator/chat/messages?phone=... */
export async function resolveChatMessagesResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "operator:read", "Somente operadores podem ver o chat.");
    const q = request.query || {};
    const payload = await listWhatsappMessages({ phone: q.phone, limit: q.limit });
    return { statusCode: 200, payload: { ...payload, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** POST /api/operator/chat/send  { phone, text } */
export async function resolveChatSendResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem enviar mensagens.");
    const body = (await parseJsonBody(request)) || {};
    const payload = await sendManualChatMessage(body);
    return { statusCode: 200, payload: { ...payload, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

// ─── Envio em massa ──────────────────────────────────────────────────────────

/** GET /api/operator/mass-outreach/routes */
export async function resolveMassRoutesResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "operator:read", "Somente operadores podem ver rotas.");
    const payload = await listMassOutreachRoutes({ limit: (request.query || {}).limit });
    return { statusCode: 200, payload: { ...payload, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** POST /api/operator/mass-outreach/preview  { audience, routes? } */
export async function resolveMassPreviewResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "operator:read", "Somente operadores podem prever envios.");
    const body = (await parseJsonBody(request)) || {};
    const payload = await previewMassAudience(body);
    return { statusCode: 200, payload: { ...payload, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/** POST /api/operator/mass-outreach/enqueue  { audience, routes?, message } */
export async function resolveMassEnqueueResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(user, "leads:write", "Somente operadores com acesso intermediário podem disparar envio em massa.");
    const body = (await parseJsonBody(request)) || {};
    const payload = await enqueueMassOutreach(body);
    return { statusCode: 201, payload: { ok: true, ...payload, meta: { correlationId } } };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}
