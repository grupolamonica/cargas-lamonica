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
   * Iter #10 — texto explicativo opcional (linha secundaria) que orienta o
   * motorista para a etapa correta do wizard (ex: "Vá para a etapa 'Cavalo'").
   * Pendencies legados (reason=EXPIRING/EXPIRED/VEHICLE_TYPE_MISMATCH/...) nao
   * carregam description; reason=NOT_FOUND/DRIVER_NOT_FOUND carregam.
   */
  description?: string;
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
  /**
   * Iter #7 — Reason=DUPLICATE_PENDING_REGISTRATION: o motorista ja submeteu
   * cadastro com mesma (cpf, horsePlate) nos ultimos 30 dias. Wizard pode
   * pular pulando o cadastro e disparar apenas o lead/claim na carga atual.
   */
  allowSkipWizard?: boolean;
  pendingRegistrationId?: string;
  submittedAt?: string;
  status?: string;
}

export interface CandidaturaCompleto {
  plate: string;
  daysUntilExpiry: number;
}

export interface PreCheckResponseMeta {
  correlationId: string;
}

/**
 * Snapshot do motorista do cadastro aprovado/concluido — devolvido pelo
 * pre-check SOMENTE quando ha pendencia de selfie (reason=SELFIE_REQUIRED),
 * para o wizard exibir a identidade conhecida no passo "so a selfie". E o
 * objeto `dados.motorista` persistido (shape do submit); todos os campos sao
 * opcionais aqui porque vem de JSON arbitrario. NAO usado para montar o
 * payload — o submit envia so a selfie e o backend faz o merge do resto.
 */
