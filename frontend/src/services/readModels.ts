import { getOperatorAccessToken, requestJson } from "@/services/apiClient";
import type { PublicLeadValidationSummary, PublicLeadValidationOverallStatus } from "@/services/loadClaims";

export interface DriverLoadReadModelItem {
  id: string;
  data: string;
  horario: string;
  origem: string;
  destino: string;
  distancia_km: number | null;
  duracao_horas: number | null;
  tempo_estimado_horas: number | null;
  perfil: string;
  valor: number | null;
  bonus: number | null;
  clienteId: string | null;
  clienteNome: string | null;
  clienteDescricao: string | null;
  carregamentoLabel: string | null;
  descargaLabel: string | null;
}

export interface OperatorDashboardItem {
  id: string;
  data: string;
  horario: string;
  origem: string;
  destino: string;
  distancia_km: number | null;
  duracao_horas: number | null;
  perfil: string;
  valor: number | null;
  bonus: number | null;
  driver_visibility: "PUBLIC" | "PREMIUM";
  status: string;
  is_template: boolean;
  sheet_lh: string | null;
  sheet_data_carregamento: string | null;
  sheet_data_descarga: string | null;
  cliente: {
    id: string;
    nome: string;
    descricao: string | null;
    forma_pagamento: string | null;
    prazo_pagamento: string | null;
    observacoes: string | null;
    tipo_veiculo: string | null;
    peso: string | null;
    exige_antt: boolean;
    exige_carga_monitorada: boolean;
    exige_rastreamento: boolean;
    exige_seguro: boolean;
    reputacao_boa_comunicacao: boolean;
    reputacao_bom_pagador: boolean;
    reputacao_carga_organizada: boolean;
    reputacao_liberacao_rapida: boolean;
    reputacao_pagamento_rapido: boolean;
  } | null;
}

interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
  maxPageSize: number;
  correlationId: string;
}

export interface OperatorCargoListItem {
  id: string;
  data: string;
  horario: string;
  origem: string;
  destino: string;
  distancia_km: number | null;
  duracao_horas: number | null;
  perfil: string;
  valor: number | null;
  bonus: number | null;
  bonus_exigencias: string | null;
  driver_visibility: "PUBLIC" | "PREMIUM";
  status: string;
  is_template: boolean;
  cliente_id: string | null;
  sheet_lh: string | null;
  sheet_data_carregamento: string | null;
  sheet_data_descarga: string | null;
  clientes: {
    nome: string;
  } | null;
}

export interface OperatorClienteListItem {
  id: string;
  created_at: string;
  nome: string;
  descricao: string | null;
  logo_url: string | null;
  forma_pagamento: string | null;
  prazo_pagamento: string | null;
  peso: string | null;
  tipo_veiculo: string | null;
  valor_frete: string | null;
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
  rastreamento: string | null;
  antt: string | null;
}

export interface OperatorRouteListItem {
  id: string;
  route_key: string;
  origin_key: string;
  destination_key: string;
  origem: string;
  destino: string;
  distancia_km: number | null;
  duracao_horas: number | null;
  tempo_estimado_horas: number | null;
  perfil_padrao: string | null;
  valor_padrao: number | null;
  bonus_padrao: number | null;
  ativa: boolean;
  observacoes: string | null;
  created_at: string | null;
  updated_at: string | null;
  base_route_label: string | null;
  persisted: boolean;
  source: "base" | "base+db" | "db";
}

export interface OperatorDriverApplicationItem {
  id: string;
  source: "CLAIM" | "PUBLIC_LEAD";
  status: string;
  submittedAt: string;
  queuePosition: number | null;
  vehicleType: string | null;
  plates: {
    horsePlate: string | null;
    trailerPlate: string | null;
    trailerPlate2: string | null;
  } | null;
  validation: PublicLeadValidationSummary | null;
  load: {
    id: string;
    status: string;
    origem: string;
    destino: string;
    data: string;
    horario: string;
    perfil: string;
  };
}

