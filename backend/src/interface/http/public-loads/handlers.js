import "../../../infrastructure/config/load-env.js";

import { z, ZodError } from "zod";

import { syncGoogleSheetLoads } from "../../../application/google-sheets/google-sheet-loads.js";
import { createSupabaseAdminClient } from "../../../infrastructure/supabase/admin-client.js";
import {
  LoadClaimServiceError,
  NotFoundError,
  ValidationError,
} from "../../../domain/load-claims/errors.js";
import {
  buildInternalErrorResponse,
  buildServiceErrorResponse,
  buildValidationErrorResponse,
} from "../error-mapping.js";
import { zodErrorToHttpResponse } from "../schemas/common.js";
import { getCorrelationId, getQueryParam, getRequestIp } from "../http-utils.js";
import {
  fetchDriverLoadFacets,
  fetchDriverLoadsReadModel,
  getHealthSnapshot,
} from "../../../application/operator-admin/service.js";
import { fetchDriverCargoDetail } from "../../../application/operator-admin/use-cases/dashboard-read-model.js";
import { isMissingAgendaAConfirmarColumnError } from "../../../application/operator-admin/use-cases/_shared.js";
import { getPublicPacote } from "../../../application/cargas-casadas/service.js";
import { pacoteIdParamsSchema } from "../../../domain/cargas-casadas/schemas.js";
import { recordDriverPortalVisit } from "../../../domain/operator-admin/driver-flow-metrics.js";
import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";

const PORTAL_VISIT_RATE_LIMIT_MS = 30_000;
const portalVisitRateLimitByIp = new Map();

// MD-02: cleanup periódico para evitar crescimento ilimitado com IPs dinâmicos (CGNAT/mobile)
setInterval(() => {
  const cutoff = Date.now() - PORTAL_VISIT_RATE_LIMIT_MS;
  for (const [key, value] of portalVisitRateLimitByIp) {
    if (value < cutoff) portalVisitRateLimitByIp.delete(key);
  }
}, 60_000).unref();

function isPortalVisitRateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  const lastSeen = portalVisitRateLimitByIp.get(ip);
  if (lastSeen && now - lastSeen < PORTAL_VISIT_RATE_LIMIT_MS) {
    return true;
  }
  portalVisitRateLimitByIp.set(ip, now);
  if (portalVisitRateLimitByIp.size > 5000) {
    const cutoff = now - PORTAL_VISIT_RATE_LIMIT_MS;
    for (const [key, value] of portalVisitRateLimitByIp) {
      if (value < cutoff) portalVisitRateLimitByIp.delete(key);
    }
  }
  return false;
}

const DRIVER_LOADS_SHEET_STALE_AFTER_MS = Math.max(
  Number.parseInt(process.env.PUBLIC_DRIVER_LOADS_SHEET_STALE_AFTER_MS || "", 10) || 7 * 60_000,
  60_000,
);
const DRIVER_LOADS_SHEET_CHECK_COOLDOWN_MS = Math.max(
  Number.parseInt(process.env.PUBLIC_DRIVER_LOADS_SHEET_CHECK_COOLDOWN_MS || "", 10) || 45_000,
  15_000,
);

let driverLoadsSheetRefreshPromise = null;
let lastDriverLoadsSheetRefreshCheckAt = 0;

function toErrorResponse(error, correlationId) {
  if (error instanceof ValidationError) {
    return buildValidationErrorResponse(error, correlationId);
  }
  return buildInternalErrorResponse(
    correlationId,
    "Unexpected error while processing the public load request.",
  );
}

function hasAutomaticDriverLoadsSheetRefreshSupport() {
  const supabaseUrl = process.env.SUPABASE_URL?.trim() || process.env.VITE_SUPABASE_URL?.trim();
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SECRET_KEY?.trim();

  return Boolean(supabaseUrl && serviceRoleKey);
}

function parseSheetSyncTimestamp(value) {
  if (!value) {
    return null;
  }

  const parsedTimestamp = new Date(value);
  return Number.isNaN(parsedTimestamp.getTime()) ? null : parsedTimestamp;
}

async function fetchLatestSheetSyncTimestamp(supabaseClient) {
  const { data, error } = await supabaseClient
    .from("cargas")
    .select("sheet_synced_at")
    .not("sheet_lh", "is", null)
    .order("sheet_synced_at", { ascending: false })
    .limit(1);

  if (error) {
    throw error;
  }

  return parseSheetSyncTimestamp(data?.[0]?.sheet_synced_at);
}

