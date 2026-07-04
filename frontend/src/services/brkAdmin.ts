import { getOperatorAccessToken, requestJson } from "@/services/apiClient";

export interface BrkSyncStatus {
  ok: boolean;
  cookies: {
    expiresAt: string | null;
    updatedAt: string | null;
    expired: boolean;
    secondsRemaining: number;
    count: number;
    hasUserAgent: boolean;
  };
  drivers: {
    withBrk: number;
    lastCheckedAt: string | null;
  };
  serverTime: string;
}

export interface BrkCookieUpdateResult {
  ok: boolean;
  cookies: {
    count: number;
    expiresAt: string;
    updatedAt: string;
    hasCfClearance: boolean;
    userAgentSet: boolean;
  };
  /** Aviso não-fatal (ex.: cole sem cf_clearance). null quando tudo ok. */
  warning: string | null;
  meta: { correlationId: string | null };
}

export async function fetchBrkSyncStatus(): Promise<BrkSyncStatus> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<BrkSyncStatus>("/api/operator/brk/status", {
    method: "GET",
    accessToken,
  });
}

/**
 * Atualiza o cookie do BRK (cole do Cookie-Editor / {nome: valor} / header cru) +
 * User-Agent opcional. O backend normaliza, valida a auth (cokiename/ASPXAUTH) e
 * grava em brk_credentials — fonte de verdade que o robô :5010 lê.
 */
export async function updateBrkCookie(input: {
  cookies: string;
  userAgent?: string;
}): Promise<BrkCookieUpdateResult> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<BrkCookieUpdateResult>("/api/operator/brk/cookie", {
    method: "POST",
    accessToken,
    body: { cookies: input.cookies, userAgent: input.userAgent || undefined },
  });
}
