import { supabase } from "@/integrations/supabase/client";
import { resolveCanonicalApiRequestUrl } from "@/lib/runtimeOrigin";

// When VITE_API_BASE_URL is set (e.g. http://localhost:3001), API calls are routed
// to the standalone backend. When empty, paths remain /api/* (Vercel-compatible).
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

interface ApiRequestOptions {
  method?: string;
  accessToken?: string;
  body?: unknown;
}

function createCorrelationId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `corr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getFallbackApiErrorMessage(url: string, response: Response, rawBody: string) {
  if (response.status === 404 && url.startsWith("/api/")) {
    return `Endpoint ${url} nao encontrado. Confirme se o ambiente expoe as rotas /api.`;
  }

  if (!rawBody.trim()) {
    return `A API ${url} respondeu sem corpo (${response.status}).`;
  }

  if (rawBody.trim().startsWith("<")) {
    return `A API ${url} nao retornou JSON valido (${response.status}).`;
  }

  return rawBody.trim();
}

async function parseApiPayload(response: Response, url: string) {
  const rawBody = await response.text();

  if (!rawBody.trim()) {
    return {
      payload: null,
      fallbackMessage: getFallbackApiErrorMessage(url, response, rawBody),
    };
  }

  try {
    return {
      payload: JSON.parse(rawBody) as unknown,
      fallbackMessage: getFallbackApiErrorMessage(url, response, rawBody),
    };
  } catch {
    return {
      payload: null,
      fallbackMessage: getFallbackApiErrorMessage(url, response, rawBody),
    };
  }
}

export async function getOperatorAccessToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error("Sessão do operador indisponível.");
  }

  return session.access_token;
}

export async function requestJson<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Correlation-Id": createCorrelationId(),
  });

  if (options.accessToken) {
    headers.set("Authorization", `Bearer ${options.accessToken}`);
  }

  const resolvedUrl = API_BASE ? `${API_BASE.replace(/\/$/, '')}${url.startsWith('/') ? url : `/${url}`}` : url;
  const requestUrl = resolveCanonicalApiRequestUrl(resolvedUrl);

  const response = await fetch(requestUrl, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const { payload, fallbackMessage } = await parseApiPayload(response, url);

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
        ? payload.message
        : fallbackMessage;

    throw new Error(message || "Erro ao executar a operacao solicitada.");
  }

  if (payload === null) {
    throw new Error(fallbackMessage);
  }

  return payload as T;
}