export async function ensureDriverLoadsSheetFresh({
  now = Date.now(),
  createClient = createSupabaseAdminClient,
  syncLoads = syncGoogleSheetLoads,
} = {}) {
  if (!hasAutomaticDriverLoadsSheetRefreshSupport()) {
    return false;
  }

  // Já há um refresh em voo: NÃO entra na fila dele. Antes era
  // `await driverLoadsSheetRefreshPromise`, então qualquer request que caísse na janela
  // do sync pagava o tempo restante dele (ver a nota de medição abaixo).
  if (driverLoadsSheetRefreshPromise) {
    return false;
  }

  if (now - lastDriverLoadsSheetRefreshCheckAt < DRIVER_LOADS_SHEET_CHECK_COOLDOWN_MS) {
    return false;
  }

  lastDriverLoadsSheetRefreshCheckAt = now;

  try {
    const supabaseClient = createClient();
    const latestSheetSyncTimestamp = await fetchLatestSheetSyncTimestamp(supabaseClient);

    if (
      latestSheetSyncTimestamp &&
      now - latestSheetSyncTimestamp.getTime() < DRIVER_LOADS_SHEET_STALE_AFTER_MS
    ) {
      return false;
    }

    // CR-01: captura a promise em variável local antes do .finally zerá-la,
    // evitando race condition onde uma request subsequente vê null e dispara sync duplo.
    const syncPromise = Promise.resolve(
      syncLoads({
        supabaseClient,
      }),
    )
      .catch((error) => {
        console.error("[driver-loads-sheet-sync]", {
          name: error?.name,
          code: error?.code,
          message: error?.message,
        });
      })
      .finally(() => {
        driverLoadsSheetRefreshPromise = null;
        lastDriverLoadsSheetRefreshCheckAt = Date.now();
      });

    driverLoadsSheetRefreshPromise = syncPromise;
    // STALE-WHILE-REVALIDATE DE VERDADE: dispara o sync e devolve JÁ, sem esperar.
    //
    // Antes havia `await syncPromise` aqui. Os três chamadores
    // (`/api/operator/cargas`, dashboard do operador e `/api/driver/loads`) já
    // documentavam a intenção — "serve dados atuais agora, próxima request reflete o
    // sync" — mas o código esperava o sync INTEIRO terminar. Medido em produção
    // 07/08/2026 pelos próprios logs do `sheet-sync-periodic`: 9.775 ms e 12.068 ms.
    // Ou seja, a request que disparasse o refresh travava ~10-12 s antes de responder.
    //
    // Intermitente por construção — só dispara quando o snapshot passa de
    // DRIVER_LOADS_SHEET_STALE_AFTER_MS (7 min) e fora do cooldown de 45 s. É
    // exatamente o "ÀS VEZES demora bastante" que o operador relatou: na maior parte
    // dos cliques o sync periódico mantém o snapshot fresco e nada acontece; quando ele
    // atrasa, o próximo a abrir a tela paga a conta.
    //
    // O erro do sync continua tratado dentro de `syncPromise` (o `.catch` acima), então
    // não há rejeição não-tratada por não aguardar aqui. Nenhum chamador usa o retorno.
    void syncPromise;
    return true;
  } catch (error) {
    console.error("[driver-loads-sheet-sync-check]", {
      name: error?.name,
      code: error?.code,
      message: error?.message,
    });
    return false;
  }
}

export function resetDriverLoadsSheetRefreshStateForTests() {
  driverLoadsSheetRefreshPromise = null;
  lastDriverLoadsSheetRefreshCheckAt = 0;
}

export async function resolveDriverLoadsReadModelResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    await ensureDriverLoadsSheetFresh();

    return await fetchDriverLoadsReadModel({
      query: request.query || {},
      correlationId,
    });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

/**
 * GET /api/driver/cargas/:cargoId — detalhe de UMA carga para o portal.
 *
 * Anônimo (sem driver auth), como /api/driver/loads. Substitui as leituras
 * diretas que a tela DriverCargoDetails fazia no banco com a chave anônima
 * (cargas + clientes + route_metrics_cache + fallback de distância): agora é
 * uma resposta cacheada por carga, e o navegador não fala mais com o pooler.
 *
 * Visibilidade: só carga em OPEN/RESERVED/BOOKED — mesma policy anônima de
 * public.cargas. Fora disso → 404 (indistinguível de carga inexistente).
 * cargoId não-UUID → 400.
 */
const driverCargoIdParamsSchema = z.object({
  cargoId: z.string().uuid("cargoId deve ser um UUID."),
});

export async function resolveDriverCargoDetailResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const { cargoId } = driverCargoIdParamsSchema.parse({
      cargoId: getQueryParam(request, "cargoId"),
    });

    return await fetchDriverCargoDetail({ cargoId, correlationId });
  } catch (error) {
    if (error instanceof ZodError) {
      return zodErrorToHttpResponse(error, correlationId);
    }
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveDriverLoadFacetsResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    return await fetchDriverLoadFacets({
      correlationId,
    });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveDriverPortalVisitResponse(request) {
  const correlationId = getCorrelationId(request);
  const requestIp = getRequestIp(request);

  if (isPortalVisitRateLimited(requestIp)) {
    return {
      statusCode: 200,
      payload: { ok: true, rateLimited: true, meta: { correlationId } },
    };
  }

  try {
    await recordDriverPortalVisit({ requestIp, correlationId });

    return {
      statusCode: 200,
      payload: { ok: true, meta: { correlationId } },
    };
  } catch (err) {
    console.error("[portal-visit] falha ao registrar visita:", err?.message);
    return {
      statusCode: 200,
      payload: { ok: false, meta: { correlationId } },
    };
  }
}

export async function resolveHealthResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const deep = getQueryParam(request, "deep") === "true";
    return await getHealthSnapshot({
      correlationId,
      deep,
    });
  } catch (error) {
    return {
      statusCode: 503,
      payload: {
        ok: false,
        error: "ServiceUnavailable",
        code: "SERVICE_UNAVAILABLE",
        message: "Healthcheck failed.",
        meta: {
          correlationId,
        },
      },
    };
  }
}

export async function resolveDriverSponsorClickResponse(request) {
  const correlationId = getCorrelationId(request);
  const brand = request.body?.brand;

  if (!brand || typeof brand !== "string") {
    return { statusCode: 400, payload: { error: "MISSING_BRAND", meta: { correlationId } } };
  }

  try {
    await withPgClient(async (client) => {
      await client.query(
        "INSERT INTO public.analytics_events (event_type, data) VALUES ($1, $2)",
        ["SPONSOR_CLICK", JSON.stringify({ brand: brand.slice(0, 120) })],
      );
    });
    return { statusCode: 200, payload: { ok: true, meta: { correlationId } } };
  } catch {
    // fire-and-forget: don't fail the request if analytics write fails
    return { statusCode: 200, payload: { ok: false, meta: { correlationId } } };
  }
}

// Sonda barata de "mudou algo?" para o portal público do motorista.
// Digest = MAX(updated_at) + contagem das cargas OPEN PUBLIC. Quando o digest muda, o
// portal invalida a query /api/driver/loads-read-model. Sem auth: igual /api/driver/loads.
//
// CACHE + SINGLE-FLIGHT (janela curta): o portal passou a sondar a cada 30 s (antes 5 min)
// para a carga marcada como "Disponível" aparecer em segundos e não em minutos. Sem o
// cache, encurtar o intervalo multiplicaria por 10 o número de queries por motorista
// simultâneo — e o read model do motorista já foi o maior consumidor de egress do pooler
// num incidente anterior. Com a janela, N motoristas sondando juntos colapsam em UMA
// query, então o custo no banco fica praticamente o mesmo de antes, com 10x menos latência
// de percepção.
//
// A janela é curta de propósito (2 s): ela existe para colapsar rajadas concorrentes, não
// para segurar novidade. O atraso que ela adiciona é irrelevante ao lado do intervalo de
// sondagem, e mantém o digest como fonte de verdade vinda do banco — o que é necessário,
// já que quem muda a carga pode ser o sync da planilha, e não só a API.
const DRIVER_LOADS_DIGEST_CACHE_TTL_MS = Math.max(
  Number.parseInt(process.env.PUBLIC_DRIVER_LOADS_DIGEST_TTL_MS || "", 10) || 2_000,
  0,
);
let _digestCache = null; // { at: number, digest: string }
let _digestInFlight = null;

/** Zera o cache do digest — só para os testes não vazarem estado entre casos. */
export function resetDriverLoadsDigestCacheForTests() {
  _digestCache = null;
  _digestInFlight = null;
}

