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
  /** Nº de eixos da carga (0/null = não especificado). Enriquecido do catálogo
   * de rotas quando a carga não define o próprio — alimenta o rótulo do veículo. */
  eixos: number | null;
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
  eixos?: number | null;
  valor: number | null;
  bonus: number | null;
  bonus_exigencias: string | null;
  driver_visibility: "PUBLIC" | "PREMIUM";
  status: string;
  is_template: boolean;
  cliente_id: string | null;
  sheet_lh: string | null;
  /** Código da viagem (único, opcional). Para cargas de planilha espelha o LH. */
  codigo_viagem: string | null;
  /** Preenchido só pelo sync da planilha Shopee; NULL em cargas importadas por CSV. */
  sheet_synced_at: string | null;
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
  /** Carga recorrente (renova-se sozinha + clona ao reservar). */
  is_recurring?: boolean;
  /** Intervalo de recorrência em dias (1 = diária). null quando não recorrente. */
  recurrence_interval_days?: number | null;
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
  eixos?: number | null;
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
    hasBrk: boolean;
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
  brkVigency: {
    status: string | null;
    statusText: string | null;
    validUntil: string | null;
    daysUntilExpiry: number | null;
    alertLevel: "OK" | "EXPIRING_SOON" | "EXPIRED" | null;
    conjuntoApto: boolean | null;
    checkedAt: string | null;
    componentes: Record<
      string,
      { status?: string | null; label?: string | null; color?: string | null; limit?: string | null }
    > | null;
  } | null;
  spxVigency: {
    status: string | null;
    statusText: string | null;
    encontrado: boolean | null;
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

// DC-270: aceita valores array (filtros multiselect) → serializa como param
// repetido (?origem=a&origem=b). Valor único (string) segue funcionando.
export async function fetchDriverLoads(params: Record<string, string | string[]>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) if (item) search.append(key, item);
    } else if (value != null && value !== "") {
      search.append(key, value);
    }
  }
  const query = search.toString();
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
    clienteOptions: { id: string; nome: string }[];
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

export interface CargoHistoryEvent {
  /** Momento do evento (ISO). Pode ser null para entradas sem data. */
  quando: string | null;
  /** Título curto e claro do que aconteceu (ex.: "Motorista reservado"). */
  titulo: string;
  /** Detalhe em linguagem do operador: motorista + veículos + motivo. */
  detalhe: string | null;
  /** Quem realizou a ação (nome do operador, "Motorista (pelo portal)" ou "Sistema"). */
  por: string | null;
  /** Código do tipo do evento (uso interno para ícone/estilo). */
  tipo: string;
}

/** Histórico de eventos de uma carga (por LH da planilha) — modal do Monitor. */
export async function fetchCargoHistory(lh: string) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ items: CargoHistoryEvent[]; meta: unknown }>(
    `/api/operator/cargas/historico?lh=${encodeURIComponent(lh)}`,
    { accessToken },
  );
}

/** Semáforo do checklist do veículo: verde/amarelo/vermelho/cinza. */
export type VehicleChecklistLevel = "ok" | "warning" | "overdue" | "unknown";

export interface VehicleChecklistItem {
  tipoVeiculo: string | null;
  statusRaw: string | null;
  ultimoStatus: string | null;
  proprietario: string | null;
  dataInclusao: string | null;
  level: VehicleChecklistLevel;
  daysToDue: number | null;
}

export interface VehicleChecklistEntry {
  placa: string;
  found: boolean;
  level: VehicleChecklistLevel;
  daysToDue: number | null;
  items: VehicleChecklistItem[];
}

/**
 * Checklist de veículo por placa (cavalo/carreta) — card de status do Monitor.
 * Status/cor calculados ao vivo no backend (validade × agora), a partir da aba
 * Checklist do robô GRIFFI (LiraLOG). Indexado pela placa EXATA enviada.
 */
export async function fetchVehicleChecklist(placas: string[]) {
  const accessToken = await getOperatorAccessToken();
  const query = encodeURIComponent(placas.map((p) => p.trim()).filter(Boolean).join(","));
  return requestJson<{ byPlaca: Record<string, VehicleChecklistEntry>; meta: unknown }>(
    `/api/operator/vehicle-checklist?placas=${query}`,
    { accessToken },
  );
}

/** Nível compacto por placa (para os ícones de semáforo na linha do Monitor). */
export interface VehicleChecklistLevelEntry {
  level: VehicleChecklistLevel;
  daysToDue: number | null;
}

/**
 * Mapa COMPACTO de níveis de checklist de TODAS as placas (chave = placa
 * normalizada, só alfanumérico maiúsculo). Uma chamada alimenta os ícones de
 * todas as linhas do Monitor sem N+1.
 */
export async function fetchVehicleChecklistLevels() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ byPlaca: Record<string, VehicleChecklistLevelEntry>; meta: unknown }>(
    `/api/operator/vehicle-checklist/levels`,
    { accessToken },
  );
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

// ─── Driver outreach — oportunidades de contato detectadas por motorista ──────

export type DriverOpportunityTrigger =
  | "churn"
  | "lost_registration"
  | "abandonment"
  | "return_load"
  | "preferences";

export interface DriverOpportunity {
  trigger: DriverOpportunityTrigger;
  severity: "high" | "medium" | "low";
  reason: string;
  message: string | null;
  whatsappUrl: string | null;
  data: Record<string, unknown>;
}

export interface DriverOpportunitiesResult {
  driver: { cpf: string | null; nome: string | null; phone: string | null };
  optedOut: boolean;
  opportunities: DriverOpportunity[];
  meta: {
    correlationId: string | null;
    generatedAt: string;
    totalLoads: number;
    lastLoadIso: string | null;
  };
}

export async function fetchDriverOpportunities(params: {
  cpf?: string | null;
  nome?: string | null;
  phone?: string | null;
}) {
  const accessToken = await getOperatorAccessToken();
  const search = new URLSearchParams();
  if (params.cpf) search.set("cpf", params.cpf);
  if (params.nome) search.set("nome", params.nome);
  if (params.phone) search.set("phone", params.phone);
  const query = search.toString();

  return requestJson<DriverOpportunitiesResult>(
    `/api/operator/driver-opportunities${query ? `?${query}` : ""}`,
    { accessToken },
  );
}

// ─── Driver outreach — tela de controle do envio automático ───────────────────

export interface OutreachSettings {
  enabled: boolean;
  coldEnabled: boolean;
  dailyCap: number;
  quietStartHour: number;
  quietEndHour: number;
  routeNeedEnabled?: boolean;
  routeNeedDaysAhead?: number;
  routeNeedWaveSize?: number;
  updatedAt: string | null;
}

export interface OutreachQueueItem {
  id: string;
  driver_key: string;
  driver_name: string | null;
  trigger: string;
  phone: string;
  message: string;
  status: "pending" | "sent" | "failed" | "skipped";
  retry_count: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface OutreachLogItem {
  driver_key: string;
  trigger: string;
  status: string;
  created_at: string;
}

export interface OutreachOptout {
  driver_key: string;
  phone: string | null;
  reason: string | null;
  created_at: string;
}

export interface OutreachOverview {
  settings: OutreachSettings;
  timing: { pollSeconds: number; scanIntervalMin: number; batchSize: number; scanMaxCandidates: number };
  evolutionConfigured: boolean;
  queueStats: { pending: number; sent: number; failed: number; skipped: number };
  sentLast24h: number;
  queue: OutreachQueueItem[];
  log: OutreachLogItem[];
  optouts: OutreachOptout[];
}

export async function fetchOutreachOverview() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<OutreachOverview>("/api/operator/outreach/overview", { accessToken });
}

