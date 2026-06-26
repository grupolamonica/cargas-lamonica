import { getOperatorAccessToken, requestJson } from "@/services/apiClient";

export interface AspxSyncStatus {
  ok: boolean;
  cookies: {
    expiresAt: string | null;
    updatedAt: string | null;
    expired: boolean;
    secondsRemaining: number;
  };
  drivers: {
    total: number;
    lastSyncAt: string | null;
  };
  serverTime: string;
}

export interface AspxSyncTriggerResult {
  ok: boolean;
  dispatchedAt: string;
  workflow: string;
  ref: string;
  meta: { correlationId: string | null };
}

export async function fetchAspxSyncStatus(): Promise<AspxSyncStatus> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<AspxSyncStatus>("/api/operator/aspx/status", {
    method: "GET",
    accessToken,
  });
}

export async function triggerAspxSync(): Promise<AspxSyncTriggerResult> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<AspxSyncTriggerResult>("/api/operator/aspx/sync", {
    method: "POST",
    accessToken,
  });
}

export interface AspxCookiesUpdateResult {
  ok: boolean;
  cookies: { count: number; expiresAt: string; updatedAt: string };
  botReloaded: boolean;
  meta: { correlationId: string | null };
}

/**
 * Atualiza os cookies do SPX a partir do export colado do Cookie-Editor
 * (string JSON — array de objetos ou objeto {nome: valor}). O backend valida,
 * grava no Supabase e recarrega a sessão do spx-bot.
 */
export async function updateAspxCookies(cookiesJson: string): Promise<AspxCookiesUpdateResult> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<AspxCookiesUpdateResult>("/api/operator/aspx/cookies", {
    method: "POST",
    accessToken,
    body: { cookies: cookiesJson },
  });
}
