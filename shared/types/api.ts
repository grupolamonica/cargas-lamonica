// shared/types/api.ts
// API contract types: request/response shapes used by frontend services
// and matched by backend handlers.
// These are the "wire format" contracts, not DB schemas.

import type { CargoStatus, DriverVisibility } from "./domain.js";

// ---------------------------------------------------------------------------
// Pagination (used by all list endpoints)
// ---------------------------------------------------------------------------

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
  maxPageSize: number;
  correlationId: string;
}

// ---------------------------------------------------------------------------
// Cargo / Load mutations
// ---------------------------------------------------------------------------

export interface CreateCargaRequest {
  data: string;
  horario: string;
  origem: string;
  destino: string;
  perfil: string;
  valor: number | null;
  bonus: number | null;
  bonus_exigencias: string | null;
  driver_visibility: DriverVisibility;
  cliente_id: string | null;
  status: CargoStatus;
  is_template: boolean;
  distancia_km: number | null;
  duracao_horas: number | null;
  sheet_data_carregamento: string | null;
  sheet_data_descarga: string | null;
}

export type UpdateCargaRequest = CreateCargaRequest;

// ---------------------------------------------------------------------------
// Lead (Public Load Pre-Registration)
// ---------------------------------------------------------------------------

export interface CreateLeadRequest {
  cpf: string;
  phone: string;
  horsePlate: string;
  trailerPlate: string;
  trailerPlate2: string;
  vehicleType: string;
}

// ---------------------------------------------------------------------------
// Driver Profile
// ---------------------------------------------------------------------------

export interface DriverProfileRequest {
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

// ---------------------------------------------------------------------------
// Generic mutation response (used by most POST/PATCH/DELETE)
// ---------------------------------------------------------------------------

export interface MutationResponse {
  ok: boolean;
  warnings?: string[];
  cascadedCargaCount?: number;
  meta: {
    correlationId: string;
  };
}
