import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  buildDriverLeadNotifications,
  shouldContinuePollingDriverLeadStatus,
  type DriverLeadNotification,
  type DriverLeadNotificationStatusEntry,
} from "@/lib/driverLeadNotifications";
import {
  dismissDriverLeadNotification,
  DRIVER_LEAD_STORAGE_EVENT,
  readAllStoredLeadStates,
  readDismissedDriverLeadNotificationIds,
  removeStoredLeadState,
  type StoredLeadState,
} from "@/lib/driverLeadStorage";
import { fetchLoadClaimStatus } from "@/services/loadClaims";

export function useLeadNotifications() {
  const [storedLeadStates, setStoredLeadStates] = useState<StoredLeadState[]>(() => readAllStoredLeadStates());
  const [dismissedLeadNotificationIds, setDismissedLeadNotificationIds] = useState<string[]>(() =>
    readDismissedDriverLeadNotificationIds(),
  );

  const trackedLeadStates = useMemo(
    () => storedLeadStates.filter((state) => state.stage === "PRE_REGISTERED" || state.stage === "QUEUED"),
    [storedLeadStates],
  );

  const trackedLeadStatesSignature = useMemo(
    () => trackedLeadStates.map((state) => `${state.loadId}:${state.leadId}`),
    [trackedLeadStates],
  );

  const hasQueuedTrackedLeadStates = useMemo(
    () => trackedLeadStates.some((state) => state.stage === "QUEUED"),
    [trackedLeadStates],
  );

  useEffect(() => {
    const syncLeadClientState = () => {
      setStoredLeadStates(readAllStoredLeadStates());
      setDismissedLeadNotificationIds(readDismissedDriverLeadNotificationIds());
    };

    syncLeadClientState();
    window.addEventListener("storage", syncLeadClientState);
    window.addEventListener(DRIVER_LEAD_STORAGE_EVENT, syncLeadClientState);

    return () => {
      window.removeEventListener("storage", syncLeadClientState);
      window.removeEventListener(DRIVER_LEAD_STORAGE_EVENT, syncLeadClientState);
    };
  }, []);

  const { data: driverLeadStatusEntries = [] } = useQuery({
    queryKey: ["driver", "lead-notifications", trackedLeadStatesSignature],
    enabled: trackedLeadStates.length > 0,
    queryFn: async (): Promise<DriverLeadNotificationStatusEntry[]> =>
      Promise.all(
        trackedLeadStates.map(async (state) => {
          try {
            return {
              state,
              status: await fetchLoadClaimStatus(state.loadId, undefined, state.leadId),
              error: null,
            };
          } catch (error) {
            return {
              state,
              status: null,
              error: error instanceof Error ? error.message : "Não foi possível atualizar o status desta candidatura.",
            };
          }
        }),
      ),
    staleTime: 10_000,
    gcTime: 10 * 60_000,
    // N-01: refetch ao voltar para a aba — motorista vê aprovação assim que abre o app.
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    // Pausa polling em background para economizar bateria mobile.
    refetchIntervalInBackground: false,
    refetchInterval: (query) => {
      // Derive hasQueued from live query data instead of the closed-over memo value.
      // The refetchInterval callback is cached by TanStack Query at registration time;
      // using the closed-over boolean would leave a stale interval if lead stages change
      // before the queryKey-based recreation fires.
      const currentEntries = query.state.data as DriverLeadNotificationStatusEntry[] | undefined;
      if (!currentEntries?.length) return false;
      const hasQueued = currentEntries.some((e) => e.state.stage === "QUEUED");
      // N-01: poll mais agressivo (15s) quando há QUEUED — motorista esperando aprovação;
      // 60s quando só há PRE_REGISTERED (mudança rara).
      // TODO: substituir polling por Supabase realtime channel em `public_load_leads`
      // para notificação imediata em vez de até 15s de espera.
      if (!hasQueued) {
        return currentEntries.some(shouldContinuePollingDriverLeadStatus) ? 60_000 : false;
      }
      return currentEntries.some(shouldContinuePollingDriverLeadStatus) ? 15_000 : false;
    },
  });

  const dismissedLeadNotificationIdSet = useMemo(
    () => new Set(dismissedLeadNotificationIds),
    [dismissedLeadNotificationIds],
  );

  const notifications = useMemo(
    () =>
      buildDriverLeadNotifications(driverLeadStatusEntries).filter(
        (notification) => !dismissedLeadNotificationIdSet.has(notification.id),
      ),
    [dismissedLeadNotificationIdSet, driverLeadStatusEntries],
  );

  const handleDismissNotification = (notification: DriverLeadNotification) => {
    dismissDriverLeadNotification(notification.id);
    removeStoredLeadState(notification.loadId);
    setStoredLeadStates(readAllStoredLeadStates());
    setDismissedLeadNotificationIds(readDismissedDriverLeadNotificationIds());
  };

  return {
    notifications,
    notificationCount: notifications.length,
    handleDismissNotification,
  };
}