export interface PersistedMotorista {
  nome?: string;
  cpf?: string;
  cnh?: { categoria?: string; validade?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface PreCheckResponse {
  pendencias: CandidaturaPendency[];
  completos: CandidaturaCompleto[];
  /** Presente apenas no caso SELFIE_REQUIRED (ver PersistedMotorista). */
  persistedMotorista?: PersistedMotorista;
  meta: PreCheckResponseMeta;
}

export interface PreCheckRequestPayload {
  cpf: string;
  horsePlate: string;
  trailerPlates: string[];
  /** Token (ignorado pelo backend público; mantido por compat de chamada). */
  accessToken?: string | null;
  /**
   * Resgate pelo operador: pede ao backend para pular as chamadas ao vivo do
   * Angellira (usa só cache/DB) — evita a tela de pré-check travar 30-45s. A
   * validação autoritativa ocorre no submit.
   */
  preferCache?: boolean;
}

export type PreCheckMutationInput = PreCheckRequestPayload;

interface ApiRequestOptions {
  method?: string;
  accessToken?: string;
  idempotencyKey?: string;
  /**
   * Token de posse do rascunho anônimo (DC-283 / CRIT-3). Vai em header, não em
   * query string, para não cair em log de proxy nem no histórico do browser.
   */
  draftToken?: string;
  body?: unknown;
  /**
   * Teto de tempo (ms) para a requisição. Quando definido, aborta o fetch e
   * lança CandidaturaApiError (status 0) em vez de ficar pendente indefinidamente.
   * Só é aplicado quando presente — chamadas sem `timeoutMs` (uploads/OCR/submit,
   * legitimamente lentas) mantêm o comportamento anterior, sem signal.
   */
  timeoutMs?: number;
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

  if (options.draftToken) {
    headers.set("X-Draft-Token", options.draftToken);
  }

  const requestUrl = resolveCanonicalApiRequestUrl(url);

  // Timeout opcional (só quando options.timeoutMs está definido). Converte uma
  // requisição travada (backend sem responder) em erro recuperável, em vez de
  // deixar a UI presa para sempre (ex.: pré-check no "Verificando seu cadastro…").
  const controller = new AbortController();
  const timeoutHandle =
    options.timeoutMs != null
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : null;

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.timeoutMs != null ? controller.signal : undefined,
    });
  } catch (err) {
    if (options.timeoutMs != null && controller.signal.aborted) {
      throw new CandidaturaApiError(
        "A verificação demorou mais que o esperado e foi interrompida. Verifique a conexão e tente novamente.",
        { status: 0, correlationId },
      );
    }
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

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
// Teto de tempo do pré-check. Sem isto, uma verificação travada (Angellira/ASPX
// não respondendo) deixava a tela presa em "Verificando seu cadastro…" para
// sempre, sem erro e sem saída. O operador roda cache-only (rápido) → teto
// curto; o motorista roda ao vivo (Angellira ~30s/chamada, em série) → folgado.
// Ao estourar, vira CandidaturaApiError e cai no PreCheckError (tem "Tentar de novo").
const PRE_CHECK_TIMEOUT_MS = { cacheOnly: 30_000, live: 90_000 } as const;

export function useCandidaturaPreCheck() {
  return useMutation<PreCheckResponse, CandidaturaApiError, PreCheckMutationInput>({
    mutationFn: ({ cpf, horsePlate, trailerPlates, preferCache }) =>
      requestJson<PreCheckResponse>("/api/candidatura/pre-check", {
        method: "POST",
        body: { cpf, horsePlate, trailerPlates, ...(preferCache ? { preferCache: true } : {}) },
        timeoutMs: preferCache ? PRE_CHECK_TIMEOUT_MS.cacheOnly : PRE_CHECK_TIMEOUT_MS.live,
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
    timeoutMs: payload.preferCache ? PRE_CHECK_TIMEOUT_MS.cacheOnly : PRE_CHECK_TIMEOUT_MS.live,
  });
}

export interface AttachSelfiePayload {
  /** CPF do motorista (dígitos; o backend normaliza). */
  cpf: string;
  /** storage_path da selfie (slot motorista_selfie_cnh) devolvido por uploadDraftFile. */
  selfieStoragePath: string;
}

export interface AttachSelfieResponse {
  ok: boolean;
  selfie_cnh_url: string;
  meta: PreCheckResponseMeta;
}

/**
 * Hook TanStack para POST /api/candidatura/attach-selfie.
 *
 * Anexa a selfie-com-CNH ao cadastro JÁ aprovado do motorista (caso
 * SELFIE_REQUIRED), sem passar pelo submit da candidatura — o backend grava
 * `selfie_cnh_url` na própria linha aprovada. Endpoint público (CPF-based).
 */
export function useAttachSelfie() {
  return useMutation<AttachSelfieResponse, CandidaturaApiError, AttachSelfiePayload>({
    mutationFn: ({ cpf, selfieStoragePath }) =>
      requestJson<AttachSelfieResponse>("/api/candidatura/attach-selfie", {
        method: "POST",
        body: { cpf, selfieStoragePath },
      }),
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
  /**
   * Só vem quando o servidor acabou de emitir o token — rascunho novo, ou
   * adoção de rascunho legado (criado antes do DC-283). Numa gravação comum o
   * cliente já tem o dele guardado.
   */
  draftToken?: string;
}

/* ------------------------------------------------------------------ *
 * Token de posse do rascunho anônimo (DC-283 / CRIT-3)
 *
 * Antes, o rascunho público era autorizado pelo CPF: qualquer um que soubesse
 * um CPF lia a ficha inteira (CNH, RG, endereço, credencial de rastreador).
 * Agora o servidor emite um token opaco na criação e passa a exigi-lo.
 *
 * Guardado em localStorage porque precisa sobreviver ao F5 — é o mesmo lugar
 * onde o wizard já persiste o rascunho. Chave única, sem CPF dentro: o
 * navegador é de uma pessoa, e o servidor valida o token contra o CPF de
 * qualquer forma.
 *
 * Consequência aceita: trocar de aparelho ou limpar o navegador faz perder o
 * rascunho do servidor. É o preço de fechar o buraco — e rascunho é dado
 * descartável de 72h.
 * ------------------------------------------------------------------ */
const DRAFT_TOKEN_STORAGE_KEY = "lamonica-draft-token";

export function readStoredDraftToken(): string | null {
  try {
    return window.localStorage.getItem(DRAFT_TOKEN_STORAGE_KEY);
  } catch {
    // Modo privado/storage bloqueado: segue sem token — o wizard cai no
    // caminho de rascunho novo em vez de quebrar.
    return null;
  }
}

export function storeDraftToken(token: string | null | undefined): void {
  if (!token) return;
  try {
    window.localStorage.setItem(DRAFT_TOKEN_STORAGE_KEY, token);
  } catch {
    /* storage indisponível — sem token, o autosave segue criando rascunho novo */
  }
}

export function clearStoredDraftToken(): void {
  try {
    window.localStorage.removeItem(DRAFT_TOKEN_STORAGE_KEY);
  } catch {
    /* idem */
  }
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
    mutationFn: async (payload) => {
      const response = await requestJson<CandidaturaDraftSaveResponse>("/api/candidatura/draft", {
        method: "POST",
        body: payload,
        accessToken: auth.session?.access_token,
        draftToken: readStoredDraftToken() ?? undefined,
      });
      // Guarda o token na primeira gravação (ou na adoção de rascunho legado);
      // sem isso o F5 seguinte não reencontra o rascunho no servidor.
      storeDraftToken(response?.draftToken);
      return response;
    },
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
 *  - Publico: apresenta o TOKEN DE POSSE guardado localmente. O parametro `cpf`
 *    segue na assinatura só para decidir SE ha um fluxo publico em andamento —
 *    ele nao vai mais para a requisicao.
 *
 * O `?cpf=` foi removido (DC-283 / CRIT-3 + ALTO-17): devolvia a ficha inteira
 * para qualquer CPF informado, e ainda deixava o CPF em log de proxy e no
 * historico do browser.
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
  const hasAuthKey = !!driverUserId && !!accessToken;
  const publicDraftToken = hasAuthKey ? null : readStoredDraftToken();
  // Sem token guardado nao ha o que buscar: o rascunho publico so e alcancavel
  // por posse. Evita uma ida ao servidor que voltaria 204 garantido.
  const hasPublicKey = normalizedCpf.length === 11 && !!publicDraftToken;
  const cargaIdNormalized = (cargaId ?? "").trim();

  return useQuery<CandidaturaDraftGetResponse | null, CandidaturaApiError>({
    enabled: hasAuthKey || hasPublicKey,
    queryKey: [
      "candidatura-draft",
      driverUserId || `cpf:${normalizedCpf}`,
      cargaIdNormalized || "no-carga",
    ],
    queryFn: () => {
      let url = "/api/candidatura/draft/me";
      if (cargaIdNormalized) {
        url += `?cargaId=${encodeURIComponent(cargaIdNormalized)}`;
      }
      return requestJson<CandidaturaDraftGetResponse | null>(url, {
        method: "GET",
        accessToken: hasAuthKey ? accessToken ?? undefined : undefined,
        draftToken: publicDraftToken ?? undefined,
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
  /**
   * true = carga ainda ativa e disponível para candidatura.
   * false = carga cancelada, arquivada ou alocada para outro motorista.
   * O draft pode ser continuado no modo standalone (sem carga) mesmo quando false.
   */
  cargaDisponivel?: boolean;
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
  /**
   * ID da carga. Omitido (undefined) no cadastro standalone (botão "Cadastro"
   * do /motorista, sem carga) → backend persiste carga_id=NULL. Sempre presente
   * no fluxo de candidatura a partir de uma carga.
   */
  cargaId?: string;
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
