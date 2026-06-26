import { createSupabaseAdminClient } from "../../infrastructure/supabase/admin-client.js";

// Contrato dos endpoints do card ASPx na tela Motoristas:
//  - getAspxSyncStatus()  -> metadados da tabela aspx_drivers + TTL dos cookies
//    cacheados em public.aspx_credentials.
//  - getAspxSyncHealth()  -> resumo operacional (idade do ultimo sync, severidade)
//    consumivel pelo dashboard / Prometheus. Sem TTL detalhado de cookies.
//  - triggerAspxSync()    -> dispara o workflow aspx-sync.yml no GitHub Actions.
//    O Action nao faz login (IP do GH e bloqueado pelo portal); ele apenas
//    reutiliza os cookies ja gravados em aspx_credentials para chamar a API e
//    fazer UPSERT em aspx_drivers. A renovacao dos cookies continua sendo
//    manual, rodando o asp.py na maquina do operador.

// Thresholds de severidade do health endpoint (segundos).
// stale_warning: > 6h sem sync -> warning amarelo.
// stale_critical: > 24h sem sync -> critical vermelho (motoristas novos invisiveis).
export const ASPX_HEALTH_STALE_WARNING_SECONDS = 6 * 60 * 60;
export const ASPX_HEALTH_STALE_CRITICAL_SECONDS = 24 * 60 * 60;

const DEFAULT_GITHUB_OWNER = "antoniocesar-dev";
const DEFAULT_GITHUB_REPO = "lamonica-cargas-platform";
const DEFAULT_WORKFLOW_FILE = "aspx-sync.yml";
const DEFAULT_REF = "main";

function resolveGithubConfig() {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    const err = new Error("GITHUB_TOKEN nao configurado no servidor.");
    err.code = "GITHUB_TOKEN_MISSING";
    throw err;
  }
  return {
    token,
    owner: process.env.GITHUB_OWNER?.trim() || DEFAULT_GITHUB_OWNER,
    repo: process.env.GITHUB_REPO?.trim() || DEFAULT_GITHUB_REPO,
    workflowFile: process.env.GITHUB_ASPX_SYNC_WORKFLOW?.trim() || DEFAULT_WORKFLOW_FILE,
    ref: process.env.GITHUB_ASPX_SYNC_REF?.trim() || DEFAULT_REF,
  };
}

export async function getAspxSyncStatus() {
  const supabase = createSupabaseAdminClient();

  const [credsResult, countResult, lastSyncResult] = await Promise.all([
    supabase
      .from("aspx_credentials")
      .select("cookies_expires_at, cookies_updated_at")
      .eq("id", 1)
      .maybeSingle(),
    supabase.from("aspx_drivers").select("*", { count: "exact", head: true }),
    supabase
      .from("aspx_drivers")
      .select("synced_at")
      .order("synced_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (credsResult.error) {
    throw new Error(`ASPX_STATUS_CREDS_FAILED:${credsResult.error.message}`);
  }
  if (countResult.error) {
    throw new Error(`ASPX_STATUS_COUNT_FAILED:${countResult.error.message}`);
  }
  if (lastSyncResult.error) {
    throw new Error(`ASPX_STATUS_LAST_SYNC_FAILED:${lastSyncResult.error.message}`);
  }

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
      },
      drivers: {
        total: countResult.count || 0,
        lastSyncAt: lastSyncResult.data?.synced_at || null,
      },
      serverTime: new Date(nowMs).toISOString(),
    },
  };
}

/**
 * Resumo de saude operacional do sync ASPx — consumivel por dashboard e
 * alertas. Diferente de getAspxSyncStatus(): nao expoe TTL de cookies, foca
 * em "ha quanto tempo o ultimo motorista foi sincronizado?".
 *
 * Severidade derivada:
 *  - secondsSinceSync <= 6h  -> "ok"
 *  - 6h < secondsSinceSync <= 24h -> "warning"
 *  - secondsSinceSync > 24h  -> "critical"
 *
 * Quando a tabela aspx_drivers esta vazia, retorna severity=critical com
 * lastSyncAt=null (sistema nunca sincronizou).
 *
 * @returns {Promise<{ statusCode: 200, payload: { ok, totalDrivers, lastSyncAt,
 *   secondsSinceSync, hoursSinceSync, isStale, severity, serverTime } }>}
 */
