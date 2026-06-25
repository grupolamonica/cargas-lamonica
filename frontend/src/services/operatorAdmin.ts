import { getOperatorAccessToken, requestJson } from "@/services/apiClient";

export type OperatorCargoStatus =
  | "DRAFT"
  | "OPEN"
  | "RESERVED"
  | "BOOKED"
  | "EXPIRED"
  | "CANCELLED"
  | "COMPLETED"
  | "FAILED";

export interface OperatorCargoPayload {
  data: string;
  horario: string;
  origem: string;
  destino: string;
  perfil: string;
  valor: number | null;
  bonus: number | null;
  bonus_exigencias: string | null;
  driver_visibility: "PUBLIC" | "PREMIUM";
  cliente_id: string | null;
  status: OperatorCargoStatus;
  is_template: boolean;
  /** Carga recorrente: renova-se sozinha e clona ao ser reservada. */
  is_recurring: boolean;
  /** Intervalo entre ocorrências em dias (1 = diária). null quando não recorrente. */
  recurrence_interval_days: number | null;
  distancia_km: number | null;
  duracao_horas: number | null;
  sheet_data_carregamento: string | null;
  sheet_data_descarga: string | null;
}

export interface CustomBadgeItem {
  id: string;
  label: string;
  icon_name: string;
  active: boolean;
}

export interface OperatorClientePayload {
  nome: string;
  descricao: string | null;
  logo_url: string | null;
  logo_url_card: string | null;
  logo_url_proximas: string | null;
  forma_pagamento: string | null;
  prazo_pagamento: string | null;
  exige_rastreamento: boolean;
  exige_antt: boolean;
  exige_seguro: boolean;
  exige_carga_monitorada: boolean;
  reputacao_pagamento_rapido: boolean;
  reputacao_bom_pagador: boolean;
  reputacao_liberacao_rapida: boolean;
  reputacao_carga_organizada: boolean;
  reputacao_boa_comunicacao: boolean;
  observacoes: string | null;
  custom_reputacoes: CustomBadgeItem[];
  custom_exigencias: CustomBadgeItem[];
}

export interface OperatorRoutePayload {
  origem: string;
  destino: string;
  distancia_km: number | null;
  duracao_horas: number | null;
  tempo_estimado_horas: number | null;
  perfil_padrao: string | null;
  valor_padrao: number | null;
  bonus_padrao: number | null;
  bonus_exigencias: string | null;
  ativa: boolean;
  observacoes: string | null;
}

interface MutationResponse {
  ok: boolean;
  id?: string | null;
  rota_id?: string | null;
  warnings?: string[];
  cascadedCargaCount?: number;
  meta: {
    correlationId: string;
  };
}

export async function createOperatorCargo(payload: OperatorCargoPayload) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<MutationResponse>("/api/operator/cargas", {
    method: "POST",
    accessToken,
    body: payload,
  });
}

export async function updateOperatorCargo(cargoId: string, payload: OperatorCargoPayload) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<MutationResponse>(`/api/operator/cargas/${cargoId}`, {
    method: "PATCH",
    accessToken,
    body: payload,
  });
}

export async function revalidateOperatorVehiclesAngellira() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{
    ok: boolean;
    total: number;
    revalidated: number;
    failed: number;
    limit: number;
    truncated: boolean;
    meta: { correlationId: string | null };
  }>(`/api/operator/veiculos/revalidate`, {
    method: "POST",
    accessToken,
  });
}

export async function syncOperatorCargasSheet() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{
    ok: boolean;
    inserted?: number;
    updated?: number;
    deactivated?: number;
    meta: { correlationId: string };
  }>(`/api/operator/cargas/sync-sheet`, {
    method: "POST",
    accessToken,
  });
}

export interface ImportCargoRowPreview {
  cod_carga: string | null;
  perfil: string;
  data: string;
  horario: string;
  data_descarga: string | null;
  origem: string;
  destino: string;
  status: string;
}

export interface ImportCargoRowResult {
  line: number;
  ok: boolean;
  errors: string[];
  preview: ImportCargoRowPreview;
  duplicate: boolean;
}

export interface ImportCargasResponse {
  ok: boolean;
  dryRun: boolean;
  headerError?: string;
  summary: {
    total: number;
    valid: number;
    invalid: number;
    duplicated: number;
    importable: number;
    imported: number;
  };
  rows: ImportCargoRowResult[];
  meta: { correlationId: string };
}

