import { addDays, format, isSameDay, startOfDay } from "date-fns";
import { ptBR } from "date-fns/locale";

import { buildLoadingDateTime } from "@/lib/estimatedTime";
import type { DriverLoadReadModelItem } from "@/services/readModels";

const NEXT_HOURS_WINDOW = 24;
const DEPARTURE_WINDOW_DAYS = 4;

export interface DriverDashboardHeroMetrics {
  openLoads: number;
  totalPayout: number;
  next24hLoads: number;
  next24hPayout: number;
  averageTicket: number | null;
  averagePayPerKm: number | null;
  bonusLoads: number;
  bonusTotal: number;
  uniqueClients: number;
  uniqueCorridors: number;
  uniqueProfiles: number;
  uniqueStates: number;
}

export interface DriverDashboardDepartureWindow {
  label: string;
  shortLabel: string;
  loads: number;
  payout: number;
}

export interface DriverDashboardTopRoute {
  id: string;
  route: string;
  clientName: string;
  profile: string;
  departureLabel: string;
  totalPayment: number | null;
  payPerKm: number | null;
  distanceKm: number | null;
  hasBonus: boolean;
}

export interface DriverDashboardTopProfile {
  profile: string;
  loads: number;
  totalPayout: number;
  averageTicket: number;
}

export interface DriverDashboardTopClient {
  clientName: string;
  loads: number;
  totalPayout: number;
  share: number;
}

export interface DriverDashboardSnapshot {
  hero: DriverDashboardHeroMetrics;
  departureWindows: DriverDashboardDepartureWindow[];
  topRoutes: DriverDashboardTopRoute[];
  topProfiles: DriverDashboardTopProfile[];
  topClients: DriverDashboardTopClient[];
}

interface DriverLoadProjection {
  load: DriverLoadReadModelItem;
  totalPayment: number | null;
  loadingDate: Date | null;
}

function getTotalPayment(load: Pick<DriverLoadReadModelItem, "valor" | "bonus">) {
  const hasValue = typeof load.valor === "number" && Number.isFinite(load.valor);
  const hasBonus = typeof load.bonus === "number" && Number.isFinite(load.bonus);

  if (!hasValue && !hasBonus) {
    return null;
  }

  return (hasValue ? load.valor : 0) + (hasBonus ? load.bonus : 0);
}

function getLoadingDate(load: Pick<DriverLoadReadModelItem, "carregamentoLabel" | "data" | "horario">) {
  return buildLoadingDateTime(load.carregamentoLabel, load.data, load.horario);
}

function getStateCode(location: string) {
  const match = location.trim().match(/(?:\/|,|-)?\s*([A-Za-z]{2})$/);
  return match?.[1]?.toUpperCase() || null;
}

function getClientName(load: Pick<DriverLoadReadModelItem, "clienteNome">) {
  return load.clienteNome?.trim() || "Sem cliente";
}

function formatDepartureLabel(load: DriverLoadReadModelItem, loadingDate: Date | null) {
  if (loadingDate) {
    return format(loadingDate, "dd/MM HH:mm", { locale: ptBR });
  }

  return `${load.data} ${load.horario.slice(0, 5)}`;
}

