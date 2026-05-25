import { useMutation, useQuery } from "@tanstack/react-query";

import { useDriverAuth } from "@/hooks/useDriverAuth";
import { resolveCanonicalApiRequestUrl } from "@/lib/runtimeOrigin";

export type CandidaturaPendencyStep = "A" | "B" | "C" | "D" | "E" | string;

/** Classificacao canonica do veiculo retornada pelo backend (Angellira). */
export type VehicleClassification = "cavalo" | "carreta";

export interface CandidaturaPendency {
  step: CandidaturaPendencyStep;
  plate?: string;
  reason: string;
  daysUntilExpiry?: number;
  label: string;
  /**
   * Reason=VEHICLE_TYPE_MISMATCH — tipo esperado pelo slot do payload
   * (`horsePlate` => "cavalo", `trailerPlate*` => "carreta"). Usado pelo
   * frontend para construir mensagem amigavel.
   */
  expectedType?: VehicleClassification;
  /**
   * Reason=VEHICLE_TYPE_MISMATCH — tipo efetivamente classificado pelo
   * Angellira para a placa enviada. Quando diferge de `expectedType`, a
   * candidatura e bloqueada e o motorista e instruido a corrigir.
   */
  actualType?: VehicleClassification;
}

export interface CandidaturaCompleto {
  plate: string;
  daysUntilExpiry: number;
}

export interface PreCheckResponseMeta {
  correlationId: string;
}

export interface PreCheckResponse {
  pendencias: CandidaturaPendency[];
  completos: CandidaturaCompleto[];
  meta: PreCheckResponseMeta;
}

export interface PreCheckRequestPayload {
  cpf: string;
  horsePlate: string;
  trailerPlates: string[];
}

export type PreCheckMutationInput = PreCheckRequestPayload;

interface ApiRequestOptions {
  method?: string;
  accessToken?: string;
  idempotencyKey?: string;
  body?: unknown;
}

export class CandidaturaApiError extends Error {
  readonly status: number;
  readonly correlationId: string | null;

  constructor(message: string, options: { status: number; correlationId: string | null }) {
    super(message);
    this.name = "CandidaturaApiError";
    this.status = options.status;
    this.correlationId = options.correlationId;
  }
}