export interface OperatorDriverListItem {
  id: string;
  sourceType: "REGISTERED" | "PUBLIC_LEAD" | "HISTORICO";
  registrationStatus: "REGISTERED" | "PUBLIC_ONLY";
  displayName: string;
  contact: {
    phone: string | null;
    document: string | null;
  };
  profile: {
    vehicleProfile: string | null;
    active: boolean | null;
    documentsValid: boolean | null;
    anttValid: boolean | null;
    trackingEnabled: boolean | null;
    insuranceValid: boolean | null;
    monitoringCapable: boolean | null;
    operationalBlocked: boolean | null;
  };
  externalValidation: {
    overallStatus: PublicLeadValidationOverallStatus;
    warnings: string[];
    hasAngelira: boolean;
    hasAspx: boolean;
    checkedAt: string | null;
  } | null;
  angelliraVigency: {
    status: string | null;
    statusText: string | null;
    validUntil: string | null;
    daysUntilExpiry: number | null;
    alertLevel: "OK" | "EXPIRING_SOON" | "EXPIRED" | null;
    checkedAt: string | null;
  } | null;
  angelliraDetails: {
    name: string | null;
    cpf: string | null;
    birthDate: string | null;
    rg: string | null;
    uf: string | null;
    fatherName: string | null;
    motherName: string | null;
    cnhNumber: string | null;
    cnhCategory: string | null;
    cnhSecurityCode: string | null;
    cnhValidity: string | null;
    phone: string | null;
    city: string | null;
    naturalness: string | null;
  } | null;
  stats: {
    totalApplications: number;
    queuedApplications: number;
    reservedApplications: number;
    confirmedApplications: number;
    latestApplicationAt: string | null;
  };
  applications: OperatorDriverApplicationItem[];
}

export async function fetchDriverLoads(params: Record<string, string>) {
  const query = new URLSearchParams(params).toString();
  return requestJson<{
    items: DriverLoadReadModelItem[];
    summary: {
      totalCount: number;
      uniqueStateCount: number;
      uniqueProfileCount: number;
    };
    meta: PaginationMeta;
  }>(`/api/driver/loads${query ? `?${query}` : ""}`);
}

async function fetchPagesWithConcurrency<T>(
  fetchers: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < fetchers.length; i += concurrency) {
    const batch = fetchers.slice(i, i + concurrency).map((fn) => fn());
    const batchResults = await Promise.all(batch);
    results.push(...batchResults);
  }
  return results;
}

export async function fetchDriverLoadsSnapshot(params: Record<string, string>) {
  const pageSize = 24;
  const firstPage = await fetchDriverLoads({
    ...params,
    page: "1",
    pageSize: String(pageSize),
  });

  if (firstPage.meta.totalPages <= 1) {
    return {
      items: firstPage.items,
      summary: firstPage.summary,
      meta: firstPage.meta,
    };
  }

  const remainingPages = await fetchPagesWithConcurrency(
    Array.from({ length: firstPage.meta.totalPages - 1 }, (_, pageIndex) => () =>
      fetchDriverLoads({
        ...params,
        page: String(pageIndex + 2),
        pageSize: String(pageSize),
      }),
    ),
    3, // max 3 concurrent requests
  );

  return {
    items: [firstPage.items, ...remainingPages.map((page) => page.items)].flat(),
    summary: {
      ...firstPage.summary,
      totalCount: firstPage.meta.totalCount,
    },
    meta: {
      ...firstPage.meta,
      page: 1,
      pageSize,
      hasNextPage: false,
    },
  };
}

export async function fetchDriverLoadFacets() {
  return requestJson<{
    origemOptions: string[];
    destinoOptions: string[];
    perfilOptions: string[];
    meta: {
      correlationId: string;
    };
  }>("/api/driver/loads/facets");
}

