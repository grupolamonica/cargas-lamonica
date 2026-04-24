// shared/types/domain.ts
// Pure domain entity types shared between frontend and backend.
// NO imports from Supabase, React, or any framework here.
// These mirror the canonical DB row shapes and domain objects.

// ---------------------------------------------------------------------------
// Cargo (Load)
// ---------------------------------------------------------------------------

export type CargoStatus =
  | "DRAFT"
  | "OPEN"
  | "RESERVED"
  | "BOOKED"
  | "EXPIRED"
  | "CANCELLED"
  | "COMPLETED"
  | "FAILED";

export type DriverVisibility = "PUBLIC" | "PREMIUM";

export interface Carga {
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
  driver_visibility: DriverVisibility;
  status: CargoStatus;
  is_template: boolean;
  cliente_id: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  reserved_at: string | null;
  reserved_claim_id: string | null;
  reserved_driver_id: string | null;
  reserved_public_lead_id: string | null;
  reserved_until: string | null;
  booked_at: string | null;
  booked_driver_id: string | null;
  sheet_lh: string | null;
  sheet_data_carregamento: string | null;
  sheet_data_descarga: string | null;
  sheet_tipo: string | null;
  sheet_synced_at: string | null;
  version: number;
}

// ---------------------------------------------------------------------------
// Cliente (Client / Shipper)
// ---------------------------------------------------------------------------

export interface Cliente {
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

// ---------------------------------------------------------------------------
// Rota (Route)
// ---------------------------------------------------------------------------

export interface Rota {
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
}

// ---------------------------------------------------------------------------
// Lead (Public Load Lead / Driver Candidate)
// ---------------------------------------------------------------------------

export type LeadStatus =
  | "PRE_REGISTERED"
  | "QUEUED"
  | "WHATSAPP_CLICKED"
  | "APPROVED"
  | "CANCELLED"
  | "EXPIRED";

export interface Lead {
  id: string;
  status: LeadStatus | string;
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
  queuePosition: number | null;
}

// ---------------------------------------------------------------------------
// Motorista (Driver)
// ---------------------------------------------------------------------------

export interface Motorista {
  id: string;
  full_name: string | null;
  document_number: string | null;
  vehicle_profile: string | null;
  active: boolean | null;
  documents_valid: boolean | null;
  antt_valid: boolean | null;
  tracking_enabled: boolean | null;
  insurance_valid: boolean | null;
  monitoring_capable: boolean | null;
  operational_blocked: boolean | null;
  phone: string | null;
}

// ---------------------------------------------------------------------------
// Claim (Load Claim State Machine)
// ---------------------------------------------------------------------------

export type ClaimStatus = "pending" | "confirmed" | "cancelled" | "expired";

export interface Claim {
  id: string;
  status: ClaimStatus | string;
  queuePosition: number | null;
  serverSequence: number | null;
  claimedAt: string | null;
  promotedAt: string | null;
  confirmedAt: string | null;
  expiredAt: string | null;
  rejectedReason: string | null;
}
