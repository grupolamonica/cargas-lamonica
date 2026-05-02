import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { addDays, format, isSameDay, parseISO, startOfToday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import { fetchDriverLoadFacets, fetchDriverLoads } from "@/services/readModels";

export const PAGE_SIZE = 12;

export interface Cargo {
  id: string;
  data: string;
  horario: string;
  origem: string;
  destino: string;
  distancia_km?: number | null;
  duracao_horas?: number | null;
  tempo_estimado_horas?: number | null;
  perfil: string;
  valor: number | null;
  bonus: number | null;
  clienteId?: string | null;
  clienteNome?: string | null;
  clienteDescricao?: string | null;
  carregamentoLabel?: string | null;
  descargaLabel?: string | null;
  routeLabel?: string | null;
}

export interface FilterOption {
  label: string;
  value: string;
}

export const normalizeText = (value: string) =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

export const normalizeDisplayCity = (city: string): string =>
  city.normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

export const splitLocation = (location: string) => {
  const trimmedLocation = location.trim();
  const matchedLocation = trimmedLocation.match(/^(.*?)(?:\s*\/\s*|\s*,\s*|\s+-\s+)([A-Za-z]{2})$/);
  if (matchedLocation) {
    return { city: matchedLocation[1].trim(), uf: matchedLocation[2].toUpperCase() };
  }
  return { city: trimmedLocation, uf: "" };
};

export const toDateInputValue = (date?: Date) => (date ? format(date, "yyyy-MM-dd") : "");

export const toFilterDateLabel = (date?: Date) => (date ? format(date, "dd/MM", { locale: ptBR }) : "");

export const toMobileDateLabel = (date?: Date) =>
  date ? format(date, "dd/MM/yyyy", { locale: ptBR }) : "Selecionar";

export const buildPeriodLabel = (dateFrom?: Date, dateTo?: Date) => {
  if (dateFrom && dateTo) return `${toFilterDateLabel(dateFrom)} - ${toFilterDateLabel(dateTo)}`;
  if (dateFrom) return `A partir de ${toFilterDateLabel(dateFrom)}`;
  if (dateTo) return `Até ${toFilterDateLabel(dateTo)}`;
  return "Qualquer data";
};

export const toTitleCase = (str: string) =>
  str.toLowerCase().replace(/(?:^|[\s-])(\S)/g, (m) => m.toUpperCase());

/** Maps ASCII canonical city names (as stored in routeLabel) to their accented display forms. */
const CITY_ACCENT_MAP: Record<string, string> = {
  "CAMACARI": "Camaçari",
  "JABOATAO DOS GUARARAPES": "Jaboatão dos Guararapes",
  "JAGUARIUNA": "Jaguariúna",
  "MACAE": "Macaé",
  "MACEIO": "Maceió",
  "SANTANA DE PARNAIBA": "Santana de Parnaíba",
  "SAO JOAO DE MERITI": "São João de Meriti",
  "SAO JOAO DO MERITI": "São João do Meriti",
  "SAO JOSE DO RIO PRETO": "São José do Rio Preto",
  "SAO PAULO": "São Paulo",
  "SIMOES FILHO": "Simões Filho",
};

/** Returns accented city name from routeLabel canonical form, falls back to toTitleCase. */
export const toDisplayCityName = (name: string): string =>
  CITY_ACCENT_MAP[name.trim().toUpperCase()] ?? toTitleCase(name);

export const formatLocationLabel = (location: string) => {
  const { city, uf } = splitLocation(location);
  const displayCity = toTitleCase(city);
  return uf ? `${displayCity}/${uf}` : displayCity;
};

export const buildCompactLocationLabel = (location?: string) => {
  if (!location) return "";
  const { city, uf } = splitLocation(location);
  return uf || toTitleCase(city);
};

export const buildLocationOptions = (locations: string[]) => {
  const optionsMap = new Map<string, FilterOption>();
  // Process entries with UF first so "City/SP" takes precedence over bare "City"
  const sorted = [...locations].sort((a, b) => {
    const aUF = splitLocation(a).uf;
    const bUF = splitLocation(b).uf;
    if (aUF && !bUF) return -1;
    if (!aUF && bUF) return 1;
    return 0;
  });
  sorted.forEach((location) => {
    const { city, uf } = splitLocation(location);
    const displayCity = toTitleCase(city);
    const label = uf ? `${displayCity}/${uf}` : displayCity;
    // Deduplicate by city name only — so "City/SP" and "City" collapse to one entry
    const key = normalizeText(city);
    if (label && !optionsMap.has(key)) {
      optionsMap.set(key, { value: label, label });
    }
  });
  return Array.from(optionsMap.values()).sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
};

export const getFilterLabel = (value: string, options: FilterOption[], fallback: string) => {
  if (!value) return fallback;
  return options.find((option) => option.value === value)?.label || value;
};

export const buildAvailableLoadsLabel = (count: number) =>
  count === 1 ? "1 carga disponível" : `${count} cargas disponíveis`;

export function useDriverLoads() {
  const [searchParams] = useSearchParams();
  const [origemFilter, setOrigemFilter] = useState(searchParams.get("origem") || "");
  const [destinoFilter, setDestinoFilter] = useState(searchParams.get("destino") || "");
  const [perfilFilter, setPerfilFilter] = useState(searchParams.get("perfil") || "");
  const [page, setPage] = useState(1);
  const [dateFrom, setDateFrom] = useState<Date | undefined>();
  const [dateTo, setDateTo] = useState<Date | undefined>();
  const [mobileOrigemDraft, setMobileOrigemDraft] = useState(searchParams.get("origem") || "");
  const [mobileDestinoDraft, setMobileDestinoDraft] = useState(searchParams.get("destino") || "");
  const [mobilePerfilDraft, setMobilePerfilDraft] = useState(searchParams.get("perfil") || "");
  const [mobileDateFromDraft, setMobileDateFromDraft] = useState<Date | undefined>();
  const [mobileDateToDraft, setMobileDateToDraft] = useState<Date | undefined>();

  useEffect(() => {
    setPage(1);
  }, [origemFilter, destinoFilter, perfilFilter, dateFrom, dateTo]);

  const deferredOrigemFilter = useDeferredValue(origemFilter);
  const deferredDestinoFilter = useDeferredValue(destinoFilter);
  const deferredPerfilFilter = useDeferredValue(perfilFilter);

  useEffect(() => {
    try {
      const STORAGE_KEY = "lamonica-driver-portal-visit-recorded";
      if (typeof window !== "undefined" && !sessionStorage.getItem(STORAGE_KEY)) {
        sessionStorage.setItem(STORAGE_KEY, "1");

        const postVisit = (body?: { lat: number; lon: number }) => {
          const init: RequestInit = body
            ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
            : { method: "POST" };
          void fetch("/api/driver/portal-view", init).catch(() => {});
        };

        // Try to include geolocation (non-blocking, no UI impact).
        // If denied or unavailable, still records the visit without location.
        if (typeof navigator !== "undefined" && "geolocation" in navigator) {
          navigator.geolocation.getCurrentPosition(
            ({ coords }) => postVisit({ lat: coords.latitude, lon: coords.longitude }),
            () => postVisit(),
            { timeout: 5000, maximumAge: 10 * 60_000 },
          );
        } else {
          postVisit();
        }
      }
    } catch {
      // sessionStorage unavailable (private mode): ignore
    }
  }, []);

  const {
    data: loadsResponse,
    error: loadsError,
    isFetching,
    isLoading,
  } = useQuery({
    queryKey: [
      "driver",
      "loads-read-model",
      deferredOrigemFilter,
      deferredDestinoFilter,
      deferredPerfilFilter,
      toDateInputValue(dateFrom),
      toDateInputValue(dateTo),
      page,
    ],
    queryFn: () =>
      fetchDriverLoads({
        origem: deferredOrigemFilter,
        destino: deferredDestinoFilter,
        perfil: deferredPerfilFilter,
        dateFrom: toDateInputValue(dateFrom),
        dateTo: toDateInputValue(dateTo),
        page: String(page),
        pageSize: String(PAGE_SIZE),
      }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: 45_000,
  });

  const { data: facetsResponse, error: facetsError } = useQuery({
    queryKey: ["driver", "loads-facets"],
    queryFn: fetchDriverLoadFacets,
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  useEffect(() => {
    if (loadsError) toast.error("Erro ao carregar cargas ativas");
  }, [loadsError]);

  useEffect(() => {
    if (facetsError) toast.error("Erro ao carregar filtros do portal");
  }, [facetsError]);

  const cargas = useMemo<Cargo[]>(() => loadsResponse?.items || [], [loadsResponse?.items]);
  const totalMatchingLoads = loadsResponse?.summary.totalCount || 0;
  const uniqueStates = loadsResponse?.summary.uniqueStateCount || 0;
  const uniqueProfilesCount = loadsResponse?.summary.uniqueProfileCount || 0;
  const loading = isLoading && !cargas.length;
  const meta = loadsResponse?.meta || {
    page,
    pageSize: PAGE_SIZE,
    totalCount: 0,
    totalPages: 1,
    hasNextPage: false,
    maxPageSize: PAGE_SIZE,
    correlationId: "",
  };
  const totalPages = Math.max(meta.totalPages, 1);
  const isPageTransitioning = isFetching && page !== meta.page;

  const origemOptions = useMemo(
    () => buildLocationOptions(facetsResponse?.origemOptions || []),
    [facetsResponse?.origemOptions],
  );
  const destinoOptions = useMemo(
    () => buildLocationOptions(facetsResponse?.destinoOptions || []),
    [facetsResponse?.destinoOptions],
  );
  const perfis = useMemo(
    () => [...(facetsResponse?.perfilOptions || [])].sort((a, b) => a.localeCompare(b, "pt-BR")),
    [facetsResponse?.perfilOptions],
  );

  const activeFilterCount = useMemo(
    () =>
      (origemFilter ? 1 : 0) +
      (destinoFilter ? 1 : 0) +
      (perfilFilter ? 1 : 0) +
      (dateFrom || dateTo ? 1 : 0),
    [origemFilter, destinoFilter, perfilFilter, dateFrom, dateTo],
  );
  const hasActiveFilters = activeFilterCount > 0;

  const activeFilterSummaryItems = useMemo(
    () =>
      [
        origemFilter ? `Origem: ${getFilterLabel(origemFilter, origemOptions, "Todas")}` : "",
        destinoFilter ? `Destino: ${getFilterLabel(destinoFilter, destinoOptions, "Todos")}` : "",
        perfilFilter ? `Veículo: ${perfilFilter}` : "",
        dateFrom || dateTo ? `Período: ${buildPeriodLabel(dateFrom, dateTo)}` : "",
      ].filter(Boolean),
    [origemFilter, destinoFilter, perfilFilter, dateFrom, dateTo, origemOptions, destinoOptions],
  );

  const mobileFilterSummary = useMemo(
    () => (activeFilterSummaryItems.length > 0 ? activeFilterSummaryItems.join(" | ") : "Todas as cargas ativas"),
    [activeFilterSummaryItems],
  );

  const mobileFilterGuide = useMemo(() => {
    if (!totalMatchingLoads) {
      if (hasActiveFilters) {
        return {
          eyebrow: "Busca atual",
          title: "Nenhuma carga apareceu com esse recorte.",
          description: "Tire um filtro ou toque em limpar para abrir mais opções de saída.",
        };
      }
      return {
        eyebrow: "Radar do momento",
        title: "Nenhuma carga aberta agora.",
        description: "As próximas oportunidades entram aqui automaticamente. Vale conferir de novo em instantes.",
      };
    }
    if (!hasActiveFilters) {
      return {
        eyebrow: "Radar do momento",
        title: `${buildAvailableLoadsLabel(totalMatchingLoads)} para você acompanhar agora.`,
        description: "Toque em Filtros para focar a próxima saída por origem, destino, veículo ou período.",
      };
    }
    return {
      eyebrow: "Busca atual",
      title:
        totalMatchingLoads === 1
          ? "1 carga combina com o filtro que você escolheu."
          : `${totalMatchingLoads} cargas combinam com o filtro que você escolheu.`,
      description: mobileFilterSummary,
    };
  }, [hasActiveFilters, mobileFilterSummary, totalMatchingLoads]);

  const desktopStickyRoute = useMemo(() => {
    const originLabel = origemFilter
      ? getFilterLabel(origemFilter, origemOptions, "Todas as origens")
      : "Todas as origens";
    const destinationLabel = destinoFilter
      ? getFilterLabel(destinoFilter, destinoOptions, "Todos os destinos")
      : "Todos os destinos";
    return {
      originLabel: buildCompactLocationLabel(originLabel) || "Todas",
      destinationLabel: buildCompactLocationLabel(destinationLabel) || "Todos",
    };
  }, [origemFilter, destinoFilter, origemOptions, destinoOptions]);

  const today = startOfToday();
  const tomorrow = addDays(today, 1);

  const isTodayQuickFilter = useMemo(
    () => Boolean(dateFrom && dateTo && isSameDay(dateFrom, today) && isSameDay(dateTo, today)),
    [dateFrom, dateTo, today],
  );
  const isTomorrowQuickFilter = useMemo(
    () => Boolean(dateFrom && dateTo && isSameDay(dateFrom, tomorrow) && isSameDay(dateTo, tomorrow)),
    [dateFrom, dateTo, tomorrow],
  );

  const syncMobileDraftsWithApplied = () => {
    setMobileOrigemDraft(origemFilter);
    setMobileDestinoDraft(destinoFilter);
    setMobilePerfilDraft(perfilFilter);
    setMobileDateFromDraft(dateFrom);
    setMobileDateToDraft(dateTo);
  };

  const clearAllFilters = () => {
    setOrigemFilter("");
    setDestinoFilter("");
    setPerfilFilter("");
    setDateFrom(undefined);
    setDateTo(undefined);
    setMobileOrigemDraft("");
    setMobileDestinoDraft("");
    setMobilePerfilDraft("");
    setMobileDateFromDraft(undefined);
    setMobileDateToDraft(undefined);
  };

  const clearMobileDraftFilters = () => {
    setMobileOrigemDraft("");
    setMobileDestinoDraft("");
    setMobilePerfilDraft("");
    setMobileDateFromDraft(undefined);
    setMobileDateToDraft(undefined);
  };

  const handlePageChange = (nextPage: number, resultsSectionRef?: React.RefObject<HTMLDivElement | null>) => {
    if (nextPage === page || nextPage < 1 || nextPage > totalPages) return;
    setPage(nextPage);
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      window.requestAnimationFrame(() => {
        resultsSectionRef?.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      });
    }
  };

  const applyMobileFilters = () => {
    setOrigemFilter(mobileOrigemDraft);
    setDestinoFilter(mobileDestinoDraft);
    setPerfilFilter(mobilePerfilDraft);
    setDateFrom(mobileDateFromDraft);
    setDateTo(mobileDateToDraft);
  };

  const handleTodayQuickFilter = () => {
    setDateFrom(today);
    setDateTo(today);
    setMobileDateFromDraft(today);
    setMobileDateToDraft(today);
  };

  const handleTomorrowQuickFilter = () => {
    setDateFrom(tomorrow);
    setDateTo(tomorrow);
    setMobileDateFromDraft(tomorrow);
    setMobileDateToDraft(tomorrow);
  };

  return {
    // Filter state
    origemFilter, setOrigemFilter,
    destinoFilter, setDestinoFilter,
    perfilFilter, setPerfilFilter,
    page, setPage,
    dateFrom, setDateFrom,
    dateTo, setDateTo,
    // Mobile draft state
    mobileOrigemDraft, setMobileOrigemDraft,
    mobileDestinoDraft, setMobileDestinoDraft,
    mobilePerfilDraft, setMobilePerfilDraft,
    mobileDateFromDraft, setMobileDateFromDraft,
    mobileDateToDraft, setMobileDateToDraft,
    // Query results
    cargas,
    isFetching,
    isLoading,
    meta,
    // Derived counts / summaries
    totalMatchingLoads,
    uniqueStates,
    uniqueProfilesCount,
    loading,
    totalPages,
    isPageTransitioning,
    // Facet options
    origemOptions,
    destinoOptions,
    perfis,
    // Filter derived state
    activeFilterCount,
    hasActiveFilters,
    activeFilterSummaryItems,
    mobileFilterSummary,
    mobileFilterGuide,
    desktopStickyRoute,
    isTodayQuickFilter,
    isTomorrowQuickFilter,
    // Actions
    clearAllFilters,
    clearMobileDraftFilters,
    syncMobileDraftsWithApplied,
    applyMobileFilters,
    handlePageChange,
    handleTodayQuickFilter,
    handleTomorrowQuickFilter,
  };
}
