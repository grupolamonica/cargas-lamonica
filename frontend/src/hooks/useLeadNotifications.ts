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
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) => {
      const currentEntries = query.state.data as DriverLeadNotificationStatusEntry[] | undefined;
      if (!hasQueuedTrackedLeadStates) return false;
      if (!currentEntries?.length) return 30_000;
      return currentEntries.some(shouldContinuePollingDriverLeadStatus) ? 30_000 : false;
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
