import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { format, parseISO } from "date-fns";
import {
  BellRing,
  CalendarIcon,
  ChevronDown,
  Compass,
  MapPin,
  Navigation,
  SlidersHorizontal,
  Truck,
  X,
} from "lucide-react";

import DriverPortalNavbar from "@/components/driver/DriverPortalNavbar";
import CargasProximasCard from "@/components/driver/CargasProximasCard";

import FilterChip from "@/components/FilterChip";
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
import { cn } from "@/lib/utils";
import { DriverClaimWorkflow } from "@/components/driver/DriverClaimWorkflow";
import { DriverRegistrationWizard } from "@/components/driver/cadastro-v2/DriverRegistrationWizard";
import {
  StandaloneCadastroDialog,
  type StandaloneCadastroProceedArgs,
} from "@/components/driver/StandaloneCadastroDialog";
import type { PreSubmitInterceptor } from "@/components/driver/DriverClaimPanel";
import {
  requestCandidaturaPreCheck,
  useIncompleteCadastroDrafts,
  type IncompleteCadastroDraft,
  type PreCheckResponse,
} from "@/api/candidaturaApi";
import { useDriverAuth } from "@/hooks/useDriverAuth";
import { persistStoredLeadState, readStoredLeadState } from "@/lib/driverLeadStorage";
import {
  createPublicLoadLeadPreRegistration,
  type PublicLoadLeadPayload,
} from "@/services/loadClaims";
import { useToast } from "@/components/ui/use-toast";
import { DriverLoadsList } from "@/components/driver/DriverLoadsList";
import {
  useDriverLoads,
  getFilterLabel,
  buildPeriodLabel,
  toDateInputValue,
  toMobileDateLabel,
  toFilterDateLabel,
  splitLocation,
  formatCityDisplay,
} from "@/hooks/useDriverLoads";
import { useLeadNotifications } from "@/hooks/useLeadNotifications";
import { useDriverGeolocation } from "@/hooks/useDriverGeolocation";
import { getOriginCoords, haversineKm } from "@/lib/cityCoordinates";
import { formatVehicleProfileLabel } from "@/lib/vehicleProfiles";
import { DriverAlert } from "@/components/driver/ui/DriverAlert";
import lamonicaLogo from "@/assets/lamonica-logo-white.png";
import { SponsoredCarousel } from "@/components/SponsoredCarousel";

const DRIVER_SUPPORT_WHATSAPP_NUMBER = "557139950665";
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