export async function getAspxSyncHealth() {
  const supabase = createSupabaseAdminClient();

  const [countResult, lastSyncResult] = await Promise.all([
    supabase.from("aspx_drivers").select("*", { count: "exact", head: true }),
    supabase
      .from("aspx_drivers")
      .select("synced_at")
      .order("synced_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (countResult.error) {
    throw new Error(`ASPX_HEALTH_COUNT_FAILED:${countResult.error.message}`);
  }
  if (lastSyncResult.error) {
    throw new Error(`ASPX_HEALTH_LAST_SYNC_FAILED:${lastSyncResult.error.message}`);
  }

  const totalDrivers = countResult.count || 0;
  const lastSyncAt = lastSyncResult.data?.synced_at || null;
  const nowMs = Date.now();
  const lastSyncMs = lastSyncAt ? new Date(lastSyncAt).getTime() : null;
  const secondsSinceSync =
    lastSyncMs === null ? null : Math.max(0, Math.floor((nowMs - lastSyncMs) / 1000));

  let severity;
  let isStale;
  if (secondsSinceSync === null) {
    severity = "critical";
    isStale = true;
  } else if (secondsSinceSync > ASPX_HEALTH_STALE_CRITICAL_SECONDS) {
    severity = "critical";
    isStale = true;
  } else if (secondsSinceSync > ASPX_HEALTH_STALE_WARNING_SECONDS) {
    severity = "warning";
    isStale = true;
  } else {
    severity = "ok";
    isStale = false;
  }

  return {
    statusCode: 200,
    payload: {
      ok: true,
      totalDrivers,
      lastSyncAt,
      secondsSinceSync,
      hoursSinceSync:
        secondsSinceSync === null ? null : Math.round(secondsSinceSync / 3600),
      isStale,
      severity,
      thresholds: {
        warningSeconds: ASPX_HEALTH_STALE_WARNING_SECONDS,
        criticalSeconds: ASPX_HEALTH_STALE_CRITICAL_SECONDS,
      },
      serverTime: new Date(nowMs).toISOString(),
    },
  };
}

export async function triggerAspxSync({ correlationId } = {}) {
  const { token, owner, repo, workflowFile, ref } = resolveGithubConfig();

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lamonica-cargas-platform",
    },
    body: JSON.stringify({ ref }),
  });

  if (response.status !== 204) {
    const text = await response.text().catch(() => "");
    const err = new Error(
      `GITHUB_DISPATCH_FAILED:${response.status}:${text.slice(0, 200)}`,
    );
    err.code = "GITHUB_DISPATCH_FAILED";
    err.statusCode = response.status;
    throw err;
  }

  return {
    statusCode: 202,
    payload: {
      ok: true,
      dispatchedAt: new Date().toISOString(),
      workflow: workflowFile,
      ref,
      meta: { correlationId: correlationId || null },
    },
  };
}

// ── Atualização manual de cookies (cole do Cookie-Editor) ────────────────────
// O SPX não tem login programático (SSO HTTPOnly + captcha + App-Bound Encryption
// do Chrome), então a sessão é mantida viva pela rotação de cookies no spx-bot.
// Quando o SSO morre de vez, o operador cola aqui o export dos cookies do seu
// Chrome logado — esta é a fonte de verdade que o spx-bot e o sync ASPX leem.

const SPX_AUTH_PREFIXES = [
  "spx_cid", "fms_user_skey", "fms_user_id", "spx_uk", "spx_uid", "spx_st",
  "SPC_", "_csrftoken", "SC_SESSION", "scfe_",
];
const SPX_COOKIE_DOMAINS = ["myagencyservice.com.br"];
const COOKIE_ROLLING_TTL_SECONDS = 14 * 60 * 60;

