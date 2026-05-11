import { useDeferredValue, useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  Loader2,
  Phone,
  RefreshCw,
  Search,
  ShieldX,
  Truck,
  UserRound,
  XCircle,
} from "lucide-react";
import { revalidateOperatorVehiclesAngellira } from "@/services/operatorAdmin";

import AdminPagination from "@/components/AdminPagination";
import DashboardHeader from "@/components/DashboardHeader";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatShortDateTime, parseDateStringAsLocal } from "@/lib/dateDisplay";
import { cn } from "@/lib/utils";
import { fetchOperatorVehicles, type OperatorVehicleListItem } from "@/services/readModels";

const VEICULOS_QUERY_KEY = ["operator", "veiculos-read-model"] as const;
const PAGE_SIZE = 12;
const LOADING_CARD_COUNT = 6;

const queryOptions = {
  staleTime: 30_000,
  gcTime: 10 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  placeholderData: keepPreviousData,
} as const;

function formatPlateRole(role: OperatorVehicleListItem["plateRole"]) {
  switch (role) {
    case "HORSE":
      return "Cavalo";
    case "TRAILER_1":
      return "Carreta 1";
    case "TRAILER_2":
      return "Carreta 2";
    default:
      return role;
  }
}

function getPlateRoleTone(role: OperatorVehicleListItem["plateRole"]) {
  switch (role) {
    case "HORSE":
      return "border-primary/15 bg-primary/8 text-primary";
    case "TRAILER_1":
      return "border-amber-200 bg-amber-50/80 text-amber-700";
    case "TRAILER_2":
      return "border-violet-200 bg-violet-50/80 text-violet-700";
    default:
      return "border-border/80 bg-white text-muted-foreground";
  }
}

function renderVehicleVigencyBadge(vehicle: OperatorVehicleListItem) {
  const vigency = vehicle.angelliraVigency;

  if (!vigency) {
    if (vehicle.angelliraStatus === "NOT_FOUND") {
      return (
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50/80 px-3 py-1.5 text-xs font-semibold text-slate-600 dark:border-slate-500/40 dark:bg-slate-500/15 dark:text-slate-200">
          <CalendarClock className="h-3.5 w-3.5" />
          Angellira: Não encontrado
        </div>
      );
    }

    if (vehicle.angelliraStatus === "FOUND") {
      return (
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50/80 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-200">
          <BadgeCheck className="h-3.5 w-3.5" />
          Angellira: Encontrado
        </div>
      );
    }

    return null;
  }

  const { alertLevel, daysUntilExpiry, validUntil, statusText } = vigency;

  if (alertLevel === "EXPIRED") {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-red-200 bg-red-50/80 px-3 py-1.5 text-xs font-semibold text-red-700 dark:border-red-400/40 dark:bg-red-500/15 dark:text-red-200">
        <XCircle className="h-3.5 w-3.5" />
        Vigência vencida{validUntil ? ` (${parseDateStringAsLocal(validUntil)?.toLocaleDateString("pt-BR") ?? ""})` : ""}
      </div>
    );
  }

  if (alertLevel === "EXPIRING_SOON") {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50/80 px-3 py-1.5 text-xs font-semibold text-amber-800 dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-200 animate-pulse">
        <AlertTriangle className="h-3.5 w-3.5" />
        Vence em {daysUntilExpiry} dia{daysUntilExpiry !== 1 ? "s" : ""}
        {validUntil ? ` (${parseDateStringAsLocal(validUntil)?.toLocaleDateString("pt-BR") ?? ""})` : ""}
      </div>
    );
  }

  if (alertLevel === "OK" && validUntil) {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50/80 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-200">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {statusText || "Vigente"} até {parseDateStringAsLocal(validUntil)?.toLocaleDateString("pt-BR") ?? ""}
      </div>
    );
  }

  if (vigency.status === "FOUND") {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50/80 px-3 py-1.5 text-xs font-semibold text-emerald-700 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-200">
        <BadgeCheck className="h-3.5 w-3.5" />
        {statusText || "Encontrado"}
      </div>
    );
  }

  if (vigency.status === "NOT_FOUND") {
    return (
      <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50/80 px-3 py-1.5 text-xs font-semibold text-slate-600 dark:border-slate-500/40 dark:bg-slate-500/15 dark:text-slate-200">
        <CalendarClock className="h-3.5 w-3.5" />
        Não encontrado
      </div>
    );
  }

  return null;
}

