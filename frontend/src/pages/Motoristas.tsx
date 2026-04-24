import { useDeferredValue, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BadgeCheck,
  BellRing,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  FileBadge2,
  Pencil,
  Phone,
  RefreshCw,
  Route,
  Search,
  ShieldCheck,
  ShieldX,
  Truck,
  UserRound,
  UsersRound,
  XCircle,
} from "lucide-react";

import AdminPagination from "@/components/AdminPagination";
import { AspxSyncCard } from "@/components/AspxSyncCard";
import DashboardHeader from "@/components/DashboardHeader";
import DriverDetailModal, { type DriverDetailModalData } from "@/components/DriverDetailModal";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { buildDisplayDateTime, formatShortDateTime, parseDateStringAsLocal } from "@/lib/dateDisplay";
import { cn } from "@/lib/utils";
import { getOperatorAccessToken } from "@/services/apiClient";
import { fetchOperatorDrivers, type OperatorDriverApplicationItem, type OperatorDriverListItem } from "@/services/readModels";
import { toast } from "sonner";

const MOTORISTAS_QUERY_KEY = ["operator", "motoristas-read-model"] as const;
const PAGE_SIZE = 8;
const LOADING_CARD_COUNT = 4;

const queryOptions = {
  staleTime: 30_000,
  gcTime: 10 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  placeholderData: keepPreviousData,
} as const;

function formatApplicationStatus(application: OperatorDriverApplicationItem) {
  if (application.source === "PUBLIC_LEAD") {
    if (application.status === "QUEUED") {
      return "Na fila publica";
    }

    if (application.status === "APPROVED") {
      return "Reservado pelo operador";
    }
  }

  if (application.status === "WAITLISTED") {
    return "Na fila";
  }

  if (application.status === "WON_RESERVATION" || application.status === "PROMOTED") {
    return "Reserva em andamento";
  }

  if (application.status === "CONFIRMED") {
    return "Confirmado";
  }

  return application.status;
}

function getApplicationTone(application: OperatorDriverApplicationItem) {
  if (application.status === "CONFIRMED") {
    return "admin-tint-success";
  }

  if (application.status === "APPROVED" || application.status === "WON_RESERVATION" || application.status === "PROMOTED") {
    return "border-primary/20 bg-primary/10 text-primary";
  }

  return "admin-tint-warning";
}

function getDriverBadgeLabel(driver: OperatorDriverListItem) {
  if (driver.registrationStatus === "REGISTERED") return "Conta cadastrada";
  if (driver.sourceType === "HISTORICO") return "Historico Angellira";
  return "Pre-cadastro publico";
}

function getDriverBadgeTone(driver: OperatorDriverListItem) {
  if (driver.registrationStatus === "REGISTERED") return "border-primary/15 bg-primary/8 text-primary";
  if (driver.sourceType === "HISTORICO") return "admin-tint-violet";
  return "admin-tint-warning";
}

function getDriverHeadline(driver: OperatorDriverListItem) {
  return driver.displayName || "Motorista sem nome cadastrado";
}

function renderProfileSignal(label: string, active: boolean | null, positiveLabel = "Ok", negativeLabel = "Pendente") {
  if (active === null) {
    return null;
  }

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold",
        active ? "admin-tint-success" : "admin-tint-danger",
      )}
    >
      {active ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldX className="h-3.5 w-3.5" />}
      {label}: {active ? positiveLabel : negativeLabel}
    </div>
  );
}

