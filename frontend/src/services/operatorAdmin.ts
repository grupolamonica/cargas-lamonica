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

export async function attachClienteRota(clienteId: string, rotaId: string) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{
    cliente_id: string;
    rota_id: string;
    link_id: string | null;
    created_at: string | null;
    already_existed: boolean;
    meta: { correlationId: string };
  }>(`/api/operator/clientes/${clienteId}/rotas`, {
    method: "POST",
    accessToken,
    body: { rotaId },
  });
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
