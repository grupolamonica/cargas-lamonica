import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  BellRing,
  CalendarIcon,
  ChevronDown,
  CheckCircle2,
  Compass,
  MapPin,
  Menu,
  Navigation,
  Package,
  PackageX,
  SlidersHorizontal,
  Truck,
  X,
} from "lucide-react";
import { addDays, format, isSameDay, isToday, parseISO, startOfToday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";

import FilterChip from "@/components/FilterChip";
import LoadCard from "@/components/LoadCard";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatShortDateTime } from "@/lib/dateDisplay";
import {
  buildDriverLeadNotifications,
  shouldContinuePollingDriverLeadStatus,
  type DriverLeadNotification,
  type DriverLeadNotificationStatusEntry,
} from "@/lib/driverLeadNotifications";
import { buildCargoPublicPath } from "@/lib/cargoLinks";
import {
  dismissDriverLeadNotification,
  DRIVER_LEAD_STORAGE_EVENT,
  readAllStoredLeadStates,
  readDismissedDriverLeadNotificationIds,
  removeStoredLeadState,
  type StoredLeadState,
} from "@/lib/driverLeadStorage";
import {
  buildLoadingDateTime,
  buildOperationalDateLabel,
  buildRouteEstimatedDurationLabel,
} from "@/lib/estimatedTime";
import { cn } from "@/lib/utils";
import { formatCurrency, buildTotalPayment } from "@/lib/currency";
import { fetchLoadClaimStatus } from "@/services/loadClaims";
import { fetchDriverLoadFacets, fetchDriverLoads } from "@/services/readModels";
import lamonicaLogo from "@/assets/lamonica-logo.png";

interface Cargo {
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
}

interface FilterOption {
  label: string;
  value: string;
}
const PAGE_SIZE = 12;
const DRIVER_SUPPORT_WHATSAPP_NUMBER = "557199050085";
const DRIVER_CADASTRO_MESSAGE =
  "Olá, quero fazer meu cadastro para receber cargas da Lamonica.";
const DRIVER_SAC_MESSAGE =
  "Olá, preciso de ajuda no portal do motorista da Lamonica.";
const DRIVER_FAQ_ITEMS = [
  {
    question: "Como eu participo de uma carga?",
    answer: "Abra a carga, toque em Candidatar-se e preencha seus dados do motorista e do veículo.",
  },
  {
    question: "Preciso falar no WhatsApp para entrar na fila?",
    answer: "Não. Sua candidatura já entra direto na fila operacional assim que você envia pelo sistema.",
  },
  {
    question: "Candidatar-se garante a carga?",
    answer: "Não. A equipe analisa perfil, disponibilidade e ordem da fila antes de liberar a carga.",
  },
  {
    question: "Onde acompanho minhas tentativas?",
    answer: "Na central de notificações você vê as cargas em que se candidatou e os retornos enviados pela equipe.",
  },
  {
    question: "Posso atualizar meus dados depois?",
    answer: "Sim. Se a candidatura ainda estiver em aberto, você pode reabrir a carga e atualizar as informações.",
  },
] as const;

const normalizeText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

const splitLocation = (location: string) => {
  const trimmedLocation = location.trim();
  const matchedLocation = trimmedLocation.match(/^(.*?)(?:\s*\/\s*|\s*,\s*|\s+-\s+)([A-Za-z]{2})$/);

  if (matchedLocation) {
    return {
      city: matchedLocation[1].trim(),
      uf: matchedLocation[2].toUpperCase(),
    };
  }

  return { city: trimmedLocation, uf: "" };
};

const buildPaymentDetailsLabel = (valor: number | null, bonus: number | null) => {
  const hasValor = typeof valor === "number" && Number.isFinite(valor);
  const hasBonus = typeof bonus === "number" && Number.isFinite(bonus) && bonus > 0;

  if (hasValor && hasBonus) {
    return `${formatCurrency(valor)} da carga + ${formatCurrency(bonus)} de bônus por concluir a entrega`;
  }

  if (hasBonus) {
    return `${formatCurrency(bonus)} de bônus por concluir a entrega`;
  }

  return null;
};

const buildDriverPaymentDetailsLabel = (valor: number | null, bonus: number | null) => {
  const hasValor = typeof valor === "number" && Number.isFinite(valor);
  const hasBonus = typeof bonus === "number" && Number.isFinite(bonus) && bonus > 0;

  if (hasValor && hasBonus) {
    return `${formatCurrency(valor)} da carga + ${formatCurrency(bonus)} de b\u00f4nus por concluir a entrega seguindo as normas pedidas`;
  }

  if (hasBonus) {
    return `${formatCurrency(bonus)} de b\u00f4nus por concluir a entrega seguindo as normas pedidas`;
  }

  return null;
};

const buildDateLabel = (cargo: Cargo) => {
  const loadingDate = buildLoadingDateTime(cargo.carregamentoLabel, cargo.data, cargo.horario);

  if (!loadingDate) {
    return "Coleta a confirmar";
  }

  const baseDate = isToday(loadingDate)
    ? "hoje"
    : format(loadingDate, "dd/MM", { locale: ptBR });

  return `Coleta ${baseDate} às ${format(loadingDate, "HH:mm")}`;
};

const toDateInputValue = (date?: Date) => (date ? format(date, "yyyy-MM-dd") : "");

