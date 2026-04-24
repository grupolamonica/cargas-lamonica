import type { StoredLeadState } from "@/lib/driverLeadStorage";
import type { PublicLoadClaimStatusResponse } from "@/services/loadClaims";

export interface DriverLeadNotificationStatusEntry {
  state: StoredLeadState;
  status: PublicLoadClaimStatusResponse | null;
  error: string | null;
}

export interface DriverLeadNotification {
  id: string;
  kind: "PRE_REGISTERED" | "QUEUED" | "APPROVED" | "ALLOCATED_TO_OTHER_DRIVER";
  loadId: string;
  leadId: string;
  title: string;
  message: string;
  origem: string;
  destino: string;
  happenedAt: string | null;
}

function normalizeStatus(value?: string | null) {
  return value?.trim().toUpperCase() || "";
}

function buildNotificationId(kind: DriverLeadNotification["kind"], state: StoredLeadState) {
  return `driver-lead:${kind}:${state.loadId}:${state.leadId}`;
}

export function shouldContinuePollingDriverLeadStatus(entry: DriverLeadNotificationStatusEntry) {
  if (entry.state.stage !== "QUEUED") {
    return false;
  }

  if (entry.error) {
    return true;
  }

  const loadStatus = normalizeStatus(entry.status?.load?.status);
  const publicLeadStatus = normalizeStatus(entry.status?.publicLead?.status);

  if (publicLeadStatus === "APPROVED") {
    return false;
  }

  return !loadStatus || loadStatus === "OPEN";
}

export function buildDriverLeadNotifications(entries: DriverLeadNotificationStatusEntry[]) {
  return entries.reduce<DriverLeadNotification[]>((notifications, entry) => {
    const load = entry.status?.load;

    if (!load || entry.state.stage !== "QUEUED") {
      if (!load || entry.state.stage !== "PRE_REGISTERED") {
        return notifications;
      }
    }

    const loadStatus = normalizeStatus(load.status);
    const publicLeadStatus = normalizeStatus(entry.status?.publicLead?.status);
    const isReserved = loadStatus === "RESERVED" || loadStatus === "BOOKED";

    if (publicLeadStatus === "APPROVED") {
      notifications.push({
        id: buildNotificationId("APPROVED", entry.state),
        kind: "APPROVED",
        loadId: entry.state.loadId,
        leadId: entry.state.leadId,
        title: loadStatus === "BOOKED" ? "Carga confirmada para você" : "Carga reservada para você",
        message:
          "A equipe liberou esta carga para você. Mesmo se ela sair da lista geral, o retorno continua salvo aqui para você acompanhar.",
        origem: load.origem?.trim() || "Origem a confirmar",
        destino: load.destino?.trim() || "Destino a confirmar",
        happenedAt: entry.status?.publicLead?.approvedAt || load.bookedAt || load.reservedAt || entry.state.updatedAt,
      });
      return notifications;
    }

    if (!isReserved && entry.state.stage === "QUEUED") {
      notifications.push({
        id: buildNotificationId("QUEUED", entry.state),
        kind: "QUEUED",
        loadId: entry.state.loadId,
        leadId: entry.state.leadId,
        title: "Candidatura em análise",
        message:
          "Sua candidatura já foi enviada para a equipe. Toque em abrir carga para acompanhar esse processo e revisar seus dados.",
        origem: load.origem?.trim() || "Origem a confirmar",
        destino: load.destino?.trim() || "Destino a confirmar",
        happenedAt: entry.status?.publicLead?.queuedAt || entry.state.updatedAt,
      });
      return notifications;
    }

    if (!isReserved && entry.state.stage === "PRE_REGISTERED") {
      notifications.push({
        id: buildNotificationId("PRE_REGISTERED", entry.state),
        kind: "PRE_REGISTERED",
        loadId: entry.state.loadId,
        leadId: entry.state.leadId,
        title: "Candidatura salva nesta carga",
        message:
          "Seus dados ficaram salvos nesta carga. Toque em abrir carga para revisar os detalhes e concluir sua candidatura.",
        origem: load.origem?.trim() || "Origem a confirmar",
        destino: load.destino?.trim() || "Destino a confirmar",
        happenedAt: entry.state.updatedAt,
      });
      return notifications;
    }

    notifications.push({
      id: buildNotificationId("ALLOCATED_TO_OTHER_DRIVER", entry.state),
      kind: "ALLOCATED_TO_OTHER_DRIVER",
      loadId: entry.state.loadId,
      leadId: entry.state.leadId,
      title: "Carga seguiu com outro motorista",
      message:
        "A equipe fechou esta carga com outra pessoa. Mesmo se ela sair da lista geral, o retorno continua salvo aqui para você acompanhar.",
      origem: load.origem?.trim() || "Origem a confirmar",
      destino: load.destino?.trim() || "Destino a confirmar",
      happenedAt: load.bookedAt || load.reservedAt || entry.state.updatedAt,
    });

    return notifications;
  }, []);
}