export function buildDriverDashboardSnapshot(
  loads: DriverLoadReadModelItem[],
  now = new Date(),
): DriverDashboardSnapshot {
  const horizonEnd = new Date(now.getTime() + NEXT_HOURS_WINDOW * 60 * 60 * 1000);
  const projections: DriverLoadProjection[] = loads.map((load) => ({
    load,
    totalPayment: getTotalPayment(load),
    loadingDate: getLoadingDate(load),
  }));

  const payoutValues = projections
    .map((item) => item.totalPayment)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const payPerKmValues = projections
    .map(({ load, totalPayment }) => {
      if (
        totalPayment === null ||
        typeof load.distancia_km !== "number" ||
        !Number.isFinite(load.distancia_km) ||
        load.distancia_km <= 0
      ) {
        return null;
      }

      return totalPayment / load.distancia_km;
    })
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const next24hLoads = projections.filter(({ loadingDate }) => {
    return Boolean(loadingDate && loadingDate >= now && loadingDate <= horizonEnd);
  });
  const bonusLoads = projections.filter(({ load }) => typeof load.bonus === "number" && load.bonus > 0);
  const uniqueStates = new Set(
    loads.flatMap((load) => [getStateCode(load.origem), getStateCode(load.destino)].filter(Boolean)),
  ).size;
  const uniqueCorridors = new Set(loads.map((load) => `${load.origem}=>${load.destino}`)).size;
  const uniqueClients = new Set(loads.map((load) => getClientName(load))).size;
  const uniqueProfiles = new Set(loads.map((load) => load.perfil || "Nao informado")).size;

  const departureWindows = Array.from({ length: DEPARTURE_WINDOW_DAYS }, (_, dayIndex) => {
    const bucketDate = addDays(startOfDay(now), dayIndex);
    const isCurrentDay = isSameDay(bucketDate, now);
    const isNextDay = isSameDay(bucketDate, addDays(startOfDay(now), 1));
    const bucketLoads = projections.filter(({ loadingDate }) => Boolean(loadingDate && isSameDay(loadingDate, bucketDate)));

    return {
      label: isCurrentDay
        ? "Hoje"
        : isNextDay
          ? "Amanhã"
          : format(bucketDate, "EEE, dd/MM", { locale: ptBR }),
      shortLabel: isCurrentDay ? "Hoje" : isNextDay ? "Amanhã" : format(bucketDate, "dd/MM", { locale: ptBR }),
      loads: bucketLoads.length,
      payout: bucketLoads.reduce((sum, item) => sum + (item.totalPayment || 0), 0),
    };
  });

  const topRoutes = projections
    .map(({ load, totalPayment, loadingDate }) => ({
      id: load.id,
      route: `${load.origem} -> ${load.destino}`,
      clientName: getClientName(load),
      profile: load.perfil || "Nao informado",
      departureLabel: formatDepartureLabel(load, loadingDate),
      totalPayment,
      payPerKm:
        totalPayment !== null &&
        typeof load.distancia_km === "number" &&
        Number.isFinite(load.distancia_km) &&
        load.distancia_km > 0
          ? totalPayment / load.distancia_km
          : null,
      distanceKm: load.distancia_km,
      hasBonus: typeof load.bonus === "number" && load.bonus > 0,
    }))
    .sort((routeA, routeB) => {
      const payPerKmA = routeA.payPerKm ?? -1;
      const payPerKmB = routeB.payPerKm ?? -1;

      if (payPerKmA !== payPerKmB) {
        return payPerKmB - payPerKmA;
      }

      const totalA = routeA.totalPayment ?? -1;
      const totalB = routeB.totalPayment ?? -1;
      return totalB - totalA;
    })
    .slice(0, 4);

  const profileGroups = new Map<string, { loads: number; totalPayout: number }>();
  projections.forEach(({ load, totalPayment }) => {
    const profile = load.perfil || "Nao informado";
    const currentGroup = profileGroups.get(profile) || { loads: 0, totalPayout: 0 };

    currentGroup.loads += 1;
    currentGroup.totalPayout += totalPayment || 0;
    profileGroups.set(profile, currentGroup);
  });

  const topProfiles = Array.from(profileGroups.entries())
    .map(([profile, group]) => ({
      profile,
      loads: group.loads,
      totalPayout: group.totalPayout,
      averageTicket: group.loads > 0 ? group.totalPayout / group.loads : 0,
    }))
    .sort((profileA, profileB) => profileB.totalPayout - profileA.totalPayout)
    .slice(0, 4);

  const clientGroups = new Map<string, { loads: number; totalPayout: number }>();
  projections.forEach(({ load, totalPayment }) => {
    const clientName = getClientName(load);
    const currentGroup = clientGroups.get(clientName) || { loads: 0, totalPayout: 0 };

    currentGroup.loads += 1;
    currentGroup.totalPayout += totalPayment || 0;
    clientGroups.set(clientName, currentGroup);
  });

  const totalPayout = payoutValues.reduce((sum, value) => sum + value, 0);
  const topClients = Array.from(clientGroups.entries())
    .map(([clientName, group]) => ({
      clientName,
      loads: group.loads,
      totalPayout: group.totalPayout,
      share: totalPayout > 0 ? group.totalPayout / totalPayout : 0,
    }))
    .sort((clientA, clientB) => clientB.totalPayout - clientA.totalPayout)
    .slice(0, 4);

  return {
    hero: {
      openLoads: loads.length,
      totalPayout,
      next24hLoads: next24hLoads.length,
      next24hPayout: next24hLoads.reduce((sum, item) => sum + (item.totalPayment || 0), 0),
      averageTicket:
        payoutValues.length > 0
          ? payoutValues.reduce((sum, value) => sum + value, 0) / payoutValues.length
          : null,
      averagePayPerKm:
        payPerKmValues.length > 0
          ? payPerKmValues.reduce((sum, value) => sum + value, 0) / payPerKmValues.length
          : null,
      bonusLoads: bonusLoads.length,
      bonusTotal: bonusLoads.reduce((sum, item) => sum + (item.load.bonus || 0), 0),
      uniqueClients,
      uniqueCorridors,
      uniqueProfiles,
      uniqueStates,
    },
    departureWindows,
    topRoutes,
    topProfiles,
    topClients,
  };
}
