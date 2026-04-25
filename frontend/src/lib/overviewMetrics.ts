import { differenceInHours } from "date-fns";

import { buildLoadingDateTime } from "@/lib/estimatedTime";

const DRIVER_VISIBLE_LOAD_STATUSES = new Set(["OPEN", "RESERVED", "BOOKED"]);
const ACTIVE_CLAIM_STATUSES = new Set(["WON_RESERVATION", "WAITLISTED", "PROMOTED", "CONFIRMED"]);
const ACTIVE_LEAD_STATUSES = new Set(["QUEUED", "APPROVED"]);
// Status terminais de carga: ficam fora da tela de Fila (alinhado a Leads.tsx).
const TERMINAL_LOAD_STATUSES = new Set(["EXPIRED", "CANCELLED", "COMPLETED", "FAILED", "BOOKED"]);
const HOURS_AHEAD_WINDOW = 24;
const STALE_HOURS_THRESHOLD = 48;

export interface OverviewCargoClientRow {
  id: string | null;
  nome: string | null;
  prazo_pagamento: string | null;
  forma_pagamento: string | null;
  reputacao_bom_pagador: boolean;
  reputacao_pagamento_rapido: boolean;
}

export interface OverviewCargoRow {
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
  status: string;
  is_template: boolean;
  created_at: string;
  updated_at: string;
  sheet_data_carregamento: string | null;
  cliente: OverviewCargoClientRow | null;
}

export interface OverviewLeadRow {
  id: string;
  load_id: string;
  status: string;
  created_at: string;
  queued_at: string | null;
  approved_at: string | null;
  whatsapp_clicked_at: string | null;
  vehicle_type: string;
}

export interface OverviewClaimRow {
  id: string;
  load_id: string;
  status: string;
  created_at: string;
  claimed_at: string;
  promoted_at: string | null;
  confirmed_at: string | null;
  queue_position: number | null;
}

export interface OverviewHeroMetrics {
  activeLoads: number;
  departuresNext24h: number;
  queuedLeads: number;
  noDriverLoads: number;
  // `activeClaims` no sentido operacional: quantos motoristas est\u00e3o disputando
  // cargas agora (QUEUED + APPROVED em load_public_leads). A tabela legacy
  // `load_claims` est\u00e1 vazia em prod; passamos a contar pelos leads vivos.
  activeClaims: number;
  draftCount: number;
  bookedCount: number;
  // Leads que foram APPROVED com approved_at no dia atual.
  approvedToday: number;
  // Cargas OPEN cujo hor\u00e1rio de carregamento j\u00e1 passou (atrasadas).
  overdueLoads: number;
  // Cargas RESERVED via candidatura (motorista aprovado aguardando confirma\u00e7\u00e3o).
  reservedCount: number;
}

export interface OverviewAttentionLoad {
  id: string;
  origem: string;
  destino: string;
  status: string;
  createdAt: string;
  ageHours: number;
  missingFields: string[];
}

export interface OverviewActivityItem {
  id: string;
  type: "load" | "lead" | "claim";
  title: string;
  description: string;
  timestamp: string;
  relativeTime: string;
}

export interface OverviewDashboardSnapshot {
  hero: OverviewHeroMetrics;
  attentionLoads: OverviewAttentionLoad[];
  recentActivity: OverviewActivityItem[];
  lastUpdatedAt: string | null;
}

function getLoadingDate(cargo: Pick<OverviewCargoRow, "sheet_data_carregamento" | "data" | "horario">) {
  return buildLoadingDateTime(cargo.sheet_data_carregamento, cargo.data, cargo.horario);
}