/**
 * Importa cargas a partir de um CSV. Com `dryRun: true` apenas valida e devolve
 * o preview por linha (sem gravar); com `dryRun: false` grava as linhas válidas.
 */
export async function importOperatorCargas(csv: string, dryRun: boolean) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<ImportCargasResponse>("/api/operator/cargas/import", {
    method: "POST",
    accessToken,
    body: { csv, dryRun },
  });
}

export async function duplicateOperatorCargo(cargoId: string) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<MutationResponse>(`/api/operator/cargas/${cargoId}/duplicate`, {
    method: "POST",
    accessToken,
  });
}

export async function toggleOperatorCargoStatus(cargoId: string) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean; status: string; meta: { correlationId: string } }>(
    `/api/operator/cargas/${cargoId}/toggle-status`,
    {
      method: "POST",
      accessToken,
    },
  );
}

export async function deleteOperatorCargo(cargoId: string) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<MutationResponse>(`/api/operator/cargas/${cargoId}`, {
    method: "DELETE",
    accessToken,
  });
}

export async function createOperatorCliente(payload: OperatorClientePayload) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<MutationResponse>("/api/operator/clientes", {
    method: "POST",
    accessToken,
    body: payload,
  });
}

export async function updateOperatorCliente(clienteId: string, payload: OperatorClientePayload) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<MutationResponse>(`/api/operator/clientes/${clienteId}`, {
    method: "PATCH",
    accessToken,
    body: payload,
  });
}

export async function deleteOperatorCliente(clienteId: string) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<MutationResponse>(`/api/operator/clientes/${clienteId}`, {
    method: "DELETE",
    accessToken,
  });
}

// ── Cliente <-> Rota associations (N:M) ───────────────────────────

export interface ClienteRotaTarifa {
  tipo_veiculo: string;
  valor_frete: number | null;
  bonus: number | null;
  bonus_exigencias: string | null;
}

export interface ClienteRotaItem {
  rota_id: string;
  origem: string;
  destino: string;
  distancia_km: number | null;
  tarifas: ClienteRotaTarifa[];
}

export interface ClienteRotasResponse {
  cliente_id: string;
  cliente_nome: string;
  rotas: ClienteRotaItem[];
  meta: { correlationId: string };
}

export async function fetchClienteRotas(clienteId: string) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<ClienteRotasResponse>(
    `/api/operator/clientes/${clienteId}/rotas`,
    { accessToken },
  );
}

export interface AttachClienteRotaResponse {
  cliente_id: string;
  rota_id: string;
  previous_cliente_id: string | null;
  transferred: boolean;
  already_attached: boolean;
  meta: { correlationId: string };
}

export async function attachClienteRota(clienteId: string, rotaId: string) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<AttachClienteRotaResponse>(
    `/api/operator/clientes/${clienteId}/rotas`,
    { method: "POST", accessToken, body: { rotaId } },
  );
}

export async function detachClienteRota(clienteId: string, rotaId: string) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{
    cliente_id: string;
    rota_id: string;
    removed: boolean;
    meta: { correlationId: string };
  }>(`/api/operator/clientes/${clienteId}/rotas/${rotaId}`, {
    method: "DELETE",
    accessToken,
  });
}

export async function createOperatorRoute(payload: OperatorRoutePayload) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<MutationResponse>("/api/operator/routes", {
    method: "POST",
    accessToken,
    body: payload,
  });
}

export async function updateOperatorRoute(routeId: string, payload: OperatorRoutePayload) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<MutationResponse>(`/api/operator/routes/${routeId}`, {
    method: "PATCH",
    accessToken,
    body: payload,
  });
}

// ─── Pacotes (cargas_casadas) — Phase 10 plan 10-07 ─────────────────────────

export type PacoteStatus =
  | "rascunho"
  | "publicado"
  | "reservado"
  | "em_andamento"
  | "concluido"
  | "cancelado";

export interface PacoteCargaSummary {
  id: string;
  ordem_viagem: number | null;
  status: string;
  origem: string;
  destino: string;
  valor: number | null;
  bonus: number | null;
  data: string | null;
  horario: string | null;
  perfil: string | null;
  cliente_id: string | null;
  cliente_nome: string | null;
}

