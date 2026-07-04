import { createSupabaseAdminClient } from "../../infrastructure/supabase/admin-client.js";

// Endpoints do card BRK (Brasil Risk) na tela Motoristas — espelha o card ASPX/SPX
// (application/aspx/aspx-admin.js). O BRK fica atrás do Cloudflare e não tem login
// programático; o cookie é obtido 1x de um Chrome logado (export do Cookie-Editor)
// e colado aqui. Esta é a fonte de verdade que o robô :5010 (lib/brasilrisk_consulta.js)
// lê para consultar aptidão.
//   - getBrkSyncStatus()  -> TTL do cookie em brk_credentials + última consulta BRK.
//   - updateBrkCookies()  -> normaliza o cole e grava em brk_credentials.

// Cookies de autenticação REAL do BRSystem (cf_clearance é do Cloudflare, não "auth").
const BRK_AUTH_COOKIE_NAMES = ["cokiename", "ASPXAUTH", "CodUsuario"];
const BRK_COOKIE_DOMAINS = ["brasilrisk.com.br"];
// TTL rolante do cookie (proxy de validade no card). O keep-alive do :5010 mantém a
// sessão viva; quando o cf_clearance morre de vez (~dias), o operador recola.
const BRK_COOKIE_ROLLING_TTL_SECONDS = Number(process.env.BRK_COOKIE_ROLLING_TTL_SEC) || 24 * 60 * 60;

function isBrkAuthCookie(name) {
  return BRK_AUTH_COOKIE_NAMES.some((n) => name.toLowerCase() === n.toLowerCase());
}

