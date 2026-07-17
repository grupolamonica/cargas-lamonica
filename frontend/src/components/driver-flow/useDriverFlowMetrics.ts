import { useState } from "react";
import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";

import { fetchDriverFlowMetrics, type DriverFlowMetricsResponse } from "@/services/readModels";

// DC-241 — Estado do período + query de driver-flow-metrics, extraídos para um
// hook próprio para poderem ser compartilhados entre as abas do Painel (o mesmo
// período governa "Visão geral" e "Insights"). Mantido fora do arquivo de
// componentes para não quebrar o Fast Refresh (react-refresh/only-export-components).

export function todayIso() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function daysAgoIso(days: number) {
  const now = new Date();
  now.setDate(now.getDate() - days);
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export interface DriverFlowController {
  dateFrom: string;
  dateTo: string;
  setDateFrom: (value: string) => void;
  setDateTo: (value: string) => void;
  quickRange: (days: number) => void;
  clear: () => void;
  query: UseQueryResult<DriverFlowMetricsResponse>;
}

export function useDriverFlowMetrics(): DriverFlowController {
  const [dateFrom, setDateFrom] = useState<string>(daysAgoIso(7));
  const [dateTo, setDateTo] = useState<string>(todayIso());

  const query = useQuery({
    queryKey: ["operator", "driver-flow-metrics", dateFrom, dateTo],
    queryFn: () => fetchDriverFlowMetrics({ dateFrom, dateTo }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const quickRange = (days: number) => {
    setDateFrom(daysAgoIso(days - 1));
    setDateTo(todayIso());
  };

  const clear = () => {
    // Esvazia inputs; backend default de 7 dias assume quando string vazia.
    setDateFrom("");
    setDateTo("");
  };

  return { dateFrom, dateTo, setDateFrom, setDateTo, quickRange, clear, query };
}