function createCorrelationId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `candidatura-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getFallbackApiErrorMessage(url: string, response: Response, rawBody: string) {
  if (response.status === 404 && url.startsWith("/api/")) {
    return `Endpoint ${url} não encontrado.`;
  }

  if (!rawBody.trim()) {
    return `A API ${url} respondeu sem corpo (${response.status}).`;
  }

  if (rawBody.trim().startsWith("<")) {
    return `A API ${url} não retornou JSON válido (${response.status}).`;
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

function extractCorrelationId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const meta = (payload as { meta?: unknown }).meta;

  if (!meta || typeof meta !== "object") {
    return null;
  }

  const correlationId = (meta as { correlationId?: unknown }).correlationId;

  return typeof correlationId === "string" ? correlationId : null;
}

async function requestJson<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
  const correlationId = createCorrelationId();

  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Correlation-Id": correlationId,
  });

  if (options.accessToken) {
    headers.set("Authorization", `Bearer ${options.accessToken}`);
  }

  if (options.idempotencyKey) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }

  const requestUrl = resolveCanonicalApiRequestUrl(url);

  const response = await fetch(requestUrl, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  // 204 No Content é resposta válida — propaga null para o caller decidir.
  if (response.status === 204) {
    return null as T;
  }

  const { payload, fallbackMessage } = await parseApiPayload(response, url);
  const responseCorrelationId = extractCorrelationId(payload) || correlationId;

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload && typeof (payload as { message: unknown }).message === "string"
        ? ((payload as { message: string }).message)
        : fallbackMessage;

    throw new CandidaturaApiError(message || "Erro ao executar a operação de candidatura.", {
      status: response.status,
      correlationId: responseCorrelationId,
    });
  }

  if (payload === null) {
    throw new CandidaturaApiError(fallbackMessage, {
      status: response.status,
      correlationId: responseCorrelationId,
    });
  }

  return payload as T;
}

/**
 * Hook TanStack para POST /api/candidatura/pre-check.
 *
 * Verifica se o motorista autenticado tem pendências cadastrais (motorista + veículos)
 * antes de abrir o fluxo de candidatura para uma carga.
 */
export function useCandidaturaPreCheck() {
  return useMutation<PreCheckResponse, CandidaturaApiError, PreCheckMutationInput>({
    mutationFn: ({ cpf, horsePlate, trailerPlates }) =>
      requestJson<PreCheckResponse>("/api/candidatura/pre-check", {
        method: "POST",
        body: { cpf, horsePlate, trailerPlates },
      }),
  });
}

/**
 * Variante imperativa do pre-check (sem hook) — usada quando precisamos
 * disparar pre-check de dentro de event handlers (ex.: interceptor v2 no
 * DriverClaimPanel.handlePreRegistration).
 */
export async function requestCandidaturaPreCheck(
  payload: PreCheckMutationInput,
): Promise<PreCheckResponse> {
  return requestJson<PreCheckResponse>("/api/candidatura/pre-check", {
    method: "POST",
    body: {
      cpf: payload.cpf,
      horsePlate: payload.horsePlate,
      trailerPlates: payload.trailerPlates,
    },
  });
}

export interface AnttPrecheckRequestPayload {
  docType: "cpf" | "cnpj";
  doc: string;
  placa: string;
}

export interface AnttPrecheckMutationInput extends AnttPrecheckRequestPayload {
  accessToken: string;
}

export interface AnttPrecheckResponse {
  rntrc: string;
  tipo?: string;
  situacao?: string;
  validade?: string;
  /** FEAT-ANTT-TITULAR — CPF/CNPJ do titular RNTRC detectado (digits only). */
  titular_doc?: string | null;
  /** FEAT-ANTT-TITULAR — Nome/razao social do titular RNTRC detectado. */
  titular_nome?: string | null;
  source?: string;
  requiresUpload?: boolean;
  meta: PreCheckResponseMeta;
}

/**
 * Hook TanStack para POST /api/candidatura/antt-precheck (W-03).
 *
 * Dispara a cascata ANTT inline a partir do Step C2 do wizard v2. Nao persiste
 * nada — apenas consulta os 5 produtos Infosimples e retorna RNTRC + situacao +
 * validade + flag requiresUpload para acionar o fallback de upload manual.
 */
export function useCandidaturaAnttPrecheck() {
  return useMutation<AnttPrecheckResponse, CandidaturaApiError, AnttPrecheckMutationInput>({
    mutationFn: ({ docType, doc, placa, accessToken }) =>
      requestJson<AnttPrecheckResponse>("/api/candidatura/antt-precheck", {
        method: "POST",
        accessToken,
        body: {
          docType,
          doc,
          placa,
        },
      }),
  });
}

export interface CandidaturaDraftSavePayload {
  cargaId: string;
  dados: Record<string, unknown>;
  /** Obrigatorio quando o motorista NAO tem session Supabase (fluxo publico Bug-8). */
  cpf?: string;
}

export interface CandidaturaDraftSaveResponse {
  id: string;
  expiresAt: string;
}

/**
 * Hook TanStack para POST /api/candidatura/draft (CADASTRO-09 / D-05).
 *
 * Autosave debounced no wizard v2 — backend faz UPSERT (1 draft ativo por
 * motorista) e renova o TTL deslizante de 72h via `updated_at`.
 */
export function useCandidaturaDraftSave() {
  const auth = useDriverAuth();
  return useMutation<CandidaturaDraftSaveResponse, CandidaturaApiError, CandidaturaDraftSavePayload>({
    mutationFn: (payload) =>
      requestJson<CandidaturaDraftSaveResponse>("/api/candidatura/draft", {
        method: "POST",
        body: payload,
        accessToken: auth.session?.access_token,
      }),
  });
}

export interface CandidaturaDraftRecord {
  id: string;
  cargaId: string;
  dados: Record<string, unknown>;
  updatedAt: string;
}

export interface CandidaturaDraftGetResponse {
  draft: CandidaturaDraftRecord;
  expiresAt: string;
}

/**
 * Hook TanStack para GET /api/candidatura/draft/me (CADASTRO-09 / D-05).
 *
 * Retorna o rascunho ativo. Dois fluxos suportados:
 *  - Autenticado: usa `driverUserId` + access_token. Iter #7: quando `cargaId`
 *    e fornecido, escopa o draft a esta carga (multi-draft simultaneo).
 *  - Publico (Bug-8 / fix F5): passa `?cpf=XXX` quando o motorista nao tem
 *    sessao Supabase — backend identifica via `dados->'motorista'->>'cpf'`.
 *
 * Backend responde 204 quando nao ha draft — `requestJson` converte em `null`.
 */
export function useCandidaturaDraftGet(
  driverUserId: string | null,
  cpf?: string | null,
  cargaId?: string | null,
) {
  const auth = useDriverAuth();
  const accessToken = auth.session?.access_token ?? null;
  const normalizedCpf = (cpf ?? "").replace(/\D/g, "");
  const hasPublicKey = normalizedCpf.length === 11;
  const hasAuthKey = !!driverUserId && !!accessToken;
  const cargaIdNormalized = (cargaId ?? "").trim();

  return useQuery<CandidaturaDraftGetResponse | null, CandidaturaApiError>({
    enabled: hasAuthKey || hasPublicKey,
    queryKey: [
      "candidatura-draft",
      driverUserId || `cpf:${normalizedCpf}`,
      cargaIdNormalized || "no-carga",
    ],
    queryFn: () => {
      let url = hasAuthKey
        ? "/api/candidatura/draft/me"
        : `/api/candidatura/draft/me?cpf=${encodeURIComponent(normalizedCpf)}`;
      if (cargaIdNormalized) {
        url += `${url.includes("?") ? "&" : "?"}cargaId=${encodeURIComponent(cargaIdNormalized)}`;
      }
      return requestJson<CandidaturaDraftGetResponse | null>(url, {
        method: "GET",
        accessToken: hasAuthKey ? accessToken ?? undefined : undefined,
      });
    },
    staleTime: 30_000,
  });
}

/* ------------------------------------------------------------------ *
 * list-incomplete-drafts — Iter #7 (1 notification card per draft)
 * ------------------------------------------------------------------ */

export interface IncompleteCadastroDraft {
  id: string;
  cargaId: string;
  currentStep: string | null;
  updatedAt: string;
  expiresAt: string;
  origem: string | null;
  destino: string | null;
  dataColeta: string | null;
  horarioColeta: string | null;
}

export interface IncompleteCadastroDraftsResponse {
  drafts: IncompleteCadastroDraft[];
  meta: PreCheckResponseMeta;
}

/**
 * Hook TanStack para GET /api/driver/cadastros/incompletos.
 *
 * Retorna a lista de drafts incompletos do motorista (1 entrada por carga).
 * Usado pelo DriverPortal para renderizar 1 card "Completar cadastro" por draft.
 */
export function useIncompleteCadastroDrafts() {
  const auth = useDriverAuth();
  const accessToken = auth.session?.access_token ?? null;
  const driverUserId = auth.session?.user?.id ?? null;

  return useQuery<IncompleteCadastroDraftsResponse, CandidaturaApiError>({
    enabled: !!driverUserId && !!accessToken,
    queryKey: ["candidatura-incomplete-drafts", driverUserId],
    queryFn: () =>
      requestJson<IncompleteCadastroDraftsResponse>(
        "/api/driver/cadastros/incompletos",
        { method: "GET", accessToken: accessToken ?? undefined },
      ),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/* ------------------------------------------------------------------ *
 * verify-document — Bug B (Phase 8 / plan 08-20 backend, 08-21 frontend)
 * ------------------------------------------------------------------ */

export type VerifyDocumentPayload =
  | { type: "cpf"; value: string }
  | { type: "horsePlate"; value: string }
  | { type: "trailerPlate"; value: string }
  // 2026-05-18 — Verificacao de duplicidade do PROPRIETARIO do CRLV (Step C cavalo / Step E carreta).
  | { type: "ownerCpf"; value: string }
  | { type: "ownerCnpj"; value: string };

export type VerifyDocumentStatus = "completo" | "pendente" | "expirado";

export interface VerifyDocumentLastCandidatura {
  protocolo: string | null;
  candidatedAt: string | null;
  lastUpdatedAt: string | null;
}

/**
 * 2026-05-18 — Cadastro externo encontrado no AngelLira/ASPX para o CPF
 * consultado. Sem PII: apenas `source` e (quando disponivel) `situacao`
 * (e.g. "ATIVO", "EM RENOVACAO"). Para placa, somente AngelLira.
 */
export interface VerifyDocumentExternalRegistration {
  source: "angellira" | "aspx" | "both";
  situacao?: string | null;
}

export interface VerifyDocumentResponse {
  exists: boolean;
  status: VerifyDocumentStatus | null;
  lastCandidatura: VerifyDocumentLastCandidatura | null;
  externalRegistration?: VerifyDocumentExternalRegistration | null;
}

/** Resposta degradada usada como fallback silencioso em erros não bloqueantes. */
const VERIFY_DOCUMENT_DEGRADED: VerifyDocumentResponse = {
  exists: false,
  status: null,
  lastCandidatura: null,
  externalRegistration: null,
};

/**
 * Consulta pública (sem auth) do endpoint `verify-document`.
 *
 * - Resposta uniforme `200` (rate-limit 5/min/IP).
 * - 429 / 422 / network error → degrada silencioso (não bloqueia o motorista).
 * - O endpoint backend NUNCA expõe PII (apenas protocolo + datas).
 *
 * Consumidores típicos: wizard cadastro-v2 quando o motorista digita/extrai
 * via OCR um CPF ou placa diferente do que veio no pre-check.
 */
export async function verifyDocument(
  payload: VerifyDocumentPayload,
): Promise<VerifyDocumentResponse> {
  try {
    const response = await requestJson<VerifyDocumentResponse>(
      "/api/candidatura/verify-document",
      {
        method: "POST",
        body: payload,
      },
    );
    if (!response || typeof response !== "object") {
      return VERIFY_DOCUMENT_DEGRADED;
    }
    return {
      exists: Boolean(response.exists),
      status: response.status ?? null,
      lastCandidatura: response.lastCandidatura ?? null,
      externalRegistration: response.externalRegistration ?? null,
    };
  } catch (err) {
    if (err instanceof CandidaturaApiError) {
      // 429 (rate limit) e 422 (payload inválido) degradam silencioso.
      if (err.status === 429 || err.status === 422 || err.status === 400) {
        if (typeof console !== "undefined" && typeof console.warn === "function") {
          console.warn("[verifyDocument] degraded silently", {
            status: err.status,
            correlationId: err.correlationId,
          });
        }
        return VERIFY_DOCUMENT_DEGRADED;
      }
    }
    // Network error / outros — não bloqueia o motorista.
    if (typeof console !== "undefined" && typeof console.warn === "function") {
      console.warn("[verifyDocument] network error", err);
    }
    return VERIFY_DOCUMENT_DEGRADED;
  }
}

/* ------------------------------------------------------------------ *
 * lookup-pis — auto-fill do PIS via Infosimples (260515-loi T3)
 * ------------------------------------------------------------------ */

export interface LookupPisRequestPayload {
  /** CPF digits only (11). */
  cpf: string;
  nome: string;
  /** ISO yyyy-mm-dd. */
  dataNascimento: string;
}

export interface LookupPisResponse {
  pis: string;
  source: "infosimples" | "mock";
  meta: { correlationId?: string };
}

/**
 * Codigos de erro amigaveis emitidos pelo `useLookupPis` para a UI lidar
 * (toast informativo, libera input manual). Preservados via `error.message`
 * do `CandidaturaApiError`.
 */
export const LOOKUP_PIS_ERROR_CODES = {
  NOT_FOUND: "PIS_NOT_FOUND",
  UNAVAILABLE: "PIS_LOOKUP_UNAVAILABLE",
  INVALID_INPUT: "PIS_LOOKUP_INVALID_INPUT",
  GENERIC: "PIS_LOOKUP_ERROR",
} as const;

/**
 * Hook TanStack para POST /api/cadastro/lookup-pis (260515-loi).
 *
 * Auto-preenche o PIS dos proprietarios PF no wizard /cadastro v2 (Step C
 * cavalo, Step E carretas) consultando o CNIS via Infosimples.
 *
 * Mapeia erros HTTP em codigos amigaveis (`LOOKUP_PIS_ERROR_CODES`) — a UI
 * decide a copy do toast. Em qualquer erro o input PIS continua editavel
 * (decisao locked, CONTEXT.md).
 */
export function useLookupPis() {
  const auth = useDriverAuth();
  return useMutation<LookupPisResponse, CandidaturaApiError, LookupPisRequestPayload>({
    mutationFn: async (payload) => {
      try {
        return await requestJson<LookupPisResponse>("/api/cadastro/lookup-pis", {
          method: "POST",
          body: {
            cpf: payload.cpf,
            nome: payload.nome,
            dataNascimento: payload.dataNascimento,
          },
          accessToken: auth.session?.access_token,
        });
      } catch (err) {
        if (err instanceof CandidaturaApiError) {
          const status = err.status;
          let code: string = LOOKUP_PIS_ERROR_CODES.GENERIC;
          if (status === 404) code = LOOKUP_PIS_ERROR_CODES.NOT_FOUND;
          else if (status === 502 || status === 503 || status === 504)
            code = LOOKUP_PIS_ERROR_CODES.UNAVAILABLE;
          else if (status === 400 || status === 422)
            code = LOOKUP_PIS_ERROR_CODES.INVALID_INPUT;

          throw new CandidaturaApiError(code, {
            status: err.status,
            correlationId: err.correlationId,
          });
        }
        throw err;
      }
    },
  });
}

export interface CandidaturaSubmitPayload {
  cargaId: string;
  dados: Record<string, unknown>;
  /**
   * Idempotency-Key v4 estável por sessão do wizard. O caller (ConfirmationScreen)
   * gera UMA vez via useMemo(() => crypto.randomUUID(), []) no mount e passa em
   * todos os retries — manter a key através de retries é critico para que o backend
   * retorne a mesma row em vez de criar candidaturas duplicadas (W-12).
   */
  idempotencyKey: string;
}

export interface CandidaturaSubmitResponse {
  id: string;
  protocolo: string;
}

/**
 * Hook TanStack para POST /api/candidatura/submit.
 *
 * - Idempotency-Key passada pelo caller (estável por sessão do wizard).
 * - Backend (plan 04) valida payload completo, persiste candidatura, retorna
 *   `{ id, protocolo }` (formato `CAD-YYYY-NNNNN`).
 * - 201 sucesso → SubmissionSuccess screen. Erro → admin-tint-danger callout
 *   + botão "Tentar enviar novamente" preservando dados.
 */
export function useCandidaturaSubmit() {
  const auth = useDriverAuth();
  return useMutation<CandidaturaSubmitResponse, CandidaturaApiError, CandidaturaSubmitPayload>({
    mutationFn: (payload) =>
      requestJson<CandidaturaSubmitResponse>("/api/candidatura/submit", {
        method: "POST",
        body: { cargaId: payload.cargaId, dados: payload.dados },
        idempotencyKey: payload.idempotencyKey,
        accessToken: auth.session?.access_token,
      }),
  });
}