export interface OperatorPacoteListItem {
  id: string;
  status: PacoteStatus;
  valor_total: number | null;
  version: number;
  published_at: string | null;
  reserved_driver_id: string | null;
  reserved_claim_id: string | null;
  booked_driver_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  cargas: PacoteCargaSummary[];
}

export interface OperatorPacoteDetailCarga {
  id: string;
  ordem_viagem: number | null;
  status: string;
  driver_visibility: "PUBLIC" | "PREMIUM";
  origem: string;
  destino: string;
  valor: number | null;
  bonus: number | null;
  bonus_exigencias: string | null;
  data: string | null;
  horario: string | null;
  perfil: string | null;
  distancia_km: number | null;
  duracao_horas: number | null;
  cliente_id: string | null;
  cliente_nome: string | null;
  cliente_logo_url: string | null;
}

export interface OperatorPacoteDetail {
  pacote: {
    id: string;
    status: PacoteStatus;
    valor_total: number | null;
    version: number;
    published_at: string | null;
    reserved_driver_id: string | null;
    reserved_claim_id: string | null;
    booked_driver_id: string | null;
    created_by: string | null;
    created_at: string;
    updated_at: string;
  };
  cargas: OperatorPacoteDetailCarga[];
}

function newIdempotencyKey(): string {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Map error codes (HTTP-shape + domain) -> mensagens pt-BR para o operador.
 * O backend retorna `code` (ex.: "VALIDATION_ERROR", "CONFLICT") e
 * `details.code` (ex.: "limite_cargas_excedido"). Consultamos ambos.
 */
export const PACOTE_ERROR_MESSAGES: Record<string, string> = {
  limite_cargas_excedido: "Pacote pode ter no máximo 3 cargas.",
  pacote_nao_editavel: "Pacote não pode ser alterado no status atual.",
  pacote_indisponivel: "Pacote não está disponível para esta ação.",
  cargas_nao_premium: "Todas as cargas precisam ser PREMIUM antes de publicar.",
  cargas_nao_abertas: "Todas as cargas precisam estar abertas (OPEN) para publicar.",
  valor_total_obrigatorio: "Informe o valor total (maior que zero) antes de publicar.",
  pacote_vazio: "Pacote precisa de pelo menos 1 carga para publicar.",
  carga_ja_em_pacote: "Carga já faz parte de outro pacote.",
  carga_com_reserva_ativa: "Carga tem candidatura ativa — cancele a reserva antes.",
  carga_status_invalido: "Carga em status incompatível com o pacote.",
  carga_nao_premium: "Pacote publicado exige cargas PREMIUM.",
  carga_nao_aberta: "Pacote publicado exige cargas em status OPEN.",
  ordem_em_uso: "Essa ordem já está ocupada por outra carga do pacote.",
  publish_status_invalido: "Apenas pacotes em rascunho podem ser publicados.",
  pacote_ja_terminal: "Pacote já está concluído ou cancelado.",
};

export interface FetchPacotesParams {
  status?: PacoteStatus;
  limit?: number;
  offset?: number;
}

export interface FetchPacotesResponse {
  items: OperatorPacoteListItem[];
  pagination: { total: number; limit: number; offset: number };
  meta: { correlationId: string | null };
}

export async function fetchOperatorPacotes(params: FetchPacotesParams = {}): Promise<FetchPacotesResponse> {
  const accessToken = await getOperatorAccessToken();
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  qs.set("limit", String(params.limit ?? 20));
  qs.set("offset", String(params.offset ?? 0));
  return requestJson<FetchPacotesResponse>(`/api/operator/cargas-casadas?${qs.toString()}`, {
    accessToken,
  });
}

export async function fetchOperatorPacote(pacoteId: string): Promise<OperatorPacoteDetail> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<OperatorPacoteDetail>(`/api/operator/cargas-casadas/${pacoteId}`, {
    accessToken,
  });
}

export interface CreatePacotePayload {
  valor_total?: number | null;
}

export interface CreatedPacote {
  ok: boolean;
  pacote: {
    id: string;
    status: PacoteStatus;
    valor_total: number | null;
    version: number;
    created_at: string;
  };
  meta: { correlationId: string | null };
}

export async function createPacote(payload: CreatePacotePayload = {}): Promise<CreatedPacote> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<CreatedPacote>(`/api/operator/cargas-casadas`, {
    method: "POST",
    accessToken,
    headers: { "Idempotency-Key": newIdempotencyKey() },
    body: payload,
  });
}

