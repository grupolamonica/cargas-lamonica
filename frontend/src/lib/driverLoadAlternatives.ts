import { endOfDay, startOfDay } from "date-fns";

import { parseDisplayDate } from "@/lib/dateDisplay";
import { fetchDriverLoads, type DriverLoadReadModelItem } from "@/services/readModels";

const DRIVER_LOAD_ALTERNATIVES_PAGE_SIZE = 5;
const DRIVER_LOAD_ALTERNATIVES_LIMIT = 3;

export type DriverLoadAlternativeScope = "same-origin-eta" | "same-origin" | "none";

export interface DriverLoadAlternativesResult {
  items: DriverLoadReadModelItem[];
  scope: DriverLoadAlternativeScope;
}

export function buildDriverAlternativeDateRange(value?: string | null) {
  const parsedDate = parseDisplayDate(value);

  if (!parsedDate) {
    return null;
  }

  return {
    dateFrom: startOfDay(parsedDate).toISOString(),
    dateTo: endOfDay(parsedDate).toISOString(),
  };
}

function trimAlternativeItems(items: DriverLoadReadModelItem[], currentLoadId: string) {
  return items.filter((item) => item.id !== currentLoadId).slice(0, DRIVER_LOAD_ALTERNATIVES_LIMIT);
}

export async function fetchDriverLoadAlternatives({
  loadId,
  origem,
  data,
}: {
  loadId: string;
  origem?: string | null;
  data?: string | null;
}): Promise<DriverLoadAlternativesResult> {
  const normalizedOrigin = origem?.trim() || "";

  if (!normalizedOrigin) {
    return {
      items: [],
      scope: "none",
    };
  }

  const sharedParams = {
    origem: normalizedOrigin,
    page: "1",
    pageSize: String(DRIVER_LOAD_ALTERNATIVES_PAGE_SIZE),
  };

  const etaDateRange = buildDriverAlternativeDateRange(data);

  if (etaDateRange) {
    const etaResponse = await fetchDriverLoads({
      ...sharedParams,
      ...etaDateRange,
    });

    const etaItems = trimAlternativeItems(etaResponse.items, loadId);

    if (etaItems.length > 0) {
      return {
        items: etaItems,
        scope: "same-origin-eta",
      };
    }
  }

  const fallbackResponse = await fetchDriverLoads(sharedParams);

  return {
    items: trimAlternativeItems(fallbackResponse.items, loadId),
    scope: "same-origin",
  };
}
