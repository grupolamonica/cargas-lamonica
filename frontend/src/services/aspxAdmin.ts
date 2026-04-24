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