export async function updateOutreachSettings(patch: Partial<OutreachSettings>) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean; settings: OutreachSettings }>("/api/operator/outreach/settings", {
    method: "PATCH",
    body: patch,
    accessToken,
  });
}

export async function runOutreachScan() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean; enqueued: number; candidates: number; reason?: string }>(
    "/api/operator/outreach/scan",
    { method: "POST", accessToken },
  );
}

export async function addOutreachOptout(body: { cpf?: string; nome?: string; phone?: string; reason?: string }) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean; driverKey: string }>("/api/operator/outreach/optout", {
    method: "POST",
    body,
    accessToken,
  });
}

export async function removeOutreachOptout(driverKey: string) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean }>(
    `/api/operator/outreach/optout/${encodeURIComponent(driverKey)}`,
    { method: "DELETE", accessToken },
  );
}

export async function cancelOutreachQueued(id: string) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean }>(
    `/api/operator/outreach/queue/${encodeURIComponent(id)}/cancel`,
    { method: "POST", accessToken },
  );
}

export type SendableTrigger = "churn" | "lost_registration" | "abandonment" | "return_load";

export interface OutreachQueueItemDetail {
  item: {
    id: string;
    driverKey: string;
    trigger: string;
    phone: string;
    message: string;
    status: "pending" | "sent" | "failed" | "skipped";
    retryCount: number;
    lastError: string | null;
    createdAt: string;
    sentAt: string | null;
  };
  driver: { cpf: string | null; nome: string | null; phone: string | null };
  optedOut: boolean;
  opportunities: DriverOpportunity[];
  messagesByTrigger: Record<string, string>;
  phoneCandidates: string[];
  angellira: {
    checked: boolean;
    status?: string;
    found?: boolean;
    validUntil?: string | null;
    vigente?: boolean;
    name?: string | null;
    error?: string;
  };
}

export async function fetchOutreachQueueItem(id: string) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<OutreachQueueItemDetail>(
    `/api/operator/outreach/queue/${encodeURIComponent(id)}`,
    { accessToken },
  );
}

export async function updateOutreachQueueItem(
  id: string,
  patch: { trigger?: string; phone?: string; message?: string; cpf?: string; nome?: string },
) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean }>(
    `/api/operator/outreach/queue/${encodeURIComponent(id)}`,
    { method: "PATCH", body: patch, accessToken },
  );
}

export async function sendOutreachQueueItem(id: string) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean; to: string }>(
    `/api/operator/outreach/queue/${encodeURIComponent(id)}/send`,
    { method: "POST", accessToken },
  );
}

export async function createOutreachManual(body: {
  cpf?: string;
  nome?: string;
  phone: string;
  trigger: string;
  message?: string;
}) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean; id: string }>("/api/operator/outreach/queue", {
    method: "POST",
    body,
    accessToken,
  });
}

export async function revalidateOutreachQueue() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean; checked: number; cancelled: number; kept: number; skippedNoCpf: number }>(
    "/api/operator/outreach/queue/revalidate",
    { method: "POST", accessToken },
  );
}

// ─── Notificações do operador (sino) ─────────────────────────────────────────

export interface OperatorNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  seen: boolean;
  seen_at: string | null;
  created_at: string;
}

export async function fetchOperatorNotifications() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ unseenCount: number; items: OperatorNotification[] }>(
    "/api/operator/notifications",
    { accessToken },
  );
}

export async function markOperatorNotificationsSeen(input: { ids?: string[]; all?: boolean }) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean; updated: number }>("/api/operator/notifications/seen", {
    method: "POST",
    body: input,
    accessToken,
  });
}

export async function clearOperatorNotifications(input: { ids?: string[]; all?: boolean }) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean; deleted: number }>("/api/operator/notifications/clear", {
    method: "POST",
    body: input,
    accessToken,
  });
}

// ─── Chat WhatsApp ───────────────────────────────────────────────────────────

export interface ChatConversation {
  phone: string;
  driver_key: string | null;
  driver_name: string | null;
  last_text: string;
  last_direction: "in" | "out" | null;
  last_ts: string | null;
  last_type: string | null;
  unread_count: number;
}

export interface ChatMessage {
  id: string;
  direction: "in" | "out";
  external_id: string | null;
  phone: string;
  driver_key: string | null;
  text: string;
  message_type: string;
  status: string;
  timestamp: string;
}

export async function fetchChatConversations(params?: { search?: string; limit?: number }) {
  const accessToken = await getOperatorAccessToken();
  const search = new URLSearchParams();
  if (params?.search) search.set("search", params.search);
  if (params?.limit) search.set("limit", String(params.limit));
  const q = search.toString();
  return requestJson<{ items: ChatConversation[] }>(
    `/api/operator/chat/conversations${q ? `?${q}` : ""}`,
    { accessToken },
  );
}

export async function fetchChatMessages(phone: string) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ items: ChatMessage[] }>(
    `/api/operator/chat/messages?phone=${encodeURIComponent(phone)}`,
    { accessToken },
  );
}

export async function sendChatMessage(input: { phone: string; text: string }) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean }>("/api/operator/chat/send", {
    method: "POST",
    body: input,
    accessToken,
  });
}

// ─── Envio em massa ──────────────────────────────────────────────────────────

export interface MassRoute {
  key: string;
  origem: string;
  destino: string;
  driverCount: number;
}

export interface MassAudiencePreview {
  total: number;
  capped: boolean;
  sample: Array<{ nome: string | null; cpf: string | null; phone: string; rota: string | null }>;
}

export async function fetchMassRoutes() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ items: MassRoute[] }>("/api/operator/mass-outreach/routes", { accessToken });
}

export async function previewMassOutreach(input: { audience: "all" | "routes"; routes?: string[] }) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<MassAudiencePreview>("/api/operator/mass-outreach/preview", {
    method: "POST",
    body: input,
    accessToken,
  });
}

export async function enqueueMassOutreach(input: {
  audience: "all" | "routes";
  routes?: string[];
  message: string;
}) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean; batchId: string; enqueued: number; total: number; etaMinutes?: number }>(
    "/api/operator/mass-outreach/enqueue",
    { method: "POST", body: input, accessToken },
  );
}

export async function reconcileRegistrations() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{
    ok: boolean;
    started: boolean;
    candidates: number;
    alreadyRunning?: boolean;
  }>(
    "/api/operator/outreach/reconcile-registrations",
    { method: "POST", accessToken },
  );
}

export interface OutreachMessageTemplate {
  key: string;
  label: string;
  description: string;
  placeholders: string[];
  defaultTemplate: string;
  template: string;
  enabled: boolean;
  customized: boolean;
}

export async function fetchOutreachMessageTemplates() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean; templates: OutreachMessageTemplate[] }>(
    "/api/operator/outreach/message-templates",
    { method: "GET", accessToken },
  );
}

export async function saveOutreachMessageTemplate(input: {
  key: string;
  template?: string | null;
  enabled?: boolean;
}) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean; templates: OutreachMessageTemplate[] }>(
    "/api/operator/outreach/message-templates",
    { method: "PATCH", body: input, accessToken },
  );
}

export interface WhatsappStatus {
  configured: boolean;
  state: string;
  instance: string | null;
  error?: string;
}

export async function fetchWhatsappStatus() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<WhatsappStatus>("/api/operator/outreach/whatsapp/status", { accessToken });
}

export interface WhatsappConnectResult {
  instance: string;
  mode: "qr" | "code";
  state: string | null;
  qrBase64: string | null;
  pairingCode: string | null;
  qrAvailable?: boolean;
  pairingAvailable?: boolean;
}

export async function connectWhatsapp(input?: { number?: string }) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<WhatsappConnectResult>("/api/operator/outreach/whatsapp/connect", {
    method: "POST",
    body: input?.number ? { number: input.number } : {},
    accessToken,
  });
}