function badRequest(message, code, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

export async function getBrkSyncStatus() {
  const supabase = createSupabaseAdminClient();

  const [credsResult, lastCheckResult, countResult] = await Promise.all([
    supabase
      .from("brk_credentials")
      .select("cookies_expires_at, cookies_updated_at, user_agent, cookies_json")
      .eq("id", 1)
      .maybeSingle(),
    supabase
      .from("driver_profiles")
      .select("brk_checked_at")
      .not("brk_checked_at", "is", null)
      .order("brk_checked_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("driver_profiles")
      .select("*", { count: "exact", head: true })
      .not("brk_checked_at", "is", null),
  ]);

  if (credsResult.error) {
    throw new Error(`BRK_STATUS_CREDS_FAILED:${credsResult.error.message}`);
  }
  // lastCheck/count são informativos — nunca derrubam o status do cookie.
  const cookiesJson = credsResult.data?.cookies_json;
  const cookieCount =
    cookiesJson && typeof cookiesJson === "object" ? Object.keys(cookiesJson).length : 0;
  const cookiesExpiresAt = credsResult.data?.cookies_expires_at || null;
  const cookiesUpdatedAt = credsResult.data?.cookies_updated_at || null;
  const nowMs = Date.now();
  const expiresMs = cookiesExpiresAt ? new Date(cookiesExpiresAt).getTime() : null;

  return {
    statusCode: 200,
    payload: {
      ok: true,
      cookies: {
        expiresAt: cookiesExpiresAt,
        updatedAt: cookiesUpdatedAt,
        expired: expiresMs === null ? true : expiresMs <= nowMs,
        secondsRemaining: expiresMs === null ? 0 : Math.max(0, Math.floor((expiresMs - nowMs) / 1000)),
        count: cookieCount,
        hasUserAgent: Boolean(credsResult.data?.user_agent),
      },
      drivers: {
        withBrk: countResult.error ? 0 : countResult.count || 0,
        lastCheckedAt: lastCheckResult.error ? null : lastCheckResult.data?.brk_checked_at || null,
      },
      serverTime: new Date(nowMs).toISOString(),
    },
  };
}

/**
 * Normaliza o cole do operador — export do Cookie-Editor (array), objeto {nome: valor}
 * ou o header Cookie cru ("a=1; b=2") — para { cookies, userAgent, expiresAtIso }.
 * Filtra o domínio do BRK, descarta cookies expirados e exige ao menos um cookie de
 * autenticação real (cokiename/ASPXAUTH/CodUsuario). Lança erro amigável se faltar.
 */
export function normalizeBrkCookies(input, userAgentInput) {
  let raw = input;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        raw = JSON.parse(trimmed);
      } catch {
        throw badRequest("Os cookies colados não são um JSON válido.", "BRK_COOKIES_INVALID_JSON");
      }
    } else if (trimmed.includes("=")) {
      // Header Cookie cru (DevTools → Copy → Copy request headers).
      const obj = {};
      for (const part of trimmed.split(";")) {
        const p = part.trim();
        const eq = p.indexOf("=");
        if (eq > 0) obj[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
      }
      raw = obj;
    } else {
      throw badRequest("Formato de cookies não reconhecido.", "BRK_COOKIES_BAD_FORMAT");
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray(raw.cookies)) {
    raw = raw.cookies;
  }

  const nowSec = Date.now() / 1000;
  const cookies = {};

  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (!c || typeof c !== "object") continue;
      const name = typeof c.name === "string" ? c.name.trim() : "";
      const value = c.value;
      if (!name || value == null) continue;
      const domain = String(c.domain || "").toLowerCase().replace(/^\./, "");
      if (domain && !BRK_COOKIE_DOMAINS.some((d) => domain === d || domain.endsWith(d))) continue;
      const exp = Number(c.expirationDate ?? c.expires ?? 0);
      if (exp && exp > 0 && exp < nowSec) continue; // já expirado — pula
      cookies[name] = String(value);
    }
  } else if (raw && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw)) {
      if (value == null) continue;
      const clean = String(name).trim();
      if (clean) cookies[clean] = String(value);
    }
  } else {
    throw badRequest(
      "Formato de cookies não reconhecido (esperado o array do Cookie-Editor, {nome: valor} ou o header Cookie).",
      "BRK_COOKIES_BAD_FORMAT",
    );
  }

  if (!Object.keys(cookies).some(isBrkAuthCookie)) {
    throw badRequest(
      "Nenhum cookie de autenticação do BRK encontrado (ex.: cokiename, ASPXAUTH). " +
        "Confirme que você está logado no br2.brasilrisk.com.br e exportou os cookies desse domínio.",
      "BRK_COOKIES_NO_AUTH",
      422,
    );
  }

  const userAgent =
    typeof userAgentInput === "string" && userAgentInput.trim() ? userAgentInput.trim() : null;
  const expiresAtIso = new Date(Date.now() + BRK_COOKIE_ROLLING_TTL_SECONDS * 1000).toISOString();

  return {
    cookies,
    userAgent,
    expiresAtIso,
    count: Object.keys(cookies).length,
    hasCfClearance: Object.keys(cookies).some((n) => /cf_clearance/i.test(n)),
  };
}

export async function updateBrkCookies({ cookiesJson, userAgent, correlationId } = {}) {
  const { cookies, userAgent: ua, expiresAtIso, count, hasCfClearance } = normalizeBrkCookies(
    cookiesJson,
    userAgent,
  );

  const supabase = createSupabaseAdminClient();
  const nowIso = new Date().toISOString();
  const patch = {
    cookies_json: cookies,
    cookies_expires_at: expiresAtIso,
    cookies_updated_at: nowIso,
    updated_at: nowIso,
  };
  if (ua) patch.user_agent = ua;

  const { error } = await supabase.from("brk_credentials").update(patch).eq("id", 1);
  if (error) {
    throw new Error(`BRK_COOKIES_UPDATE_FAILED:${error.message}`);
  }

  return {
    statusCode: 200,
    payload: {
      ok: true,
      cookies: {
        count,
        expiresAt: expiresAtIso,
        updatedAt: nowIso,
        hasCfClearance,
        userAgentSet: Boolean(ua),
      },
      // O robô :5010 (SERVERBD) lê o cookie do Supabase no próximo ciclo — sem cf_clearance,
      // a consulta pode tomar 403 no Cloudflare.
      warning: hasCfClearance
        ? null
        : "Sem cf_clearance no cole — a consulta pode falhar no Cloudflare. Exporte TODOS os cookies do br2.brasilrisk.com.br.",
      meta: { correlationId: correlationId || null },
    },
  };
}