function renderAngelliraVigencyBadge(driver: OperatorDriverListItem) {
  const vigency = driver.angelliraVigency;

  if (!vigency) {
    return null;
  }

  const { alertLevel, daysUntilExpiry, validUntil, statusText } = vigency;

  if (alertLevel === "EXPIRED") {
    return (
      <div className="admin-tint-danger inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold">
        <XCircle className="h-3.5 w-3.5" />
        Angellira: Vigencia vencida{validUntil ? ` (${parseDateStringAsLocal(validUntil)?.toLocaleDateString("pt-BR") ?? ""})` : ""}
      </div>
    );
  }

  if (alertLevel === "EXPIRING_SOON") {
    return (
      <div className="admin-tint-warning inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold animate-pulse">
        <AlertTriangle className="h-3.5 w-3.5" />
        Angellira: Vence em {daysUntilExpiry} dia{daysUntilExpiry !== 1 ? "s" : ""}
        {validUntil ? ` (${parseDateStringAsLocal(validUntil)?.toLocaleDateString("pt-BR") ?? ""})` : ""}
      </div>
    );
  }

  if (alertLevel === "OK" && validUntil) {
    return (
      <div className="admin-tint-success inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Angellira: {statusText || "Vigente"} ate {parseDateStringAsLocal(validUntil)?.toLocaleDateString("pt-BR") ?? ""}
      </div>
    );
  }

  if (vigency.status === "FOUND") {
    return (
      <div className="admin-tint-success inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold">
        <BadgeCheck className="h-3.5 w-3.5" />
        Angellira: {statusText || "Encontrado"}
      </div>
    );
  }

  if (vigency.status === "NOT_FOUND") {
    return (
      <div className="admin-tint-neutral inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold">
        <CalendarClock className="h-3.5 w-3.5" />
        Angellira: Nao encontrado
      </div>
    );
  }

  return null;
}

