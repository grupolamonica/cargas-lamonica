import { z } from "zod";
import { CANONICAL_VEHICLE_PROFILES, normalizeVehicleProfile } from "../../lib/vehicle-profiles.js";

const MANUAL_CARGO_STATUSES = ["DRAFT", "OPEN"];
const OPERATIONAL_CARGO_STATUSES = ["RESERVED", "BOOKED", "EXPIRED", "CANCELLED", "COMPLETED", "FAILED"];
const ALL_CARGO_STATUSES = [...MANUAL_CARGO_STATUSES, ...OPERATIONAL_CARGO_STATUSES];
const LEGACY_STATUS_MAP = new Map([
  ["rascunho", "DRAFT"],
  ["ativa", "OPEN"],
  ["draft", "DRAFT"],
  ["open", "OPEN"],
  ["reserved", "RESERVED"],
  ["booked", "BOOKED"],
  ["expired", "EXPIRED"],
  ["cancelled", "CANCELLED"],
  ["completed", "COMPLETED"],
  ["failed", "FAILED"],
]);
const DRIVER_VISIBILITY_OPTIONS = ["PUBLIC", "PREMIUM"];
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const optionalTrimmedString = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => {
    const trimmedValue = typeof value === "string" ? value.trim() : "";
    return trimmedValue ? trimmedValue : null;
  });

const optionalUuid = z
  .union([z.string().uuid(), z.literal(""), z.null(), z.undefined()])
  .transform((value) => {
    const trimmedValue = typeof value === "string" ? value.trim() : "";
    return trimmedValue || null;
  });

const optionalNumeric = z
  .union([z.number().finite(), z.null(), z.undefined()])
  .transform((value) => (typeof value === "number" && Number.isFinite(value) ? value : null));

const booleanField = z.boolean().default(false);
const canonicalVehicleProfileSchema = z
  .string()
  .trim()
  .transform((value) => normalizeVehicleProfile(value))
  .refine((value) => Boolean(value), {
    message: `Perfil do veiculo deve ser um destes: ${CANONICAL_VEHICLE_PROFILES.join(", ")}`,
  });
const optionalCanonicalVehicleProfileSchema = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => normalizeVehicleProfile(value));

function parsePositiveInteger(value, fallback) {
  const parsedValue = Number.parseInt(String(value || ""), 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallback;
  }

  return parsedValue;
}

function normalizeCargoStatus(value) {
  const trimmed = String(value || "").trim();
  return LEGACY_STATUS_MAP.get(trimmed.toLowerCase()) || trimmed;
}

const cargoStatusSchema = z
  .string()
  .trim()
  .transform(normalizeCargoStatus)
  .refine((value) => ALL_CARGO_STATUSES.includes(value), {
    message: `Status deve ser um destes: ${ALL_CARGO_STATUSES.join(", ")}`,
  });

const manualCargoStatusSchema = z
  .string()
  .trim()
  .transform(normalizeCargoStatus)
  .refine((value) => MANUAL_CARGO_STATUSES.includes(value), {
    message: `Status para criacao deve ser: ${MANUAL_CARGO_STATUSES.join(", ")}`,
  });

const cargoMutationBaseShape = {
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  horario: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  origem: z.string().trim().min(2).max(180),
  destino: z.string().trim().min(2).max(180),
  perfil: canonicalVehicleProfileSchema,
  valor: optionalNumeric,
  bonus: optionalNumeric,
  bonus_exigencias: optionalTrimmedString,
  driver_visibility: z.enum(DRIVER_VISIBILITY_OPTIONS).default("PUBLIC"),
  cliente_id: optionalUuid,
  is_template: z.boolean(),
  distancia_km: optionalNumeric,
  duracao_horas: optionalNumeric,
  sheet_data_carregamento: optionalTrimmedString,
  sheet_data_descarga: optionalTrimmedString,
};

export const cargoCreateMutationSchema = z
  .object({
    ...cargoMutationBaseShape,
    status: manualCargoStatusSchema,
  })
  .strict();

export const cargoUpdateMutationSchema = z
  .object({
    ...cargoMutationBaseShape,
    status: cargoStatusSchema,
  })
  .strict();

export const cargoMutationSchema = cargoCreateMutationSchema;

export const clienteMutationSchema = z
  .object({
    nome: z.string().trim().min(2).max(160),
    descricao: optionalTrimmedString,
    logo_url: optionalTrimmedString,
    forma_pagamento: optionalTrimmedString,
    prazo_pagamento: optionalTrimmedString,
    exige_rastreamento: booleanField,
    exige_antt: booleanField,
    exige_seguro: booleanField,
    exige_carga_monitorada: booleanField,
    reputacao_pagamento_rapido: booleanField,
    reputacao_bom_pagador: booleanField,
    reputacao_liberacao_rapida: booleanField,
    reputacao_carga_organizada: booleanField,
    reputacao_boa_comunicacao: booleanField,
    observacoes: optionalTrimmedString,
  })
  .strict();

