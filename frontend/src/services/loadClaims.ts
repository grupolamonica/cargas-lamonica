import { resolveCanonicalApiRequestUrl } from "@/lib/runtimeOrigin";
import { getOperatorAccessToken } from "@/services/apiClient";

export interface DriverProfilePayload {
  full_name: string;
  phone: string;
  document_number?: string;
  vehicle_profile: string;
  documents_valid: boolean;
  antt_valid: boolean;
  tracking_enabled: boolean;
  insurance_valid: boolean;
  monitoring_capable: boolean;
  allowed_regions: string[];
  metadata?: Record<string, unknown>;
}

export interface PublicLoadLeadPayload {
  cpf: string;
  phone: string;
  horsePlate: string;
  trailerPlate: string;
  trailerPlate2: string;
  vehicleType: string;
}

export type PublicLeadValidationOverallStatus =
  | "VALID"
  | "EXPIRING"
  | "INVALID"
  | "NOT_FOUND"
  | "PLATE_MISMATCH"
  | "PARTIAL"
  | "UNAVAILABLE"
  | "INCOMPLETE";

export type PublicLeadValidationLookupStatus = "FOUND" | "NOT_FOUND" | "UNAVAILABLE";
export type PublicLeadValidationVigencyStatus = "VALID" | "EXPIRING" | "INVALID" | "MISSING" | "UNAVAILABLE";

export interface PublicLeadValidationSource {
  status: PublicLeadValidationLookupStatus;
  found: boolean;
  displayName?: string | null;
  validUntil?: string | null;
  lastSeenAt?: string | null;
}

export interface PublicLeadValidationPlate {
  field: "horsePlate" | "trailerPlate" | "trailerPlate2";
  label: string;
  status: PublicLeadValidationLookupStatus;
  found: boolean;
  validUntil: string | null;
  lastSeenAt: string | null;
}

export interface PublicLeadValidationSummary {
  schemaVersion: number;
  checkedAt: string;
  candidateSubmittedAt: string;
  overallStatus: PublicLeadValidationOverallStatus;
  missingFields: string[];
  warnings: string[];
  driver: {
    angelira: PublicLeadValidationSource;
    aspx: PublicLeadValidationSource;
  };
  plates: PublicLeadValidationPlate[];
  vigency: {
    status: PublicLeadValidationVigencyStatus;
    validUntil: string | null;
    daysUntilExpiry: number | null;
    source: string | null;
  };
  support: {
    whatsappNumber: string | null;
    whatsappUrl: string | null;
  };
  sources: {
    angelira: {
      status: "OK" | "UNAVAILABLE";
    };
    aspx: {
      status: "OK" | "UNAVAILABLE";
    };
  };
}

export interface PublicLoadLead {
  id: string;
  status: string;
  cpf: string;
  phone: string;
  horsePlate: string;
  trailerPlate: string;
  trailerPlate2: string;
  vehicleType: string;
  preRegisteredAt: string;
  queuedAt: string | null;
  whatsappClickedAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  validation?: PublicLeadValidationSummary | null;
  queuePosition: number | null;
}

export type OperatorPacoteStatus =
  | "rascunho"
  | "publicado"
  | "reservado"
  | "em_andamento"
  | "concluido"
  | "cancelado";

export interface OperatorLeadPacoteMeta {
  id: string;
  status: OperatorPacoteStatus | string | null;
  valorTotal: number | null;
  version: number | null;
  totalCargas: number | null;
  ordemPropria: number | null;
}

export interface OperatorLeadGroup {
  load: {
    id: string;
    status: string;
    origem: string;
    destino: string;
    perfil: string;
    data: string;
    horario: string;
    reservedPublicLeadId: string | null;
    sheetLh: string | null;
    sheetDataCarregamento: string | null;
    sheetDataDescarga: string | null;
    sheetMotorista: string | null;
    sheetCavalo: string | null;
    sheetCarreta: string | null;
    sheetStatus?: string | null;
    clienteId?: string | null;
    clienteNome?: string | null;
    clienteLogoUrl?: string | null;
    viagemId?: string | null;
    ordemViagem?: number | null;
    pacoteMeta?: OperatorLeadPacoteMeta | null;
  };
  queueCount: number;
  totalLeads: number;
  leads: Array<
    PublicLoadLead & {
      whatsappUrl: string;
    }
  >;
}

