import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { addDays, format, isSameDay, parseISO, startOfToday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import { fetchDriverLoadFacets, fetchDriverLoads, fetchDriverLoadsDigest } from "@/services/readModels";
import type { PacoteMeta } from "@/services/readModels";
import { formatVehicleProfileLabel, normalizeVehicleProfile } from "@/lib/vehicleProfiles";

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
  eixos?: number | null;
  valor: number | null;
  bonus: number | null;
  clienteId?: string | null;
  clienteNome?: string | null;
  clienteDescricao?: string | null;
  clienteLogoUrl?: string | null;
  clienteLogoUrlCard?: string | null;
  clienteLogoUrlProximas?: string | null;
  carregamentoLabel?: string | null;
  descargaLabel?: string | null;
  routeLabel?: string | null;
  /** Pacote (cargas casadas) ao qual esta carga pertence — null quando avulsa. Plan 10-05. */
  viagem_id?: string | null;
  /** Posição (1..N) dentro do pacote — null quando avulsa. */
  ordem_viagem?: number | null;
  /** Resumo inline do pacote para renderização no LoadCard — null quando avulsa. */
  pacote_meta?: PacoteMeta | null;
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
  "CAMPO GRANDE": "Campo Grande",
  "FEIRA DE SANTANA": "Feira de Santana",
  "FRANCO DA ROCHA": "Franco da Rocha",
  "GUARULHOS": "Guarulhos",
  "JABOATAO DOS GUARARAPES": "Jaboatão dos Guararapes",
  "JAGUARIUNA": "Jaguariúna",
  "MACAE": "Macaé",
  "MACEIO": "Maceió",
  "PEDREIRA": "Pedreira",
  "RECIFE": "Recife",
  "SALVADOR": "Salvador",
  "SANTANA DE PARNAIBA": "Santana de Parnaíba",
  "SAO JOAO DE MERITI": "São João de Meriti",
  "SAO JOAO DO MERITI": "São João do Meriti",
  "SAO JOSE DO RIO PRETO": "São José do Rio Preto",
  "SAO PAULO": "São Paulo",
  "SIMOES FILHO": "Simões Filho",
  "SJ RIO PRETO": "SJ Rio Preto",
};

/** Returns accented city name from routeLabel canonical form, falls back to toTitleCase. */
export const toDisplayCityName = (name: string): string =>
  CITY_ACCENT_MAP[name.trim().toUpperCase()] ?? toTitleCase(name);

/**
 * Formats a raw city string (from cargo.origem/destino or routeLabel) for display.
 * Strips trailing numeric suffixes (e.g. "SJ Rio Preto-02" → "SJ Rio Preto"),
 * normalises diacritics for the accent-map lookup, and falls back to toTitleCase.
 */
