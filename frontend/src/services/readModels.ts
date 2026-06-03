import { getOperatorAccessToken, requestJson } from "@/services/apiClient";
import type { PublicLeadValidationSummary, PublicLeadValidationOverallStatus } from "@/services/loadClaims";

/**
 * Pacote (cargas casadas) — meta enviada inline com cada carga no read model
 * driver-facing quando a carga pertence a um pacote. Permite que o `LoadCard`
 * detecte e renderize a vista de viagem casada sem fetch adicional.
 *
 * `total_cargas === 1` é um pacote "degenerado" — funcional equivalente a
 * carga avulsa; o LoadCard deve renderizar como avulsa nesse caso.
 *
 * Plan 10-05 (CARGAS-CASADAS-06).
 */
export interface PacoteMeta {
  id: string;
  status: "publicado" | "reservado" | "em_andamento";
  valor_total: number;
  version: number;
  total_cargas: number;
  /** Posição (1..N) desta carga específica dentro do pacote. */
  ordem_propria: number;
  published_at?: string | null;
  /**
   * Campos derivados (plan revisão 2026-05-23) — agregados sobre as cargas do
   * pacote. Opcionais para backward-compat com clientes antigos do read model.
   */
  /** Menor `data` (YYYY-MM-DD) entre as cargas do pacote. */
  earliest_carga_date?: string | null;
  /**
   * Horário (HH:MM:SS) da carga com menor data — usado pelo PacoteHeader badge
   * "Coleta DD/MM às HH:MM" (iter #2 2026-05-23). Null quando todas cargas
   * estão sem horário definido.
   */
  earliest_carga_horario?: string | null;
  /** Soma das `distancia_km` das cargas. */
  total_km?: number | null;
  /** Soma das `duracao_horas` das cargas. */
  total_duration_horas?: number | null;
  /** Cliente único (igual em todas as cargas) — null quando multi-cliente. */
  cliente_uniforme?: {
    id: string;
    nome: string | null;
    logo_url: string | null;
  } | null;
  /** Perfil de veículo único (igual em todas as cargas) — null quando heterogêneo. */
  perfil_uniforme?: string | null;
}

/** Carga individual dentro do payload `PacoteFull` (detalhe completo do pacote). */
export interface PacoteCarga {
  id: string;
  ordem_viagem: number;
  status: string;
  origem: string;
  destino: string;
  perfil: string;
  valor: number | null;
  bonus: number | null;
  bonus_exigencias: string | null;
  data: string | null;
  horario: string | null;
  distancia_km: number | null;
  duracao_horas: number | null;
  driver_visibility: "PUBLIC" | "PREMIUM";
  cliente: {
    id: string;
    nome: string;
    logo_url: string | null;
    descricao: string | null;
  } | null;
}

/** Payload completo retornado por GET /api/public-loads/pacotes/:id. */
export interface PacoteFull {
  id: string;
  status: "publicado" | "reservado" | "em_andamento";
  valor_total: number;
  version: number;
  published_at: string | null;
  total_cargas: number;
  cargas: PacoteCarga[];
}

/**
 * Fetch público anônimo (sem Authorization header) do detalhe completo de um
 * pacote. Backend retorna 404 quando o pacote não está em estado público
 * (publicado/reservado/em_andamento), garantindo que rascunhos não vazem.
 */