const buildDriverSupportWhatsAppUrl = (message: string) =>
  `https://wa.me/${DRIVER_SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;

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

const DriverPortal = () => {
  const {
    origemFilter, setOrigemFilter,
    destinoFilter, setDestinoFilter,
    perfilFilter, setPerfilFilter,
    page,
    dateFrom, setDateFrom,
    dateTo, setDateTo,
    mobileOrigemDraft, setMobileOrigemDraft,
    mobileDestinoDraft, setMobileDestinoDraft,
    mobilePerfilDraft, setMobilePerfilDraft,
    mobileDateFromDraft, setMobileDateFromDraft,
    mobileDateToDraft, setMobileDateToDraft,
    cargas,
    isFetching,
    meta,
    totalMatchingLoads,
    uniqueStates,
    uniqueProfilesCount,
    loading,
    totalPages,
    isPageTransitioning,
    origemOptions,
    destinoOptions,
    perfis,
    activeFilterCount,
    hasActiveFilters,
    activeFilterSummaryItems,
    mobileFilterGuide,
    desktopStickyRoute,
    isTodayQuickFilter,
    isTomorrowQuickFilter,
    clearAllFilters,
    clearMobileDraftFilters,
    syncMobileDraftsWithApplied,
    applyMobileFilters,
    handlePageChange,
    handleTodayQuickFilter,
    handleTomorrowQuickFilter,
  } = useDriverLoads();

  const { notifications, notificationCount, handleDismissNotification } = useLeadNotifications();
  // Iter #7: lista de drafts incompletos do motorista (1 card por draft).
  const incompleteDraftsQuery = useIncompleteCadastroDrafts();
  const incompleteDrafts = incompleteDraftsQuery.data?.drafts ?? [];
  const [draftLoadingId, setDraftLoadingId] = useState<string | null>(null);
  // Badge count agregado: notifications + drafts incompletos.
  const totalNotificationCount = notificationCount + incompleteDrafts.length;
  const { toast } = useToast();
  const driverAuth = useDriverAuth();
  const isDriverAuthenticated = Boolean(driverAuth.session?.access_token);

  const [isMobileFilterDrawerOpen, setIsMobileFilterDrawerOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [isFaqOpen, setIsFaqOpen] = useState(false);
  const [isLoadInterestDialogOpen, setIsLoadInterestDialogOpen] = useState(false);
  const [showStickyBar, setShowStickyBar] = useState(false);

  // Wizard de cadastro v2 (CADASTRO-01/02). Abertura via:
  //   (a) interceptor em DriverCargoDetails (fluxo original de candidatura)
  //   (b) botão "Completar/Atualizar cadastro" nas notificações (novo fluxo de renovação)
  const [registrationWizardOpen, setRegistrationWizardOpen] = useState(false);
  // Cadastro avulso (sem carga) acionado pelo botão "Cadastro".
  const [standaloneCadastroOpen, setStandaloneCadastroOpen] = useState(false);
  const [registrationContext, setRegistrationContext] = useState<{
    // Opcional: ausente no cadastro standalone (sem carga associada).
    cargaId?: string;
    cpf: string;
    horsePlate: string;
    trailerPlates: string[];
    preCheckResponse: PreCheckResponse;
    // Snapshot do nome amigavel da carga (origem/destino/routeLabel) capturado
    // no momento da abertura do wizard. Necessario porque o `cargas` listing
    // pode refresh durante o cadastro (carga vira BOOKED → some da lista) —
    // sem snapshot, summary cai pro UUID cru no retry/refresh.
    cargaSummary?: { origem?: string; destino?: string; routeLabel?: string };
  } | null>(null);
  /** loadId com pre-check em progresso — controla spinner no botão da notificação. */
  const [registrationLoadingId, setRegistrationLoadingId] = useState<string | null>(null);

  // PERF-02: handlers estáveis para hotspots — evita re-render em cascata
  // quando setShowStickyBar/scroll dispara render do root.
  const openNotifications = useCallback(() => setIsNotificationsOpen(true), []);
  const openFaq = useCallback(() => setIsFaqOpen(true), []);
  const clearOrigemFilter = useCallback(() => setOrigemFilter(""), [setOrigemFilter]);
  const clearDestinoFilter = useCallback(() => setDestinoFilter(""), [setDestinoFilter]);
  const clearPerfilFilter = useCallback(() => setPerfilFilter(""), [setPerfilFilter]);

  const handleExistingClaimFlow = (ctx: {
    cargaId: string;
    horsePlate: string;
    trailerPlates: string[];
  }) => {
    // Hand-off para o fluxo de candidatura existente. Hoje os cards levam o usuario
    // ate /cargo/:id (DriverCargoDetails) onde o DriverClaimPanel abre — basta
    // garantir que a navegacao ja existente continue valida.
    void ctx;
  };

  // Cadastro avulso: o dialog rodou o pre-check e achou pendências. Abre o
  // wizard completo SEM cargaId — submit persiste carga_id=NULL.
  const handleStandaloneProceed = useCallback(
    ({ cpf, horsePlate, trailerPlates, preCheckResponse }: StandaloneCadastroProceedArgs) => {
      setRegistrationContext({
        // cargaId omitido de propósito — cadastro sem carga.
        cpf,
        horsePlate,
        trailerPlates,
        preCheckResponse,
      });
      setStandaloneCadastroOpen(false);
      setRegistrationWizardOpen(true);
    },
    [],
  );

  /**
   * Phase 8 — Fix entry-point "Candidatar-se" quebrado.
   *
   * Factory que devolve um interceptor com o loadId do card capturado.
   * Espelha o `handlePreSubmitInterceptor` do DriverCargoDetails para que o
   * fluxo de candidatura iniciado direto da tela principal (card → "Candidatar-se")
   * também rode o pre-check v2 e abra o wizard quando houver pendências.
   *
   * Decisão (sem mudar o submit v1):
   *  - CPF inválido / vazio       → 'continue' (não bloqueia)
   *  - pre-check pendências=0     → 'continue' (submit v1 normal)
   *  - pre-check pendências>0     → 'abort' + abre wizard v2 já pré-populado
   *  - falha de rede no pre-check → 'continue' (backend re-valida no submit final)
   */
  const buildPreSubmitInterceptor = useCallback(
    (loadId: string): PreSubmitInterceptor => async (form) => {
      const cpf = form.cpf?.replace(/\D/g, "") || "";
      if (cpf.length !== 11) {
        return "continue";
      }

      const trailerPlatesArray = [form.trailerPlate, form.trailerPlate2]
        .map((plate) => plate?.trim() || "")
        .filter((plate) => plate.length > 0);

      let response: PreCheckResponse;
      try {
        response = await requestCandidaturaPreCheck({
          cpf,
          horsePlate: form.horsePlate,
          trailerPlates: trailerPlatesArray,
        });
      } catch (preCheckError) {
        console.warn("[DriverPortal] pre-check failed; continuing v1 submit", preCheckError);
        return "continue";
      }

      if (!Array.isArray(response.pendencias) || response.pendencias.length === 0) {
        return "continue";
      }

      // BUG FIX (15/05/2026) — replicar persist-before-wizard do
      // DriverCargoDetails.handlePreSubmitInterceptor (Task 08-18 / Bug A S2).
      //
      // Wave 1 fix 08-19 (commit 7c097fa) plumbou o canal card→wizard mas
      // omitiu este passo: lead precisa ser PERSISTIDO no DB (status QUEUED)
      // ANTES de abrir o wizard. Sem isso, motorista que clica "Agora não"
      // descarta a candidatura inteira — operator dashboard nunca vê.
      //
      // O endpoint /pre-registration funciona como UPSERT idempotente (insere
      // se não existe, reutiliza se identity tuple bate). Status inicial
      // QUEUED (via insertPreRegisteredLead). Falha de rede/4xx cai para
      // fallback localStorage para não bloquear motorista.
      const payload: PublicLoadLeadPayload = {
        cpf,
        phone: form.phone,
        horsePlate: form.horsePlate,
        trailerPlate: form.trailerPlate,
        trailerPlate2: form.trailerPlate2,
        vehicleType: form.vehicleType,
      };

      try {
        const persistResult = await createPublicLoadLeadPreRegistration(
          loadId,
          payload,
        );
        persistStoredLeadState({
          loadId,
          leadId: persistResult.lead.id,
          stage:
            persistResult.lead.status === "PRE_REGISTERED"
              ? "PRE_REGISTERED"
              : "QUEUED",
          form: payload,
          whatsappUrl: null,
          updatedAt: new Date().toISOString(),
        });
      } catch (persistError) {
        console.warn(
          "[DriverPortal] persist-before-wizard failed; opening wizard mesmo assim",
          persistError,
        );
        try {
          persistStoredLeadState({
            loadId,
            leadId: `local-pending-${cpf}`,
            stage: "PRE_REGISTERED",
            form: payload,
            whatsappUrl: null,
            updatedAt: new Date().toISOString(),
          });
        } catch (storageError) {
          console.warn(
            "[DriverPortal] localStorage persist also failed",
            storageError,
          );
        }
      }

      // Pendências detectadas — interceptor toma controle e abre o wizard.
      const cargaSnap = cargas.find((c) => c.id === loadId);
      setRegistrationContext({
        cargaId: loadId,
        cpf,
        horsePlate: form.horsePlate,
        trailerPlates: trailerPlatesArray,
        preCheckResponse: response,
        cargaSummary: cargaSnap
          ? { origem: cargaSnap.origem, destino: cargaSnap.destino, routeLabel: cargaSnap.routeLabel }
          : undefined,
      });
      setRegistrationWizardOpen(true);
      return "abort";
    },
    [cargas],
  );

  /**
   * Disparado quando o motorista clica em "Completar/Atualizar cadastro"
   * na view de candidatura salva do DriverClaimPanel (embed do card). Aqui o
   * pre-check já foi feito pelo painel — só passamos o contexto adiante.
   */
  const handleCompleteRegistrationFromCard = useCallback(
    (params: {
      preCheckResponse: PreCheckResponse;
      cpf: string;
      horsePlate: string;
      trailerPlates: string[];
      loadId: string;
    }) => {
      const cargaSnap = cargas.find((c) => c.id === params.loadId);
      setRegistrationContext({
        cargaId: params.loadId,
        cpf: params.cpf,
        horsePlate: params.horsePlate,
        trailerPlates: params.trailerPlates,
        preCheckResponse: params.preCheckResponse,
        cargaSummary: cargaSnap
          ? { origem: cargaSnap.origem, destino: cargaSnap.destino, routeLabel: cargaSnap.routeLabel }
          : undefined,
      });
      setRegistrationWizardOpen(true);
    },
    [cargas],
  );

  /**
   * Abre o wizard de cadastro a partir da central de notificações.
   * Roda pre-check com os dados salvos da candidatura para identificar
   * apenas os steps com pendências (cadastro incompleto ou vigência vencendo).
   */
  const handleCompleteRegistrationFromNotification = async (loadId: string) => {
    const stored = readStoredLeadState(loadId);
    if (!stored) {
      toast({
        title: "Dados não encontrados",
        description: "Reabra a carga e tente candidatar-se novamente.",
        variant: "destructive",
      });
      return;
    }

    const { cpf, horsePlate, trailerPlate, trailerPlate2 } = stored.form;
    const trailerPlates = [trailerPlate, trailerPlate2].filter(Boolean);

    setRegistrationLoadingId(loadId);
    setIsNotificationsOpen(false);

    try {
      const response = await requestCandidaturaPreCheck({ cpf, horsePlate, trailerPlates });

      if (response.pendencias.length === 0) {
        // Sem pendências — verificar se há documentos próximos do vencimento
        const expiring = response.completos.filter((c) => c.daysUntilExpiry <= 30);
        if (expiring.length === 0) {
          toast({
            title: "Cadastro em dia ✓",
            description: "Todos os seus documentos estão válidos e atualizados.",
          });
        } else {
          toast({
            title: "Documentos próximos do vencimento",
            description: `${expiring.length} documento(s) vence(m) em menos de 30 dias. Renove em breve.`,
          });
        }
        return;
      }

      // Há pendências — abre o wizard mostrando apenas os steps necessários
      const cargaSnap = cargas.find((c) => c.id === loadId);
      setRegistrationContext({
        cargaId: loadId,
        cpf,
        horsePlate,
        trailerPlates,
        preCheckResponse: response,
        cargaSummary: cargaSnap
          ? { origem: cargaSnap.origem, destino: cargaSnap.destino, routeLabel: cargaSnap.routeLabel }
          : undefined,
      });
      setRegistrationWizardOpen(true);
    } catch {
      toast({
        title: "Erro ao verificar cadastro",
        description: "Não foi possível checar o status. Tente novamente.",
        variant: "destructive",
      });
      setIsNotificationsOpen(true); // reabre o painel se falhar
    } finally {
      setRegistrationLoadingId(null);
    }
  };

  /**
   * Iter #7 — Abre o wizard a partir de um draft incompleto. Reusa o snapshot
   * salvo em driverLeadStorage (cpf + placas) — se nao existir, usa apenas o
   * cargaId + cpf da sessao do motorista (sem placas, wizard reabre na Tela 0).
   */
  const handleContinueDraft = async (draft: IncompleteCadastroDraft) => {
    setDraftLoadingId(draft.cargaId);
    setIsNotificationsOpen(false);

    try {
      const stored = readStoredLeadState(draft.cargaId);
      if (stored) {
        const { cpf, horsePlate, trailerPlate, trailerPlate2 } = stored.form;
        const trailerPlates = [trailerPlate, trailerPlate2].filter(Boolean);
        const response = await requestCandidaturaPreCheck({ cpf, horsePlate, trailerPlates });
        const cargaSnap = cargas.find((c) => c.id === draft.cargaId);
        setRegistrationContext({
          cargaId: draft.cargaId,
          cpf,
          horsePlate,
          trailerPlates,
          preCheckResponse: response,
          cargaSummary: cargaSnap
            ? { origem: cargaSnap.origem, destino: cargaSnap.destino, routeLabel: cargaSnap.routeLabel }
            : undefined,
        });
        setRegistrationWizardOpen(true);
      } else {
        // Sem snapshot local — direciona pra pagina da carga, motorista clica
        // candidatar e o wizard reabre com o draft existente do server.
        toast({
          title: "Reabra a carga para continuar",
          description: "Toque em Candidatar-se na pagina da carga para retomar o cadastro.",
        });
      }
    } catch {
      toast({
        title: "Nao foi possivel retomar o cadastro",
        description: "Tente novamente em alguns instantes.",
        variant: "destructive",
      });
      setIsNotificationsOpen(true);
    } finally {
      setDraftLoadingId(null);
    }
  };

  const showStickyBarRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const desktopFiltersRef = useRef<HTMLDivElement | null>(null);
  const mobileFiltersRef = useRef<HTMLDivElement | null>(null);
  const resultsSectionRef = useRef<HTMLDivElement | null>(null);

  // PERF-02: pagination handlers estáveis (referenciam resultsSectionRef declarado acima).
  const handlePrevPage = useCallback(
    () => handlePageChange(page - 1, resultsSectionRef),
    [handlePageChange, page],
  );
  const handleNextPage = useCallback(
    () => handlePageChange(page + 1, resultsSectionRef),
    [handlePageChange, page],
  );

  const supportHref = buildDriverSupportWhatsAppUrl(DRIVER_SAC_MESSAGE);



  const { location: driverLocation, loading: locationLoading, denied: locationDenied, unavailable: locationUnavailable } = useDriverGeolocation();

  /** Only show cargas within this radius (km). Beyond this they are not meaningfully "próximas". */
  const MAX_NEARBY_KM = 400;

  const nearbyCargas = useMemo(() => {
    if (!driverLocation) return [];
    return [...cargas]
      .map((cargo) => {
        const coords = getOriginCoords(cargo.origem);
        const distKm = coords
          ? haversineKm(driverLocation.lat, driverLocation.lon, coords.lat, coords.lon)
          : Infinity;
        return { cargo, distKm };
      })
      .filter((item) => item.distKm !== Infinity && item.distKm <= MAX_NEARBY_KM)
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, 3)
      .map((item) => item.cargo);
  }, [cargas, driverLocation]);

  const nearbyItems = useMemo(() => nearbyCargas.map((cargo) => {
    const [routeOrigin, routeDestination] = cargo.routeLabel
      ? cargo.routeLabel.split(" X ").map((s: string) => s.trim())
      : [null, null];
    const originRaw = routeOrigin ? null : splitLocation(cargo.origem);
    const destinationRaw = routeDestination ? null : splitLocation(cargo.destino);
    const origCity = routeOrigin
      ? formatCityDisplay(routeOrigin)
      : formatCityDisplay(originRaw!.city);
    const destCity = routeDestination
      ? formatCityDisplay(routeDestination)
      : formatCityDisplay(destinationRaw!.city);
    const dateLabel = (() => {
      try { return `${format(parseISO(cargo.data), "dd/MM")} às ${cargo.horario}`; }
      catch { return cargo.horario || ""; }
    })();
    const distLabel = "";
    const logoUrl = cargo.clienteLogoUrlProximas ?? undefined;
    return { id: cargo.id, dateLabel, originCity: origCity, destCity: destCity, perfil: cargo.perfil || "", distLabel, logoUrl, logoAlt: cargo.clienteNome ?? undefined };
  }), [nearbyCargas, driverLocation]);

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

  const handleDesktopStickyBarClick = () => {
    desktopFiltersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

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
            onClick={handlePrevPage}
            disabled={page <= 1 || isFetching}
          >
            Anterior
          </Button>
          <Button
            type="button"
            className="rounded-full"
            onClick={handleNextPage}
            disabled={page >= totalPages || isFetching}
          >
            Próxima
          </Button>
        </div>
      </div>
    ) : null;

  return (
    <div className="driver-theme relative min-h-screen bg-background lg:bg-white">
      <DriverPortalNavbar
        notificationCount={totalNotificationCount}
        onNotificationsOpen={openNotifications}
        onCadastroClick={() => setStandaloneCadastroOpen(true)}
        onFaqOpen={openFaq}
        supportHref={supportHref}
      />
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 lg:hidden">
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
        </div>

        <div className="relative mx-auto max-w-7xl px-4 pb-5 pt-5 sm:pb-7 sm:pt-8 lg:px-6 lg:pb-10 lg:pt-9">
          <div className="lg:hidden">
            <div className="mb-4 flex items-center justify-between sm:mb-6">
              <div className="flex items-center">
                <img
                  src={lamonicaLogo}
                  alt="Lamonica Logistica"
                  className="h-12 w-auto object-contain sm:h-14"
                />
              </div>

            </div>

            <div className="mb-3 sm:mb-5">
              <SponsoredCarousel inline />
            </div>

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setStandaloneCadastroOpen(true)}
                className="inline-flex items-center justify-center rounded-[18px] border border-white/18 bg-white/[0.12] px-3 py-3 text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-white shadow-[0_18px_34px_-24px_rgba(3,14,42,0.62)] backdrop-blur-md transition-all duration-200 hover:bg-white/[0.18]"
              >
                Cadastro
              </button>
              <a
                href={supportHref}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center rounded-[18px] border border-white/18 bg-white/[0.12] px-3 py-3 text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-white shadow-[0_18px_34px_-24px_rgba(3,14,42,0.62)] backdrop-blur-md transition-all duration-200 hover:bg-white/[0.18]"
              >
                Suporte
              </a>
              <button
                type="button"
                onClick={openFaq}
                className="inline-flex items-center justify-center rounded-[18px] border border-white/18 bg-white/[0.12] px-3 py-3 text-center text-[11px] font-semibold uppercase tracking-[0.14em] text-white shadow-[0_18px_34px_-24px_rgba(3,14,42,0.62)] backdrop-blur-md transition-all duration-200 hover:bg-white/[0.18]"
              >
                Dúvidas
              </button>
            </div>
          </div>

          <div className="hidden lg:block">
            <div className="mt-0 flex items-start gap-5 xl:gap-6">
              {/* carousel — left */}
              <div className="min-w-0 flex-1">
                <SponsoredCarousel inline />
              </div>

              {/* cargas próximas — right */}
              <div className="w-[272px] shrink-0 xl:w-[300px]">
                <CargasProximasCard
                  items={nearbyItems}
                  buildHref={(id) => `/motorista/cargas/${id}`}
                  title="Cargas próximas a você"
                  loading={locationLoading}
                  denied={locationDenied}
                  unavailable={locationUnavailable}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="absolute bottom-0 left-0 right-0 lg:hidden">
          <svg
            viewBox="0 0 1440 40"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-full sm:h-5"
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
                count={totalNotificationCount}
                onClick={openNotifications}
                showLabel={false}
                className="h-11 min-w-[58px] shrink-0 rounded-xl px-2.5"
              />
            </div>

          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleTodayQuickFilter}
              aria-pressed={isTodayQuickFilter}
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
              aria-pressed={isTomorrowQuickFilter}
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
              aria-label="Limpar filtros"
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
                  label="Coleta"
                  value={getFilterLabel(origemFilter, origemOptions, "Todas")}
                  active={Boolean(origemFilter)}
                  icon={<MapPin className="h-3.5 w-3.5" />}
                />
              </PopoverTrigger>
              <PopoverContent className="driver-theme w-80 rounded-2xl border-border/40 premium-shadow" align="start" side="bottom">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Local de coleta
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
                  onClick={clearOrigemFilter}
                  className="mt-3 text-sm font-semibold text-primary"
                >
                  Limpar origem
                </button>
              </PopoverContent>
            </Popover>

            <Popover>
              <PopoverTrigger asChild>
                <FilterChip
                  label="Entrega"
                  value={getFilterLabel(destinoFilter, destinoOptions, "Todos")}
                  active={Boolean(destinoFilter)}
                  icon={<Compass className="h-3.5 w-3.5" />}
                />
              </PopoverTrigger>
              <PopoverContent className="driver-theme w-80 rounded-2xl border-border/40 premium-shadow" align="start" side="bottom">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Local de entrega
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
                  onClick={clearDestinoFilter}
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
                  value={perfilFilter ? formatVehicleProfileLabel(perfilFilter) : "Todos"}
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
                    <option key={perfil.value} value={perfil.value}>
                      {perfil.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={clearPerfilFilter}
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
                  title={`${toFilterDateLabel(dateFrom) || "Início"} - ${toFilterDateLabel(dateTo) || "Fim"}`}
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
                      {toFilterDateLabel(dateFrom) || "Início"}
                      {" - "}
                      {toFilterDateLabel(dateTo) || "Fim"}
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

        <DriverClaimWorkflow
          isOpen={isNotificationsOpen}
          onOpenChange={setIsNotificationsOpen}
          notifications={notifications}
          notificationCount={notificationCount}
          onDismissNotification={handleDismissNotification}
          onCompleteRegistration={(loadId) => {
            void handleCompleteRegistrationFromNotification(loadId);
          }}
          registrationLoadingId={registrationLoadingId}
          incompleteDrafts={incompleteDrafts}
          onContinueDraft={(draft) => {
            void handleContinueDraft(draft);
          }}
          draftLoadingId={draftLoadingId}
        />

        <StandaloneCadastroDialog
          open={standaloneCadastroOpen}
          onOpenChange={setStandaloneCadastroOpen}
          onProceed={handleStandaloneProceed}
        />

        <DriverRegistrationWizard
          open={registrationWizardOpen}
          onOpenChange={setRegistrationWizardOpen}
          cargaId={registrationContext?.cargaId}
          cargaContext={(() => {
            const id = registrationContext?.cargaId;
            if (!id) return undefined;
            // Prefere snapshot capturado na abertura (sobrevive a refresh do
            // listing). Fallback ao lookup live caso snapshot ausente.
            const snap = registrationContext?.cargaSummary;
            if (snap && (snap.origem || snap.destino || snap.routeLabel)) {
              return { origem: snap.origem, destino: snap.destino, routeLabel: snap.routeLabel };
            }
            const match = cargas.find((c) => c.id === id);
            if (!match) return undefined;
            return {
              origem: match.origem,
              destino: match.destino,
              routeLabel: match.routeLabel,
            };
          })()}
          cpf={registrationContext?.cpf}
          horsePlate={registrationContext?.horsePlate}
          trailerPlates={registrationContext?.trailerPlates}
          initialPreCheckResponse={registrationContext?.preCheckResponse}
          onPreCheckPassed={handleExistingClaimFlow}
        />

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
                    Coleta
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
                    Entrega
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
                      <option key={`perfil-drawer-${perfil.value}`} value={perfil.value}>
                        {perfil.label}
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
                  onClick={() => {
                    applyMobileFilters();
                    setIsMobileFilterDrawerOpen(false);
                  }}
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
                      <span className="block text-[10px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground/80">Coleta</span>
                      <span className="mt-0.5 block truncate text-[15px] font-bold text-foreground">
                        {getFilterLabel(origemFilter, origemOptions, "Todas as origens")}
                      </span>
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-hover:text-primary/60" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="driver-theme w-[300px] rounded-[28px] border-border/45 bg-background/95 p-4 premium-shadow backdrop-blur-xl" align="start" side="bottom">
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
                    onClick={clearOrigemFilter}
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
                      <span className="block text-[10px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground/80">Entrega</span>
                      <span className="mt-0.5 block truncate text-[15px] font-bold text-foreground">
                        {getFilterLabel(destinoFilter, destinoOptions, "Todos os destinos")}
                      </span>
                    </span>
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-hover:text-primary/60" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="driver-theme w-[300px] rounded-[28px] border-border/45 bg-background/95 p-4 premium-shadow backdrop-blur-xl" align="start" side="bottom">
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
                    onClick={clearDestinoFilter}
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
                        {perfilFilter ? formatVehicleProfileLabel(perfilFilter) : "Todos os perfis"}
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
                      <option key={`desktop-popover-perfil-${perfil.value}`} value={perfil.value}>
                        {perfil.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={clearPerfilFilter}
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

          {/* Cada `cargo.pacote_meta` flui como `pacoteMeta={cargo.pacote_meta}` para LoadCard
              dentro de DriverLoadsList — disparando branch de viagem casada quando aplicável.
              Plan 10-05 (CARGAS-CASADAS-06/08). */}
          <DriverLoadsList
            cargas={cargas}
            loading={loading}
            hasActiveFilters={hasActiveFilters}
            onClearFilters={clearAllFilters}
            onInterestDialogOpenChange={setIsLoadInterestDialogOpen}
            driverClaimMode={isDriverAuthenticated ? "authenticated-claim" : "public-form"}
            buildDriverClaimPreSubmit={buildPreSubmitInterceptor}
            onDriverClaimCompleteRegistration={handleCompleteRegistrationFromCard}
          />
          {paginationControls}
        </div>

        <div ref={resultsSectionRef} className="lg:hidden">
          {/* Cargas próximas — mobile/tablet (desktop has it in the header section) */}
          {/* Only render when loading OR when there are nearby cargas — avoids empty/error states taking space on mobile */}
          {(locationLoading || nearbyItems.length > 0) ? (
            <div className="mb-6">
              <CargasProximasCard
                items={nearbyItems}
                buildHref={(id) => `/motorista/cargas/${id}`}
                title="Cargas próximas a você"
                loading={locationLoading}
                denied={locationDenied}
                unavailable={locationUnavailable}
              />
            </div>
          ) : null}
          {/* D-01: fallback quando geolocalização OK mas nenhuma carga próxima foi computada
              (origem fora do whitelist hardcoded em cityCoordinates.ts). Aponta a lista completa abaixo.
              TODO: substituir cityCoordinates hardcoded por Geoapify geocoding (refactor futuro). */}
          {!locationLoading && !locationDenied && !locationUnavailable && driverLocation
            && nearbyItems.length === 0 && cargas.length > 0 ? (
            <div className="mb-6">
              <DriverAlert
                variant="info"
                title="Não calculamos cargas próximas"
                description="Não conseguimos estimar a distância da sua localização até as cargas. Olha a lista completa abaixo."
              />
            </div>
          ) : null}

          <div className="mb-6 flex items-center gap-3">
            <h2 className="text-xs font-extrabold uppercase tracking-[0.2em] text-muted-foreground">
              Cargas disponíveis
            </h2>
            <span className="inline-flex h-6 min-w-[28px] items-center justify-center rounded-lg bg-primary/10 px-2 text-xs font-extrabold text-primary">
              {totalMatchingLoads}
            </span>
            <div className="h-px flex-1 bg-gradient-to-r from-border/60 to-transparent" />
          </div>

          {/* Cada `cargo.pacote_meta` flui como `pacoteMeta={cargo.pacote_meta}` para LoadCard
              dentro de DriverLoadsList — disparando branch de viagem casada quando aplicável.
              Plan 10-05 (CARGAS-CASADAS-06/08). */}
          <DriverLoadsList
            cargas={cargas}
            loading={loading}
            hasActiveFilters={hasActiveFilters}
            onClearFilters={clearAllFilters}
            onInterestDialogOpenChange={setIsLoadInterestDialogOpen}
            driverClaimMode={isDriverAuthenticated ? "authenticated-claim" : "public-form"}
            buildDriverClaimPreSubmit={buildPreSubmitInterceptor}
            onDriverClaimCompleteRegistration={handleCompleteRegistrationFromCard}
          />
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
              aria-label="Voltar para a área de filtros e cargas"
              className={cn("inline-flex items-center gap-4 rounded-full border border-white/70 bg-white/94 px-5 py-3 text-left shadow-[0_24px_46px_-24px_hsl(222_50%_12%/0.35)] backdrop-blur-md transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_28px_54px_-24px_hsl(222_50%_12%/0.42)]", showStickyBar ? "pointer-events-auto" : "pointer-events-none")}
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
              count={totalNotificationCount}
              onClick={openNotifications}
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

export default DriverPortal;