export const formatCityDisplay = (raw: string): string => {
  const stripped = raw.replace(/[-\s]+\d+\s*$/, "").trim();
  const key = normalizeText(stripped).toUpperCase();
  return CITY_ACCENT_MAP[key] ?? toTitleCase(stripped);
};

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
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  // DC-270: filtros multiselect (arrays). Deep-link via params repetidos
  // (?origem=a&origem=b). Data/período seguem single. Cliente é novo.
  const [origemFilter, setOrigemFilter] = useState<string[]>(() => searchParams.getAll("origem"));
  const [destinoFilter, setDestinoFilter] = useState<string[]>(() => searchParams.getAll("destino"));
  const [perfilFilter, setPerfilFilter] = useState<string[]>(() => searchParams.getAll("perfil"));
  const [clienteFilter, setClienteFilter] = useState<string[]>(() => searchParams.getAll("clienteId"));
  const [page, setPage] = useState(1);
  const [dateFrom, setDateFrom] = useState<Date | undefined>();
  const [dateTo, setDateTo] = useState<Date | undefined>();
  const [mobileOrigemDraft, setMobileOrigemDraft] = useState<string[]>(() => searchParams.getAll("origem"));
  const [mobileDestinoDraft, setMobileDestinoDraft] = useState<string[]>(() => searchParams.getAll("destino"));
  const [mobilePerfilDraft, setMobilePerfilDraft] = useState<string[]>(() => searchParams.getAll("perfil"));
  const [mobileClienteDraft, setMobileClienteDraft] = useState<string[]>(() => searchParams.getAll("clienteId"));
  const [mobileDateFromDraft, setMobileDateFromDraft] = useState<Date | undefined>();
  const [mobileDateToDraft, setMobileDateToDraft] = useState<Date | undefined>();

  // Chaves estáveis (ordem-insensível) p/ deps de effect e queryKey — o array em
  // si muda de referência a cada seleção, mas a chave só muda quando o conteúdo muda.
  const origemKey = [...origemFilter].sort().join("|");
  const destinoKey = [...destinoFilter].sort().join("|");
  const perfilKey = [...perfilFilter].sort().join("|");
  const clienteKey = [...clienteFilter].sort().join("|");

  useEffect(() => {
    setPage(1);
  }, [origemKey, destinoKey, perfilKey, clienteKey, dateFrom, dateTo]);

  const deferredOrigemFilter = useDeferredValue(origemFilter);
  const deferredDestinoFilter = useDeferredValue(destinoFilter);
  const deferredPerfilFilter = useDeferredValue(perfilFilter);
  const deferredClienteFilter = useDeferredValue(clienteFilter);

  useEffect(() => {
    try {
      const STORAGE_KEY = "lamonica-driver-portal-visit-recorded";
      if (typeof window !== "undefined" && !sessionStorage.getItem(STORAGE_KEY)) {
        sessionStorage.setItem(STORAGE_KEY, "1");

        void fetch("/api/driver/portal-view", { method: "POST" }).catch(() => {});
      }
    } catch {
      // sessionStorage unavailable (private mode): ignore
    }
  }, []);

  // Polling foi substituido por: window focus + reconnect + digest poll de 5min.
  // O digest abaixo verifica MAX(updated_at)+count em cargas OPEN/PUBLIC; se mudou,
  // invalida o read-model. Quando a aba esta em background, o poll do digest
  // tambem pausa (refetchIntervalInBackground: false).
  const {
    data: loadsResponse,
    error: loadsError,
    isFetching,
    isLoading,
  } = useQuery({
    queryKey: [
      "driver",
      "loads-read-model",
      [...deferredOrigemFilter].sort().join("|"),
      [...deferredDestinoFilter].sort().join("|"),
      [...deferredPerfilFilter].sort().join("|"),
      [...deferredClienteFilter].sort().join("|"),
      toDateInputValue(dateFrom),
      toDateInputValue(dateTo),
      page,
    ],
    queryFn: () =>
      fetchDriverLoads({
        origem: deferredOrigemFilter,
        destino: deferredDestinoFilter,
        perfil: deferredPerfilFilter,
        clienteId: deferredClienteFilter,
        dateFrom: toDateInputValue(dateFrom),
        dateTo: toDateInputValue(dateTo),
        page: String(page),
        pageSize: String(PAGE_SIZE),
      }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const { data: facetsResponse, error: facetsError } = useQuery({
    queryKey: ["driver", "loads-facets"],
    queryFn: fetchDriverLoadFacets,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  // 5min digest poll — pausa em background. Invalida o read-model quando muda.
  const lastLoadsDigestRef = useRef<string | null>(null);
  const loadsDigestQuery = useQuery({
    queryKey: ["driver", "loads-digest"] as const,
    queryFn: fetchDriverLoadsDigest,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    const currentDigest = loadsDigestQuery.data?.digest;
    if (!currentDigest) return;
    if (lastLoadsDigestRef.current !== null && lastLoadsDigestRef.current !== currentDigest) {
      void queryClient.invalidateQueries({ queryKey: ["driver", "loads-read-model"] });
    }
    lastLoadsDigestRef.current = currentDigest;
  }, [loadsDigestQuery.data?.digest, queryClient]);

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
  // Normaliza facets via normalizeVehicleProfile para deduplicar variações
  // ("BITRUCK"/"BITREM", "CARRETA EXPRESSA"/"CARRETA_EXPRESSA"). Mantém o
  // valor canônico para envio ao backend e o label apresentado no UI.
  const perfis = useMemo<FilterOption[]>(() => {
    const seen = new Map<string, FilterOption>();
    (facetsResponse?.perfilOptions || []).forEach((raw) => {
      const canonical = normalizeVehicleProfile(raw);
      if (!seen.has(canonical)) {
        seen.set(canonical, { value: canonical, label: formatVehicleProfileLabel(canonical) });
      }
    });
    return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  }, [facetsResponse?.perfilOptions]);

  // DC-270: opções de cliente (embarcadores com carga aberta) do facet.
  const clienteOptions = useMemo<FilterOption[]>(
    () =>
      (facetsResponse?.clienteOptions || [])
        .map((c) => ({ value: c.id, label: c.nome }))
        .sort((a, b) => a.label.localeCompare(b.label, "pt-BR")),
    [facetsResponse?.clienteOptions],
  );

  // Resumo de uma seleção multiselect: vazio→""; 1→o rótulo; N→"N <noun>".
  const summarizeSelection = (values: string[], options: FilterOption[], noun: string) => {
    if (values.length === 0) return "";
    if (values.length === 1) return options.find((o) => o.value === values[0])?.label ?? values[0];
    return `${values.length} ${noun}`;
  };

  const activeFilterCount = useMemo(
    () =>
      (origemFilter.length ? 1 : 0) +
      (destinoFilter.length ? 1 : 0) +
      (perfilFilter.length ? 1 : 0) +
      (clienteFilter.length ? 1 : 0) +
      (dateFrom || dateTo ? 1 : 0),
    [origemFilter, destinoFilter, perfilFilter, clienteFilter, dateFrom, dateTo],
  );
  const hasActiveFilters = activeFilterCount > 0;

  const activeFilterSummaryItems = useMemo(
    () =>
      [
        origemFilter.length ? `Origem: ${summarizeSelection(origemFilter, origemOptions, "origens")}` : "",
        destinoFilter.length ? `Destino: ${summarizeSelection(destinoFilter, destinoOptions, "destinos")}` : "",
        perfilFilter.length ? `Veículo: ${summarizeSelection(perfilFilter, perfis, "veículos")}` : "",
        clienteFilter.length ? `Cliente: ${summarizeSelection(clienteFilter, clienteOptions, "clientes")}` : "",
        dateFrom || dateTo ? `Período: ${buildPeriodLabel(dateFrom, dateTo)}` : "",
      ].filter(Boolean),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [origemFilter, destinoFilter, perfilFilter, clienteFilter, dateFrom, dateTo, origemOptions, destinoOptions, perfis, clienteOptions],
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
    const originLabel = origemFilter.length
      ? summarizeSelection(origemFilter, origemOptions, "origens")
      : "Todas as origens";
    const destinationLabel = destinoFilter.length
      ? summarizeSelection(destinoFilter, destinoOptions, "destinos")
      : "Todos os destinos";
    return {
      originLabel: buildCompactLocationLabel(originLabel) || "Todas",
      destinationLabel: buildCompactLocationLabel(destinationLabel) || "Todos",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setMobileClienteDraft(clienteFilter);
    setMobileDateFromDraft(dateFrom);
    setMobileDateToDraft(dateTo);
  };

  const clearAllFilters = () => {
    setOrigemFilter([]);
    setDestinoFilter([]);
    setPerfilFilter([]);
    setClienteFilter([]);
    setDateFrom(undefined);
    setDateTo(undefined);
    setMobileOrigemDraft([]);
    setMobileDestinoDraft([]);
    setMobilePerfilDraft([]);
    setMobileClienteDraft([]);
    setMobileDateFromDraft(undefined);
    setMobileDateToDraft(undefined);
  };

  const clearMobileDraftFilters = () => {
    setMobileOrigemDraft([]);
    setMobileDestinoDraft([]);
    setMobilePerfilDraft([]);
    setMobileClienteDraft([]);
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
    setClienteFilter(mobileClienteDraft);
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
    clienteFilter, setClienteFilter,
    page, setPage,
    dateFrom, setDateFrom,
    dateTo, setDateTo,
    // Mobile draft state
    mobileOrigemDraft, setMobileOrigemDraft,
    mobileDestinoDraft, setMobileDestinoDraft,
    mobilePerfilDraft, setMobilePerfilDraft,
    mobileClienteDraft, setMobileClienteDraft,
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
    clienteOptions,
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