export interface PublicLoadClaimStatusResponse {
  load: {
    id: string;
    status: string;
    version?: number;
    reservedUntil: string | null;
    reservedAt?: string | null;
    bookedAt?: string | null;
    data?: string | null;
    horario?: string | null;
    origem?: string | null;
    destino?: string | null;
    perfil?: string | null;
    valor?: number | string | null;
    bonus?: number | string | null;
    clienteId?: string | null;
    clienteNome?: string | null;
    clienteDescricao?: string | null;
    carregamentoLabel?: string | null;
    descargaLabel?: string | null;
  };
  publicLead?: {
    id: string;
    status: string;
    queuedAt: string | null;
    whatsappClickedAt: string | null;
    approvedAt: string | null;
    approvedBy: string | null;
    validation?: PublicLeadValidationSummary | null;
  } | null;
  claim: {
    id: string;
    status: string;
    queuePosition: number | null;
    serverSequence?: number | null;
    claimedAt?: string | null;
    promotedAt?: string | null;
    confirmedAt?: string | null;
    expiredAt?: string | null;
    rejectedReason?: string | null;
  } | null;
  driverProfile?: {
    fullName?: string;
    vehicleProfile?: string;
    active?: boolean;
    documentsValid?: boolean;
    allowedRegions?: string[];
  } | null;
  meta: {
    correlationId: string;
    claim_v2_enabled?: boolean;
    waitlist_enabled?: boolean;
    reservation_ttl_seconds?: number;
    realtime_claim_updates_enabled?: boolean;
    publicLeadWhatsappConfigured?: boolean;
  };
}

interface ApiRequestOptions {
  method?: string;
  accessToken?: string;
  idempotencyKey?: string;
  body?: unknown;
}

function getFallbackApiErrorMessage(url: string, response: Response, rawBody: string) {
  if (response.status === 404 && url.startsWith("/api/")) {
    return `Endpoint ${url} não encontrado. Se estiver em desenvolvimento, confirme se o servidor expõe as rotas /api.`;
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
      rawBody,
      fallbackMessage: getFallbackApiErrorMessage(url, response, rawBody),
    };
  }

  try {
    return {
      payload: JSON.parse(rawBody) as unknown,
      rawBody,
      fallbackMessage: getFallbackApiErrorMessage(url, response, rawBody),
    };
  } catch {
    return {
      payload: null,
      rawBody,
      fallbackMessage: getFallbackApiErrorMessage(url, response, rawBody),
    };
  }
}

function createIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  return `claim-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Erro enriquecido com status HTTP + code para permitir que callers (e
 * TanStack Query retry) distingam 5xx transient de 4xx terminal.
 */
export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, options: { status: number; code?: string }) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
  }
}

async function requestJson<T>(url: string, options: ApiRequestOptions = {}): Promise<T> {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Correlation-Id": createIdempotencyKey(),
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

  const { payload, fallbackMessage } = await parseApiPayload(response, url);

  if (!response.ok) {
    const isPayloadObject = payload && typeof payload === "object";
    const message =
      isPayloadObject && "message" in payload && typeof (payload as { message: unknown }).message === "string"
        ? (payload as { message: string }).message
        : fallbackMessage;
    const code =
      isPayloadObject && "code" in payload && typeof (payload as { code: unknown }).code === "string"
        ? (payload as { code: string }).code
        : undefined;

    throw new ApiError(message || "Erro ao executar a operacao de aceite.", {
      status: response.status,
      code,
    });
  }

  if (payload === null) {
    throw new ApiError(fallbackMessage, { status: response.status });
  }

  return payload as T;
}

export async function registerDriverAccount(payload: { email: string; password: string; profile: DriverProfilePayload }) {
  return requestJson("/api/drivers/register", {
    method: "POST",
    body: payload,
  });
}

export async function updateDriverProfile(accessToken: string, profile: DriverProfilePayload) {
  return requestJson("/api/drivers/me", {
    method: "PUT",
    accessToken,
    body: profile,
  });
}

export async function fetchDriverProfile(accessToken: string) {
  return requestJson("/api/drivers/me", {
    accessToken,
  });
}

export async function fetchLoadClaimStatus(loadId: string, accessToken?: string, leadId?: string | null) {
  const query = leadId ? `?leadId=${encodeURIComponent(leadId)}` : "";

  return requestJson<PublicLoadClaimStatusResponse>(`/api/loads/${loadId}/claim-status${query}`, {
    accessToken,
  });
}

export async function createPublicLoadLeadPreRegistration(loadId: string, payload: PublicLoadLeadPayload) {
  return requestJson<{
    ok: boolean;
    lead: PublicLoadLead;
    load: {
      id: string;
      status: string;
      origem: string;
      destino: string;
      perfil: string;
      data: string;
      horario: string;
      reservedAt: string | null;
      reservedUntil: string | null;
      reservedPublicLeadId: string | null;
    };
    meta: {
      correlationId: string;
      reused: boolean;
    };
  }>(`/api/loads/${loadId}/pre-registration`, {
    method: "POST",
    body: payload,
  });
}

export async function queuePublicLoadLeadViaWhatsApp(loadId: string, leadId: string) {
  return requestJson<{
    ok: boolean;
    lead: PublicLoadLead;
    load: {
      id: string;
      status: string;
      origem: string;
      destino: string;
      perfil: string;
      data: string;
      horario: string;
      reservedAt: string | null;
      reservedUntil: string | null;
      reservedPublicLeadId: string | null;
    };
    whatsappUrl: string;
    meta: {
      correlationId: string;
    };
  }>(`/api/loads/${loadId}/leads/${leadId}/whatsapp`, {
    method: "POST",
  });
}

export async function fetchOperatorLoadLeads() {
  const accessToken = await getOperatorAccessToken();

  return requestJson<{
    groups: OperatorLeadGroup[];
    meta: {
      correlationId: string;
    };
  }>("/api/operator/leads", {
    accessToken,
  });
}

export async function approveOperatorLoadLead(loadId: string, leadId: string) {
  const accessToken = await getOperatorAccessToken();

  return requestJson<{
    ok: boolean;
    lead: PublicLoadLead;
    load: {
      id: string;
      status: string;
      origem: string;
      destino: string;
      perfil: string;
      data: string;
      horario: string;
      reservedAt: string | null;
      reservedUntil: string | null;
      reservedPublicLeadId: string | null;
    };
    meta: {
      correlationId: string;
      idempotent: boolean;
    };
  }>(`/api/loads/${loadId}/leads/${leadId}/approve`, {
    method: "POST",
    accessToken,
  });
}

export type RevalidateScope = "fila" | "historico";

export async function revalidateQueuedOperatorLeads(scope: RevalidateScope = "fila") {
  const accessToken = await getOperatorAccessToken();

  return requestJson<{
    ok: boolean;
    total: number;
    revalidated: number;
    failed: number;
    limit: number;
    truncated: boolean;
    abortedByDeadline?: boolean;
    meta: { correlationId: string };
  }>(`/api/operator/leads/revalidate-queued?scope=${scope}`, {
    method: "POST",
    accessToken,
  });
}

export async function revalidateQueuedOperatorLeadsAspx(scope: RevalidateScope = "fila") {
  const accessToken = await getOperatorAccessToken();

  return requestJson<{
    ok: boolean;
    total: number;
    revalidated: number;
    foundInAspx: number;
    failed: number;
    limit: number;
    truncated: boolean;
    meta: { correlationId: string };
  }>(`/api/operator/leads/revalidate-queued-aspx?scope=${scope}`, {
    method: "POST",
    accessToken,
  });
}

export interface DirectAllocationPayload {
  cpf: string;
  phone: string;
  horsePlate: string;
  vehicleType: string;
  trailerPlate?: string;
  trailerPlate2?: string;
}

export async function createDirectAllocation(loadId: string, payload: DirectAllocationPayload) {
  const accessToken = await getOperatorAccessToken();

  return requestJson<{
    ok: boolean;
    lead: PublicLoadLead;
    load: {
      id: string;
      status: string;
      origem: string;
      destino: string;
      perfil: string;
      data: string;
      horario: string;
      reservedAt: string | null;
      reservedUntil: string | null;
      reservedPublicLeadId: string | null;
    };
    meta: { correlationId: string };
  }>(`/api/operator/loads/${loadId}/direct-allocation`, {
    method: "POST",
    accessToken,
    body: payload,
  });
}

export async function cancelOperatorLoadLead(loadId: string, leadId: string) {
  const accessToken = await getOperatorAccessToken();

  return requestJson<{
    ok: boolean;
    lead: PublicLoadLead;
    load: {
      id: string;
      status: string;
      origem: string;
      destino: string;
      perfil: string;
      data: string;
      horario: string;
      reservedAt: string | null;
      reservedUntil: string | null;
      reservedPublicLeadId: string | null;
    };
    meta: {
      correlationId: string;
      idempotent: boolean;
    };
  }>(`/api/loads/${loadId}/leads/${leadId}/cancel`, {
    method: "POST",
    accessToken,
  });
}

export async function createDriverClaim(loadId: string, accessToken: string) {
  return requestJson(`/api/loads/${loadId}/claims`, {
    method: "POST",
    accessToken,
    idempotencyKey: createIdempotencyKey(),
  });
}

export async function confirmDriverClaim(loadId: string, claimId: string, accessToken: string) {
  return requestJson(`/api/loads/${loadId}/claims/${claimId}/confirm`, {
    method: "POST",
    accessToken,
    idempotencyKey: createIdempotencyKey(),
  });
}

export async function cancelDriverClaim(loadId: string, claimId: string, accessToken: string) {
  return requestJson(`/api/loads/${loadId}/claims/${claimId}/cancel`, {
    method: "POST",
    accessToken,
    idempotencyKey: createIdempotencyKey(),
  });
}