async function updateDriverProfile(driverId: string, payload: Record<string, unknown>) {
  const accessToken = await getOperatorAccessToken();
  const response = await fetch(`/api/operator/motoristas/${driverId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message || "Erro ao atualizar perfil do motorista.");
  }
  return response.json();
}

function SectionTrigger({ label, isOpen }: { label: string; isOpen: boolean }) {
  return (
    <CollapsibleTrigger asChild>
      <button
        type="button"
        className="group flex w-full items-center gap-2 rounded-xl px-1 py-1.5 text-left transition-colors hover:bg-muted/40"
      >
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            isOpen && "rotate-180",
          )}
        />
        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </span>
      </button>
    </CollapsibleTrigger>
  );
}

const Motoristas = () => {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("todos");
  const [applicationStatusFilter, setApplicationStatusFilter] = useState("todos");
  const [page, setPage] = useState(1);
  const deferredSearch = useDeferredValue(search.trim());
  const [detailDriver, setDetailDriver] = useState<DriverDetailModalData | null>(null);
  const [editingDriver, setEditingDriver] = useState<OperatorDriverListItem | null>(null);
  const [editForm, setEditForm] = useState<{
    full_name: string;
    vehicle_profile: string;
    documents_valid: boolean;
    antt_valid: boolean;
    tracking_enabled: boolean;
    insurance_valid: boolean;
    monitoring_capable: boolean;
    operational_blocked: boolean;
  }>({
    full_name: "",
    vehicle_profile: "",
    documents_valid: false,
    antt_valid: false,
    tracking_enabled: false,
    insurance_valid: false,
    monitoring_capable: false,
    operational_blocked: false,
  });

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});

  const toggleSection = (driverId: string, section: string) => {
    const key = `${driverId}::${section}`;
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const isSectionOpen = (driverId: string, section: string) => {
    return openSections[`${driverId}::${section}`] ?? false;
  };

  const updateMutation = useMutation({
    mutationFn: (args: { driverId: string; payload: Record<string, unknown> }) =>
      updateDriverProfile(args.driverId, args.payload),
    onSuccess: () => {
      toast.success("Perfil do motorista atualizado com sucesso.");
      setEditingDriver(null);
      queryClient.invalidateQueries({ queryKey: MOTORISTAS_QUERY_KEY });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Erro ao atualizar motorista.");
    },
  });

  const handleOpenDetail = (driver: OperatorDriverListItem) => {
    const latestValidation = driver.applications.find((a) => a.validation)?.validation || null;
    const latestPlates = driver.applications.find((a) => a.plates)?.plates || null;
    setDetailDriver({
      name: driver.displayName || null,
      cpf: driver.contact.document || null,
      phone: driver.contact.phone || null,
      vehicleType: driver.profile.vehicleProfile || null,
      plates: latestPlates,
      validation: latestValidation,
      angelliraDetails: driver.angelliraDetails || null,
    });
  };

  const handleEditDriver = (driver: OperatorDriverListItem) => {
    setEditingDriver(driver);
    setEditForm({
      full_name: driver.displayName || "",
      vehicle_profile: driver.profile.vehicleProfile || "",
      documents_valid: driver.profile.documentsValid ?? false,
      antt_valid: driver.profile.anttValid ?? false,
      tracking_enabled: driver.profile.trackingEnabled ?? false,
      insurance_valid: driver.profile.insuranceValid ?? false,
      monitoring_capable: driver.profile.monitoringCapable ?? false,
      operational_blocked: driver.profile.operationalBlocked ?? false,
    });
  };

  const handleSaveDriver = () => {
    if (!editingDriver) return;
    updateMutation.mutate({
      driverId: editingDriver.id.replace("driver:", ""),
      payload: editForm,
    });
  };

  const { data, error, isLoading, isFetching } = useQuery({
    queryKey: [...MOTORISTAS_QUERY_KEY, deferredSearch, sourceFilter, applicationStatusFilter, page],
    queryFn: () =>
      fetchOperatorDrivers({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        search: deferredSearch,
        source: sourceFilter,
        applicationStatus: applicationStatusFilter,
      }),
    ...queryOptions,
  });

  const items = data?.items ?? [];
  const meta = data?.meta ?? {
    page,
    pageSize: PAGE_SIZE,
    totalCount: 0,
    totalPages: 1,
    hasNextPage: false,
    maxPageSize: PAGE_SIZE,
    correlationId: "",
  };
  const summary = data?.summary ?? {
    totalDrivers: 0,
    registeredCount: 0,
    publicOnlyCount: 0,
    totalApplications: 0,
  };

  const currentPageApplicationCount = items.reduce((total, driver) => total + driver.stats.totalApplications, 0);

  useEffect(() => {
    setPage(1);
  }, [deferredSearch, sourceFilter, applicationStatusFilter]);

  useEffect(() => {
    if (!items?.length) return;
    const currentIds = new Set(items.map((item) => item.id));
    setOpenSections((prev) => {
      const pruned: Record<string, boolean> = {};
      for (const key of Object.keys(prev)) {
        const driverId = key.split("::")[0];
        if (currentIds.has(driverId)) {
          pruned[key] = prev[key];
        }
      }
      return pruned;
    });
  }, [items]);
  const hasActiveFilters = deferredSearch.length > 0 || sourceFilter !== "todos" || applicationStatusFilter !== "todos";

  return (
    <div className="min-w-0">
      <DashboardHeader title="Motoristas" />

      <main className="min-w-0 space-y-5 p-6 lg:p-8">
        <AspxSyncCard />

        <section className="admin-panel overflow-hidden p-5 lg:p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-primary/60">Visao operacional</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                  {summary.totalDrivers} motorista{summary.totalDrivers === 1 ? "" : "s"} com candidatura{summary.totalApplications === 1 ? "" : "s"}
                </h2>
                {isFetching && !isLoading ? (
                  <span className="inline-flex items-center gap-2 rounded-full border border-primary/12 bg-primary/8 px-3 py-1 text-xs font-semibold text-primary">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    Atualizando
                  </span>
                ) : null}
              </div>
              <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
                A tela consolida contas de motorista cadastradas e pre-cadastros publicos, agrupando as candidaturas mais recentes.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="admin-soft-panel flex items-center gap-3 px-4 py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <UsersRound className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Cadastrados</p>
                  <p className="text-sm font-semibold text-foreground">{summary.registeredCount}</p>
                </div>
              </div>

              <div className="admin-soft-panel flex items-center gap-3 px-4 py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500/12 text-amber-700">
                  <BellRing className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Pre-cadastros</p>
                  <p className="text-sm font-semibold text-foreground">{summary.publicOnlyCount}</p>
                </div>
              </div>

              <div className="admin-soft-panel flex items-center gap-3 px-4 py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-700">
                  <Route className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Candidaturas</p>
                  <p className="text-sm font-semibold text-foreground">{summary.totalApplications}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_220px_220px_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Pesquisar por nome, telefone, documento, rota ou placa..."
                className="h-12 rounded-2xl border-border/80 bg-white/92 pl-11 pr-4"
              />
            </div>

            <select
              value={sourceFilter}
              onChange={(event) => setSourceFilter(event.target.value)}
              className="h-12 rounded-2xl border border-border/80 bg-white/92 px-4 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
            >
              <option value="todos">Todas as origens</option>
              <option value="cadastrados">Apenas cadastrados</option>
              <option value="publicos">Apenas pre-cadastros</option>
              <option value="historico">Historico Angellira</option>
            </select>

            <select
              value={applicationStatusFilter}
              onChange={(event) => setApplicationStatusFilter(event.target.value)}
              className="h-12 rounded-2xl border border-border/80 bg-white/92 px-4 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
            >
              <option value="todos">Todos os status</option>
              <option value="fila">Na fila</option>
              <option value="reservado">Reservado</option>
              <option value="confirmado">Confirmado</option>
            </select>

            <button
              type="button"
              onClick={() => {
                setSearch("");
                setSourceFilter("todos");
                setApplicationStatusFilter("todos");
              }}
              disabled={!hasActiveFilters}
              className="inline-flex items-center justify-center rounded-2xl border border-border/80 bg-white/92 px-4 text-sm font-semibold text-foreground transition-colors duration-200 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              Limpar filtros
            </button>
          </div>
        </section>

        {isLoading ? (
          <section className="grid gap-4 xl:grid-cols-2">
            {Array.from({ length: LOADING_CARD_COUNT }, (_, index) => (
              <div key={`motorista-loading-${index}`} className="admin-soft-panel animate-pulse p-5 sm:p-6">
                <div className="flex items-start gap-4">
                  <div className="h-14 w-14 rounded-3xl bg-primary/10" />
                  <div className="grid flex-1 gap-3">
                    <div className="h-5 w-44 rounded-full bg-muted/70" />
                    <div className="h-4 w-64 rounded-full bg-muted/45" />
                  </div>
                </div>
                <div className="mt-5 h-24 rounded-[24px] bg-muted/45" />
                <div className="mt-4 grid gap-3">
                  <div className="h-24 rounded-[24px] bg-muted/45" />
                  <div className="h-24 rounded-[24px] bg-muted/45" />
                </div>
              </div>
            ))}
          </section>
        ) : error ? (
          <section className="admin-panel flex min-h-[260px] flex-col items-center justify-center gap-4 p-10 text-center">
            <ShieldX className="h-14 w-14 text-rose-500/70" />
            <div className="space-y-1">
              <p className="text-lg font-bold text-foreground">Nao foi possivel carregar os motoristas</p>
              <p className="text-sm text-muted-foreground">
                {error instanceof Error ? error.message : "Verifique a sessao do operador e tente novamente."}
              </p>
            </div>
          </section>
        ) : items.length === 0 ? (
          <section className="admin-panel flex min-h-[260px] flex-col items-center justify-center gap-4 p-10 text-center">
            <UsersRound className="h-14 w-14 text-muted-foreground/35" />
            <div className="space-y-1">
              <p className="text-lg font-bold text-foreground">Nenhum motorista encontrado</p>
              <p className="text-sm text-muted-foreground">
                Ajuste os filtros ou aguarde novas candidaturas entrarem no sistema.
              </p>
            </div>
          </section>
        ) : (
          <section className="space-y-4">
            <div className="text-sm text-muted-foreground">
              Exibindo {items.length} motorista{items.length === 1 ? "" : "s"} nesta pagina, com {currentPageApplicationCount} candidatura{currentPageApplicationCount === 1 ? "" : "s"} visiveis.
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              {items.map((driver) => (
                <article
                  key={driver.id}
                  className="admin-soft-panel flex h-full flex-col gap-4 p-5 transition-transform duration-200 hover:-translate-y-0.5 sm:p-6"
                >
                  {/* ── ALWAYS VISIBLE: Header ── */}
                  <div className="flex items-start gap-4">
                    <button
                      type="button"
                      onClick={() => handleOpenDetail(driver)}
                      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[20px] border border-primary/10 bg-[linear-gradient(135deg,#022483,#0b4de8)] text-sm font-bold text-white shadow-[0_14px_28px_-16px_rgba(2,36,131,0.7)] transition-transform hover:scale-105 hover:shadow-[0_18px_32px_-16px_rgba(2,36,131,0.85)]"
                      title="Ver detalhes do motorista"
                    >
                      <UserRound className="h-6 w-6" />
                    </button>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="text-left hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          onClick={() => handleOpenDetail(driver)}
                        >
                          <h3 className="truncate text-lg font-semibold tracking-tight text-foreground hover:text-primary transition-colors">
                            {getDriverHeadline(driver)}
                          </h3>
                        </button>
                        <span className={cn("inline-flex rounded-full border px-2.5 py-0.5 text-[0.68rem] font-semibold", getDriverBadgeTone(driver))}>
                          {getDriverBadgeLabel(driver)}
                        </span>
                        {driver.registrationStatus === "REGISTERED" ? (
                          <button
                            type="button"
                            onClick={() => handleEditDriver(driver)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-primary/15 bg-primary/8 text-primary transition-all hover:bg-primary/15 hover:scale-105"
                            title="Editar perfil do motorista"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Ultima candidatura:{" "}
                        {driver.stats.latestApplicationAt
                          ? formatShortDateTime(driver.stats.latestApplicationAt)
                          : "sem data"}
                      </p>
                    </div>
                  </div>

                  {/* ── ALWAYS VISIBLE: Contact row ── */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <Phone className="h-3.5 w-3.5 text-primary" />
                      {driver.contact.phone || "Telefone indisponivel"}
                    </span>
                    <span className="hidden text-border sm:inline">|</span>
                    <span className="inline-flex items-center gap-1.5">
                      <FileBadge2 className="h-3.5 w-3.5 text-primary" />
                      {driver.contact.document || "Documento indisponivel"}
                    </span>
                    <span className="hidden text-border sm:inline">|</span>
                    <span className="inline-flex items-center gap-1.5">
                      <Truck className="h-3.5 w-3.5 text-primary" />
                      {driver.profile.vehicleProfile || "Perfil nao informado"}
                    </span>
                  </div>

                  {/* ── ALWAYS VISIBLE: Application counters (inline badges) ── */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/6 px-2.5 py-1 text-xs font-semibold text-foreground">
                      Total: {driver.stats.totalApplications}
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/8 px-2.5 py-1 text-xs font-semibold text-amber-700">
                      Fila: {driver.stats.queuedApplications}
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/8 px-2.5 py-1 text-xs font-semibold text-primary">
                      Reserva: {driver.stats.reservedApplications}
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                      Confirmado: {driver.stats.confirmedApplications}
                    </span>
                  </div>

                  {/* ── ALWAYS VISIBLE: Angellira vigency badge ── */}
                  {renderAngelliraVigencyBadge(driver)}

                  {/* ── COLLAPSIBLE: Sinais do perfil ── */}
                  {(driver.registrationStatus === "REGISTERED" || driver.externalValidation) ? (
                    <Collapsible
                      open={isSectionOpen(driver.id, "sinais")}
                      onOpenChange={() => toggleSection(driver.id, "sinais")}
                    >
                      <SectionTrigger label="Sinais do perfil" isOpen={isSectionOpen(driver.id, "sinais")} />
                      <CollapsibleContent>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {driver.registrationStatus === "REGISTERED" ? (
                            <>
                              {renderProfileSignal("Cadastro", driver.profile.active, "Ativo", "Inativo")}
                              {renderProfileSignal("Documentos", driver.profile.documentsValid)}
                              {renderProfileSignal("ANTT", driver.profile.anttValid)}
                              {renderProfileSignal("Rastreamento", driver.profile.trackingEnabled, "Ativo", "Desligado")}
                              {renderProfileSignal("Seguro", driver.profile.insuranceValid, "Ok", "Nao informado")}
                              {renderProfileSignal("Monitoramento", driver.profile.monitoringCapable, "Ok", "Nao")}
                              {renderProfileSignal("Operacao", driver.profile.operationalBlocked === null ? null : !driver.profile.operationalBlocked, "Liberado", "Bloqueado")}
                            </>
                          ) : driver.externalValidation ? (
                            <>
                              <span className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1.5 text-xs font-semibold text-primary">
                                <BadgeCheck className="h-3.5 w-3.5" />
                                Angellira: {driver.externalValidation.hasAngelira ? "encontrado" : "nao encontrado"}
                              </span>
                              <span className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1.5 text-xs font-semibold text-primary">
                                <BadgeCheck className="h-3.5 w-3.5" />
                                ASPx: {driver.externalValidation.hasAspx ? "encontrado" : "nao encontrado"}
                              </span>
                            </>
                          ) : null}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  ) : null}

                  {/* Dados Angellira agora s\u00f3 via DriverDetailModal (clique no avatar/nome). */}

                  {/* ── COLLAPSIBLE: Candidaturas ── */}
                  <Collapsible
                    open={isSectionOpen(driver.id, "candidaturas")}
                    onOpenChange={() => toggleSection(driver.id, "candidaturas")}
                  >
                    <SectionTrigger
                      label={`Candidaturas (${driver.applications.length})`}
                      isOpen={isSectionOpen(driver.id, "candidaturas")}
                    />
                    <CollapsibleContent>
                      <div className="mt-2 space-y-3">
                        <p className="text-xs text-muted-foreground">Mostrando as {driver.applications.length} mais recentes desta pagina de resultados.</p>

                        {driver.applications.length === 0 ? (
                          <div className="admin-card-surface rounded-[24px] border border-dashed px-4 py-5 text-sm text-muted-foreground">
                            Nenhuma candidatura disponivel para este motorista no filtro atual.
                          </div>
                        ) : (
                          <div className="grid gap-3">
                            {driver.applications.map((application) => (
                              <div
                                key={application.id}
                                className="admin-card-surface rounded-[24px] border p-4"
                              >
                                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="text-sm font-semibold text-foreground">
                                        {application.load.origem} {"->"} {application.load.destino}
                                      </span>
                                      <span
                                        className={cn(
                                          "inline-flex rounded-full border px-3 py-1 text-xs font-semibold",
                                          getApplicationTone(application),
                                        )}
                                      >
                                        {formatApplicationStatus(application)}
                                      </span>
                                      <span className="inline-flex rounded-full border border-border/80 bg-white px-3 py-1 text-xs font-semibold text-muted-foreground dark:bg-muted/40">
                                        {application.source === "CLAIM" ? "Conta no app" : "Pre-cadastro"}
                                      </span>
                                    </div>

                                    <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                                      <span>
                                        Carga {application.load.id} • {application.load.perfil}
                                      </span>
                                      <span>
                                        {formatShortDateTime(buildDisplayDateTime(application.load.data, application.load.horario), "A confirmar")}
                                      </span>
                                      <span>{application.load.status}</span>
                                    </div>
                                  </div>

                                  <div className="text-sm text-muted-foreground">
                                    {formatShortDateTime(application.submittedAt)}
                                  </div>
                                </div>

                                {application.plates ? (
                                  <div className="mt-4 flex flex-wrap gap-2">
                                    <span className="inline-flex rounded-full border border-border/80 bg-white px-3 py-1 text-xs font-semibold text-foreground dark:bg-muted/40">
                                      Cavalo: {application.plates.horsePlate || "indisponivel"}
                                    </span>
                                    <span className="inline-flex rounded-full border border-border/80 bg-white px-3 py-1 text-xs font-semibold text-foreground dark:bg-muted/40">
                                      Carreta 1: {application.plates.trailerPlate || "indisponivel"}
                                    </span>
                                    {application.plates.trailerPlate2 ? (
                                      <span className="inline-flex rounded-full border border-border/80 bg-white px-3 py-1 text-xs font-semibold text-foreground dark:bg-muted/40">
                                        Carreta 2: {application.plates.trailerPlate2}
                                      </span>
                                    ) : null}
                                  </div>
                                ) : null}

                                {application.validation ? (
                                  <div className="mt-4 flex flex-wrap gap-1.5">
                                    <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                                      application.validation.driver.angelira.status === "FOUND"
                                        ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-200"
                                        : application.validation.driver.angelira.status === "UNAVAILABLE"
                                          ? "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-500/40 dark:bg-slate-500/15 dark:text-slate-200"
                                          : "border-red-200 bg-red-50 text-red-700 dark:border-red-400/40 dark:bg-red-500/15 dark:text-red-200"
                                    }`}>
                                      {application.validation.driver.angelira.status === "FOUND" ? "Angellira" : application.validation.driver.angelira.status === "UNAVAILABLE" ? "Angellira indisponivel" : "Fora do Angellira"}
                                    </span>
                                    <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                                      application.validation.driver.aspx.status === "FOUND"
                                        ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-200"
                                        : application.validation.driver.aspx.status === "UNAVAILABLE"
                                          ? "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-500/40 dark:bg-slate-500/15 dark:text-slate-200"
                                          : "border-red-200 bg-red-50 text-red-700 dark:border-red-400/40 dark:bg-red-500/15 dark:text-red-200"
                                    }`}>
                                      {application.validation.driver.aspx.status === "FOUND" ? "ASPx" : application.validation.driver.aspx.status === "UNAVAILABLE" ? "ASPx indisponivel" : "Fora do ASPx"}
                                    </span>
                                  </div>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </article>
              ))}
            </div>
          </section>
        )}

        <AdminPagination
          page={meta.page}
          totalPages={meta.totalPages}
          totalCount={meta.totalCount}
          pageSize={meta.pageSize}
          itemLabel={`motorista${meta.totalCount === 1 ? "" : "s"}`}
          isFetching={isFetching}
          onPrevious={() => setPage((currentPage) => Math.max(currentPage - 1, 1))}
          onNext={() => setPage((currentPage) => Math.min(currentPage + 1, meta.totalPages))}
        />
      </main>

      <Dialog open={editingDriver !== null} onOpenChange={(open) => { if (!open) setEditingDriver(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Editar motorista</DialogTitle>
            {editingDriver ? (
              <p className="mt-1 text-sm text-muted-foreground">Altere os dados do perfil de {editingDriver.displayName || "motorista"}.</p>
            ) : null}
          </DialogHeader>

          <div className="grid gap-3">
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Nome completo</label>
              <Input
                type="text"
                value={editForm.full_name}
                onChange={(e) => setEditForm((f) => ({ ...f, full_name: e.target.value }))}
                className="mt-1.5"
              />
            </div>
            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Perfil do veiculo</label>
              <Input
                type="text"
                value={editForm.vehicle_profile}
                onChange={(e) => setEditForm((f) => ({ ...f, vehicle_profile: e.target.value }))}
                className="mt-1.5"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Telefone e documento sao gerenciados pelo proprio motorista e nao podem ser alterados pelo operador.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {[
              { key: "documents_valid" as const, label: "Documentos validos" },
              { key: "antt_valid" as const, label: "ANTT valida" },
              { key: "tracking_enabled" as const, label: "Rastreamento" },
              { key: "insurance_valid" as const, label: "Seguro" },
              { key: "monitoring_capable" as const, label: "Monitoramento" },
              { key: "operational_blocked" as const, label: "Operacao bloqueada" },
            ].map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2.5 rounded-2xl border border-border/60 bg-white/80 px-3.5 py-3 text-sm cursor-pointer hover:bg-muted/30 transition-colors">
                <input
                  type="checkbox"
                  checked={editForm[key]}
                  onChange={(e) => setEditForm((f) => ({ ...f, [key]: e.target.checked }))}
                  className="h-4 w-4 rounded border-primary/30 text-primary accent-primary"
                />
                <span className="font-medium text-foreground">{label}</span>
              </label>
            ))}
          </div>

          <DialogFooter>
            <button
              type="button"
              onClick={() => setEditingDriver(null)}
              className="rounded-2xl border border-border/80 bg-white px-5 py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSaveDriver}
              disabled={updateMutation.isPending}
              className="rounded-2xl bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-60 hover:bg-primary/90"
            >
              {updateMutation.isPending ? "Salvando..." : "Salvar alteracoes"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DriverDetailModal
        open={detailDriver !== null}
        onOpenChange={(open) => { if (!open) setDetailDriver(null); }}
        data={detailDriver}
        hideValidation
      />
    </div>
  );
};

export default Motoristas;
