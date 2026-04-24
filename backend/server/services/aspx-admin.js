import { createSupabaseAdminClient } from "./google-sheet-loads.js";

// Contrato dos dois endpoints do card ASPx na tela Motoristas:
//  - getAspxSyncStatus()  -> metadados da tabela aspx_drivers + TTL dos cookies
//    cacheados em public.aspx_credentials.
//  - triggerAspxSync()    -> dispara o workflow aspx-sync.yml no GitHub Actions.
//    O Action nao faz login (IP do GH e bloqueado pelo portal); ele apenas
//    reutiliza os cookies ja gravados em aspx_credentials para chamar a API e
//    fazer UPSERT em aspx_drivers. A renovacao dos cookies continua sendo
//    manual, rodando o asp.py na maquina do operador.

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