export async function fetchPacote(pacoteId: string): Promise<PacoteFull> {
  const res = await fetch(`/api/driver/pacotes/${pacoteId}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(
      body?.error?.message || `Falha ao carregar pacote (HTTP ${res.status})`,
    );
  }
  const json = (await res.json()) as { pacote: PacoteFull };
  return json.pacote;
}

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
  clienteLogoUrl: string | null;
  clienteLogoUrlCard: string | null;
  clienteLogoUrlProximas: string | null;
  carregamentoLabel: string | null;
  descargaLabel: string | null;
  /** Pacote ao qual esta carga pertence — null quando carga é avulsa. */
  viagem_id?: string | null;
  /** Posição dentro do pacote (1..N) — null quando carga é avulsa. */
  ordem_viagem?: number | null;
  /** Resumo do pacote para renderização inline no LoadCard — null quando avulsa. */
  pacote_meta?: PacoteMeta | null;
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
  /** Pacote (cargas_casadas) — null quando carga é avulsa. Plan 10-05. */
  viagem_id?: string | null;
  /** Posição da carga dentro do pacote (1..N) — null quando avulsa. */
  ordem_viagem?: number | null;
  /** Resumo inline do pacote para painel operador — null quando avulsa. */
  pacote_meta?: PacoteMeta | null;
}

export interface OperatorClienteListItem {
  id: string;
  created_at: string;
  nome: string;
  descricao: string | null;
  logo_url: string | null;
  logo_url_card: string | null;
  logo_url_proximas: string | null;
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
  custom_reputacoes: import("@/services/operatorAdmin").CustomBadgeItem[];
  custom_exigencias: import("@/services/operatorAdmin").CustomBadgeItem[];
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
  bonus_exigencias: string | null;
  ativa: boolean;
  observacoes: string | null;
  created_at: string | null;
  updated_at: string | null;
  base_route_label: string | null;
  persisted: boolean;
  source: "base" | "base+db" | "db";
  rota_id: string | null;
  cliente_id: string | null;
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

export async function enrichSheetMonitor({ force = false, forceSessionStart }: { force?: boolean; forceSessionStart?: string } = {}): Promise<{
  enriched: number;
  remaining: number;
}> {
  const accessToken = await getOperatorAccessToken();
  const params = new URLSearchParams();
  if (force) params.set("force", "true");
  if (forceSessionStart) params.set("forceSessionStart", forceSessionStart);
  const qs = params.toString();
  return requestJson<{ enriched: number; remaining: number }>(
    `/api/operator/sheet-monitor/enrich${qs ? `?${qs}` : ""}`,
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

export interface SponsorClickRow {
  brand: string;
  clicks: number;
}

export async function fetchSponsorClicks() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ items: SponsorClickRow[]; meta: { correlationId: string } }>(
    "/api/operator/sponsor-clicks",
    { accessToken },
  );
}

export async function fetchOperatorOverviewDigest() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ digest: string; meta: { correlationId: string } }>(
    "/api/operator/overview/digest",
    { accessToken },
  );
}

export async function fetchDriverLoadsDigest() {
  return requestJson<{ digest: string; meta: { correlationId: string } }>(
    "/api/driver/loads/digest",
  );
}

// ─── Cadastros pendentes de motoristas ───────────────────────────────────────

export interface PendingDriverRegistrationItem {
  id: string;
  id_cadastro: string;
  created_at: string;
  status: "pendente" | "em_revisao" | "aprovado" | "rejeitado";
  observacoes: string | null;
  reviewed_at: string | null;
  reviewed_by_id: string | null;
  nome_motorista: string | null;
  cpf_motorista: string | null;
  placa_cavalo: string | null;
  dados: Record<string, unknown> | null;
}

export async function fetchCadastrosPendentes(params: {
  status?: string;
  page?: number;
  pageSize?: number;
}) {
  const accessToken = await getOperatorAccessToken();
  const query = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return requestJson<{ items: PendingDriverRegistrationItem[]; meta: PaginationMeta }>(
    `/api/operator/cadastros-pendentes${query ? `?${query}` : ""}`,
    { accessToken },
  );
}

// ─── Rascunhos de cadastro (draft rescue) ────────────────────────────────────

export type DraftRegistrationItem = {
  id: string;
  carga_id: string | null;
  created_at: string;
  updated_at: string | null;
  current_step: string;
  step_label: string;
  progress_pct: number;
  at_confirmation: boolean;
  has_submit_key: boolean;
  cpf: string | null;
  nome: string | null;
  placa_cavalo: string | null;
  cnh_categoria: string | null;
  steps_done: { a: boolean; b: boolean; c: boolean; d: boolean; e: boolean };
};

export async function fetchDraftRegistrations(
  accessToken: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ items: DraftRegistrationItem[]; meta: { page: number; pageSize: number; total: number } }> {
  const query = new URLSearchParams(
    Object.entries({ page: opts.page, pageSize: opts.pageSize })
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return requestJson<{ items: DraftRegistrationItem[]; meta: { page: number; pageSize: number; total: number } }>(
    `/api/operator/cadastros/rascunhos${query ? `?${query}` : ""}`,
    { accessToken },
  );
}

export type AngelliraJobStep =
  | "proprietario_cavalo"
  | "cavalo"
  | "proprietario_carreta"
  | "carreta"
  | "motorista";

export type AngelliraStepResult = {
  step: AngelliraJobStep;
  status: "OK" | "OK_CACHED" | "ERROR";
  external_id?: string | null;
  error?: {
    code?: string;
    message?: string;
    etapa?: string | null;
    acao?: string | null;
  } | null;
};

export type ExternalRegistrationJob = {
  id: string;
  cadastro_id: string;
  driver_user_id?: string | null;
  target: "angellira" | "spx" | "unificada";
  step: string;
  status: "PENDING" | "IN_PROGRESS" | "OK" | "ERROR";
  external_id?: string | null;
  attempts?: number;
  error?: Record<string, unknown> | null;
  response?: Record<string, unknown> | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

/**
 * Aprova o cadastro. Opcionalmente dispara cadastro automático nos sistemas
 * externos via `jobs: ['angellira']`. Quando `jobs` vazio (default), só cria
 * conta Supabase — comportamento original preservado.
 *
 * DC-111 / Sprint 1.
 */
export async function aprovarCadastro(id: string, options?: { jobs?: string[] }) {
  const accessToken = await getOperatorAccessToken();
  const response = await fetch(`/api/operator/cadastros/${id}/aprovar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jobs: options?.jobs ?? [] }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error((body as { message?: string })?.message || "Erro ao aprovar cadastro.");
  }
  return response.json() as Promise<{
    ok: boolean;
    driverId: string;
    jobs?: string[];
    angellira?: { ok: boolean; results: AngelliraStepResult[]; error?: { code?: string; message?: string } } | null;
  }>;
}

