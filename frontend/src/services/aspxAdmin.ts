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

export interface AspxSessionRefreshResult {
  ok: boolean;
  /** true = sessão viva e renovada; false = morta (precisa de novo login no SPX). */
  alive: boolean;
  detail: string | null;
  meta: { correlationId: string | null };
}

/**
 * Renova a sessão SPX na hora (botão "Renovar agora", 1 clique, sem digitar).
 * O backend pede ao spx-bot pra recarregar cookies + ping + estender o prazo.
 * Não faz login (impossível — captcha); se a sessão estiver morta, alive=false.
 */
export async function refreshAspxSession(): Promise<AspxSessionRefreshResult> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<AspxSessionRefreshResult>("/api/operator/aspx/refresh", {
    method: "POST",
    accessToken,
  });
}