const buildDriverSupportWhatsAppUrl = (message: string) =>
  `https://wa.me/${DRIVER_SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;

const toMobileDateLabel = (date?: Date) =>
  date ? format(date, "dd/MM/yyyy", { locale: ptBR }) : "Selecionar";

const toFilterDateLabel = (date?: Date) =>
  date ? format(date, "dd/MM", { locale: ptBR }) : "";

const buildPeriodLabel = (dateFrom?: Date, dateTo?: Date) => {
  if (dateFrom && dateTo) {
    return `${toFilterDateLabel(dateFrom)} - ${toFilterDateLabel(dateTo)}`;
  }

  if (dateFrom) {
    return `A partir de ${toFilterDateLabel(dateFrom)}`;
  }

  if (dateTo) {
    return `Até ${toFilterDateLabel(dateTo)}`;
  }

  return "Qualquer data";
};

const formatLocationLabel = (location: string) => {
  const { city, uf } = splitLocation(location);
  return uf ? `${city}/${uf}` : city;
};

const buildCompactLocationLabel = (location?: string) => {
  if (!location) {
    return "";
  }

  const { city, uf } = splitLocation(location);
  return uf || city;
};

const buildAvailableLoadsLabel = (count: number) => {
  if (count === 1) {
    return "1 carga disponível";
  }

  return `${count} cargas disponíveis`;
};

const formatRouteMetric = (value: number) =>
  value.toLocaleString("pt-BR", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });

const formatRouteDistanceLabel = (distanceKm: number) => `${formatRouteMetric(distanceKm)} km`;

interface NotificationTriggerButtonProps {
  count: number;
  onClick: () => void;
  className?: string;
  showLabel?: boolean;
  invertTone?: boolean;
}

const NotificationTriggerButton = ({
  count,
  onClick,
  className,
  showLabel = true,
  invertTone = false,
}: NotificationTriggerButtonProps) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={count > 0 ? `Abrir notificações (${count})` : "Abrir notificações"}
    className={cn(
      "relative inline-flex items-center justify-center rounded-full border transition-all duration-300",
      showLabel ? "gap-2 px-3 py-2" : "gap-1.5 px-2.5 py-2",
      invertTone
        ? "border-white/[0.24] bg-white/[0.16] text-white shadow-[0_18px_34px_-24px_rgba(3,14,42,0.72)] backdrop-blur-md hover:bg-white/[0.22]"
        : "border-border/60 bg-card/90 text-foreground shadow-[0_18px_34px_-24px_hsl(223_56%_12%/0.18)] hover:border-primary/20 hover:bg-card",
      className,
    )}
  >
    <BellRing className={cn(showLabel ? "h-4 w-4" : "h-[18px] w-[18px]", invertTone ? "text-white" : "text-primary")} />
    {showLabel ? <span className="text-sm font-semibold">Notificações</span> : null}
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full py-0.5 text-[11px] font-extrabold",
        showLabel ? "min-w-[22px] px-1.5" : "min-w-[24px] px-2",
        count > 0
          ? invertTone
            ? "bg-accent text-[hsl(222_50%_10%)]"
            : "bg-primary text-primary-foreground"
          : invertTone
            ? "bg-white/18 text-white/88"
            : "bg-muted text-muted-foreground",
      )}
    >
      {count}
    </span>
  </button>
);

const buildLocationOptions = (locations: string[]) => {
  const optionsMap = new Map<string, FilterOption>();

  locations.forEach((location) => {
    const label = formatLocationLabel(location);
    const key = normalizeText(label);

    if (label && !optionsMap.has(key)) {
      optionsMap.set(key, {
        value: label,
        label,
      });
    }
  });

  return Array.from(optionsMap.values()).sort((optionA, optionB) =>
    optionA.label.localeCompare(optionB.label, "pt-BR"),
  );
};

const getFilterLabel = (value: string, options: FilterOption[], fallback: string) => {
  if (!value) {
    return fallback;
  }

  return options.find((option) => option.value === value)?.label || value;
};

const matchesLocationFilter = (location: string, filter: string) => {
  if (!filter) {
    return true;
  }

  const normalizedFilter = normalizeText(filter);
  const { city, uf } = splitLocation(location);
  const formattedLocation = formatLocationLabel(location);

  return (
    normalizeText(location).includes(normalizedFilter) ||
    normalizeText(formattedLocation).includes(normalizedFilter) ||
    normalizeText(city).includes(normalizedFilter) ||
    normalizeText(uf) === normalizedFilter
  );
};

const DriverPortalPreview = () => {
  const [searchParams] = useSearchParams();
  const [origemFilter, setOrigemFilter] = useState(searchParams.get("origem") || "");
  const [destinoFilter, setDestinoFilter] = useState(searchParams.get("destino") || "");
  const [perfilFilter, setPerfilFilter] = useState(searchParams.get("perfil") || "");
  const [page, setPage] = useState(1);
  const [dateFrom, setDateFrom] = useState<Date | undefined>();
  const [dateTo, setDateTo] = useState<Date | undefined>();
  const [isMobileFilterDrawerOpen, setIsMobileFilterDrawerOpen] = useState(false);
  const [mobileOrigemDraft, setMobileOrigemDraft] = useState(searchParams.get("origem") || "");
  const [mobileDestinoDraft, setMobileDestinoDraft] = useState(searchParams.get("destino") || "");
  const [mobilePerfilDraft, setMobilePerfilDraft] = useState(searchParams.get("perfil") || "");
  const [mobileDateFromDraft, setMobileDateFromDraft] = useState<Date | undefined>();
  const [mobileDateToDraft, setMobileDateToDraft] = useState<Date | undefined>();
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isFaqOpen, setIsFaqOpen] = useState(false);
  const [isPreviewMenuOpen, setIsPreviewMenuOpen] = useState(false);
  const [isLoadInterestDialogOpen, setIsLoadInterestDialogOpen] = useState(false);
  const [showStickyBar, setShowStickyBar] = useState(false);
  const [storedLeadStates, setStoredLeadStates] = useState<StoredLeadState[]>(() => readAllStoredLeadStates());
  const [dismissedLeadNotificationIds, setDismissedLeadNotificationIds] = useState<string[]>(() =>
    readDismissedDriverLeadNotificationIds(),
  );
  const showStickyBarRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const desktopFiltersRef = useRef<HTMLDivElement | null>(null);
  const mobileFiltersRef = useRef<HTMLDivElement | null>(null);
  const resultsSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setPage(1);
  }, [origemFilter, destinoFilter, perfilFilter, dateFrom, dateTo]);

  const deferredOrigemFilter = useDeferredValue(origemFilter);
  const deferredDestinoFilter = useDeferredValue(destinoFilter);
  const deferredPerfilFilter = useDeferredValue(perfilFilter);
  const cadastroHref = buildDriverSupportWhatsAppUrl(DRIVER_CADASTRO_MESSAGE);
  const sacHref = buildDriverSupportWhatsAppUrl(DRIVER_SAC_MESSAGE);

  useEffect(() => {
    // Registra visita \u00fanica por sess\u00e3o para o "Pico de acesso" do painel do operador.
    try {
      const STORAGE_KEY = "lamonica-driver-portal-visit-recorded";
      if (typeof window !== "undefined" && !sessionStorage.getItem(STORAGE_KEY)) {
        sessionStorage.setItem(STORAGE_KEY, "1");
        void fetch("/api/driver/portal-view", { method: "POST" }).catch(() => {
          // fire-and-forget, silencioso
        });
      }
    } catch {
      // sessionStorage indispon\u00edvel (modo privado): ignora
    }
  }, []);
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

      if (!hasQueuedTrackedLeadStates) {
        return false;
      }

      if (!currentEntries?.length) {
        return 30_000;
      }

      return currentEntries.some(shouldContinuePollingDriverLeadStatus) ? 30_000 : false;
    },
  });

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

  const {
    data: facetsResponse,
    error: facetsError,
  } = useQuery({
    queryKey: ["driver", "loads-facets"],
    queryFn: fetchDriverLoadFacets,
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  useEffect(() => {
    if (loadsError) {
      toast.error("Erro ao carregar cargas ativas");
    }
  }, [loadsError]);

  useEffect(() => {
    if (facetsError) {
      toast.error("Erro ao carregar filtros do portal");
    }
  }, [facetsError]);

  useEffect(() => {
    const handleScroll = () => {
      if (scrollFrameRef.current !== null) {
        return;
      }

      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        const isDesktopViewport = window.innerWidth >= 1024;
        const hasBlockingOverlay =
          isMobileFilterDrawerOpen || isNotificationsOpen || isLoadInterestDialogOpen || isFaqOpen;
        let nextShowStickyBar = false;

        if (!hasBlockingOverlay) {
          if (isDesktopViewport) {
            nextShowStickyBar = window.scrollY > 280;
          } else {
            const mobileFiltersBottom =
              mobileFiltersRef.current?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY;
            const resultsTop =
              resultsSectionRef.current?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;

            nextShowStickyBar =
              window.scrollY > 360 &&
              mobileFiltersBottom < 12 &&
              resultsTop < window.innerHeight - 120;
          }
        }

        if (showStickyBarRef.current !== nextShowStickyBar) {
          showStickyBarRef.current = nextShowStickyBar;
          setShowStickyBar(nextShowStickyBar);
        }
      });
    };

    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, [isFaqOpen, isLoadInterestDialogOpen, isMobileFilterDrawerOpen, isNotificationsOpen]);
  const cargas = useMemo<Cargo[]>(() => loadsResponse?.items || [], [loadsResponse?.items]);
  const deferredFiltered = useDeferredValue(cargas);
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
  const dismissedLeadNotificationIdSet = useMemo(
    () => new Set(dismissedLeadNotificationIds),
    [dismissedLeadNotificationIds],
  );
  const driverLeadNotifications = useMemo(
    () =>
      buildDriverLeadNotifications(driverLeadStatusEntries).filter(
        (notification) => !dismissedLeadNotificationIdSet.has(notification.id),
      ),
    [dismissedLeadNotificationIdSet, driverLeadStatusEntries],
  );
  const notificationCount = driverLeadNotifications.length;

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

  const activeFilterCount = useMemo(() => {
    return (
      (origemFilter ? 1 : 0) +
      (destinoFilter ? 1 : 0) +
      (perfilFilter ? 1 : 0) +
      (dateFrom || dateTo ? 1 : 0)
    );
  }, [origemFilter, destinoFilter, perfilFilter, dateFrom, dateTo]);

  const hasActiveFilters = activeFilterCount > 0;

  const activeFilterSummaryItems = useMemo(() => {
    return [
      origemFilter ? `Origem: ${getFilterLabel(origemFilter, origemOptions, "Todas")}` : "",
      destinoFilter ? `Destino: ${getFilterLabel(destinoFilter, destinoOptions, "Todos")}` : "",
      perfilFilter ? `Veículo: ${perfilFilter}` : "",
      dateFrom || dateTo ? `Período: ${buildPeriodLabel(dateFrom, dateTo)}` : "",
    ].filter(Boolean);
  }, [origemFilter, destinoFilter, perfilFilter, dateFrom, dateTo, origemOptions, destinoOptions]);

  const mobileFilterSummary = useMemo(() => {
    return activeFilterSummaryItems.length > 0 ? activeFilterSummaryItems.join(" | ") : "Todas as cargas ativas";
  }, [activeFilterSummaryItems]);

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

  const isTodayQuickFilter = useMemo(() => {
    return Boolean(dateFrom && dateTo && isSameDay(dateFrom, today) && isSameDay(dateTo, today));
  }, [dateFrom, dateTo, today]);

  const isTomorrowQuickFilter = useMemo(() => {
    return Boolean(dateFrom && dateTo && isSameDay(dateFrom, tomorrow) && isSameDay(dateTo, tomorrow));
  }, [dateFrom, dateTo, tomorrow]);

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

  const handlePageChange = (nextPage: number) => {
    if (nextPage === page || nextPage < 1 || nextPage > totalPages) {
      return;
    }

    setPage(nextPage);

    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      window.requestAnimationFrame(() => {
        resultsSectionRef.current?.scrollIntoView?.({
          behavior: "smooth",
          block: "start",
        });
      });
    }
  };

  const applyMobileFilters = () => {
    setOrigemFilter(mobileOrigemDraft);
    setDestinoFilter(mobileDestinoDraft);
    setPerfilFilter(mobilePerfilDraft);
    setDateFrom(mobileDateFromDraft);
    setDateTo(mobileDateToDraft);
    setIsMobileFilterDrawerOpen(false);
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

  const handleDesktopStickyBarClick = () => {
    desktopFiltersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleDismissLeadNotification = (notification: DriverLeadNotification) => {
    dismissDriverLeadNotification(notification.id);
    removeStoredLeadState(notification.loadId);
    setStoredLeadStates(readAllStoredLeadStates());
    setDismissedLeadNotificationIds(readDismissedDriverLeadNotificationIds());
  };

  const cargoCards = useMemo(() => {
    return deferredFiltered.map((cargo, index) => {
      const origin = splitLocation(cargo.origem);
      const destination = splitLocation(cargo.destino);
      const loadingScheduleLabel = buildOperationalDateLabel(
        cargo.carregamentoLabel,
        cargo.data,
        cargo.horario,
      );
      const totalPaymentValue = buildTotalPayment(cargo.valor, cargo.bonus);
      const paymentLabel = totalPaymentValue !== null ? formatCurrency(totalPaymentValue) : "A combinar";
      const paymentDetailsLabel = buildDriverPaymentDetailsLabel(cargo.valor, cargo.bonus);
      const routeDistanceLabel =
        typeof cargo.distancia_km === "number" && Number.isFinite(cargo.distancia_km)
          ? formatRouteDistanceLabel(cargo.distancia_km)
          : "A confirmar";
      const routeDurationLabel = buildRouteEstimatedDurationLabel({
        routeEstimatedHours: cargo.tempo_estimado_horas,
        fallbackDurationHours: cargo.duracao_horas,
      });
      return (
        <LoadCard
          key={cargo.id}
          id={cargo.id.slice(0, 8).toUpperCase()}
          loadId={cargo.id}
          dateTime={buildDateLabel(cargo)}
          clienteId={cargo.clienteId}
          clienteNome={cargo.clienteNome}
          clienteDescricao={cargo.clienteDescricao}
          carregamentoLabel={loadingScheduleLabel}
          descargaLabel={cargo.descargaLabel}
          origemCidade={origin.city}
          origemEstado={origin.uf}
          destinoCidade={destination.city}
          destinoEstado={destination.uf}
          tipoVeiculo={cargo.perfil}
          secondaryLabel="Percurso recomendado"
          SecondaryIcon={Navigation}
          secondaryValue={routeDistanceLabel}
          secondarySupportText={routeDurationLabel}
          pagamento={paymentLabel}
          paymentDetails={paymentDetailsLabel}
          routeDistanceLabel={routeDistanceLabel}
          routeDurationLabel={routeDurationLabel}
          detailsHref={`/motorista/cargas/${cargo.id}`}
          index={index}
          onInterestDialogOpenChange={setIsLoadInterestDialogOpen}
        />
      );
    });
  }, [deferredFiltered]);

  const paginationControls =
    totalMatchingLoads > 0 ? (
      <div className="mt-5 flex flex-col gap-3 rounded-[28px] border border-border/60 bg-card/90 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-foreground">
            Exibindo {(page - 1) * meta.pageSize + 1} a {Math.min(page * meta.pageSize, totalMatchingLoads)} de {totalMatchingLoads} carga{totalMatchingLoads === 1 ? "" : "s"}
          </p>
          <p className="hidden text-xs text-muted-foreground">
            Página {meta.page} de {Math.max(meta.totalPages, 1)}
          </p>
          <p className="text-xs text-muted-foreground">
            {isPageTransitioning ? `Carregando página ${page}...` : `Página ${page} de ${totalPages}`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="rounded-full"
            onClick={() => handlePageChange(page - 1)}
            disabled={page <= 1 || isFetching}
          >
            Anterior
          </Button>
          <Button
            type="button"
            className="rounded-full"
            onClick={() => handlePageChange(page + 1)}
            disabled={page >= totalPages || isFetching}
          >
            Próxima
          </Button>
        </div>
      </div>
    ) : null;

  const resultsContent = loading ? (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-4 rounded-3xl border border-border/50 bg-card px-6 py-12 text-center premium-shadow">
      <div className="h-10 w-10 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
      <p className="text-sm font-medium text-muted-foreground">Carregando cargas...</p>
    </div>
  ) : deferredFiltered.length === 0 ? (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-4 rounded-3xl border border-border/50 bg-card px-6 py-12 text-center premium-shadow animate-slide-up">
      <PackageX className="h-14 w-14 text-muted-foreground/35" />
      <div>
        <p className="text-lg font-bold text-foreground">Nenhuma carga encontrada</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Não encontrou uma carga? Toque em limpar filtros para ver tudo de novo ou confira se ela ainda está disponível.
        </p>
      </div>
      {hasActiveFilters ? (
        <Button
          type="button"
          variant="outline"
          onClick={clearAllFilters}
          className="rounded-2xl px-5 font-semibold"
        >
          Limpar filtros
        </Button>
      ) : (
        <p className="text-sm font-medium text-muted-foreground">
          As cargas são atualizadas periodicamente sem precisar carregar a lista inteira no navegador.
        </p>
      )}
    </div>
  ) : (
    <div className="space-y-5 xl:grid xl:grid-cols-2 xl:gap-4 xl:space-y-0">
      {cargoCards}
    </div>
  );

  return (
    <div className="driver-theme relative min-h-screen bg-background">
      <nav className="sticky top-0 z-40 border-b border-white/10 bg-[hsl(225_52%_10%/0.82)] shadow-[0_8px_24px_-12px_rgba(3,14,42,0.6)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 lg:px-6">
          <Link to="/motorista-preview" className="flex items-center gap-3">
            <div className="relative">
              <img
                src={lamonicaLogo}
                alt="Lamonica Logistica"
                className="h-9 w-9 rounded-xl object-cover ring-1 ring-white/20 sm:h-10 sm:w-10"
              />
              <div className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-[hsl(225_52%_10%)] bg-accent shadow-[0_0_8px_hsl(var(--accent)/0.6)]" />
            </div>
            <div>
              <span className="block text-sm font-extrabold leading-none tracking-tight text-white sm:text-base">
                LAMONICA
              </span>
              <span className="hidden text-[10px] font-medium uppercase tracking-[0.22em] text-white/70 sm:block">
                Portal do motorista
              </span>
            </div>
          </Link>

          <div className="hidden items-center gap-1 lg:flex">
            <a
              href={cadastroHref}
              target="_blank"
              rel="noreferrer"
              className="rounded-full px-4 py-2 text-sm font-semibold text-white/85 transition-colors hover:bg-white/[0.08] hover:text-white"
            >
              Cadastro
            </a>
            <a
              href={sacHref}
              target="_blank"
              rel="noreferrer"
              className="rounded-full px-4 py-2 text-sm font-semibold text-white/85 transition-colors hover:bg-white/[0.08] hover:text-white"
            >
              Suporte
            </a>
            <button
              type="button"
              onClick={() => setIsFaqOpen(true)}
              className="rounded-full px-4 py-2 text-sm font-semibold text-white/85 transition-colors hover:bg-white/[0.08] hover:text-white"
            >
              Dúvidas
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-1.5 rounded-full border border-white/[0.18] bg-white/[0.08] px-3 py-1.5 sm:flex">
              <div className="relative flex items-center justify-center">
                <Activity className="h-3 w-3 text-accent" />
                <div className="absolute inset-0 animate-ping">
                  <Activity className="h-3 w-3 text-accent/50" />
                </div>
              </div>
              <span className="text-[11px] font-bold text-white">Ao vivo</span>
            </div>

            <a
              href={cadastroHref}
              target="_blank"
              rel="noreferrer"
              className="hidden items-center justify-center rounded-full bg-white px-4 py-2 text-sm font-semibold text-primary shadow-sm transition-colors hover:bg-white/95 lg:inline-flex"
            >
              Cadastrar-se
            </a>

            <button
              type="button"
              onClick={() => setIsPreviewMenuOpen((value) => !value)}
              aria-label={isPreviewMenuOpen ? "Fechar menu" : "Abrir menu"}
              aria-expanded={isPreviewMenuOpen}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.18] bg-white/[0.08] text-white transition-colors hover:bg-white/[0.16] lg:hidden"
            >
              {isPreviewMenuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {isPreviewMenuOpen ? (
          <div className="border-t border-white/10 bg-[hsl(225_52%_10%/0.92)] backdrop-blur-xl lg:hidden">
            <div className="mx-auto grid max-w-7xl gap-2 px-4 py-3">
              <a
                href={cadastroHref}
                target="_blank"
                rel="noreferrer"
                onClick={() => setIsPreviewMenuOpen(false)}
                className="flex items-center justify-between rounded-2xl border border-white/[0.12] bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-white/[0.12]"
              >
                Cadastro
                <ArrowRight className="h-4 w-4 text-accent" />
              </a>
              <a
                href={sacHref}
                target="_blank"
                rel="noreferrer"
                onClick={() => setIsPreviewMenuOpen(false)}
                className="flex items-center justify-between rounded-2xl border border-white/[0.12] bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-white/[0.12]"
              >
                Suporte
                <ArrowRight className="h-4 w-4 text-accent" />
              </a>
              <button
                type="button"
                onClick={() => {
                  setIsPreviewMenuOpen(false);
                  setIsFaqOpen(true);
                }}
                className="flex items-center justify-between rounded-2xl border border-white/[0.12] bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-white/[0.12]"
              >
                Dúvidas
                <ArrowRight className="h-4 w-4 text-accent" />
              </button>
            </div>
          </div>
        ) : null}
      </nav>

      <div className="relative overflow-hidden">
        <div className="absolute inset-0 bg-[linear-gradient(135deg,hsl(227_60%_11%),hsl(220_52%_16%)_46%,hsl(223_92%_31%))]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,hsl(var(--accent)/0.18),transparent_35%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_right_top,hsl(var(--primary)/0.32),transparent_42%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_center,hsl(220_100%_60%/0.16),transparent_48%)]" />
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E\")",
          }}
        />
        <div className="absolute right-16 top-10 h-52 w-52 rounded-full bg-primary/24 blur-3xl" />
        <div className="absolute left-1/3 top-14 h-28 w-28 rounded-full bg-white/8 blur-3xl" />
        <div className="absolute bottom-6 left-8 h-36 w-36 rounded-full bg-accent/16 blur-3xl" />

        <div className="relative mx-auto max-w-7xl px-4 pb-5 pt-5 sm:pb-7 sm:pt-8 lg:px-6 lg:pb-10 lg:pt-9">
          <div className="lg:hidden">
            <div className="mb-4 flex items-center justify-between sm:mb-6">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <img
                    src={lamonicaLogo}
                    alt="Lamonica Logistica"
                    className="h-10 w-10 rounded-2xl object-cover ring-2 ring-white/25 shadow-lg sm:h-11 sm:w-11"
                  />
                  <div className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-primary bg-accent shadow-[0_0_8px_hsl(var(--accent)/0.6)]" />
                </div>
                <div>
                  <h1 className="text-base font-extrabold leading-none tracking-tight text-white [text-shadow:0_6px_18px_rgba(3,14,42,0.3)] sm:text-lg">
                    Lamonica
                  </h1>
                  <span className="text-[11px] font-semibold tracking-[0.18em] text-white [text-shadow:0_6px_18px_rgba(3,14,42,0.3)]">
                    LOGISTICA
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 rounded-full border border-white/[0.28] bg-white/[0.2] px-2.5 py-1 shadow-[0_12px_24px_-18px_rgba(3,14,42,0.7)] backdrop-blur-md sm:px-3 sm:py-1.5">
                  <div className="relative flex items-center justify-center">
                    <Activity className="h-3 w-3 text-accent" />
                    <div className="absolute inset-0 animate-ping">
                      <Activity className="h-3 w-3 text-accent/50" />
                    </div>
                  </div>
                  <span className="text-[10px] font-bold text-white sm:text-[11px]">Ao vivo</span>
                </div>
              </div>
            </div>

            <div className="mb-3 grid grid-cols-3 gap-2 sm:mb-5 sm:gap-2.5">
              <div className="rounded-[24px] border border-white/[0.16] bg-white/[0.1] px-3 py-3 text-left backdrop-blur-xl sm:px-3 sm:py-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-2xl border border-white/25 bg-primary/18 shadow-[0_10px_24px_hsl(224_94%_37%/0.24)] sm:h-10 sm:w-10">
                  <Package className="h-4 w-4 text-white sm:h-5 sm:w-5" />
                </div>
                <div className="mt-4">
                  <span className="block text-xl font-extrabold leading-none text-white sm:text-2xl">
                    {totalMatchingLoads}
                  </span>
                  <span className="mt-2 block text-[10px] font-semibold uppercase tracking-[0.16em] text-white [text-shadow:0_6px_18px_rgba(3,14,42,0.22)] sm:text-[11px]">
                    Cargas
                  </span>
                </div>
              </div>
              <div className="rounded-[24px] border border-white/[0.16] bg-white/[0.1] px-3 py-3 text-left backdrop-blur-xl sm:px-3 sm:py-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-2xl border border-white/20 bg-accent/18 shadow-[0_10px_24px_hsl(var(--accent)/0.2)] sm:h-10 sm:w-10">
                  <Truck className="h-4 w-4 text-white sm:h-5 sm:w-5" />
                </div>
                <div className="mt-4">
                  <span className="block text-xl font-extrabold leading-none text-white sm:text-2xl">
                    {uniqueProfilesCount}
                  </span>
                  <span className="mt-2 block text-[10px] font-semibold uppercase tracking-[0.16em] text-white [text-shadow:0_6px_18px_rgba(3,14,42,0.22)] sm:text-[11px]">
                    Veículos
                  </span>
                </div>
              </div>
              <div className="rounded-[24px] border border-white/[0.16] bg-white/[0.1] px-3 py-3 text-left backdrop-blur-xl sm:px-3 sm:py-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-2xl border border-white/20 bg-white/12 shadow-[0_10px_24px_rgba(255,255,255,0.16)] sm:h-10 sm:w-10">
                  <MapPin className="h-4 w-4 text-white sm:h-5 sm:w-5" />
                </div>
                <div className="mt-4">
                  <span className="block text-xl font-extrabold leading-none text-white sm:text-2xl">
                    {uniqueStates}
                  </span>
                  <span className="mt-2 block text-[10px] font-semibold uppercase tracking-[0.16em] text-white [text-shadow:0_6px_18px_rgba(3,14,42,0.22)] sm:text-[11px]">
                    Estados
                  </span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <a
                href={cadastroHref}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center rounded-[18px] border border-white/18 bg-white/[0.12] px-3 py-3 text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-white shadow-[0_18px_34px_-24px_rgba(3,14,42,0.62)] backdrop-blur-md transition-all duration-200 hover:bg-white/[0.18]"
              >
                Cadastro
              </a>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-[18px] border border-white/18 bg-white/[0.12] px-3 py-3 text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-white shadow-[0_18px_34px_-24px_rgba(3,14,42,0.62)] backdrop-blur-md transition-all duration-200 hover:bg-white/[0.18]"
              >
                Suporte
              </button>
              <button
                type="button"
                onClick={() => setIsFaqOpen(true)}
                className="inline-flex items-center justify-center rounded-[18px] border border-white/18 bg-white/[0.12] px-3 py-3 text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-white shadow-[0_18px_34px_-24px_rgba(3,14,42,0.62)] backdrop-blur-md transition-all duration-200 hover:bg-white/[0.18]"
              >
                Dúvidas
              </button>
            </div>
          </div>

          <div className="hidden lg:block">
            <div className="flex items-start justify-between gap-6">
              <div className="flex items-center gap-4">
                <div className="relative flex h-16 w-16 items-center justify-center rounded-[22px] border border-white/16 bg-white/[0.12] backdrop-blur-sm shadow-[0_18px_35px_-24px_rgba(0,0,0,0.75)]">
                  <img
                    src={lamonicaLogo}
                    alt="Lamonica Logistica"
                    className="h-12 w-12 rounded-2xl object-cover"
                  />
                  <div className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full border-[3px] border-[hsl(225_52%_10%)] bg-accent shadow-[0_0_14px_hsl(var(--accent)/0.75)]" />
                </div>

                <div>
                  <h1 className="text-[1.65rem] font-bold leading-none tracking-tight text-white">
                    LAMONICA <span className="font-normal text-white">LOGISTICA</span>
                  </h1>
                  <span className="mt-1 block text-[11px] font-medium uppercase tracking-[0.22em] text-white [text-shadow:0_4px_12px_rgba(3,14,42,0.24)]">
                    Portal do motorista
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <NotificationTriggerButton
                  count={notificationCount}
                  onClick={() => setIsNotificationsOpen(true)}
                  invertTone
                />

                <div className="flex items-center gap-2 rounded-full border border-white/[0.22] bg-white/[0.16] px-5 py-3 shadow-[0_18px_34px_-24px_rgba(3,14,42,0.72)] backdrop-blur-md">
                  <div className="relative flex items-center justify-center">
                    <Activity className="h-4.5 w-4.5 text-accent" />
                    <div className="absolute inset-0 animate-ping">
                      <Activity className="h-4.5 w-4.5 text-accent/50" />
                    </div>
                  </div>
                  <span className="text-base font-bold text-white">Ao vivo</span>
                </div>
              </div>
            </div>

            <div className="mt-8 grid grid-cols-[minmax(0,1.08fr)_430px] items-end gap-10 xl:gap-14">
              <div className="max-w-[640px]">
                <div className="relative overflow-hidden rounded-[32px] border border-white/12 bg-[linear-gradient(145deg,hsl(220_34%_23%/0.92),hsl(223_48%_29%/0.88))] px-6 py-7 shadow-[0_28px_58px_-34px_rgba(3,14,42,0.78)]">
                  <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(145deg,hsl(0_0%_100%/0.08),transparent_30%,transparent_70%,hsl(var(--primary)/0.06))]" />
                  <div className="pointer-events-none absolute -right-10 top-6 h-24 w-24 transform-gpu rounded-full bg-primary/14 blur-3xl will-change-transform animate-float-soft" />
                  <div className="pointer-events-none absolute -left-6 bottom-4 h-20 w-20 transform-gpu rounded-full bg-accent/12 blur-3xl will-change-transform animate-float-soft-delay" />
                  <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/45 to-transparent" />
                  <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/[0.12] px-3 py-1.5 shadow-[0_12px_24px_-18px_rgba(3,14,42,0.72)]">
                    <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_10px_hsl(var(--accent)/0.9)]" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white">
                      Rotas ativas Lamonica
                    </span>
                  </div>
                  <h2 className="relative max-w-[620px] text-[3.4rem] font-bold leading-[0.95] tracking-tight text-white [text-shadow:0_8px_22px_rgba(3,14,42,0.2)] xl:text-[3.6rem]">
                    Cargas para
                    <span className="block font-bold text-[hsl(var(--accent))]">motoristas</span>
                  </h2>
                  <p className="relative mt-5 max-w-[560px] text-[1.05rem] font-normal leading-8 text-white [text-shadow:0_5px_14px_rgba(3,14,42,0.16)]">
                    Veja as cargas disponíveis, filtre por origem, destino e veículo e candidate-se pelo sistema em
                    poucos passos.
                  </p>
                  <div className="relative mt-6 flex flex-wrap gap-3">
                    <a
                      href={cadastroHref}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center rounded-full border border-white/18 bg-white px-5 py-3 text-sm font-semibold text-primary shadow-[0_18px_34px_-24px_rgba(3,14,42,0.62)] transition-colors hover:bg-white/95"
                    >
                      Cadastro
                    </a>
                    <button
                      type="button"
                      className="inline-flex items-center justify-center rounded-full border border-white/18 bg-white/[0.12] px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_34px_-24px_rgba(3,14,42,0.62)] backdrop-blur-md transition-colors hover:bg-white/[0.18]"
                    >
                      Suporte
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsFaqOpen(true)}
                      className="inline-flex items-center justify-center rounded-full border border-white/18 bg-white/[0.12] px-5 py-3 text-sm font-semibold text-white shadow-[0_18px_34px_-24px_rgba(3,14,42,0.62)] backdrop-blur-md transition-colors hover:bg-white/[0.18]"
                    >
                      Dúvidas
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid w-full grid-cols-3 gap-4">
                <div className="group transform-gpu rounded-[30px] border border-white/12 bg-[linear-gradient(180deg,hsl(220_38%_24%/0.92),hsl(222_34%_18%/0.96))] p-5 shadow-[0_24px_48px_-28px_rgba(0,0,0,0.7)] transition-all duration-300 hover:-translate-y-1 hover:border-white/20 hover:shadow-[0_28px_56px_-26px_rgba(0,0,0,0.78)]">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/18 text-white shadow-[0_14px_26px_-18px_hsl(224_94%_37%/0.8)]">
                    <Package className="h-5 w-5" />
                  </div>
                  <div className="mt-9">
                    <span className="block text-[2.15rem] font-bold leading-none text-white">
                      {totalMatchingLoads}
                    </span>
                    <span className="mt-3 block text-[11px] font-medium uppercase tracking-[0.18em] text-white">
                      Cargas
                    </span>
                  </div>
                </div>

                <div className="group transform-gpu rounded-[30px] border border-white/12 bg-[linear-gradient(180deg,hsl(220_38%_24%/0.92),hsl(222_34%_18%/0.96))] p-5 shadow-[0_24px_48px_-28px_rgba(0,0,0,0.7)] transition-all duration-300 hover:-translate-y-1 hover:border-white/20 hover:shadow-[0_28px_56px_-26px_rgba(0,0,0,0.78)]">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/18 text-white shadow-[0_14px_26px_-18px_hsl(var(--accent)/0.82)]">
                    <Truck className="h-5 w-5" />
                  </div>
                  <div className="mt-9">
                    <span className="block text-[2.15rem] font-bold leading-none text-white">
                      {uniqueProfilesCount}
                    </span>
                    <span className="mt-3 block text-[11px] font-medium uppercase tracking-[0.18em] text-white">
                      Veículos
                    </span>
                  </div>
                </div>

                <div className="group transform-gpu rounded-[30px] border border-white/12 bg-[linear-gradient(180deg,hsl(220_38%_24%/0.92),hsl(222_34%_18%/0.96))] p-5 shadow-[0_24px_48px_-28px_rgba(0,0,0,0.7)] transition-all duration-300 hover:-translate-y-1 hover:border-white/20 hover:shadow-[0_28px_56px_-26px_rgba(0,0,0,0.78)]">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/12 text-white shadow-[0_14px_26px_-18px_rgba(255,255,255,0.26)]">
                    <MapPin className="h-5 w-5" />
                  </div>
                  <div className="mt-9">
                    <span className="block text-[2.15rem] font-bold leading-none text-white">
                      {uniqueStates}
                    </span>
                    <span className="mt-3 block text-[11px] font-medium uppercase tracking-[0.18em] text-white">
                      Estados
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0">
          <svg
            viewBox="0 0 1440 40"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-full sm:h-5 lg:h-7"
            preserveAspectRatio="none"
          >
            <path d="M0 40V20C360 0 1080 0 1440 20V40H0Z" fill="hsl(var(--background))" />
          </svg>
        </div>
      </div>

      <div className="relative mx-auto max-w-7xl px-3 pb-24 pt-4 sm:px-4 sm:py-10 lg:px-6 lg:pb-10 lg:pt-5">
        <div ref={mobileFiltersRef} className="mb-4 space-y-3 sm:hidden">
          <div className="glass-surface rounded-2xl p-2 premium-shadow">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="filter"
                onClick={() => {
                  syncMobileDraftsWithApplied();
                  setIsMobileFilterDrawerOpen(true);
                }}
                className="h-11 flex-1 justify-between rounded-xl px-4 text-sm font-semibold"
              >
                <span className="flex items-center gap-2">
                  <SlidersHorizontal className="h-4 w-4 text-primary" />
                  Filtros
                </span>
                <span className="inline-flex min-w-[24px] items-center justify-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-extrabold text-primary">
                  {activeFilterCount}
                </span>
              </Button>

              {activeFilterCount > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={clearAllFilters}
                  className="h-11 w-11 rounded-xl border border-border/50 bg-card text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </Button>
              ) : null}

              <NotificationTriggerButton
                count={notificationCount}
                onClick={() => setIsNotificationsOpen(true)}
                showLabel={false}
                className="h-11 min-w-[58px] shrink-0 rounded-xl px-2.5"
              />
            </div>

            <div className="mt-2 rounded-[18px] border border-border/50 bg-white/72 px-3 py-2.5 shadow-[0_12px_28px_-26px_hsl(223_56%_12%/0.25)]">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary/60">
                {mobileFilterGuide.eyebrow}
              </p>
              <p className="mt-1 text-[13px] font-semibold leading-5 text-foreground">
                {mobileFilterGuide.title}
              </p>
              <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                {mobileFilterGuide.description}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleTodayQuickFilter}
              className={cn(
                "inline-flex h-9 items-center rounded-full border px-3 text-xs font-bold transition-colors",
                isTodayQuickFilter
                  ? "border-primary/30 bg-[hsl(224_94%_37%)] text-white"
                  : "border-border/60 bg-card text-foreground",
              )}
            >
              Hoje
            </button>
            <button
              type="button"
              onClick={handleTomorrowQuickFilter}
              className={cn(
                "inline-flex h-9 items-center rounded-full border px-3 text-xs font-bold transition-colors",
                isTomorrowQuickFilter
                  ? "border-primary/30 bg-[hsl(224_94%_37%)] text-white"
                  : "border-border/60 bg-card text-foreground",
              )}
            >
              Amanhã
            </button>
            <button
              type="button"
              onClick={clearAllFilters}
              className={cn(
                "inline-flex h-9 items-center rounded-full border px-3 text-xs font-bold transition-colors",
                activeFilterCount > 0
                  ? "border-[hsl(224_94%_37%/0.18)] bg-[hsl(224_94%_37%/0.08)] text-[hsl(224_94%_37%)]"
                  : "border-border/60 bg-card text-muted-foreground",
              )}
            >
              Limpar
            </button>
          </div>
        </div>

        <div className="glass-surface mb-6 hidden rounded-2xl p-2.5 premium-shadow sm:mb-8 sm:block sm:rounded-3xl sm:p-3 lg:hidden">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4 sm:gap-2.5">
            <Popover>
              <PopoverTrigger asChild>
                <FilterChip
                  label="Origem"
                  value={getFilterLabel(origemFilter, origemOptions, "Todas")}
                  active={Boolean(origemFilter)}
                  icon={<MapPin className="h-3.5 w-3.5" />}
                />
              </PopoverTrigger>
              <PopoverContent className="driver-theme w-80 rounded-2xl border-border/40 premium-shadow" align="start" side="bottom">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Filtrar origem
                </p>
                <select
                  value={origemFilter}
                  onChange={(event) => setOrigemFilter(event.target.value)}
                  className="mt-3 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground outline-none"
                >
                  <option value="">Todas as origens</option>
                  {origemOptions.map((option) => (
                    <option key={`origem-${option.label}`} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setOrigemFilter("")}
                  className="mt-3 text-sm font-semibold text-primary"
                >
                  Limpar origem
                </button>
              </PopoverContent>
            </Popover>

            <Popover>
              <PopoverTrigger asChild>
                <FilterChip
                  label="Destino"
                  value={getFilterLabel(destinoFilter, destinoOptions, "Todos")}
                  active={Boolean(destinoFilter)}
                  icon={<Compass className="h-3.5 w-3.5" />}
                />
              </PopoverTrigger>
              <PopoverContent className="driver-theme w-80 rounded-2xl border-border/40 premium-shadow" align="start" side="bottom">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Filtrar destino
                </p>
                <select
                  value={destinoFilter}
                  onChange={(event) => setDestinoFilter(event.target.value)}
                  className="mt-3 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground outline-none"
                >
                  <option value="">Todos os destinos</option>
                  {destinoOptions.map((option) => (
                    <option key={`destino-${option.label}`} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setDestinoFilter("")}
                  className="mt-3 text-sm font-semibold text-primary"
                >
                  Limpar destino
                </button>
              </PopoverContent>
            </Popover>

            <Popover>
              <PopoverTrigger asChild>
                <FilterChip
                  label="Veículo"
                  value={perfilFilter || "Todos"}
                  active={Boolean(perfilFilter)}
                  icon={<Truck className="h-3.5 w-3.5" />}
                />
              </PopoverTrigger>
              <PopoverContent className="driver-theme w-72 rounded-2xl border-border/40 premium-shadow" align="start" side="bottom">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Filtrar veículo
                </p>
                <select
                  value={perfilFilter}
                  onChange={(event) => setPerfilFilter(event.target.value)}
                  className="mt-3 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm text-foreground outline-none"
                >
                  <option value="">Todos os perfis</option>
                  {perfis.map((perfil) => (
                    <option key={perfil} value={perfil}>
                      {perfil}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setPerfilFilter("")}
                  className="mt-3 text-sm font-semibold text-primary"
                >
                  Limpar veículo
                </button>
              </PopoverContent>
            </Popover>

            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  title={`${dateFrom ? format(dateFrom, "dd/MM", { locale: ptBR }) : "Início"} - ${dateTo ? format(dateTo, "dd/MM", { locale: ptBR }) : "Fim"}`}
                  className={cn(
                    "group relative flex min-h-[70px] w-full min-w-0 items-center gap-2 rounded-xl border border-border/60 bg-card px-3 py-2.5 text-sm transition-all duration-300 ease-out sm:gap-2.5 sm:rounded-2xl sm:px-4 sm:py-3",
                    "hover:-translate-y-0.5 hover:border-primary/25 hover:premium-shadow",
                    "focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/30",
                    "active:translate-y-0 active:shadow-sm",
                  )}
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-badge text-primary transition-colors duration-200 group-hover:bg-primary/15">
                    <CalendarIcon className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="text-[10px] font-semibold uppercase tracking-widest leading-none text-muted-foreground">
                      Período
                    </span>
                    <span className="mt-1 block truncate whitespace-nowrap text-sm font-bold leading-none text-card-foreground">
                      {dateFrom ? format(dateFrom, "dd/MM", { locale: ptBR }) : "Início"}
                      {" - "}
                      {dateTo ? format(dateTo, "dd/MM", { locale: ptBR }) : "Fim"}
                    </span>
                  </div>
                </button>
              </PopoverTrigger>
              <PopoverContent className="driver-theme w-auto rounded-2xl border-border/40 p-0 premium-shadow" align="start" side="bottom">
                <div className="flex flex-col sm:flex-row">
                  <div className="border-b border-border/40 p-2.5 sm:border-b-0 sm:border-r sm:p-3">
                    <p className="mb-1 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Início
                    </p>
                    <Calendar
                      mode="single"
                      selected={dateFrom}
                      onSelect={setDateFrom}
                      initialFocus
                      className={cn("pointer-events-auto p-1.5 sm:p-2")}
                    />
                  </div>
                  <div className="p-2.5 sm:p-3">
                    <p className="mb-1 px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Fim
                    </p>
                    <Calendar
                      mode="single"
                      selected={dateTo}
                      onSelect={setDateTo}
                      className={cn("pointer-events-auto p-1.5 sm:p-2")}
                    />
                  </div>
                </div>
                <div className="border-t border-border/40 px-4 py-3">
                  <button
                    type="button"
                    onClick={() => {
                      setDateFrom(undefined);
                      setDateTo(undefined);
                    }}
                    className="text-sm font-semibold text-primary"
                  >
                    Limpar período
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <Dialog open={isNotificationsOpen} onOpenChange={setIsNotificationsOpen}>
          <DialogContent
            overlayClassName="bg-[hsl(223_56%_10%/0.76)] backdrop-blur-[2px]"
            className="driver-theme left-0 right-0 top-auto bottom-0 max-h-[86vh] w-full translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-t-[28px] rounded-b-none border-x-0 border-b-0 bg-[linear-gradient(180deg,hsl(0_0%_100%),hsl(220_33%_98%))] p-0 data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom sm:left-[50%] sm:right-auto sm:top-[50%] sm:bottom-auto sm:max-h-[82vh] sm:w-[min(100%-2rem,54rem)] sm:max-w-[54rem] sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-[30px] sm:border"
          >
            <DialogHeader className="border-b border-border/50 px-4 pb-4 pt-5 text-left sm:px-5 sm:pb-5 sm:pt-5">
              <div className="flex items-start gap-3 pr-10">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-[0_14px_30px_-22px_hsl(224_94%_37%/0.7)]">
                  <BellRing className="h-4.5 w-4.5" />
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-primary/60 sm:text-[11px]">
                    Atualizações das suas candidaturas
                  </p>
                  <DialogTitle className="mt-1 text-lg font-bold tracking-tight text-foreground sm:text-xl">
                    Central de notificações do motorista
                  </DialogTitle>
                  <DialogDescription className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    Aqui ficam guardadas as cargas em que você já se candidatou e também os retornos enviados pela equipe.
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="max-h-[calc(86vh-7.5rem)] overflow-y-auto px-3 py-3 sm:max-h-[calc(82vh-8.5rem)] sm:px-4 sm:py-4">
              {notificationCount ? (
                <div className="grid gap-3">
                  {driverLeadNotifications.map((notification) => {
                    const routeLabel = `${notification.origem} -> ${notification.destino}`;
                    const happenedAtLabel = formatShortDateTime(notification.happenedAt, "Agora");

                    return (
                      <article
                        key={notification.id}
                        className={cn(
                          "rounded-[22px] border p-3.5 shadow-[0_18px_34px_-28px_hsl(223_56%_12%/0.22)] sm:rounded-[26px] sm:p-4",
                          notification.kind === "APPROVED"
                            ? "border-emerald-200 bg-[linear-gradient(135deg,hsl(145_77%_95%),hsl(148_46%_90%))]"
                            : notification.kind === "ALLOCATED_TO_OTHER_DRIVER"
                              ? "border-amber-200 bg-amber-50"
                              : "border-primary/20 bg-[linear-gradient(135deg,hsl(224_84%_97%),hsl(223_68%_93%))]",
                        )}
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                          <div
                            className={cn(
                              "flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl sm:mt-0.5 sm:h-10 sm:w-10",
                              notification.kind === "APPROVED"
                                ? "bg-emerald-100 text-emerald-700"
                                : notification.kind === "ALLOCATED_TO_OTHER_DRIVER"
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-primary/12 text-primary",
                            )}
                          >
                            {notification.kind === "APPROVED" ? (
                              <CheckCircle2 className="h-4.5 w-4.5 sm:h-5 sm:w-5" />
                            ) : notification.kind === "ALLOCATED_TO_OTHER_DRIVER" ? (
                              <AlertCircle className="h-4.5 w-4.5 sm:h-5 sm:w-5" />
                            ) : (
                              <Activity className="h-4.5 w-4.5 sm:h-5 sm:w-5" />
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                              <p className="text-sm font-semibold text-foreground sm:text-base">{notification.title}</p>
                              <span className="max-w-full rounded-full bg-white/72 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                                {routeLabel}
                              </span>
                            </div>

                            <p className="mt-2 text-[13px] leading-6 text-muted-foreground sm:text-sm sm:leading-relaxed">
                              {notification.message}
                            </p>
                            <p className="mt-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                              Atualizado em {happenedAtLabel}
                            </p>

                            <div className="mt-3 flex flex-col gap-2 sm:mt-4 sm:flex-row sm:flex-wrap sm:items-center">
                              <Link
                                to={buildCargoPublicPath(notification.loadId)}
                                className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 sm:w-auto"
                                onClick={() => setIsNotificationsOpen(false)}
                              >
                                {notification.kind === "PRE_REGISTERED"
                                  ? "Abrir carga"
                                  : notification.kind === "QUEUED"
                                    ? "Acompanhar candidatura"
                                    : "Abrir carga"}
                                <ArrowRight className="h-4 w-4" />
                              </Link>

                              <button
                                type="button"
                                onClick={() => handleDismissLeadNotification(notification)}
                                className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-border/70 bg-white/85 px-4 py-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:bg-white hover:text-foreground sm:w-auto"
                              >
                                Remover da central
                              </button>
                            </div>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="flex min-h-[240px] flex-col items-center justify-center gap-4 rounded-[24px] border border-border/60 bg-white/82 px-6 py-10 text-center shadow-[0_18px_34px_-28px_hsl(223_56%_12%/0.18)]">
                  <div className="flex h-14 w-14 items-center justify-center rounded-[20px] bg-primary/10 text-primary">
                    <BellRing className="h-6 w-6" />
                  </div>
                  <div>
                    <p className="text-lg font-bold text-foreground">Nenhuma notificação salva</p>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                      Quando você enviar uma candidatura ou receber retorno da equipe, tudo vai aparecer aqui automaticamente.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={isFaqOpen} onOpenChange={setIsFaqOpen}>
          {isFaqOpen ? (
            <DialogContent
              overlayClassName="bg-[hsl(223_56%_10%/0.76)] backdrop-blur-[2px]"
              className="driver-theme admin-dialog-surface max-h-[88vh] w-[min(100%-1.5rem,46rem)] overflow-y-auto rounded-[28px] border p-0 shadow-[0_32px_60px_-36px_hsl(223_56%_10%/0.42)]"
            >
              <DialogHeader className="border-b border-border/50 px-5 pb-4 pt-5 text-left sm:px-6 sm:pb-5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-primary/60 sm:text-[11px]">
                  Dúvidas do motorista
                </p>
                <DialogTitle className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
                  Respostas rápidas para usar o portal
                </DialogTitle>
                <DialogDescription className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                  Tudo o que você precisa para se candidatar com clareza e acompanhar suas cargas sem sair do sistema.
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-3 px-4 py-4 sm:px-6 sm:py-5">
                {DRIVER_FAQ_ITEMS.map((item) => (
                  <div
                    key={item.question}
                    className="admin-card-surface rounded-[22px] border border-border/60 px-4 py-4 shadow-[0_18px_34px_-28px_hsl(223_56%_12%/0.18)]"
                  >
                    <p className="text-sm font-semibold text-foreground sm:text-base">{item.question}</p>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.answer}</p>
                  </div>
                ))}
              </div>
            </DialogContent>
          ) : null}
        </Dialog>

        <Drawer
          open={isMobileFilterDrawerOpen}
          onOpenChange={(open) => {
            if (open) {
              syncMobileDraftsWithApplied();
            }
            setIsMobileFilterDrawerOpen(open);
          }}
          shouldScaleBackground={false}
        >
          <DrawerContent className="driver-theme max-h-[88vh] rounded-t-[28px] border-none bg-background sm:hidden">
            <DrawerHeader className="px-4 pb-2 pt-4 text-left">
              <DrawerTitle>Filtrar cargas</DrawerTitle>
              <DrawerDescription>
                Ajuste origem, destino, veículo e período sem sair da lista.
              </DrawerDescription>
            </DrawerHeader>

            <div className="overflow-y-auto px-4 pb-3">
              <div className="space-y-4">
                <label className="block">
                  <span className="mb-2 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Origem
                  </span>
                  <select
                    value={mobileOrigemDraft}
                    onChange={(event) => setMobileOrigemDraft(event.target.value)}
                    className="h-12 w-full rounded-2xl border border-input bg-background px-4 text-base font-semibold text-foreground outline-none"
                  >
                    <option value="">Todas as origens</option>
                    {origemOptions.map((option) => (
                      <option key={`origem-drawer-${option.label}`} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-2 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Destino
                  </span>
                  <select
                    value={mobileDestinoDraft}
                    onChange={(event) => setMobileDestinoDraft(event.target.value)}
                    className="h-12 w-full rounded-2xl border border-input bg-background px-4 text-base font-semibold text-foreground outline-none"
                  >
                    <option value="">Todos os destinos</option>
                    {destinoOptions.map((option) => (
                      <option key={`destino-drawer-${option.label}`} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-2 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Veículo
                  </span>
                  <select
                    value={mobilePerfilDraft}
                    onChange={(event) => setMobilePerfilDraft(event.target.value)}
                    className="h-12 w-full rounded-2xl border border-input bg-background px-4 text-base font-semibold text-foreground outline-none"
                  >
                    <option value="">Todos os perfis</option>
                    {perfis.map((perfil) => (
                      <option key={`perfil-drawer-${perfil}`} value={perfil}>
                        {perfil}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="rounded-2xl border border-border/50 bg-card p-3">
                  <span className="mb-3 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    Período
                  </span>

                  <div className="space-y-3">
                    <label className="block rounded-xl border border-border/50 bg-muted/15 p-2.5">
                      <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Início
                      </span>
                      <div className="relative min-w-0 overflow-hidden rounded-xl border border-input bg-background">
                        <div className="pointer-events-none flex h-11 min-w-0 items-center justify-between gap-2 px-3">
                          <span className="truncate text-sm font-semibold text-foreground">
                            {toMobileDateLabel(mobileDateFromDraft)}
                          </span>
                          <CalendarIcon className="h-4 w-4 shrink-0 text-primary" />
                        </div>
                        <input
                          type="date"
                          aria-label="Selecionar data inicial"
                          value={toDateInputValue(mobileDateFromDraft)}
                          max={toDateInputValue(mobileDateToDraft) || undefined}
                          onChange={(event) =>
                            setMobileDateFromDraft(event.target.value ? parseISO(event.target.value) : undefined)
                          }
                          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                        />
                      </div>
                    </label>

                    <label className="block rounded-xl border border-border/50 bg-muted/15 p-2.5">
                      <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                        Fim
                      </span>
                      <div className="relative min-w-0 overflow-hidden rounded-xl border border-input bg-background">
                        <div className="pointer-events-none flex h-11 min-w-0 items-center justify-between gap-2 px-3">
                          <span className="truncate text-sm font-semibold text-foreground">
                            {toMobileDateLabel(mobileDateToDraft)}
                          </span>
                          <CalendarIcon className="h-4 w-4 shrink-0 text-primary" />
                        </div>
                        <input
                          type="date"
                          aria-label="Selecionar data final"
                          value={toDateInputValue(mobileDateToDraft)}
                          min={toDateInputValue(mobileDateFromDraft) || undefined}
                          onChange={(event) =>
                            setMobileDateToDraft(event.target.value ? parseISO(event.target.value) : undefined)
                          }
                          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                        />
                      </div>
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <DrawerFooter className="border-t border-border/50 bg-background/95 px-4 pb-6 pt-4">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={clearMobileDraftFilters}
                  className="h-11 flex-1 rounded-2xl border-[hsl(224_94%_37%/0.16)] text-[hsl(224_94%_37%)] hover:bg-[hsl(224_94%_37%/0.06)] hover:text-[hsl(224_94%_37%)]"
                >
                  Limpar
                </Button>
                <Button
                  type="button"
                  onClick={applyMobileFilters}
                  className="h-11 flex-1 rounded-2xl border-0 bg-[linear-gradient(135deg,hsl(226_56%_11%),hsl(223_95%_31%))] font-bold text-white hover:bg-[linear-gradient(135deg,hsl(226_56%_11%),hsl(223_95%_31%))]"
                >
                  Aplicar filtros
                </Button>
              </div>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>

        <div ref={desktopFiltersRef} className="hidden lg:block">
          <div className="admin-card-surface relative mb-5 overflow-hidden rounded-[32px] border p-4 shadow-[0_28px_70px_-40px_hsl(215_25%_12%/0.3)] xl:p-5">
            <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-primary/35 to-transparent" />
            <div className="pointer-events-none absolute -right-8 top-8 h-24 w-24 rounded-full bg-primary/8 blur-3xl" />
            <div className="flex items-center justify-between gap-6">
              <div className="flex min-w-0 items-center gap-3">
                <h2 className="text-[1.32rem] font-bold tracking-tight text-foreground xl:text-[1.45rem]">
                  Cargas disponíveis
                </h2>
                <span className="inline-flex h-7 min-w-[30px] items-center justify-center rounded-full bg-primary/10 px-2.5 text-[13px] font-bold text-primary">
                  {totalMatchingLoads}
                </span>
              </div>

              {hasActiveFilters ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={clearAllFilters}
                  className="h-9 rounded-full px-4 text-sm font-semibold text-muted-foreground hover:text-foreground"
                >
                  Limpar
                </Button>
              ) : null}
            </div>

            {hasActiveFilters ? (
              <p className="mt-2.5 text-sm font-medium text-muted-foreground">
                {activeFilterSummaryItems.join(" | ")}
              </p>
            ) : null}

            <div className="mt-4 grid gap-3 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)]">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="group flex h-[62px] w-full items-center gap-3 rounded-[22px] border border-border/60 bg-secondary/60 px-4 text-left transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/18 hover:bg-white focus:outline-none focus:ring-2 focus:ring-primary/15"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-primary shadow-[0_8px_18px_-12px_hsl(210_100%_45%/0.65)]">
                      <MapPin className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[10px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground/80">Origem</span>
                      <span className="mt-0.5 block truncate text-[15px] font-bold text-foreground">
                        {getFilterLabel(origemFilter, origemOptions, "Todas as origens")}
                      </span>
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-hover:text-primary/60" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="driver-theme w-[320px] rounded-[28px] border-border/45 bg-background/95 p-4 premium-shadow backdrop-blur-xl" align="start" side="bottom">
                  <p className="text-sm font-semibold text-foreground">Local de coleta</p>
                  <select
                    value={origemFilter}
                    onChange={(event) => setOrigemFilter(event.target.value)}
                    className="mt-3 h-11 w-full rounded-2xl border border-input bg-background px-3 text-sm font-medium text-foreground outline-none"
                  >
                    <option value="">Todas as origens</option>
                    {origemOptions.map((option) => (
                      <option key={`desktop-popover-origem-${option.label}`} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setOrigemFilter("")}
                    className="mt-3 text-sm font-semibold text-primary"
                  >
                    Limpar origem
                  </button>
                </PopoverContent>
              </Popover>

              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="group flex h-[62px] w-full items-center gap-3 rounded-[22px] border border-border/60 bg-secondary/60 px-4 text-left transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/18 hover:bg-white focus:outline-none focus:ring-2 focus:ring-primary/15"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-primary shadow-[0_8px_18px_-12px_hsl(210_100%_45%/0.65)]">
                      <Compass className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[10px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground/80">Destino</span>
                      <span className="mt-0.5 block truncate text-[15px] font-bold text-foreground">
                        {getFilterLabel(destinoFilter, destinoOptions, "Todos os destinos")}
                      </span>
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-hover:text-primary/60" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="driver-theme w-[320px] rounded-[28px] border-border/45 bg-background/95 p-4 premium-shadow backdrop-blur-xl" align="start" side="bottom">
                  <p className="text-sm font-semibold text-foreground">Local de entrega</p>
                  <select
                    value={destinoFilter}
                    onChange={(event) => setDestinoFilter(event.target.value)}
                    className="mt-3 h-11 w-full rounded-2xl border border-input bg-background px-3 text-sm font-medium text-foreground outline-none"
                  >
                    <option value="">Todos os destinos</option>
                    {destinoOptions.map((option) => (
                      <option key={`desktop-popover-destino-${option.label}`} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setDestinoFilter("")}
                    className="mt-3 text-sm font-semibold text-primary"
                  >
                    Limpar destino
                  </button>
                </PopoverContent>
              </Popover>

              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="group flex h-[62px] w-full items-center gap-3 rounded-[22px] border border-border/60 bg-secondary/60 px-4 text-left transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/18 hover:bg-white focus:outline-none focus:ring-2 focus:ring-primary/15"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-primary shadow-[0_8px_18px_-12px_hsl(210_100%_45%/0.65)]">
                      <Truck className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[10px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground/80">Veículo</span>
                      <span className="mt-0.5 block truncate text-[15px] font-bold text-foreground">
                        {perfilFilter || "Todos os perfis"}
                      </span>
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-hover:text-primary/60" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="driver-theme w-[300px] rounded-[28px] border-border/45 bg-background/95 p-4 premium-shadow backdrop-blur-xl" align="start" side="bottom">
                  <p className="text-sm font-semibold text-foreground">Tipo de veículo</p>
                  <select
                    value={perfilFilter}
                    onChange={(event) => setPerfilFilter(event.target.value)}
                    className="mt-3 h-11 w-full rounded-2xl border border-input bg-background px-3 text-sm font-medium text-foreground outline-none"
                  >
                    <option value="">Todos os perfis</option>
                    {perfis.map((perfil) => (
                      <option key={`desktop-popover-perfil-${perfil}`} value={perfil}>
                        {perfil}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setPerfilFilter("")}
                    className="mt-3 text-sm font-semibold text-primary"
                  >
                    Limpar veículo
                  </button>
                </PopoverContent>
              </Popover>

              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="group flex h-[62px] w-full items-center gap-3 rounded-[22px] border border-border/60 bg-secondary/60 px-4 text-left transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/18 hover:bg-white focus:outline-none focus:ring-2 focus:ring-primary/15"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-primary shadow-[0_8px_18px_-12px_hsl(210_100%_45%/0.65)]">
                      <CalendarIcon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[10px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground/80">Período</span>
                      <span className="mt-0.5 block truncate text-[15px] font-bold text-foreground">
                        {buildPeriodLabel(dateFrom, dateTo)}
                      </span>
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-hover:text-primary/60" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="driver-theme w-[320px] rounded-[28px] border-border/45 bg-background/95 p-4 premium-shadow backdrop-blur-xl" align="start" side="bottom">
                  <p className="text-sm font-semibold text-foreground">Período da carga</p>
                  <div className="mt-3 grid gap-3">
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Início</span>
                      <input
                        type="date"
                        aria-label="Selecionar data inicial desktop"
                        value={toDateInputValue(dateFrom)}
                        max={toDateInputValue(dateTo) || undefined}
                        onChange={(event) => setDateFrom(event.target.value ? parseISO(event.target.value) : undefined)}
                        className="h-11 w-full rounded-2xl border border-input bg-background px-3 text-sm font-medium text-foreground outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Fim</span>
                      <input
                        type="date"
                        aria-label="Selecionar data final desktop"
                        value={toDateInputValue(dateTo)}
                        min={toDateInputValue(dateFrom) || undefined}
                        onChange={(event) => setDateTo(event.target.value ? parseISO(event.target.value) : undefined)}
                        className="h-11 w-full rounded-2xl border border-input bg-background px-3 text-sm font-medium text-foreground outline-none"
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setDateFrom(undefined);
                      setDateTo(undefined);
                    }}
                    className="mt-3 text-sm font-semibold text-primary"
                  >
                    Limpar período
                  </button>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {resultsContent}
          {paginationControls}
        </div>

        <div ref={resultsSectionRef} className="lg:hidden">
          <div className="mb-6 flex items-center gap-3">
            <h2 className="text-xs font-extrabold uppercase tracking-[0.2em] text-muted-foreground">
              Cargas disponíveis
            </h2>
            <span className="inline-flex h-6 min-w-[28px] items-center justify-center rounded-lg bg-primary/10 px-2 text-xs font-extrabold text-primary">
              {totalMatchingLoads}
            </span>
            <div className="h-px flex-1 bg-gradient-to-r from-border/60 to-transparent" />
          </div>

          {resultsContent}
          {paginationControls}
        </div>
      </div>

        {desktopStickyRoute ? (
          <div
            className={cn(
              "fixed left-0 right-0 top-5 z-50 hidden justify-center px-6 transition-all duration-500 ease-out lg:flex",
              showStickyBar ? "translate-y-0 opacity-100" : "-translate-y-6 opacity-0 pointer-events-none",
            )}
          >
            <button
              type="button"
              onClick={handleDesktopStickyBarClick}
              aria-label="Voltar para a ?rea de filtros e cargas"
              className="pointer-events-auto inline-flex items-center gap-4 rounded-full border border-white/70 bg-white/94 px-5 py-3 text-left shadow-[0_24px_46px_-24px_hsl(222_50%_12%/0.35)] backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_28px_54px_-24px_hsl(222_50%_12%/0.42)]"
            >
              <span className="flex min-w-[44px] items-center gap-3">
                <span className="relative flex h-3 w-3 shrink-0 items-center justify-center">
                  <span className="h-3 w-3 rounded-full bg-accent" />
                  <span className="absolute inset-0 rounded-full bg-accent/45 animate-ping" />
                </span>
                <span className="text-[1.45rem] font-extrabold tracking-tight text-foreground">
                  {desktopStickyRoute.originLabel}
                </span>
              </span>

              <span className="flex items-center gap-3 text-muted-foreground">
                <span className="h-px w-10 bg-border/80" />
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary shadow-[0_14px_30px_-22px_hsl(224_94%_37%/0.7)]">
                  <Truck className="h-5 w-5" />
                </span>
                <span className="h-px w-10 bg-border/80" />
              </span>

              <span className="min-w-[44px] text-[1.45rem] font-extrabold tracking-tight text-foreground">
                {desktopStickyRoute.destinationLabel}
              </span>
            </button>
          </div>
        ) : null}

        <div
          className={cn(
            "fixed left-0 right-0 z-50 flex justify-center px-3 transition-all duration-500 ease-out lg:hidden",
            "top-[calc(env(safe-area-inset-top)+0.75rem)]",
            showStickyBar ? "translate-y-0 opacity-100" : "-translate-y-full opacity-0 pointer-events-none",
          )}
        >
        <div className="w-full max-w-4xl">
          <div className="flex items-center gap-2 rounded-2xl border border-border/50 bg-card/95 p-2 backdrop-blur-xl premium-shadow sm:hidden">
            <Button
              type="button"
              variant="filter"
              onClick={() => {
                syncMobileDraftsWithApplied();
                setIsMobileFilterDrawerOpen(true);
              }}
              className="h-12 flex-1 justify-between rounded-xl px-4 text-sm font-semibold"
            >
              <span className="flex items-center gap-2">
                <SlidersHorizontal className="h-4 w-4 text-primary" />
                Filtros
              </span>
              <span className="inline-flex min-w-[22px] items-center justify-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-extrabold text-primary">
                {activeFilterCount}
              </span>
            </Button>

            <NotificationTriggerButton
              count={notificationCount}
              onClick={() => setIsNotificationsOpen(true)}
              showLabel={false}
              className="h-12 min-w-[60px] shrink-0 rounded-xl px-2.5"
            />

            {activeFilterCount > 0 ? (
              <Button
                type="button"
                variant="ghost"
                onClick={clearAllFilters}
                className="h-12 rounded-xl px-3 text-sm font-semibold text-primary"
              >
                Limpar
              </Button>
            ) : null}
          </div>

          <div className="hidden items-center gap-3 rounded-full border border-border/50 bg-card/80 px-5 py-2.5 backdrop-blur-xl premium-shadow sm:flex lg:hidden">
            <div className="relative flex items-center justify-center">
              <div className="h-2.5 w-2.5 rounded-full bg-accent" />
              <div className="absolute inset-0 h-2.5 w-2.5 rounded-full bg-accent opacity-50 animate-ping" />
            </div>
            <span className="text-sm font-bold text-foreground">
              {getFilterLabel(origemFilter, origemOptions, "Todas")}
            </span>
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <div className="h-px w-8 bg-border" />
              <Truck className="h-4 w-4 text-primary" />
              <div className="h-px w-8 bg-border" />
            </div>
            <span className="text-sm font-bold text-foreground">
              {getFilterLabel(destinoFilter, destinoOptions, "Todos")}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DriverPortalPreview;