export async function fetchOperatorDashboard(params: Record<string, string>) {
  const accessToken = await getOperatorAccessToken();
  const query = new URLSearchParams(params).toString();

  return requestJson<{
    items: OperatorDashboardItem[];
    summary: {
      activeCount: number;
      draftCount: number;
      templateCount: number;
    };
    meta: PaginationMeta;
  }>(`/api/operator/dashboard${query ? `?${query}` : ""}`, {
    accessToken,
  });
}

export async function fetchOperatorCargas(params: Record<string, string>) {
  const accessToken = await getOperatorAccessToken();
  const query = new URLSearchParams(params).toString();

  return requestJson<{
    items: OperatorCargoListItem[];
    meta: PaginationMeta;
  }>(`/api/operator/cargas${query ? `?${query}` : ""}`, {
    accessToken,
  });
}

export async function fetchOperatorClientes(params: Record<string, string>) {
  const accessToken = await getOperatorAccessToken();
  const query = new URLSearchParams(params).toString();

  return requestJson<{
    items: OperatorClienteListItem[];
    meta: PaginationMeta;
  }>(`/api/operator/clientes${query ? `?${query}` : ""}`, {
    accessToken,
  });
}

export async function fetchOperatorRoutes(params: Record<string, string>) {
  const accessToken = await getOperatorAccessToken();
  const query = new URLSearchParams(params).toString();

  return requestJson<{
    items: OperatorRouteListItem[];
    supportsCatalogFields: boolean;
    summary: {
      totalRoutes: number;
      activeRoutes: number;
      baseRoutes: number;
    };
    meta: PaginationMeta;
  }>(`/api/operator/routes${query ? `?${query}` : ""}`, {
    accessToken,
  });
}

export async function fetchOperatorDrivers(params: Record<string, string>) {
  const accessToken = await getOperatorAccessToken();
  const query = new URLSearchParams(params).toString();

  return requestJson<{
    items: OperatorDriverListItem[];
    summary: {
      totalDrivers: number;
      registeredCount: number;
      publicOnlyCount: number;
      totalApplications: number;
    };
    meta: PaginationMeta;
  }>(`/api/operator/motoristas${query ? `?${query}` : ""}`, {
    accessToken,
  });
}