export async function rejeitarCadastro(id: string, observacoes?: string) {
  const accessToken = await getOperatorAccessToken();
  const response = await fetch(`/api/operator/cadastros/${id}/rejeitar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ observacoes: observacoes ?? null }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error((body as { message?: string })?.message || "Erro ao rejeitar cadastro.");
  }
  return response.json() as Promise<{ ok: boolean }>;
}

// ── Angellira (DC-111 / Sprint 1) ───────────────────────────────────────

async function postOperator<T>(path: string, body?: unknown): Promise<T> {
  const accessToken = await getOperatorAccessToken();
  const response = await fetch(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => null);
    const msg = (errBody as { message?: string })?.message || `HTTP ${response.status}`;
    const err = new Error(msg) as Error & { code?: string; details?: unknown };
    err.code = (errBody as { code?: string })?.code;
    err.details = errBody;
    throw err;
  }
  return response.json() as Promise<T>;
}

async function getOperator<T>(path: string): Promise<T> {
  const accessToken = await getOperatorAccessToken();
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => null);
    const msg = (errBody as { message?: string })?.message || `HTTP ${response.status}`;
    throw new Error(msg);
  }
  return response.json() as Promise<T>;
}

async function patchOperator<T>(path: string, body: unknown): Promise<T> {
  const accessToken = await getOperatorAccessToken();
  const response = await fetch(path, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => null);
    const msg = (errBody as { message?: string })?.message || `HTTP ${response.status}`;
    throw new Error(msg);
  }
  return response.json() as Promise<T>;
}

async function deleteOperator<T>(path: string): Promise<T> {
  const accessToken = await getOperatorAccessToken();
  const response = await fetch(path, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => null);
    const msg = (errBody as { message?: string })?.message || `HTTP ${response.status}`;
    throw new Error(msg);
  }
  return response.json() as Promise<T>;
}

export async function precheckAngellira(id: string) {
  return postOperator<{ ok: boolean; motorista?: unknown; cavalo?: unknown; carreta?: unknown }>(
    `/api/operator/cadastros/${id}/angellira/precheck`,
  );
}

export async function checkOwnerAngellira(id: string, body: {
  placa: string;
  expected_cpf?: string;
  expected_cnpj?: string;
  expected_tipo?: "PF" | "PJ";
}) {
  return postOperator<{
    ok: boolean;
    result?: {
      veiculo_existe: boolean;
      vehicle_id?: number | null;
      owner_atual?: { id?: number; name?: string; cpf?: string; cnpj?: string; tipo?: string };
      divergencia: boolean;
      motivo?: string | null;
    };
  }>(`/api/operator/cadastros/${id}/angellira/check-owner`, body);
}

export async function cadastrarAngellira(id: string) {
  return postOperator<{ ok: boolean; results: AngelliraStepResult[] }>(
    `/api/operator/cadastros/${id}/angellira/cadastrar`,
  );
}

export async function retryAngelliraStep(id: string, step: AngelliraJobStep) {
  return postOperator<{ ok: boolean; results: AngelliraStepResult[] }>(
    `/api/operator/cadastros/${id}/angellira/cadastrar/${step}`,
  );
}

export async function listExternalJobs(id: string) {
  return getOperator<{ ok: boolean; jobs: ExternalRegistrationJob[] }>(
    `/api/operator/cadastros/${id}/external-jobs`,
  );
}

// ── SPX (DC-111 / extensão SPX) ──────────────────────────────────────────

export type SpxPrecheckStatus =
  | "NOT_FOUND"
  | "IS_MATCHED_NOSSA"
  | "IS_MATCHED_OUTRA"
  | "REQUEST_PENDENTE"
  | "INATIVO"
  | "BLOQUEADO"
  | "UNAVAILABLE";

export type SpxPrecheckResult = {
  ok: boolean;
  status: SpxPrecheckStatus;
  retcode?: number | null;
  existingDriverId?: number | null;
  existingRequestId?: number | null;
  driverInfo?: Record<string, unknown> | null;
  message?: string;
};

export async function precheckSpx(id: string) {
  return postOperator<SpxPrecheckResult>(
    `/api/operator/cadastros/${id}/spx/precheck`,
  );
}

export async function cadastrarSpx(id: string, overrides?: Record<string, unknown>) {
  return postOperator<{
    ok: boolean;
    results: Array<{
      step: "spx_motorista";
      status: "OK" | "OK_CACHED" | "ERROR";
      external_id?: string | null;
      error?: { code?: string; message?: string; acao?: string } | null;
    }>;
  }>(`/api/operator/cadastros/${id}/spx/cadastrar`, { overrides });
}

// ── Gerenciamento de cadastros (editar/excluir) ───────────────────────────

export async function getCadastro(id: string) {
  return getOperator<{
    cadastro: {
      id: string;
      status: string;
      dados: Record<string, unknown>;
      observacoes?: string | null;
      created_at: string;
      reviewed_at?: string | null;
    };
  }>(`/api/operator/cadastros/${id}`);
}

export async function patchCadastroDados(id: string, dados: Record<string, unknown>) {
  return patchOperator<{ ok: boolean }>(`/api/operator/cadastros/${id}/dados`, { dados });
}

export async function deleteCadastro(id: string) {
  return deleteOperator<{ ok: boolean }>(`/api/operator/cadastros/${id}`);
}

// ── Cadastro rápido de motorista pelo operador ────────────────────────────

export interface CadastroRapidoInput {
  cpf: string;
  nome: string;
  telefone?: string;
  placa_cavalo?: string;
}

export interface CadastroRapidoResult {
  ok: boolean;
  driverId: string;
  email: string;
  nome: string;
  cpf: string;
}

export async function cadastrarMotoristaRapido(data: CadastroRapidoInput) {
  return postOperator<CadastroRapidoResult>("/api/operator/motoristas/cadastrar", data);
}