function buildRelativeTimeLabel(timestamp: string, now: Date) {
  const referenceDate = new Date(timestamp);
  const diffHours = differenceInHours(now, referenceDate);

  if (!Number.isFinite(referenceDate.getTime())) {
    return "agora";
  }

  if (diffHours < 1) {
    const diffMinutes = Math.max(Math.round((now.getTime() - referenceDate.getTime()) / 60_000), 0);
    return diffMinutes <= 1 ? "agora" : `ha ${diffMinutes} min`;
  }

  if (diffHours < 24) {
    return `ha ${diffHours}h`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `ha ${diffDays}d`;
}

function buildActivityFeed(
  cargos: OverviewCargoRow[],
  leads: OverviewLeadRow[],
  claims: OverviewClaimRow[],
  now: Date,
) {
  const routeByLoadId = new Map(
    cargos.map((cargo) => [cargo.id, `${cargo.origem} -> ${cargo.destino}`] as const),
  );

  const cargoEvents: OverviewActivityItem[] = cargos
    .filter((cargo) => !cargo.is_template)
    .map((cargo) => {
      const routeLabel = `${cargo.origem} -> ${cargo.destino}`;
      const title =
        cargo.status === "OPEN"
          ? "Carga aberta na malha"
          : cargo.status === "RESERVED"
            ? "Carga reservada"
            : cargo.status === "BOOKED"
              ? "Carga confirmada"
              : "Carga atualizada";

      return {
        id: `cargo:${cargo.id}`,
        type: "load",
        title,
        description: `${routeLabel} | Perfil ${cargo.perfil}`,
        timestamp: cargo.updated_at || cargo.created_at,
        relativeTime: buildRelativeTimeLabel(cargo.updated_at || cargo.created_at, now),
      };
    });

  const leadEvents: OverviewActivityItem[] = leads
    .filter((lead) => ACTIVE_LEAD_STATUSES.has(lead.status))
    .map((lead) => {
      const timestamp = lead.approved_at || lead.queued_at || lead.whatsapp_clicked_at || lead.created_at;
      return {
        id: `lead:${lead.id}`,
        type: "lead",
        title: lead.status === "APPROVED" ? "Lead aprovado" : "Lead entrou na fila",
        description: `${routeByLoadId.get(lead.load_id) || lead.load_id} | Veiculo ${lead.vehicle_type}`,
        timestamp,
        relativeTime: buildRelativeTimeLabel(timestamp, now),
      };
    });

  const claimEvents: OverviewActivityItem[] = claims
    .filter((claim) => ACTIVE_CLAIM_STATUSES.has(claim.status))
    .map((claim) => {
      const timestamp = claim.confirmed_at || claim.promoted_at || claim.claimed_at || claim.created_at;
      const title =
        claim.status === "CONFIRMED"
          ? "Disputa confirmada"
          : claim.status === "PROMOTED"
            ? "Motorista promovido na fila"
            : claim.status === "WON_RESERVATION"
              ? "Reserva imediata concedida"
              : "Disputa ativa na fila";

      return {
        id: `claim:${claim.id}`,
        type: "claim",
        title,
        description: routeByLoadId.get(claim.load_id) || claim.load_id,
        timestamp,
        relativeTime: buildRelativeTimeLabel(timestamp, now),
      };
    });

  return [...cargoEvents, ...leadEvents, ...claimEvents]
    .filter((item) => item.timestamp)
    .sort((itemA, itemB) => new Date(itemB.timestamp).getTime() - new Date(itemA.timestamp).getTime())
    .slice(0, 8);
}

function buildAttentionLoads(
  cargos: OverviewCargoRow[],
  loadInterestById: Map<string, number>,
  now: Date,
): OverviewAttentionLoad[] {
  const openLoads = cargos.filter(
    (cargo) => cargo.status === "OPEN" && !cargo.is_template,
  );

  const attentionItems: OverviewAttentionLoad[] = [];

  for (const cargo of openLoads) {
    const ageHours = differenceInHours(now, new Date(cargo.created_at));
    const interestCount = loadInterestById.get(cargo.id) || 0;
    const missingFields: string[] = [];

    if (!cargo.perfil) {
      missingFields.push("perfil");
    }
    if (typeof cargo.distancia_km !== "number" || cargo.distancia_km <= 0) {
      missingFields.push("distancia_km");
    }
    if (!cargo.origem) {
      missingFields.push("origem");
    }
    if (!cargo.destino) {
      missingFields.push("destino");
    }

    const isStale = ageHours >= STALE_HOURS_THRESHOLD && interestCount === 0;
    const hasMissingData = missingFields.length > 0;

    if (isStale || hasMissingData) {
      attentionItems.push({
        id: cargo.id,
        origem: cargo.origem || "?",
        destino: cargo.destino || "?",
        status: cargo.status,
        createdAt: cargo.created_at,
        ageHours,
        missingFields,
      });
    }
  }

  return attentionItems
    .sort((a, b) => b.ageHours - a.ageHours)
    .slice(0, 10);
}

export function buildOverviewSnapshot(
  cargos: OverviewCargoRow[],
  leads: OverviewLeadRow[],
  claims: OverviewClaimRow[],
  now = new Date(),
): OverviewDashboardSnapshot {
  const nonTemplateLoads = cargos.filter((cargo) => !cargo.is_template);
  const openLoads = nonTemplateLoads.filter((cargo) => cargo.status === "OPEN");
  const reservedLoads = nonTemplateLoads.filter((cargo) => cargo.status === "RESERVED");
  const activeLoads = openLoads.length;

  const horizonEnd = new Date(now.getTime() + HOURS_AHEAD_WINDOW * 60 * 60 * 1000);

  const activeClaims = claims.filter((claim) => ACTIVE_CLAIM_STATUSES.has(claim.status));
  const activeLeads = leads.filter((lead) => ACTIVE_LEAD_STATUSES.has(lead.status));

  // Cargas que aparecem na tela de Fila (não-terminais). Espelha Leads.tsx.
  const queueLoadIds = new Set(
    nonTemplateLoads
      .filter((cargo) => !TERMINAL_LOAD_STATUSES.has(cargo.status))
      .map((cargo) => cargo.id),
  );
  const openLoadIds = new Set(openLoads.map((cargo) => cargo.id));

  // Apenas leads/claims cujas cargas estão nas telas de Fila.
  const queueActiveLeads = activeLeads.filter((lead) => queueLoadIds.has(lead.load_id));
  const queueActiveClaims = activeClaims.filter((claim) => queueLoadIds.has(claim.load_id));

  const loadInterestById = new Map<string, number>();
  queueActiveClaims.forEach((claim) => {
    loadInterestById.set(claim.load_id, (loadInterestById.get(claim.load_id) || 0) + 1);
  });
  queueActiveLeads.forEach((lead) => {
    loadInterestById.set(lead.load_id, (loadInterestById.get(lead.load_id) || 0) + 1);
  });

  const departuresNext24h = openLoads.filter((cargo) => {
    const loadingDate = getLoadingDate(cargo);
    return Boolean(loadingDate && loadingDate >= now && loadingDate <= horizonEnd);
  }).length;

  const noDriverLoads = openLoads.filter((cargo) => {
    const interestCount = loadInterestById.get(cargo.id) || 0;
    return interestCount === 0;
  }).length;

  // "NA FILA" = cargas distintas sem motorista reservado (status OPEN) que
  // possuem pelo menos um lead QUEUED na tela de Fila.
  const queuedCargoIds = new Set<string>();
  queueActiveLeads.forEach((lead) => {
    if (lead.status === "QUEUED" && openLoadIds.has(lead.load_id)) {
      queuedCargoIds.add(lead.load_id);
    }
  });
  const queuedLeads = queuedCargoIds.size;
  const draftCount = nonTemplateLoads.filter((cargo) => cargo.status === "DRAFT").length;
  const bookedCount = nonTemplateLoads.filter(
    (cargo) => cargo.status === "BOOKED" || cargo.status === "COMPLETED",
  ).length;

  // Aprovadas hoje: leads com approved_at dentro do dia corrente (local).
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
  const approvedToday = leads.filter((lead) => {
    if (!lead.approved_at) return false;
    const approvedAt = new Date(lead.approved_at);
    return approvedAt >= startOfToday && approvedAt < startOfTomorrow;
  }).length;

  // Cargas em atraso: OPEN cujo hor\u00e1rio de carregamento j\u00e1 passou.
  const overdueLoads = openLoads.filter((cargo) => {
    const loadingDate = getLoadingDate(cargo);
    return Boolean(loadingDate && loadingDate < now);
  }).length;

  const lastUpdatedAt =
    [
      ...cargos.map((cargo) => cargo.updated_at || cargo.created_at),
      ...activeLeads.map(
        (lead) => lead.approved_at || lead.queued_at || lead.whatsapp_clicked_at || lead.created_at,
      ),
      ...activeClaims.map(
        (claim) => claim.confirmed_at || claim.promoted_at || claim.claimed_at || claim.created_at,
      ),
    ]
      .filter(Boolean)
      .sort()
      .at(-1) || null;

  return {
    hero: {
      activeLoads,
      departuresNext24h,
      queuedLeads,
      noDriverLoads,
      // Disputas ativas = leads vivos (QUEUED + APPROVED) cujas cargas estão
      // nas telas de Fila (não-terminais). Reflete exatamente o que o operador
      // vê na Fila agora.
      activeClaims: queueActiveLeads.length,
      draftCount,
      bookedCount,
      approvedToday,
      overdueLoads,
      reservedCount: reservedLoads.length,
    },
    attentionLoads: buildAttentionLoads(cargos, loadInterestById, now),
    recentActivity: buildActivityFeed(cargos, leads, claims, now),
    lastUpdatedAt,
  };
}