export async function disconnectWhatsapp() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean }>("/api/operator/outreach/whatsapp/disconnect", {
    method: "POST",
    accessToken,
  });
}

// ── WhatsApp do REPOM (número dedicado ao cadastro de motoristas) ─────────────

export async function fetchRepomWhatsappStatus() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<WhatsappStatus>("/api/operator/repom/whatsapp/status", { accessToken });
}

export async function connectRepomWhatsapp(input?: { number?: string }) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<WhatsappConnectResult>("/api/operator/repom/whatsapp/connect", {
    method: "POST",
    body: input?.number ? { number: input.number } : {},
    accessToken,
  });
}

export async function disconnectRepomWhatsapp() {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean }>("/api/operator/repom/whatsapp/disconnect", {
    method: "POST",
    accessToken,
  });
}

export async function sendWhatsappTest(body: { phone: string; text?: string }) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean; to: string }>("/api/operator/outreach/whatsapp/test", {
    method: "POST",
    body,
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
  /** Cliente da carga (planilha → cliente da planilha, ex. Shopee; sistema → cliente_id→nome). */
  cliente?: string | null;
  /** Código sequencial da rota (operator-only) — usado no filtro de Rotas do Monitor. */
  routeCodigo?: number | null;
  /** false = trajeto (origem→destino) sem rota cadastrada no catálogo. */
  routeRegistered?: boolean;
  origem: string;
  destino: string;
  data: string | null;
  horario: string | null;
  carregamentoLabel: string | null;
  descargaLabel: string | null;
  valor: number | undefined;
  cavalo: string;
  carreta: string;
  /** Motivo da última troca de motorista/veículo (carga do sistema; planilha usa allocByLh). */
  descricao?: string | null;
  /** Vínculo do motorista vindo da planilha (col H) — override efetivo via allocByLh. */
  vinculo?: string | null;
  checklistCavalo: string;
  checklistCarreta: string;
  isAvailable: boolean;
  hasDriver: boolean;
  // Efetivo (vem do override alloc_pinned, mesclado no front). Carga fixa = o
  // motorista/veículo é intocável (arrasto, edição e cascata).
  pinned?: boolean;
  // Check Rodopar (DC-260): 0=não lançado (vermelho), 1=lançado (preto),
  // 2=lançado incorreto/incompleto (azul). Sheet: vem do overlay allocByLh;
  // sistema: vem direto da linha. Mesclado no front (efetivo).
  rodoparStatus?: number;
  /** Quem alterou o Check Rodopar por último (nome/email do operador) e quando (ISO). */
  rodoparUpdatedBy?: string | null;
  rodoparUpdatedAt?: string | null;
  // Linha sintética de RESERVA (motorista em standby na rota; não vem da
  // planilha, não tem LH real). Arrastável p/ puxar o motorista pra uma carga.
  reserva?: boolean;
  /** id da reserva (monitor_reservas) — só para reserva=true. */
  reservaId?: string | null;
  /** Quando entrou em standby (created_at da reserva, ISO) — só para reserva=true. */
  standbyAt?: string | null;
  /** Telefone do motorista (motoristas_historico), resolvido por nome. Opcional. */
  telefone?: string | null;
  // ── Visão unificada (planilha ∪ sistema) ──
  // Identidade estável da linha: 'sheet:<lh>' | 'cargo:<uuid>' | 'reserva:<id>'.
  rowKey?: string;
  // Origem da linha: 'planilha' (Shopee, base na planilha), 'sistema' (carga
  // criada no sistema, editável em tudo), 'reserva' (standby).
  source?: "planilha" | "sistema" | "reserva";
  // id da carga no banco (só para source='sistema') — usado na edição/criação.
  cargoId?: string;
  // status de ciclo de vida da carga do sistema (DRAFT/OPEN/...) — informativo.
  lifecycleStatus?: string | null;
  // datetime-local ('YYYY-MM-DDTHH:MM') p/ os inputs do modal (só source='sistema').
  cargaAt?: string | null; // carregamento (= data + horário)
  descargaAt?: string | null; // descarga
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

/**
 * Alocação editada pelo operador no Monitor (cargas.alloc_*), por LH. Sobrepõe os
 * valores que vieram da planilha — efetivo = alloc_* ?? valor da planilha (Fase 0).
 */
export interface SheetMonitorAllocation {
  sheet_lh: string;
  alloc_motorista: string | null;
  alloc_cavalo: string | null;
  alloc_carreta: string | null;
  alloc_status: string | null;
  alloc_tipo: string | null;
  alloc_descricao: string | null;
  alloc_vinculo: string | null;
  alloc_pinned: boolean | null;
  alloc_updated_at: string | null;
}

export async function fetchSheetMonitor({ refresh = false }: { refresh?: boolean } = {}) {
  const accessToken = await getOperatorAccessToken();
  const url = refresh ? "/api/operator/sheet-monitor?refresh=true" : "/api/operator/sheet-monitor";

  return requestJson<{
    items: SheetMonitorRow[];
    summary: SheetMonitorSummary;
    enrichedByLh: Record<string, SheetMonitorEnrichedRow>;
    enrichedByCargoId?: Record<string, SheetMonitorEnrichedRow>;
    allocByLh?: Record<string, SheetMonitorAllocation>;
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

/**
 * Salva a alocação editada no Monitor (motorista/cavalo/carreta/status operacional)
 * para um LH. Cada campo: string define o override; "" = vazio EXPLÍCITO (a carga
 * fica sem aquele valor, sobrepondo a planilha — não volta a refletir a planilha).
 */
export async function updateMonitorAllocation(input: {
  lh: string;
  motorista?: string | null;
  cavalo?: string | null;
  carreta?: string | null;
  status?: string | null;
  tipo?: string | null;
  descricao?: string | null; // motivo da troca de motorista/veículo
  vinculo?: string | null; // vínculo do motorista (col H da planilha)
}) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{
    ok: boolean;
    lh: string;
    allocation: {
      motorista: string | null;
      cavalo: string | null;
      carreta: string | null;
      status: string | null;
      source: string;
    };
    meta: { correlationId: string };
  }>("/api/operator/sheet-monitor", { accessToken, method: "PATCH", body: input });
}

/**
 * Reordena a "fila" de motoristas/veículos do Monitor (F3): move a alocação
 * motorista+cavalo+carreta entre cargas, em lote/transação. `""` = vazio
 * explícito (carga fica sem motorista). Não toca o status operacional.
 * Carga da planilha → `lh`; carga do sistema → `cargoId` (uuid). Cada move usa um.
 */
export async function reassignMonitorAllocations(
  moves: Array<{ lh?: string; cargoId?: string; motorista: string; cavalo: string; carreta: string }>,
) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{
    ok: boolean;
    updated: string[];
    count: number;
    meta: { correlationId: string };
  }>("/api/operator/sheet-monitor/reassign", { accessToken, method: "POST", body: { moves } });
}

/**
 * Descer a fila (cascata manual): o motorista de `sourceLh` desce uma carga,
 * empurrando os de baixo; a próxima carga em branco absorve e o que sobra vira
 * reserva. O front manda só a ORDEM exibida da rota (`orderedLhs`, topo→base, já
 * respeitando os filtros da tela) + a origem; o backend é AUTORITATIVO: lê
 * pinned/status/alocação reais e calcula a cascata — carga fixada é pulada (fica
 * no lugar), nunca bloqueia. `skippedPinned` volta as cargas fixadas mantidas.
 */
export async function descendQueueCascade(input: { sourceLh: string; targetLh: string; orderedLhs: string[] }) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{
    ok: boolean;
    count: number;
    reserva: boolean;
    skippedPinned: string[];
    moves: Array<{ lh: string; motorista: string; cavalo: string; carreta: string }>;
    meta: { correlationId: string };
  }>("/api/operator/sheet-monitor/descend", { accessToken, method: "POST", body: input });
}

// ── Reverter últimas mudanças de alocação (DC-283) ──────────────────────────

export interface AllocationChangeAlloc {
  motorista: string | null;
  cavalo: string | null;
  carreta: string | null;
  status?: string | null;
}

export interface AllocationChangeCargo {
  lh: string | null;
  cargoId: string | null;
  before: AllocationChangeAlloc;
  after: AllocationChangeAlloc;
  /** Alocação atual ainda bate com o "depois" gravado → seguro reverter. */
  currentMatchesAfter: boolean;
  cargoFound: boolean;
}

export interface AllocationChangeItem {
  auditLogId: string;
  eventType: string;
  eventLabel: string;
  createdAt: string;
  route: string | null;
  /** A ação criou/mexeu num standby (reserva) — o modal avisa p/ revisar manual. */
  reserva: boolean;
  touchesStatus: boolean;
  /** Ao menos uma carga é revertível (tem estado anterior E não foi mexida depois). */
  revertible: boolean;
  reason: string | null;
  cargos: AllocationChangeCargo[];
}

/** Últimas mudanças de alocação do operador logado (fonte do modal "Reverter"). */
export async function fetchOperatorAllocationChanges(params: { page?: number; pageSize?: number } = {}) {
  const accessToken = await getOperatorAccessToken();
  const qs = new URLSearchParams();
  if (params.page) qs.set("page", String(params.page));
  if (params.pageSize) qs.set("pageSize", String(params.pageSize));
  const query = qs.toString();
  return requestJson<{ items: AllocationChangeItem[]; meta: PaginationMeta }>(
    `/api/operator/allocation-changes${query ? `?${query}` : ""}`,
    { accessToken },
  );
}

/**
 * Reverte mudanças de alocação selecionadas no modal. Manda só os pares
 * (auditLogId, carga) — o servidor lê o "antes" do próprio audit log. Devolve o
 * que foi revertido e o que foi pulado (com motivo, ex.: alterada depois).
 */
export async function revertAllocationChanges(
  items: Array<{ auditLogId: string; lh?: string; cargoId?: string }>,
) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{
    ok: boolean;
    revertedCount: number;
    skippedCount: number;
    reverted: Array<{ auditLogId: string; lh: string | null; cargoId: string | null }>;
    skipped: Array<{ auditLogId: string; lh?: string | null; cargoId?: string | null; reason: string }>;
    meta: { correlationId: string };
  }>("/api/operator/allocation-changes/revert", { accessToken, method: "POST", body: { items } });
}

