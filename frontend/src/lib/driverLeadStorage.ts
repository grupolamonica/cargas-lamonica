import type { PublicLoadLeadPayload } from "@/services/loadClaims";

const DRIVER_LEAD_STORAGE_PREFIX = "lamonica-public-load-lead";
export const DRIVER_LEAD_STORAGE_EVENT = "lamonica-driver-lead-storage-changed";
const DRIVER_LEAD_NOTIFICATION_DISMISSALS_KEY = "lamonica-driver-lead-notification-dismissals";

export interface StoredLeadState {
  loadId: string;
  leadId: string;
  stage: "PRE_REGISTERED" | "QUEUED";
  form: PublicLoadLeadPayload;
  whatsappUrl: string | null;
  updatedAt: string;
}

function emitDriverLeadStorageChange() {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent(DRIVER_LEAD_STORAGE_EVENT));
}

function getDriverLeadStorageKey(loadId: string) {
  return `${DRIVER_LEAD_STORAGE_PREFIX}:${loadId}`;
}

export function readStoredLeadState(loadId: string): StoredLeadState | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(getDriverLeadStorageKey(loadId));
    if (!rawValue) {
      return null;
    }

    const parsedValue = JSON.parse(rawValue) as StoredLeadState;
    return parsedValue.loadId === loadId ? parsedValue : null;
  } catch {
    return null;
  }
}

export function readAllStoredLeadStates() {
  if (typeof window === "undefined") {
    return [] as StoredLeadState[];
  }

  return Object.keys(window.localStorage)
    .filter((key) => key.startsWith(`${DRIVER_LEAD_STORAGE_PREFIX}:`))
    .map((key) => {
      try {
        return JSON.parse(window.localStorage.getItem(key) || "null") as StoredLeadState | null;
      } catch {
        return null;
      }
    })
    .filter((state): state is StoredLeadState => Boolean(state?.loadId && state?.leadId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function persistStoredLeadState(state: StoredLeadState) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(getDriverLeadStorageKey(state.loadId), JSON.stringify(state));
  emitDriverLeadStorageChange();
}

export function removeStoredLeadState(loadId: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(getDriverLeadStorageKey(loadId));
  emitDriverLeadStorageChange();
}

export function readDismissedDriverLeadNotificationIds() {
  if (typeof window === "undefined") {
    return [] as string[];
  }

  try {
    const rawValue = window.localStorage.getItem(DRIVER_LEAD_NOTIFICATION_DISMISSALS_KEY);
    if (!rawValue) {
      return [] as string[];
    }

    const parsedValue = JSON.parse(rawValue) as unknown;
    return Array.isArray(parsedValue) ? parsedValue.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [] as string[];
  }
}

export function dismissDriverLeadNotification(notificationId: string) {
  if (typeof window === "undefined") {
    return;
  }

  const dismissedIds = new Set(readDismissedDriverLeadNotificationIds());
  dismissedIds.add(notificationId);
  window.localStorage.setItem(
    DRIVER_LEAD_NOTIFICATION_DISMISSALS_KEY,
    JSON.stringify(Array.from(dismissedIds.values())),
  );
  emitDriverLeadStorageChange();
}