export async function resolveDriverLoadsDigestResponse(request) {
  const correlationId = getCorrelationId(request);

  // Janela de cache: serve o digest recém-calculado sem tocar o banco.
  const agora = Date.now();
  if (_digestCache && agora - _digestCache.at < DRIVER_LOADS_DIGEST_CACHE_TTL_MS) {
    return { statusCode: 200, payload: { digest: _digestCache.digest, meta: { correlationId, cached: true } } };
  }
  // Single-flight: uma rajada concorrente compartilha a query em andamento.
  if (_digestInFlight) {
    try {
      const digest = await _digestInFlight;
      return { statusCode: 200, payload: { digest, meta: { correlationId, cached: true } } };
    } catch {
      // A dona da promise já trata e responde 503; aqui só não propaga o erro dela.
      return { statusCode: 503, payload: { error: "SERVICE_UNAVAILABLE", meta: { correlationId } } };
    }
  }

  try {
    const promise = withPgClient(async (client) => {
      // Cruza com a planilha (sheet_motorista) para que o digest nao conte
      // cargas ja alocadas no Google Sheets — caso o sync atrase, o frontend
      // nao dispara invalidacao para cargas que ja estao fechadas. Filtro de
      // sheet_status removido (era over-broad).
      // Iter #8: filtra cargas expiradas (data + horario passados) — pg-mem nao
      // suporta CURRENT_DATE/CURRENT_TIME, entao parameterizamos.
      // "Agora" no fuso de Sao Paulo (container roda em UTC; data/horario sao BRT).
      const { dateIso: todayIso, timeIso: nowTimeIso } = getSaoPauloWallClock();
      // Exceção "A confirmar": carga com agenda indefinida (placeholder hoje/00:00 +
      // agenda_a_confirmar) aparece na lista — tem que entrar no digest também, senão
      // o portal não invalida o cache quando uma dessas é lançada/alterada.
      const digestSql = (comExcecaoAConfirmar = true) => `
        SELECT
          COALESCE(EXTRACT(EPOCH FROM MAX(updated_at))::bigint, 0) AS ts,
          COUNT(*)::bigint                                          AS cnt
        FROM public.cargas
        WHERE status = 'OPEN'
          AND COALESCE(driver_visibility, 'PUBLIC') = 'PUBLIC'
          AND COALESCE(is_template, false) = false
          AND COALESCE(alloc_motorista, sheet_motorista, '') = ''
          AND (data IS NULL OR data > $1 OR (data = $2 AND (horario IS NULL OR horario >= $3))${
            comExcecaoAConfirmar ? " OR COALESCE(agenda_a_confirmar, false) = true" : ""
          })
      `;
      let rows;
      try {
        ({ rows } = await client.query(digestSql(), [todayIso, todayIso, nowTimeIso]));
      } catch (digestError) {
        // Banco sem a coluna da flag → digest sem a exceção (degrada, não derruba).
        if (!isMissingAgendaAConfirmarColumnError(digestError)) throw digestError;
        ({ rows } = await client.query(digestSql(false), [todayIso, todayIso, nowTimeIso]));
      }
      const r = rows[0] || {};
      return `${r.ts}:${r.cnt}`;
    });
    _digestInFlight = promise;

    let digest;
    try {
      digest = await promise;
    } finally {
      // Libera o single-flight SEMPRE — se ficasse preso numa promise rejeitada, todo
      // sondador seguinte herdaria o erro para sempre.
      _digestInFlight = null;
    }
    _digestCache = { at: Date.now(), digest };

    return {
      statusCode: 200,
      payload: { digest, meta: { correlationId } },
    };
  } catch (err) {
    console.error("[driver-loads-digest] erro ao calcular digest:", err?.message);
    return {
      statusCode: 503,
      payload: { error: "SERVICE_UNAVAILABLE", meta: { correlationId } },
    };
  }
}

/**
 * GET /api/driver/pacotes/:pacoteId — Phase 10 (cargas-casadas)
 *
 * Anonimo (sem driver auth) — espelha resolveDriverLoadsReadModelResponse.
 * Retorna pacote completo + cargas ordenadas APENAS quando o pacote esta em
 * status publicado/reservado/em_andamento. Outros status (incluindo rascunho,
 * concluido, cancelado, ou pacoteId inexistente) -> 404 com mesma mensagem
 * para nao vazar informacao (T-10-20).
 *
 * Validacao do pacoteId via pacoteIdParamsSchema (UUID strict) — pacoteId
 * invalido -> 400.
 */
export async function resolveGetPublicPacoteResponse(request) {
  const correlationId = getCorrelationId(request);
  try {
    const { pacoteId } = pacoteIdParamsSchema.parse({
      pacoteId: getQueryParam(request, "pacoteId"),
    });
    return await getPublicPacote({ pacoteId, correlationId });
  } catch (error) {
    if (error instanceof ZodError) {
      return zodErrorToHttpResponse(error, correlationId);
    }
    if (error instanceof NotFoundError) {
      return buildServiceErrorResponse(error, correlationId);
    }
    if (error instanceof ValidationError) {
      return buildValidationErrorResponse(error, correlationId);
    }
    if (error instanceof LoadClaimServiceError) {
      return buildServiceErrorResponse(error, correlationId);
    }
    return buildInternalErrorResponse(
      correlationId,
      "Unexpected error while loading the pacote.",
    );
  }
}