/**
 * Consulta, por viagem SPX ("LT…"), se o motorista informado (o EFETIVO da carga)
 * é o MESMO que está atribuído àquela viagem no SPX/ASPX. Alimenta o selo "S":
 *   assignedByLh[lh] === true  → atribuído (verde)
 *   assignedByLh[lh] === false → não atribuído / motorista diferente / sem motorista (vermelho)
 *   lh ausente do mapa         → não consultado / não-SPX (cinza)
 * Cache curto no backend; o front chaveia a query pelos pares (lh, motorista) →
 * trocar a fila/motorista re-consulta na hora.
 */
export async function fetchAspxAssigned(
  items: Array<{ lh: string; motorista: string }>,
): Promise<{ assignedByLh: Record<string, boolean>; meta: { correlationId: string } }> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{
    assignedByLh: Record<string, boolean>;
    meta: { correlationId: string };
  }>("/api/operator/sheet-monitor/aspx-assigned", { accessToken, method: "POST", body: { items } });
}

/**
 * Puxa um motorista em STANDBY (reserva) para uma carga, arrastando a reserva e
 * soltando na linha da carga. Grava a alocação do standby na carga e dá baixa na
 * reserva; se a carga já tinha motorista, esse vira uma nova reserva (swap).
 */
export async function assignReservaToCarga(input: { reservaId: string; targetLh: string }) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{
    ok: boolean;
    lh: string;
    bumped: boolean;
    meta: { correlationId: string };
  }>("/api/operator/sheet-monitor/assign-reserva", { accessToken, method: "POST", body: input });
}

/** Um motorista que já rodou a rota (origem → destino), sugerido para reserva.
 *  `telefone` vem de motoristas_historico (opcional, pode ser null). */
export interface RouteDriverHistoryEntry {
  motorista: string;
  cavalo: string;
  carreta: string;
  ultimaData: string | null;
  ultimoHorario: string | null;
  ultimaAgendaLabel: string | null;
  runCount: number;
  telefone: string | null;
}

/**
 * Histórico de motoristas que já rodaram uma rota (origem → destino) — para
 * sugerir quem colocar numa reserva. Deduplicado por motorista (mais recente
 * vence) com runCount e telefone (quando houver em motoristas_historico).
 */
export async function fetchRouteDriverHistory(params: {
  origem: string;
  destino: string;
}): Promise<{ drivers: RouteDriverHistoryEntry[] }> {
  const accessToken = await getOperatorAccessToken();
  const qs = `origem=${encodeURIComponent(params.origem)}&destino=${encodeURIComponent(params.destino)}`;
  const data = await requestJson<{ drivers?: RouteDriverHistoryEntry[] }>(
    `/api/operator/sheet-monitor/route-history?${qs}`,
    { accessToken },
  );
  return { drivers: data.drivers ?? [] };
}

/** Cria uma reserva (standby) de motorista para uma rota (origem → destino). */
export async function createReserva(input: {
  motorista: string;
  cavalo?: string;
  carreta?: string;
  origem: string;
  destino: string;
}): Promise<{ ok: boolean; id: string }> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean; id: string }>(
    "/api/operator/sheet-monitor/reserva",
    { accessToken, method: "POST", body: input },
  );
}

/** Edita uma reserva ativa. Parcial: só os campos enviados são alterados. */
export async function updateReserva(input: {
  reservaId: string;
  motorista?: string;
  cavalo?: string;
  carreta?: string;
}): Promise<{ ok: boolean; id: string }> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean; id: string }>(
    "/api/operator/sheet-monitor/reserva",
    { accessToken, method: "PATCH", body: input },
  );
}

/** Remove (soft) uma reserva ativa. */
export async function deleteReserva(input: { reservaId: string }): Promise<{ ok: boolean }> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ ok: boolean }>(
    "/api/operator/sheet-monitor/reserva",
    { accessToken, method: "DELETE", body: input },
  );
}

/**
 * Fixa ("fixo") ou desafixa a alocação de uma carga. Carga fixa = motorista/veículo
 * intocável (não move por arrasto, edição inline/modal, nem cascata de cancelamento).
 */
export async function setMonitorAllocationPin(input: { lh: string; pinned: boolean }) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{
    ok: boolean;
    lh: string;
    pinned: boolean;
    meta: { correlationId: string };
  }>("/api/operator/sheet-monitor/pin", { accessToken, method: "POST", body: input });
}

/** Check Rodopar (DC-260): grava o status por LH da linha do Monitor (0/1/2),
 *  em monitor_rodopar_status — independente de existir carga. */
export async function setMonitorRodoparStatus(input: { lh: string; status: number }) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{
    ok: boolean;
    lh: string;
    rodoparStatus: number;
    meta: { correlationId: string };
  }>("/api/operator/sheet-monitor/rodopar", { accessToken, method: "POST", body: input });
}

/** Campos editáveis de uma carga do SISTEMA no grid do Monitor. Parcial: só os
 *  campos enviados são alterados. "" limpa motorista/veículo/status/lh. */