export interface OperatorVehicleListItem {
  id: string;
  plate: string;
  vehicleType: string | null;
  plateRole: "HORSE" | "TRAILER_1" | "TRAILER_2";
  angelliraStatus: string | null;
  angelliraValidUntil: string | null;
  angelliraStatusText: string | null;
  angelliraDisplayName: string | null;
  angelliraLastSeenAt: string | null;
  angelliraCheckedAt: string | null;
  linkedDriverId: string | null;
  linkedDriverCpf: string | null;
  linkedDriverName: string | null;
  linkedDriverPhone: string | null;
  source: "PUBLIC_LEAD" | "MANUAL";
  angelliraVigency: {
    status: string | null;
    statusText: string | null;
    validUntil: string | null;
    daysUntilExpiry: number | null;
    alertLevel: "OK" | "EXPIRING_SOON" | "EXPIRED" | null;
    checkedAt: string | null;
  } | null;
  angelliraDetails: {
    type: string | null;
    plate: string | null;
    brand: string | null;
    model: string | null;
    fabricationYear: number | null;
    modelYear: number | null;
    color: string | null;
    renavam: string | null;
    chassis: string | null;
    antt: string | null;
    uf: string | null;
    lastLicensing: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export async function fetchOperatorVehicles(params: Record<string, string>) {
  const accessToken = await getOperatorAccessToken();
  const query = new URLSearchParams(params).toString();

  return requestJson<{
    items: OperatorVehicleListItem[];
    summary: {
      totalVehicles: number;
      foundCount: number;
      notFoundCount: number;
      expiringSoonCount: number;
    };
    meta: PaginationMeta;
  }>(`/api/operator/veiculos${query ? `?${query}` : ""}`, {
    accessToken,
  });
}

export interface SheetMonitorRow {
  lh: string;
  tipo: string | null;
  status: string;
  motoristas: string;
  origem: string;
  destino: string;
  data: string | null;
  horario: string | null;
  carregamentoLabel: string | null;
  descargaLabel: string | null;
  valor: number | undefined;
  cavalo: string;
  carreta: string;
  checklistCavalo: string;
  checklistCarreta: string;
  isAvailable: boolean;
  hasDriver: boolean;
}

export interface SheetMonitorSummary {
  total: number;
  available: number;
  assigned: number;
  withStatus: number;
  statuses: Record<string, number>;
  tipos: Record<string, number>;
}

export interface SheetMonitorEnrichedRow {
  lh: string;
  driver_name: string | null;
  aspx_cpf: string | null;
  aspx_display_name: string | null;
  angellira_driver_found: boolean | null;
  angellira_driver_status: string | null;
  angellira_driver_valid_until: string | null;
  angellira_driver_status_text: string | null;
  angellira_driver_details: unknown;
  cavalo_plate: string | null;
  cavalo_source: "db" | "angellira" | "not_found" | null;
  cavalo_type: string | null;
  cavalo_angellira_found: boolean | null;
  cavalo_angellira_status: string | null;
  cavalo_angellira_valid_until: string | null;
  cavalo_angellira_status_text: string | null;
  cavalo_angellira_display: string | null;
  cavalo_details: unknown;
  carreta_plate: string | null;
  carreta_source: "db" | "angellira" | "not_found" | null;
  carreta_type: string | null;
  carreta_angellira_found: boolean | null;
  carreta_angellira_status: string | null;
  carreta_angellira_valid_until: string | null;
  carreta_angellira_status_text: string | null;
  carreta_angellira_display: string | null;
  carreta_details: unknown;
  enriched_at: string | null;
}

export async function fetchSheetMonitor({ refresh = false }: { refresh?: boolean } = {}) {
  const accessToken = await getOperatorAccessToken();
  const url = refresh ? "/api/operator/sheet-monitor?refresh=true" : "/api/operator/sheet-monitor";

  return requestJson<{
    items: SheetMonitorRow[];
    summary: SheetMonitorSummary;
    enrichedByLh: Record<string, SheetMonitorEnrichedRow>;
    meta: {
      correlationId: string;
      sheetConfigured: boolean;
      cachedAt?: string;
      noSnapshot?: boolean;
      snapshotSaved?: boolean;
      snapshotSaveError?: string;
    };
  }>(url, { accessToken });
}

export async function enrichSheetMonitor({ force = false }: { force?: boolean } = {}): Promise<{
  enriched: number;
  remaining: number;
}> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ enriched: number; remaining: number }>(
    `/api/operator/sheet-monitor/enrich${force ? "?force=true" : ""}`,
    { accessToken, method: "POST" },
  );
}

export interface SheetMonitorVehicleDetail {
  plate: string;
  source: "db" | "angellira" | "not_found";
  vehicle_type?: string | null;
  plate_role?: string | null;
  angellira_status?: string | null;
  angellira_valid_until?: string | null;
  angellira_status_text?: string | null;
  angellira_display_name?: string | null;
  angellira_details?: unknown;
  linked_driver_cpf?: string | null;
  updated_at?: string | null;
}

export interface SheetMonitorDriverProfile {
  user_id: string;
  full_name: string | null;
  document_number: string | null;
  vehicle_profile: string | null;
  documents_valid: boolean | null;
  antt_valid: boolean | null;
  insurance_valid: boolean | null;
  tracking_enabled: boolean | null;
  angellira_status: string | null;
  angellira_valid_until: string | null;
  angellira_status_text: string | null;
  angellira_details: unknown;
}

export interface SheetMonitorRowDetail {
  row: SheetMonitorRow;
  driver: {
    queried: boolean;
    searchName: string | null;
    profiles: SheetMonitorDriverProfile[];
  };
  vehicles: {
    cavalo: SheetMonitorVehicleDetail | null;
    carreta: SheetMonitorVehicleDetail | null;
  };
  meta: { correlationId: string };
}