export const routeMutationSchema = z
  .object({
    origem: z.string().trim().min(2).max(180),
    destino: z.string().trim().min(2).max(180),
    distancia_km: optionalNumeric,
    duracao_horas: optionalNumeric,
    tempo_estimado_horas: optionalNumeric,
    perfil_padrao: optionalCanonicalVehicleProfileSchema,
    valor_padrao: optionalNumeric,
    bonus_padrao: optionalNumeric,
    ativa: z.boolean().default(true),
    observacoes: optionalTrimmedString,
  })
  .strict();

export const driverProfileUpdateMutationSchema = z
  .object({
    full_name: z.string().trim().min(3).optional(),
    phone: z.string().trim().min(8).optional(),
    document_number: z.string().trim().min(5).optional().or(z.literal("")),
    vehicle_profile: optionalCanonicalVehicleProfileSchema.optional(),
    documents_valid: z.boolean().optional(),
    antt_valid: z.boolean().optional(),
    tracking_enabled: z.boolean().optional(),
    insurance_valid: z.boolean().optional(),
    monitoring_capable: z.boolean().optional(),
    operational_blocked: z.boolean().optional(),
    allowed_regions: z.array(z.string().trim().min(2).max(2)).optional(),
  })
  .strict();

export function parsePaginationQuery(query = {}, { defaultPageSize = DEFAULT_PAGE_SIZE, maxPageSize = MAX_PAGE_SIZE } = {}) {
  const page = parsePositiveInteger(query.page, 1);
  const pageSize = Math.min(parsePositiveInteger(query.pageSize, defaultPageSize), maxPageSize);

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    maxPageSize,
  };
}

export function parseOperatorDashboardQuery(query = {}) {
  const pagination = parsePaginationQuery(query, {
    defaultPageSize: 12,
    maxPageSize: 24,
  });

  return {
    ...pagination,
    search: typeof query.search === "string" ? query.search.trim() : "",
    status: typeof query.status === "string" ? query.status.trim() : "todos",
    driverVisibility: typeof query.driverVisibility === "string" ? query.driverVisibility.trim() : "todos",
  };
}

export function parseDriverLoadsQuery(query = {}) {
  const pagination = parsePaginationQuery(query, {
    defaultPageSize: 12,
    maxPageSize: 24,
  });

  return {
    ...pagination,
    origem: typeof query.origem === "string" ? query.origem.trim() : "",
    destino: typeof query.destino === "string" ? query.destino.trim() : "",
    perfil: typeof query.perfil === "string" ? query.perfil.trim() : "",
    dateFrom: typeof query.dateFrom === "string" ? query.dateFrom.trim() : "",
    dateTo: typeof query.dateTo === "string" ? query.dateTo.trim() : "",
  };
}

export function parseOperatorCargoListQuery(query = {}) {
  const pagination = parsePaginationQuery(query, {
    defaultPageSize: 12,
    maxPageSize: 50,
  });

  return {
    ...pagination,
    search: typeof query.search === "string" ? query.search.trim() : "",
    status: typeof query.status === "string" ? query.status.trim() : "todos",
    driverVisibility: typeof query.driverVisibility === "string" ? query.driverVisibility.trim() : "todos",
    source: typeof query.source === "string" ? query.source.trim() : "todos",
    // Intervalo de data de carregamento (ISO YYYY-MM-DD). Vazio = sem filtro.
    dateFrom: typeof query.dateFrom === "string" ? query.dateFrom.trim() : "",
    dateTo: typeof query.dateTo === "string" ? query.dateTo.trim() : "",
  };
}

export function parseOperatorClientesListQuery(query = {}) {
  const pagination = parsePaginationQuery(query, {
    defaultPageSize: 12,
    maxPageSize: 200,
  });

  return {
    ...pagination,
    search: typeof query.search === "string" ? query.search.trim() : "",
  };
}

export function parseOperatorRoutesListQuery(query = {}) {
  const pagination = parsePaginationQuery(query, {
    defaultPageSize: 12,
    maxPageSize: 200,
  });

  return {
    ...pagination,
    search: typeof query.search === "string" ? query.search.trim().toLowerCase() : "",
    status: typeof query.status === "string" ? query.status.trim() : "ativas",
  };
}

export function parseOperatorVehiclesListQuery(query = {}) {
  const pagination = parsePaginationQuery(query, {
    defaultPageSize: 12,
    maxPageSize: 50,
  });

  return {
    ...pagination,
    search: typeof query.search === "string" ? query.search.trim() : "",
    status: typeof query.status === "string" ? query.status.trim() : "todos",
    plateRole: typeof query.plateRole === "string" ? query.plateRole.trim() : "todos",
  };
}

export function parseOperatorDriversListQuery(query = {}) {
  const pagination = parsePaginationQuery(query, {
    defaultPageSize: 8,
    maxPageSize: 50,
  });

  return {
    ...pagination,
    search: typeof query.search === "string" ? query.search.trim() : "",
    source: typeof query.source === "string" ? query.source.trim() : "todos",
    applicationStatus: typeof query.applicationStatus === "string" ? query.applicationStatus.trim() : "todos",
  };
}

export function parseSheetMonitorQuery(query = {}) {
  return {
    status: typeof query.status === "string" ? query.status.trim() : "todos",
    tipo: typeof query.tipo === "string" ? query.tipo.trim() : "todos",
    search: typeof query.search === "string" ? query.search.trim() : "",
  };
}