export interface MonitorCargoUpdate {
  cargoId: string;
  motorista?: string | null;
  cavalo?: string | null;
  carreta?: string | null;
  status?: string | null;
  origem?: string;
  destino?: string;
  data?: string; // YYYY-MM-DD (carregamento)
  horario?: string; // HH:MM (carregamento)
  descarga?: string; // datetime-local 'YYYY-MM-DDTHH:MM' ou '' p/ limpar
  lh?: string | null;
  tipo?: string | null;
  descricao?: string | null; // motivo da troca de motorista/veículo
  vinculo?: string | null; // vínculo do motorista
}

/**
 * Edita uma carga do SISTEMA (sheet_lh nulo) direto no grid do Monitor — como uma
 * planilha. Diferente das linhas da planilha, aqui Rota/Agenda/LH também são
 * editáveis (a carga do sistema é a fonte da verdade; não há sync sobrescrevendo).
 */
export async function updateMonitorCargo(input: MonitorCargoUpdate) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{
    ok: boolean;
    cargoId: string;
    rowKey: string;
    cargo: {
      lh: string; motorista: string; cavalo: string; carreta: string;
      status: string; origem: string; destino: string;
      data: string | null; horario: string | null;
    };
    meta: { correlationId: string };
  }>("/api/operator/sheet-monitor/cargo", { accessToken, method: "PATCH", body: input });
}

/** Cria uma carga do SISTEMA a partir do grid do Monitor ("Nova carga").
 *  Reusa o endpoint canônico de criação (sheet_lh fica nulo → vira linha do
 *  sistema na próxima leitura do Monitor). Criada como OPEN p/ aparecer já. */
export async function createMonitorCargo(input: {
  origem: string;
  destino: string;
  data: string; // YYYY-MM-DD (carregamento)
  horario: string; // HH:MM (carregamento)
  descarga?: string; // 'YYYY-MM-DD HH:MM' (texto) — opcional
  perfil?: string;
}) {
  const accessToken = await getOperatorAccessToken();
  return requestJson<{ id?: string; cargo?: { id: string }; meta?: { correlationId: string } }>(
    "/api/operator/cargas",
    {
      accessToken,
      method: "POST",
      body: {
        origem: input.origem,
        destino: input.destino,
        data: input.data,
        horario: input.horario,
        ...(input.descarga ? { sheet_data_descarga: input.descarga } : {}),
        perfil: input.perfil || "CARRETA",
        status: "OPEN",
        is_template: false,
        driver_visibility: "PUBLIC",
      },
    },
  );
}

/** Estado de uma carga na pré-visualização de atribuição no ASPX.
 *  Preview: assign · pending · assigned · in_progress · done · cancelled · not_ready · unknown.
 *  Resultado do envio: dry_run · skipped · error. */
export type AspxAllocationState =
  | "assign"
  | "pending"
  | "assigned"
  | "in_progress"
  | "done"
  | "cancelled"
  | "not_ready"
  | "unknown"
  | "dry_run"
  | "skipped"
  | "error";

export interface AspxAllocationItem {
  lh: string;
  origem: string | null;
  destino: string | null;
  motorista: string;
  cavalo: string;
  carreta: string;
  pinned: boolean;
  tripId: number | null;
  driverId: number | null;
  state: AspxAllocationState;
  /** Nome do status real da viagem no ASPX (ex.: "Assigned", "Departed"). */
  realStatus: string | null;
  /** Motorista atualmente atribuído no ASPX (quando já atribuída). */
  assignedDriver: string;
  /** ASPX tem um motorista DIFERENTE do sistema (conflito). */
  divergent: boolean;
  /** Divergente que PODE ser trocada no ASPX (trip_id + motorista do sistema resolvidos). */
  reassignable?: boolean;
  /** Agenda da carga (DD/MM/YYYY HH:MM). */
  carregamentoLabel: string | null;
  descargaLabel: string | null;
  reason: string | null;
}

export type AspxAllocationWarning = "assignable_empty" | "index_unavailable" | "index_truncated" | "index_partial" | "index_gaps";

export interface AspxAllocationPreview {
  ok: boolean;
  configured: boolean;
  writeEnabled: boolean;
  summary: {
    willAssign: number;
    pending: number;
    divergent: number;
    hidden: number;
    totalCandidates: number;
    alreadyAssigned: number;
    cancelled: number;
    notReady: number;
    unknown: number;
  };
  warnings: AspxAllocationWarning[];
  items: AspxAllocationItem[];
  meta: { correlationId: string };
}

/**
 * Pré-visualização (dry-run) da atribuição no ASPX: lista as cargas alocadas no
 * sistema (só line-hauls com código "LT") e diz, para cada uma, se vai atribuir /
 * já está atribuída / está pendente. Nada é enviado ao ASPX — só leitura. Se o
 * sidecar SPX estiver fora do ar, a chamada falha (sem estados simulados).
 */
export async function previewAspxAllocation(): Promise<AspxAllocationPreview> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<AspxAllocationPreview>("/api/operator/sheet-monitor/aspx-preview", {
    accessToken,
    method: "POST",
    body: {},
  });
}

export interface AspxAssignResult {
  ok: boolean;
  writeEnabled: boolean;
  dryRun: boolean;
  summary: { assigned: number; dryRun: number; pending: number; skipped: number; error: number };
  results: Array<{ lh: string; state: AspxAllocationState; reason?: string; tripId?: number; driverId?: number }>;
  meta: { correlationId: string };
}

/**
 * Confirma a atribuição no ASPX das cargas (LHs) selecionadas — só as com código
 * "LT" são enviadas; as demais são ignoradas (skipped). O envio real só ocorre
 * com o kill switch ligado no backend (SPX_ALLOC_WRITE_ENABLED); caso contrário
 * roda em dry_run. Se o sidecar SPX estiver fora do ar, a chamada falha.
 */
export async function assignAspxAllocations(input: { lhs: string[]; dryRun?: boolean }): Promise<AspxAssignResult> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<AspxAssignResult>("/api/operator/sheet-monitor/aspx-assign", {
    accessToken,
    method: "POST",
    body: input,
  });
}

/* ─────────────────────────── Programação (DC-136) ─────────────────────────── */

export type ProgramacaoTab = "planejado" | "aceito" | "concluido";

export interface ProgramacaoRow {
  lh: string;
  nome: string;
  statusRaw: string;
  statusOperacional: string;
  motorista: string;
  veiculo: string;
  placa: string;
  origem: string;
  destino: string;
  origemRaw: string;
  destinoRaw: string;
  origemCidadeUf: string;
  destinoCidadeUf: string;
  data: string | null;
  horario: string | null;
  /** Epoch (segundos, UTC) do carregamento — instante absoluto p/ decidir atraso sem fuso. */
  carregamentoTs: number | null;
  dataDescarga: string | null;
  horarioDescarga: string | null;
  tab: ProgramacaoTab;
  cliente: string;
  /** Origem da linha: "spx-direct" (Shopee) ou "nestle-galileu" (Nestlé). */
  source?: string;
  /** Nestlé: CONTRATO | ADICIONAL | LEILAO (classificação da oferta). */
  tipo?: string | null;
  isLinehaul: boolean;
  acceptanceStatus: number | null;
  podeAceitar: boolean;
  aguardandoMotorista: boolean;
  /** Pode lançar no sistema pela tela: Planejado (SPX/Nestlé) ou Nestlé aceita sem motorista. */
  podeLancar?: boolean;
  jaLancada: boolean;
  expirada: boolean;
}

export interface ProgramacaoClient {
  id: string;
  nome: string;
  source: string;
}

export interface ProgramacaoOverview {
  ok: boolean;
  configured: boolean;
  acceptWriteEnabled: boolean;
  clientes: ProgramacaoClient[];
  byTab: Record<ProgramacaoTab, number>;
  summary: {
    planejado: number;
    aceito: number;
    concluido: number;
    total: number;
    podeAceitar: number;
    aguardandoMotorista: number;
    jaLancadas: number;
  };
  warnings: string[];
  rows: ProgramacaoRow[];
  meta: { correlationId: string; fetchedAt: string };
}