function isAuthLikeCookie(name) {
  return SPX_AUTH_PREFIXES.some((p) => name === p || name.startsWith(p));
}

function badRequest(message, code, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

/**
 * Normaliza o que o operador colou — export do Cookie-Editor (array de objetos)
 * ou objeto simples {nome: valor} — para { cookies: {nome: valor}, expiresAtIso }.
 * Filtra os domínios SPX, descarta cookies expirados e exige ao menos um cookie
 * de autenticação (sessão válida). Lança erro com statusCode amigável caso não.
 */
export function normalizeSpxCookies(input) {
  let raw = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw badRequest("Os cookies colados não são um JSON válido.", "ASPX_COOKIES_INVALID_JSON");
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray(raw.cookies)) {
    raw = raw.cookies;
  }

  const nowSec = Date.now() / 1000;
  const cookies = {};
  let earliestAuthExpiry = null;

  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (!c || typeof c !== "object") continue;
      const name = typeof c.name === "string" ? c.name.trim() : "";
      const value = c.value;
      if (!name || value == null) continue;
      const domain = String(c.domain || "").toLowerCase().replace(/^\./, "");
      if (domain && !SPX_COOKIE_DOMAINS.some((d) => domain === d || domain.endsWith(d))) continue;
      const exp = Number(c.expirationDate ?? c.expires ?? 0);
      if (exp && exp > 0 && exp < nowSec) continue; // já expirado — pula
      cookies[name] = String(value);
      if (isAuthLikeCookie(name) && exp && exp > 0) {
        if (earliestAuthExpiry === null || exp < earliestAuthExpiry) earliestAuthExpiry = exp;
      }
    }
  } else if (raw && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw)) {
      if (value == null) continue;
      const cleanName = String(name).trim();
      if (cleanName) cookies[cleanName] = String(value);
    }
  } else {
    throw badRequest(
      "Formato de cookies não reconhecido (esperado o array do Cookie-Editor ou um objeto {nome: valor}).",
      "ASPX_COOKIES_BAD_FORMAT",
    );
  }

  if (!Object.keys(cookies).some(isAuthLikeCookie)) {
    throw badRequest(
      "Nenhum cookie de autenticação SPX encontrado (ex.: spx_cid, fms_user_skey, SPC_*). " +
        "Confirme que você está logado no SPX e exportou os cookies do domínio myagencyservice.com.br.",
      "ASPX_COOKIES_NO_AUTH",
      422,
    );
  }

  const expiresAtIso = earliestAuthExpiry
    ? new Date(earliestAuthExpiry * 1000).toISOString()
    : new Date(Date.now() + COOKIE_ROLLING_TTL_SECONDS * 1000).toISOString();

  return { cookies, expiresAtIso, count: Object.keys(cookies).length };
}

async function resetSpxBotSession() {
  const base = (process.env.SPX_BOT_URL?.trim() || "http://spx-bot:8766").replace(/\/$/, "");
  try {
    const resp = await fetch(`${base}/spx/session/reset`, { method: "POST" });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function updateAspxCookies({ cookiesJson, correlationId } = {}) {
  const { cookies, expiresAtIso, count } = normalizeSpxCookies(cookiesJson);

  const supabase = createSupabaseAdminClient();
  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("aspx_credentials")
    .update({
      cookies_json: cookies,
      cookies_expires_at: expiresAtIso,
      cookies_updated_at: nowIso,
    })
    .eq("id", 1);

  if (error) {
    throw new Error(`ASPX_COOKIES_UPDATE_FAILED:${error.message}`);
  }

  // Recarrega a sessão do spx-bot imediatamente (best-effort — não falha o request).
  const botReloaded = await resetSpxBotSession();

  return {
    statusCode: 200,
    payload: {
      ok: true,
      cookies: { count, expiresAt: expiresAtIso, updatedAt: nowIso },
      botReloaded,
      meta: { correlationId: correlationId || null },
    },
  };
}