export async function fetchSheetMonitorRowDetail(lh: string): Promise<SheetMonitorRowDetail> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<SheetMonitorRowDetail>(
    `/api/operator/sheet-monitor/row?lh=${encodeURIComponent(lh)}`,
    { accessToken },
  );
}

export interface DriverFlowMetricsFunnel {
  preRegistered: number;
  queued: number;
  whatsappClicked: number;
  approved: number;
  cancelled: number;
  avgPreregToWhatsappSeconds: number | null;
  avgPreregToApprovedSeconds: number | null;
}

export interface DriverFlowMetricsAccessPeaks {
  byHour: { hour: number; total: number }[];
  byDow: { dow: number; total: number }[];
}

export interface DriverFlowMetricsPortalVisits {
  total: number;
  byHour: { hour: number; total: number }[];
  byDow: { dow: number; total: number }[];
}

export interface DriverFlowMetricsValidation {
  total: number;
  valid: number;
  expiring: number;
  invalid: number;
  notFound: number;
  plateMismatch: number;
  pending: number;
  angeliraFound: number;
  aspxFound: number;
  topWarnings: { warning: string; total: number }[];
}

export interface DriverFlowMetricsRecurrence {
  uniqueCpfs: number;
  totalCandidaturas: number;
  avgPerCpf: number;
  maxPerCpf: number;
  newDrivers: number;
  recurringDrivers: number;
}

export interface DriverFlowMetricsResponse {
  window: {
    from: string;
    toExclusive: string;
  };
  funnel: DriverFlowMetricsFunnel;
  accessPeaks: DriverFlowMetricsAccessPeaks;
  validation: DriverFlowMetricsValidation;
  recurrence: DriverFlowMetricsRecurrence;
  portalVisits: DriverFlowMetricsPortalVisits;
  meta: {
    correlationId: string | null;
  };
}

export interface OperatorAuditLogItem {
  id: string;
  eventType: string;
  severity: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  actorDisplayName: string | null;
  actorRole: string | null;
  resourceType: string | null;
  resourceId: string | null;
  action: string | null;
  outcome: string | null;
  requestIp: string | null;
  correlationId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface OperatorAuditOperatorSummary {
  id: string;
  email: string | null;
  displayName: string | null;
  accessLevel: "advanced" | "intermediate" | null;
}

export async function fetchOperatorAuditLogs(query: { dateFrom?: string; dateTo?: string; operatorId?: string; page?: string; pageSize?: string }) {
  const accessToken = await getOperatorAccessToken();
  const search = new URLSearchParams();
  if (query.dateFrom) search.set("dateFrom", query.dateFrom);
  if (query.dateTo) search.set("dateTo", query.dateTo);
  if (query.operatorId) search.set("operatorId", query.operatorId);
  if (query.page) search.set("page", query.page);
  if (query.pageSize) search.set("pageSize", query.pageSize);
  const qs = search.toString();
  const url = qs ? `/api/operator/audit-logs?${qs}` : "/api/operator/audit-logs";

  return requestJson<{
    items: OperatorAuditLogItem[];
    meta: {
      page: number;
      pageSize: number;
      totalCount: number;
      totalPages: number;
      hasNextPage: boolean;
      maxPageSize: number;
      correlationId: string;
    };
    operators: OperatorAuditOperatorSummary[];
  }>(url, { accessToken });
}

export async function fetchDriverFlowMetrics(query: { dateFrom?: string; dateTo?: string }) {
  const accessToken = await getOperatorAccessToken();
  const search = new URLSearchParams();
  if (query.dateFrom) search.set("dateFrom", query.dateFrom);
  if (query.dateTo) search.set("dateTo", query.dateTo);
  const qs = search.toString();
  const url = qs ? `/api/operator/driver-flow-metrics?${qs}` : "/api/operator/driver-flow-metrics";

  return requestJson<DriverFlowMetricsResponse>(url, { accessToken });
}