/**
 * Viagens SPX/Shopee ao vivo (API DC-136 da Torre), agrupadas por status
 * (Planejado/Aceito/Concluído). Read-only. 503 quando a integração não está
 * configurada no backend (o chamador trata via ApiError.status).
 */
export async function fetchProgramacao(params: { force?: boolean; tabs?: string } = {}): Promise<ProgramacaoOverview> {
  const accessToken = await getOperatorAccessToken();
  // force → ?refresh=1 (bypassa o cache do proxy; busca ao vivo no portal SPX).
  // tabs → busca só as abas pedidas (lazy: Concluído só quando abre).
  const q = new URLSearchParams();
  if (params.force) q.set("refresh", "1");
  if (params.tabs) q.set("tabs", params.tabs);
  const qs = q.toString();
  return requestJson<ProgramacaoOverview>(`/api/operator/programacao${qs ? `?${qs}` : ""}`, { accessToken });
}

export interface AutoLaunchResult {
  ok: boolean;
  candidates: number;
  routed: number;
  launched: number;
  already: number;
  errors: number;
  deferred: number;
}

/**
 * DC-201 — dispara o auto-lançamento dos spots Planejado que já têm rota cadastrada
 * (o mesmo do cron). Usado logo após cadastrar uma rota p/ lançar as viagens dessa
 * rota na hora, sem esperar o ciclo. Idempotente; NÃO aceita no SPX.
 */
export async function runAutoLaunchSpots(): Promise<AutoLaunchResult> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<AutoLaunchResult>("/api/operator/programacao/auto-launch", {
    accessToken,
    method: "POST",
  });
}

export interface ProgramacaoSettings {
  spotAutolaunchEnabled: boolean;
  /** DC-279: rotas (origin_key|destination_key) que disparam alerta de spot. */
  alertRouteKeys: string[];
  updatedAt: string | null;
}

/** DC-201 — lê o estado do lançamento automático de spots com rota (liga/desliga). */
export async function getProgramacaoSettings(): Promise<ProgramacaoSettings> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<ProgramacaoSettings>("/api/operator/programacao/settings", { accessToken });
}

/** DC-201 — liga/desliga o lançamento automático (scanner passa a pular/retomar). */
export async function setSpotAutolaunchEnabled(enabled: boolean): Promise<ProgramacaoSettings> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<ProgramacaoSettings>("/api/operator/programacao/settings", {
    accessToken,
    method: "PATCH",
    body: { spotAutolaunchEnabled: enabled },
  });
}

/** DC-279 — define quais rotas cadastradas disparam alerta de spot (compartilhado). */
export async function setSpotAlertRouteKeys(alertRouteKeys: string[]): Promise<ProgramacaoSettings> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<ProgramacaoSettings>("/api/operator/programacao/settings", {
    accessToken,
    method: "PATCH",
    body: { alertRouteKeys },
  });
}

export interface AspxAcceptResult {
  ok: boolean;
  writeEnabled: boolean;
  dryRun: boolean;
  summary: { accepted: number; dryRun: number; skipped: number; error: number };
  results: Array<{ key: string; tripId: number | null; state: "accepted" | "dry_run" | "skipped" | "error"; reason?: string }>;
  meta: { correlationId: string };
}

/**
 * Aceita (reserva) viagens SPX no ASPX pelo LH (trip_number). Reusa o endpoint de
 * accept do Monitor. Envio real só com SPX_ACCEPT_WRITE_ENABLED=true no backend;
 * senão roda dry_run (state "dry_run"). HTTP 200 pode conter itens skipped/error —
 * inspecionar results[].state.
 */
export async function acceptSpxTrips(lhs: string[], dryRun = false): Promise<AspxAcceptResult> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<AspxAcceptResult>("/api/operator/sheet-monitor/aspx-accept", {
    accessToken,
    method: "POST",
    body: { lhs, dryRun },
  });
}

export interface LaunchCargoResult {
  ok: boolean;
  alreadyExists: boolean;
  /** true quando a carga entrou sem agenda definida ("a confirmar"). */
  aConfirmar?: boolean;
  id: string;
  cargo: { id: string; status?: string };
  clienteId?: string | null;
  meta: { correlationId: string };
}

/**
 * Lança uma carga do sistema a partir de uma viagem (SPX/Nestlé). Idempotente por LH.
 * Sem `data` (carregamento) a carga entra como "a confirmar" (agenda definida depois).
 */
export async function launchCargoFromTrip(input: {
  lh: string;
  origem: string;
  destino: string;
  data?: string;
  horario?: string;
  dataDescarga?: string;
  horarioDescarga?: string;
  nome?: string;
  perfil?: string;
}): Promise<LaunchCargoResult> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<LaunchCargoResult>("/api/operator/programacao/launch", {
    accessToken,
    method: "POST",
    body: input,
  });
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