const Veiculos = () => {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [plateRoleFilter, setPlateRoleFilter] = useState("todos");
  const [page, setPage] = useState(1);
  const [detailVehicle, setDetailVehicle] = useState<OperatorVehicleListItem | null>(null);
  const [revalidating, setRevalidating] = useState(false);

  const handleRevalidateVehicles = async () => {
    if (revalidating) return;
    if (
      !window.confirm(
        "Revalidar todos os veículos no Angellira? O processo verifica até 50 placas por vez e pode levar alguns segundos.",
      )
    ) {
      return;
    }
    try {
      setRevalidating(true);
      const response = await revalidateOperatorVehiclesAngellira();
      if (response.total === 0) {
        toast.info("Nenhum veículo para revalidar.");
      } else {
        const truncatedSuffix = response.truncated ? ` (limite de ${response.limit} por execução)` : "";
        toast.success(
          `Angellira consultado para ${response.revalidated}/${response.total} veículos${truncatedSuffix}.` +
            (response.failed > 0 ? ` ${response.failed} falharam.` : ""),
        );
      }
      await queryClient.invalidateQueries({ queryKey: VEICULOS_QUERY_KEY });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível revalidar os veículos agora.");
    } finally {
      setRevalidating(false);
    }
  };
  const deferredSearch = useDeferredValue(search.trim());

  useEffect(() => {
    setPage(1);
  }, [deferredSearch, statusFilter, plateRoleFilter]);

  const { data, error, isLoading, isFetching } = useQuery({
    queryKey: [...VEICULOS_QUERY_KEY, deferredSearch, statusFilter, plateRoleFilter, page],
    queryFn: () =>
      fetchOperatorVehicles({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        search: deferredSearch,
        status: statusFilter,
        plateRole: plateRoleFilter,
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
    totalVehicles: 0,
    foundCount: 0,
    notFoundCount: 0,
    expiringSoonCount: 0,
  };

  const hasActiveFilters = deferredSearch.length > 0 || statusFilter !== "todos" || plateRoleFilter !== "todos";

  return (
    <div className="min-w-0">
      <DashboardHeader title="Veículos" />

      <main className="min-w-0 space-y-5 p-6 lg:p-8">
        {/* Summary + Filters */}
        <section className="admin-panel overflow-hidden p-5 lg:p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-primary/60">Frota cadastrada</p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold tracking-tight text-foreground">
                  {summary.totalVehicles} veículo{summary.totalVehicles === 1 ? "" : "s"} registrado{summary.totalVehicles === 1 ? "" : "s"}
                </h2>
                {isFetching && !isLoading ? (
                  <span className="inline-flex items-center gap-2 rounded-full border border-primary/12 bg-primary/8 px-3 py-1 text-xs font-semibold text-primary">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    Atualizando
                  </span>
                ) : null}
              </div>
              <p className="mt-3 max-w-3xl text-sm text-muted-foreground">
                Veículos cadastrados automaticamente quando motoristas enviam placas durante o processo de candidatura. Os dados de vigência são verificados pelo Angellira.
              </p>
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => void handleRevalidateVehicles()}
                  disabled={revalidating}
                  className="inline-flex items-center justify-center gap-2 rounded-2xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-[0_10px_22px_-14px_rgba(2,36,131,0.55)] transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  title="Consulta Angellira para todos os veículos e atualiza o banco de dados"
                >
                  {revalidating ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />}
                  <span className="whitespace-nowrap">{revalidating ? "Consultando Angellira..." : "Revalidar Angellira em massa"}</span>
                </button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              <div className="admin-soft-panel flex items-center gap-3 px-4 py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Truck className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Total</p>
                  <p className="text-sm font-semibold text-foreground">{summary.totalVehicles}</p>
                </div>
              </div>

              <div className="admin-soft-panel flex items-center gap-3 px-4 py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Encontrados</p>
                  <p className="text-sm font-semibold text-foreground">{summary.foundCount}</p>
                </div>
              </div>

              <div className="admin-soft-panel flex items-center gap-3 px-4 py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-rose-500/12 text-rose-700">
                  <XCircle className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Nao encontrados</p>
                  <p className="text-sm font-semibold text-foreground">{summary.notFoundCount}</p>
                </div>
              </div>

              <div className="admin-soft-panel flex items-center gap-3 px-4 py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-amber-500/12 text-amber-700">
                  <AlertTriangle className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Vencendo</p>
                  <p className="text-sm font-semibold text-foreground">{summary.expiringSoonCount}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_200px_200px_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Pesquisar por placa, motorista ou CPF..."
                className="h-12 rounded-2xl border-border/80 bg-white/92 pl-11 pr-4"
              />
            </div>

            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="h-12 rounded-2xl border border-border/80 bg-white/92 px-4 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
            >
              <option value="todos">Todos os status</option>
              <option value="found">Encontrados</option>
              <option value="not_found">Nao encontrados</option>
              <option value="expiring">Vencendo</option>
              <option value="expired">Vencidos</option>
            </select>

            <select
              value={plateRoleFilter}
              onChange={(event) => setPlateRoleFilter(event.target.value)}
              className="h-12 rounded-2xl border border-border/80 bg-white/92 px-4 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
            >
              <option value="todos">Todos os tipos</option>
              <option value="HORSE">Cavalo</option>
              <option value="TRAILER_1">Carreta 1</option>
              <option value="TRAILER_2">Carreta 2</option>
            </select>

            <button
              type="button"
              onClick={() => {
                setSearch("");
                setStatusFilter("todos");
                setPlateRoleFilter("todos");
              }}
              disabled={!hasActiveFilters}
              className="inline-flex items-center justify-center rounded-2xl border border-border/80 bg-white/92 px-4 text-sm font-semibold text-foreground transition-colors duration-200 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              Limpar filtros
            </button>
          </div>
        </section>

        {/* Loading */}
        {isLoading ? (
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: LOADING_CARD_COUNT }, (_, index) => (
              <div key={`veiculo-loading-${index}`} className="admin-soft-panel animate-pulse p-5 sm:p-6">
                <div className="flex items-start gap-4">
                  <div className="h-14 w-14 rounded-3xl bg-primary/10" />
                  <div className="grid flex-1 gap-3">
                    <div className="h-5 w-32 rounded-full bg-muted/70" />
                    <div className="h-4 w-48 rounded-full bg-muted/45" />
                  </div>
                </div>
                <div className="mt-5 h-16 rounded-[24px] bg-muted/45" />
              </div>
            ))}
          </section>
        ) : error ? (
          <section className="admin-panel flex min-h-[260px] flex-col items-center justify-center gap-4 p-10 text-center">
            <ShieldX className="h-14 w-14 text-rose-500/70" />
            <div className="space-y-1">
              <p className="text-lg font-bold text-foreground">Não foi possível carregar os veículos</p>
              <p className="text-sm text-muted-foreground">
                {error instanceof Error ? error.message : "Verifique a sessao do operador e tente novamente."}
              </p>
            </div>
          </section>
        ) : items.length === 0 ? (
          <section className="admin-panel flex min-h-[260px] flex-col items-center justify-center gap-4 p-10 text-center">
            <Truck className="h-14 w-14 text-muted-foreground/35" />
            <div className="space-y-1">
              <p className="text-lg font-bold text-foreground">Nenhum veículo encontrado</p>
              <p className="text-sm text-muted-foreground">
                Ajuste os filtros ou aguarde motoristas enviarem suas placas durante candidaturas.
              </p>
            </div>
          </section>
        ) : (
          <section className="space-y-4">
            <div className="text-sm text-muted-foreground">
              Exibindo {items.length} veículo{items.length === 1 ? "" : "s"} nesta página.
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((vehicle) => (
                <article
                  key={vehicle.id}
                  className="admin-soft-panel flex h-full flex-col gap-4 p-5 transition-transform duration-200 hover:-translate-y-0.5 sm:p-6"
                >
                  {/* Header: plate + role */}
                  <div className="flex items-start gap-4">
                    <div className="flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-[22px] border border-primary/10 bg-[linear-gradient(135deg,#022483,#0b4de8)] text-white shadow-[0_18px_32px_-20px_rgba(2,36,131,0.8)]">
                      <Truck className="h-7 w-7" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-xl font-semibold tracking-tight text-foreground font-mono">
                          {vehicle.plate}
                        </h3>
                        <span className={cn("inline-flex rounded-full border px-3 py-1 text-xs font-semibold", getPlateRoleTone(vehicle.plateRole))}>
                          {formatPlateRole(vehicle.plateRole)}
                        </span>
                      </div>
                      {vehicle.angelliraDisplayName ? (
                        <p className="mt-1 text-xs text-muted-foreground">{vehicle.angelliraDisplayName}</p>
                      ) : null}
                      {vehicle.linkedDriverName ? (
                        <p className="mt-0.5 text-xs text-muted-foreground">{vehicle.linkedDriverName}</p>
                      ) : null}
                      {vehicle.linkedDriverPhone ? (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                          <Phone className="h-3 w-3" />
                          {vehicle.linkedDriverPhone}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {/* Vigency badge */}
                  <div className="flex flex-wrap gap-2">
                    {renderVehicleVigencyBadge(vehicle)}
                    <span className={cn(
                      "inline-flex rounded-full border px-3 py-1 text-xs font-semibold",
                      vehicle.source === "PUBLIC_LEAD"
                        ? "border-primary/15 bg-primary/8 text-primary"
                        : "border-border/80 bg-white text-muted-foreground",
                    )}>
                      {vehicle.source === "PUBLIC_LEAD" ? "Candidatura pública" : "Cadastro manual"}
                    </span>
                  </div>

                  <div className="mt-auto pt-2">
                    <button
                      type="button"
                      onClick={() => setDetailVehicle(vehicle)}
                      className="inline-flex items-center justify-center rounded-full border border-border/80 bg-white/80 px-4 py-2 text-xs font-semibold text-foreground transition-colors duration-200 hover:bg-muted dark:bg-muted/40"
                    >
                      Detalhes
                    </button>
                  </div>
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
          itemLabel={`veiculo${meta.totalCount === 1 ? "" : "s"}`}
          isFetching={isFetching}
          onPrevious={() => setPage((currentPage) => Math.max(currentPage - 1, 1))}
          onNext={() => setPage((currentPage) => Math.min(currentPage + 1, meta.totalPages))}
        />
      </main>

      <Dialog open={detailVehicle !== null} onOpenChange={(open) => !open && setDetailVehicle(null)}>
        <DialogContent className="max-w-2xl">
          {detailVehicle ? (
            <>
              <DialogHeader>
                <DialogTitle className="font-mono">{detailVehicle.plate}</DialogTitle>
                <DialogDescription>
                  {formatPlateRole(detailVehicle.plateRole)}
                  {detailVehicle.angelliraDisplayName ? ` · ${detailVehicle.angelliraDisplayName}` : ""}
                </DialogDescription>
              </DialogHeader>

              {detailVehicle.angelliraDetails ? (
                <div className="admin-card-surface rounded-[20px] border p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Truck className="h-4 w-4 text-primary" />
                    Dados Angellira
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
                    {detailVehicle.angelliraDetails.type ? (
                      <div>
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Tipo</p>
                        <p className="mt-0.5 font-medium text-foreground">{detailVehicle.angelliraDetails.type}</p>
                      </div>
                    ) : null}
                    {detailVehicle.angelliraDetails.brand ? (
                      <div>
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Marca</p>
                        <p className="mt-0.5 font-medium text-foreground">{detailVehicle.angelliraDetails.brand}</p>
                      </div>
                    ) : null}
                    {detailVehicle.angelliraDetails.model ? (
                      <div>
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Modelo</p>
                        <p className="mt-0.5 font-medium text-foreground">{detailVehicle.angelliraDetails.model}</p>
                      </div>
                    ) : null}
                    {detailVehicle.angelliraDetails.fabricationYear ? (
                      <div>
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Ano Fabricacao</p>
                        <p className="mt-0.5 font-medium text-foreground">{detailVehicle.angelliraDetails.fabricationYear}{detailVehicle.angelliraDetails.modelYear ? `/${detailVehicle.angelliraDetails.modelYear}` : ""}</p>
                      </div>
                    ) : null}
                    {detailVehicle.angelliraDetails.plate ? (
                      <div>
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Placa Registro</p>
                        <p className="mt-0.5 font-mono font-medium text-foreground">{detailVehicle.angelliraDetails.plate}</p>
                      </div>
                    ) : null}
                    {detailVehicle.angelliraDetails.renavam ? (
                      <div>
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Renavam</p>
                        <p className="mt-0.5 font-mono font-medium text-foreground">{detailVehicle.angelliraDetails.renavam}</p>
                      </div>
                    ) : null}
                    {detailVehicle.angelliraDetails.chassis ? (
                      <div className="col-span-2">
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Chassi</p>
                        <p className="mt-0.5 font-mono text-xs font-medium text-foreground">{detailVehicle.angelliraDetails.chassis}</p>
                      </div>
                    ) : null}
                    {detailVehicle.angelliraDetails.antt ? (
                      <div>
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">ANTT</p>
                        <p className="mt-0.5 font-mono font-medium text-foreground">{detailVehicle.angelliraDetails.antt}</p>
                      </div>
                    ) : null}
                    {detailVehicle.angelliraDetails.lastLicensing ? (
                      <div>
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Ultimo Licenciamento</p>
                        <p className="mt-0.5 font-medium text-foreground">{parseDateStringAsLocal(detailVehicle.angelliraDetails.lastLicensing)?.toLocaleDateString("pt-BR") ?? ""}</p>
                      </div>
                    ) : null}
                    {detailVehicle.angelliraDetails.color ? (
                      <div>
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Cor</p>
                        <p className="mt-0.5 font-medium text-foreground">{detailVehicle.angelliraDetails.color}</p>
                      </div>
                    ) : null}
                    {detailVehicle.angelliraDetails.uf ? (
                      <div>
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">UF</p>
                        <p className="mt-0.5 font-medium text-foreground">{detailVehicle.angelliraDetails.uf}</p>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {detailVehicle.linkedDriverName || detailVehicle.linkedDriverCpf ? (
                <div className="admin-card-surface rounded-[20px] border p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <UserRound className="h-4 w-4 text-primary" />
                    Motorista vinculado
                  </div>
                  <div className="mt-3 grid gap-2 text-sm text-foreground">
                    {detailVehicle.linkedDriverName ? (
                      <span>{detailVehicle.linkedDriverName}</span>
                    ) : null}
                    {detailVehicle.linkedDriverPhone ? (
                      <span className="text-muted-foreground text-xs">
                        {detailVehicle.linkedDriverPhone}
                      </span>
                    ) : null}
                    {detailVehicle.linkedDriverCpf ? (
                      <span className="text-muted-foreground text-xs font-mono">
                        CPF: {detailVehicle.linkedDriverCpf}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {detailVehicle.angelliraLastSeenAt ? (
                  <span>Data envio: {formatShortDateTime(detailVehicle.angelliraLastSeenAt)}</span>
                ) : null}
                {detailVehicle.angelliraCheckedAt ? (
                  <span>Verificado: {formatShortDateTime(detailVehicle.angelliraCheckedAt)}</span>
                ) : null}
                <span>Cadastro: {formatShortDateTime(detailVehicle.createdAt)}</span>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Veiculos;