export interface UpdatedPacote {
  ok: boolean;
  pacote: {
    id: string;
    status: PacoteStatus;
    valor_total: number | null;
    version: number;
    updated_at: string;
  };
  meta: { correlationId: string | null };
}

export async function updatePacote(
  pacoteId: string,
  payload: { valor_total: number },
): Promise<UpdatedPacote> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<UpdatedPacote>(`/api/operator/cargas-casadas/${pacoteId}`, {
    method: "PUT",
    accessToken,
    headers: { "Idempotency-Key": newIdempotencyKey() },
    body: payload,
  });
}

export interface AddCargaResponse {
  ok: boolean;
  pacoteId: string;
  cargaId: string;
  ordem: number;
  version: number;
  total_cargas: number;
  meta: { correlationId: string | null };
}

export async function addCargaToPacote(
  pacoteId: string,
  payload: { cargaId: string; ordem?: number },
): Promise<AddCargaResponse> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<AddCargaResponse>(`/api/operator/cargas-casadas/${pacoteId}/cargas`, {
    method: "POST",
    accessToken,
    headers: { "Idempotency-Key": newIdempotencyKey() },
    body: payload,
  });
}

export interface RemoveCargaResponse {
  ok: boolean;
  pacoteId: string;
  cargaId: string;
  total_cargas: number;
  version: number;
  meta: { correlationId: string | null };
}

export async function removeCargaFromPacote(
  pacoteId: string,
  cargaId: string,
): Promise<RemoveCargaResponse> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<RemoveCargaResponse>(
    `/api/operator/cargas-casadas/${pacoteId}/cargas/${cargaId}`,
    {
      method: "DELETE",
      accessToken,
      headers: { "Idempotency-Key": newIdempotencyKey() },
    },
  );
}

export interface ReorderResponse {
  ok: boolean;
  pacoteId: string;
  version: number;
  meta: { correlationId: string | null };
}

export async function reorderCargasInPacote(
  pacoteId: string,
  orderings: Array<{ cargaId: string; ordem: number }>,
): Promise<ReorderResponse> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<ReorderResponse>(
    `/api/operator/cargas-casadas/${pacoteId}/cargas/reorder`,
    {
      method: "PUT",
      accessToken,
      headers: { "Idempotency-Key": newIdempotencyKey() },
      body: { orderings },
    },
  );
}

export interface PublishPacoteResponse {
  ok: boolean;
  pacote: {
    id: string;
    status: PacoteStatus;
    valor_total: number;
    version: number;
    published_at: string;
  };
  total_cargas: number;
  meta: { correlationId: string | null };
}

export async function publishPacote(pacoteId: string): Promise<PublishPacoteResponse> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<PublishPacoteResponse>(
    `/api/operator/cargas-casadas/${pacoteId}/publish`,
    {
      method: "POST",
      accessToken,
      headers: { "Idempotency-Key": newIdempotencyKey() },
    },
  );
}

export interface CancelPacoteResponse {
  ok: boolean;
  pacote: { id: string; status: PacoteStatus; version: number };
  cargas_afetadas: number;
  claims_rejeitados: number;
  meta: { correlationId: string | null };
}

export async function cancelPacote(pacoteId: string): Promise<CancelPacoteResponse> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<CancelPacoteResponse>(
    `/api/operator/cargas-casadas/${pacoteId}/cancel`,
    {
      method: "POST",
      accessToken,
      headers: { "Idempotency-Key": newIdempotencyKey() },
    },
  );
}

/**
 * Resolve a friendly pt-BR message from an `ApiError` (or any error) thrown by
 * the pacote service functions. Falls back to `error.message` and a generic
 * fallback if nothing matches.
 */
export function translatePacoteError(err: unknown, fallback = "Erro ao processar pacote."): string {
  if (err && typeof err === "object") {
    const e = err as { details?: { code?: string } | null; code?: string | null; message?: string };
    const domainCode = e.details?.code;
    if (domainCode && PACOTE_ERROR_MESSAGES[domainCode]) return PACOTE_ERROR_MESSAGES[domainCode];
    if (e.code && PACOTE_ERROR_MESSAGES[e.code]) return PACOTE_ERROR_MESSAGES[e.code];
    if (e.message) return e.message;
  }
  return fallback;
}