// DC-230: consulta Angellira/ASPX de UM item só (a linha selecionada), sem
// varrer a planilha inteira. `lh` p/ carga da planilha; `cargoId` p/ carga do
// sistema. Reaproveita o mesmo endpoint de enriquecimento com filtro de item.
export async function enrichSheetMonitorRow(
  scope:
    | { lh: string; motorista?: string; cavalo?: string; carreta?: string }
    | { cargoId: string },
): Promise<{ enriched: number; remaining: number; scoped?: boolean }> {
  const accessToken = await getOperatorAccessToken();
  const params = new URLSearchParams();
  // Motorista/veículo EFETIVO (o que a tela mostra) vão no CORPO, não na URL —
  // o nome é PII e o backend enriquece exatamente esses valores, cobrindo cargas
  // fora do snapshot (Nestlé/importadas). `lh`/`cargoId` (identificador) na URL.
  let body: { motorista: string; cavalo: string; carreta: string } | undefined;
  if ("cargoId" in scope && scope.cargoId) {
    params.set("cargoId", scope.cargoId);
  } else if ("lh" in scope && scope.lh) {
    params.set("lh", scope.lh);
    body = {
      motorista: scope.motorista ?? "",
      cavalo: scope.cavalo ?? "",
      carreta: scope.carreta ?? "",
    };
  }
  return requestJson<{ enriched: number; remaining: number; scoped?: boolean }>(
    `/api/operator/sheet-monitor/enrich?${params.toString()}`,
    { accessToken, method: "POST", ...(body ? { body } : {}) },
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
  /** soma de acessos ao portal no período (uma contagem por visita) — DC-242. */
  total: number;
  /** IPs distintos no período — aprox. de "usuário único" (DC-242); rede/aparelho, não pessoa. */
  uniqueVisitors: number;
  /** acesso mais antigo na janela (ISO) — base da "média/dia" no modo todo o período. */
  firstVisitAt: string | null;
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

/** DC-243: indicadores do sistema de Cadastro no período (pending_driver_registrations). */
export interface DriverFlowMetricsCadastros {
  /** cadastros criados no período, excluindo rascunhos (status <> 'draft'). */
  realizados: number;
  /** cadastros pendentes de ação do operador que entraram no período (status = 'pendente'). */
  pendentes: number;
}

/** DC-244: cargas disponibilizadas no portal do motorista no período (cargas.created_at). */
export interface DriverFlowMetricsPortalAvailability {
  /** total de cargas publicadas no portal (não-rascunho, visíveis) criadas no período — inclui spots DC-201. */
  total: number;
}

export interface DriverFlowMetricsResponse {
  window: {
    from: string;
    toExclusive: string;
    /** true quando o filtro de data foi limpo (range=all) — janela = todo o período. */
    allTime?: boolean;
  };
  funnel: DriverFlowMetricsFunnel;
  accessPeaks: DriverFlowMetricsAccessPeaks;
  validation: DriverFlowMetricsValidation;
  recurrence: DriverFlowMetricsRecurrence;
  portalVisits: DriverFlowMetricsPortalVisits;
  cadastros: DriverFlowMetricsCadastros;
  portalAvailability: DriverFlowMetricsPortalAvailability;
  meta: {
    correlationId: string | null;
  };
}

/** DC-184: um campo alterado (valor anterior → novo). */
export interface OperatorAuditLogChange {
  field: string;
  label: string;
  before: unknown;
  after: unknown;
}

export interface OperatorAuditLogItem {
  id: string;
  eventType: string;
  /** Rótulo humano do evento (pt-BR), resolvido pela taxonomia do backend. */
  eventLabel: string;
  /** Categoria ("tipo de log") — DC-185. */
  categoryKey: string;
  categoryLabel: string;
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
  /** DC-184: lista de mudanças antes → depois (null quando não houver). */
  changes: OperatorAuditLogChange[] | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface OperatorAuditOperatorSummary {
  id: string;
  email: string | null;
  displayName: string | null;
  accessLevel: "advanced" | "intermediate" | null;
}

/** DC-185: categoria disponível no filtro multiselect. */
export interface OperatorAuditCategory {
  key: string;
  label: string;
}

export interface OperatorAuditLogsResponse {
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
  categories: OperatorAuditCategory[];
}

export async function fetchOperatorAuditLogs(query: {
  dateFrom?: string;
  dateTo?: string;
  operatorId?: string;
  categories?: string[];
  page?: string;
  pageSize?: string;
}) {
  const accessToken = await getOperatorAccessToken();
  const search = new URLSearchParams();
  if (query.dateFrom) search.set("dateFrom", query.dateFrom);
  if (query.dateTo) search.set("dateTo", query.dateTo);
  if (query.operatorId) search.set("operatorId", query.operatorId);
  if (query.categories && query.categories.length > 0) {
    search.set("categories", query.categories.join(","));
  }
  if (query.page) search.set("page", query.page);
  if (query.pageSize) search.set("pageSize", query.pageSize);
  const qs = search.toString();
  const url = qs ? `/api/operator/audit-logs?${qs}` : "/api/operator/audit-logs";

  return requestJson<OperatorAuditLogsResponse>(url, { accessToken });
}

export async function fetchDriverFlowMetrics(query: { dateFrom?: string; dateTo?: string }) {
  const accessToken = await getOperatorAccessToken();
  const search = new URLSearchParams();
  if (query.dateFrom) search.set("dateFrom", query.dateFrom);
  if (query.dateTo) search.set("dateTo", query.dateTo);
  // Filtro de data limpo = todo o período. Basta faltar QUALQUER extremo (limpar só
  // um dos campos também) para sinalizar range=all e o backend somar tudo, em vez de
  // cair no default de 7 dias / janela estreita (DC-241 fix).
  if (!query.dateFrom || !query.dateTo) search.set("range", "all");
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
  /** Presente só no balde "incompletos" (aba Dados incompletos). */
  problemas?: CadastroProblema[];
  n_problemas?: number;
}

export async function fetchCadastrosPendentes(params: {
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: "nome" | "placa" | "enviado" | "status";
  dir?: "asc" | "desc";
  /** Aba "Dados incompletos": esconde da revisão os cadastros com problema. */
  excluirIncompletos?: boolean;
  /** Balde da fila: "revisao" (default), "incompletos" ou "nao_conformidade". */
  bucket?: "revisao" | "incompletos" | "nao_conformidade";
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

// ─── Cadastros com dados incompletos / não conformes (aba derivada) ──────────
export interface CadastroProblema {
  area: "motorista" | "cavalo" | "carreta" | "proprietario";
  tipo: "incompleto" | "nao_conforme";
  motivo: string;
}

export interface CadastroIncompletoItem extends PendingDriverRegistrationItem {
  problemas: CadastroProblema[];
  n_problemas: number;
}

export interface CadastrosIncompletosResponse {
  items: CadastroIncompletoItem[];
  meta: PaginationMeta;
  counts: { revisao: number; incompletos: number; total: number };
}

export async function fetchCadastrosIncompletos(params: {
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: "nome" | "placa" | "enviado" | "status";
  dir?: "asc" | "desc";
}) {
  const accessToken = await getOperatorAccessToken();
  const query = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return requestJson<CadastrosIncompletosResponse>(
    `/api/operator/cadastros-incompletos${query ? `?${query}` : ""}`,
    { accessToken },
  );
}

// ─── Cadastros com erro no cadastro externo (DC-196) ─────────────────────────
export interface CadastroBotHealth {
  key: "angellira" | "spx" | "unificada";
  label: string;
  online: boolean;
  detail: string | null;
}

export interface CadastroBotsHealthResponse {
  bots: CadastroBotHealth[];
  anyOffline: boolean;
  offline: { key: string; label: string; detail: string | null }[];
  meta: { correlationId: string | null; checkedAt: string };
}

/** B3 (DC-222 AC6): saúde dos robôs de cadastro externo (Angellira/SPX/Dossiê). */
export async function fetchCadastroBotsHealth(): Promise<CadastroBotsHealthResponse> {
  const accessToken = await getOperatorAccessToken();
  return requestJson<CadastroBotsHealthResponse>("/api/operator/cadastro-bots/health", { accessToken });
}

export interface CadastroComErroFalha {
  target: string;
  step: string;
  code: string | null;
  message: string | null;
  acao: string | null;
}
export interface CadastroComErroItem {
  id: string;
  status: string | null;
  nome_motorista: string | null;
  cpf_motorista: string | null;
  placa_cavalo: string | null;
  n_erros: number;
  ultimo_erro_at: string | null;
  falhas: CadastroComErroFalha[];
}
export async function fetchCadastrosComErro(params: { origem?: "angellira" | "spx"; page?: number; pageSize?: number }) {
  const accessToken = await getOperatorAccessToken();
  const query = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return requestJson<{ items: CadastroComErroItem[]; meta: PaginationMeta }>(
    `/api/operator/cadastros-com-erro${query ? `?${query}` : ""}`,
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
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ items: DraftRegistrationItem[]; meta: { page: number; pageSize: number; total: number } }> {
  const accessToken = await getOperatorAccessToken();
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
export async function aprovarCadastro(
  id: string,
  options?: { jobs?: string[]; conformidade?: { angellira: boolean; spx: boolean } },
) {
  const accessToken = await getOperatorAccessToken();
  const response = await fetch(`/api/operator/cadastros/${id}/aprovar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    // conformidade (DC-198): usada só pelo gatilho de WhatsApp; não altera a aprovação.
    body: JSON.stringify({ jobs: options?.jobs ?? [], conformidade: options?.conformidade }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error((body as { message?: string })?.message || "Erro ao aprovar cadastro.");
  }
  return response.json() as Promise<{
    ok: boolean;
    // false quando o cadastro externo (Angellira/SPX) solicitado falhou: o
    // cadastro NÃO foi aprovado e segue na fila para retentar.
    approved: boolean;
    driverId: string;
    jobs?: string[];
    angellira?: { ok: boolean; results: AngelliraStepResult[]; error?: { code?: string; message?: string } } | null;
    spx?: { ok: boolean; results?: AngelliraStepResult[]; error?: { code?: string; message?: string } } | null;
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

/**
 * Move (ou desfaz) um cadastro para a sub-aba "Não conformidade". Grava um
 * marcador derivado no JSONB (status segue 'pendente'; não sai da fila).
 */
export async function marcarNaoConformidade(
  id: string,
  options?: { motivos?: string[]; desfazer?: boolean },
) {
  const accessToken = await getOperatorAccessToken();
  const response = await fetch(`/api/operator/cadastros/${id}/nao-conformidade`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ motivos: options?.motivos ?? [], desfazer: options?.desfazer ?? false }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error((body as { message?: string })?.message || "Erro ao mover para não conformidade.");
  }
  return response.json() as Promise<{ ok: boolean }>;
}

/** Relatório por documento devolvido pelo reprocessamento. */
export interface ReprocessDocReport {
  label: string;
  kind: string;
  ok: boolean;
  provider?: string | null;
  code?: number | null;
  message?: string | null;
  filled: string[];
}

/**
 * Reprocessa (re-OCR) os documentos já enviados de um cadastro pendente e mescla
 * o resultado no `dados` (merge não-destrutivo no backend). Devolve o `dados`
 * atualizado (para atualizar o card inline) + o relatório por documento.
 */
export async function reprocessarDocsCadastro(id: string): Promise<{
  ok: boolean;
  changed: boolean;
  dados: Record<string, unknown>;
  report: ReprocessDocReport[];
}> {
  const accessToken = await getOperatorAccessToken();
  const response = await fetch(`/api/operator/cadastros/${id}/reprocessar-documentos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error((body as { message?: string })?.message || "Erro ao reprocessar documentos.");
  }
  return response.json() as Promise<{
    ok: boolean;
    changed: boolean;
    dados: Record<string, unknown>;
    report: ReprocessDocReport[];
  }>;
}

// ── Auto-aprovação por vigência no Angellira ────────────────────────────
export interface AutoApproveAngelliraState {
  ok: boolean;
  enabled: boolean;
  running: boolean;
  lastRun:
    | {
        at?: string;
        trigger?: string;
        scanned?: number;
        vigentes?: number;
        approved?: number;
        vencidos?: number;
        notFound?: number;
        errors?: number;
      }
    | null;
  pendingCount: number;
}

/** Estado atual do auto-approve (ligado?, rodando?, última execução, fila). */
export async function getAutoApproveAngellira(): Promise<AutoApproveAngelliraState> {
  return getOperator<AutoApproveAngelliraState>("/api/operator/settings/auto-approve-angellira");
}

/** Liga/desliga o job automático. */
export async function setAutoApproveAngellira(enabled: boolean): Promise<{ ok: boolean; enabled: boolean }> {
  return putOperator<{ ok: boolean; enabled: boolean }>("/api/operator/settings/auto-approve-angellira", { enabled });
}

/** Dispara uma leva agora (assíncrono no servidor; acompanhe via getAutoApproveAngellira). */
export async function runAutoApproveAngellira(limit?: number): Promise<{ ok: boolean; started: boolean }> {
  return postOperator<{ ok: boolean; started: boolean }>(
    "/api/operator/cadastros/auto-approve-angellira/run",
    limit != null ? { limit } : undefined,
  );
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

async function putOperator<T>(path: string, body: unknown): Promise<T> {
  const accessToken = await getOperatorAccessToken();
  const response = await fetch(path, {
    method: "PUT",
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

export interface TorreDriverInfo {
  cadastroTorre: boolean;
  fonte: string | null;
  geradoEm: string | null;
  ranking: {
    encontrado: boolean;
    posicao: number | null;
    pontuacao: number | null;
    vinculo: string | null;
    status: string | null;
  };
  identidade: {
    nome: string | null;
    driverKind: string | null;
    cidade: string | null;
    estado: string | null;
    shopeeDriverId: string | null;
  };
  conformidade: {
    operationalScore: number | null;
    angelliraStatus: string | null;
    angelliraValidUntil: string | null;
    anttValid: boolean | null;
    documentsValid: boolean | null;
    operationalBlocked: boolean | null;
  };
  viagens: {
    total: number;
    completas: number;
    canceladas: number;
    emAndamento: number;
    pctNoPrazo: number | null;
    ultima: string | null;
  };
  ocorrencias: { total: number };
  ultimaPosicao: { at?: string | null; cidade?: string | null; uf?: string | null; veiculo?: string | null } | null;
}

/** Dossiê da Torre de Controle (ranking + sinais) do motorista do cadastro. */
export async function fetchTorreDriverInfo(id: string) {
  return getOperator<{ ok: boolean; found: boolean; torre: TorreDriverInfo | null }>(
    `/api/operator/cadastros/${id}/torre`,
  );
}

/** Dossiê da Torre por CPF direto — fila de candidatos / DriverDetailModal. */
export async function fetchTorreDriverInfoByCpf(cpf: string) {
  const digits = cpf.replace(/\D/g, "");
  return getOperator<{ ok: boolean; found: boolean; torre: TorreDriverInfo | null }>(
    `/api/operator/drivers/${digits}/torre`,
  );
}

// ── Preview de payloads (G3 — inspeção read-only antes do disparo) ─────────
export type PreviewProprietario =
  | { tipo: "PF" | "PJ"; payload: Record<string, unknown>; owner_is_driver?: boolean }
  | { reused_from_cavalo: true }
  | { skipped: true; reason: string };

export type PreviewVeiculo =
  | {
      payload: Record<string, unknown>;
      owner_cpf: string | null;
      owner_cnpj: string | null;
      rntrc_fallback: string | null;
    }
  | { skipped: true; reason: string };

export type PreviewPayloadsResult = {
  ok: boolean;
  angellira: {
    proprietario_cavalo: PreviewProprietario;
    proprietario_carreta: PreviewProprietario;
    motorista: { payload: Record<string, unknown> };
    cavalo: PreviewVeiculo;
    carreta: PreviewVeiculo;
  };
  spx: { payload: Record<string, unknown> } | { skipped: true; reason: string } | null;
};

export async function previewPayloads(id: string) {
  return getOperator<PreviewPayloadsResult>(
    `/api/operator/cadastros/${id}/preview-payloads`,
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

/**
 * Resgate de rascunho: o operador completa e submete um draft em nome do
 * motorista. Reusa o pipeline canônico (gera 'pendente' + protocolo) e consome
 * a row de rascunho de origem. Espelha o submit do wizard do motorista.
 */
export async function submitCadastroRascunho(id: string, dados: Record<string, unknown>) {
  return postOperator<{ id: string; protocolo: string; meta?: { correlationId?: string } }>(
    `/api/operator/cadastros/${id}/submeter`,
    { dados },
  );
}

/**
 * Gera uma signed URL (TTL 1h) para visualizar um arquivo enviado pelo motorista
 * (CNH/CRLV/comprovante/etc.) no bucket privado cadastro-drafts. O backend valida
 * que o path pertence ao cadastro.
 */
export async function fetchCadastroArquivoUrl(cadastroId: string, path: string) {
  return getOperator<{ signed_url: string; expires_in: number }>(
    `/api/operator/cadastros/${cadastroId}/arquivo?path=${encodeURIComponent(path)}`,
  );
}

export interface MigratedDocItem {
  tipo: string;
  label: string;
  filename: string;
  content_type: string;
}

/**
 * Lista os documentos de um cadastro MIGRADO (bot WhatsApp) que existem no share
 * local. Para cadastro não-migrado volta { docs: [], migrado: false }.
 */
export async function fetchMigratedDocsManifest(cadastroId: string) {
  return getOperator<{ docs: MigratedDocItem[]; migrado: boolean }>(
    `/api/operator/cadastros/${cadastroId}/docs-migrados`,
  );
}

/**
 * Busca UM documento de cadastro migrado como data-URI base64 (lido do share, sem
 * passar pelo Supabase). Renderizado inline no FilePreviewModal.
 */
export async function fetchCadastroDocMigrado(cadastroId: string, tipo: string) {
  return getOperator<{ data_uri: string; content_type: string; filename: string; tipo: string }>(
    `/api/operator/cadastros/${cadastroId}/doc-migrado?tipo=${encodeURIComponent(tipo)}`,
  );
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
