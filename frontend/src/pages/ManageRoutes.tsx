import { useDeferredValue, useEffect, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Clock3,
  CreditCard,
  MapPinned,
  Navigation,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Search,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { toast } from "sonner";

import AdminPagination from "@/components/AdminPagination";
import RouteModal, { type RouteFormData } from "@/components/RouteModal";
import DashboardHeader from "@/components/DashboardHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { formatDateOnly } from "@/lib/dateDisplay";
import { confirmAction } from "@/lib/confirm";
import { canWriteOperatorRoutes, getOperatorAccessLevel, getOperatorAccessLevelLabel } from "@/lib/operatorAccess";
import {
  formatRouteCurrency,
  formatRouteDurationHours,
  formatRouteMetric,
  parseMoneyInput,
  parseOptionalNumber,
  trimTextOrNull,
} from "@/lib/routeCatalog";
import { createOperatorRoute, updateOperatorRoute } from "@/services/operatorAdmin";
import { fetchOperatorRoutes, type OperatorRouteListItem } from "@/services/readModels";
import { resolveRouteMetrics } from "@/services/routeMetrics";

type RouteCatalogRow = OperatorRouteListItem;

const ROUTES_QUERY_KEY = ["admin", "routes-read-model"] as const;
const PAGE_SIZE = 8;

function mapRouteToFormData(route: RouteCatalogRow): RouteFormData {
  return {
    origem: route.origem,
    destino: route.destino,
    distancia_km: String(route.distancia_km ?? ""),
    duracao_horas: String(route.duracao_horas ?? ""),
    tempo_estimado_horas: route.tempo_estimado_horas !== null ? String(route.tempo_estimado_horas) : "",
    perfil_padrao: route.perfil_padrao || "CARRETA",
    valor_padrao: route.valor_padrao !== null ? String(route.valor_padrao) : "",
    bonus_padrao: route.bonus_padrao !== null ? String(route.bonus_padrao) : "",
    ativa: route.ativa,
    observacoes: route.observacoes || "",
  };
}

const ManageRoutes = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ativas");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRoute, setEditingRoute] = useState<RouteCatalogRow | null>(null);
  const [detailRoute, setDetailRoute] = useState<RouteCatalogRow | null>(null);
  const [page, setPage] = useState(1);
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());

  useEffect(() => {
    setPage(1);
  }, [deferredSearch, statusFilter]);

  const {
    data,
    error,
    isFetching,
    isLoading,
  } = useQuery({
    queryKey: [...ROUTES_QUERY_KEY, deferredSearch, statusFilter, page],
    queryFn: () =>
      fetchOperatorRoutes({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        search: deferredSearch,
        status: statusFilter,
      }),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (error) {
      toast.error("Erro ao carregar rotas");
    }
  }, [error]);

  const routes = data?.items || [];
  const operatorAccessLevel = getOperatorAccessLevel(user);
  const canManageRoutes = canWriteOperatorRoutes(user);
  const supportsCatalogFields = data?.supportsCatalogFields ?? true;
  const totalRoutes = data?.summary.totalRoutes ?? 0;
  const activeRoutes = data?.summary.activeRoutes ?? 0;
  const baseRoutesCount = data?.summary.baseRoutes ?? 0;
  const meta = data?.meta || {
    page,
    pageSize: PAGE_SIZE,
    totalCount: 0,
    totalPages: 1,
    hasNextPage: false,
    maxPageSize: PAGE_SIZE,
    correlationId: "",
  };
  const loading = isLoading && !routes.length;
  const isRefreshing = isFetching && !loading;

  const refreshRoutes = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ROUTES_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ["admin", "assignable-routes"] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "cargas-read-model"] }),
      queryClient.invalidateQueries({ queryKey: ["operator", "dashboard-read-model"] }),
      queryClient.invalidateQueries({ queryKey: ["driver", "loads-read-model"] }),
    ]);
  };

  const resolveMetricsForModal = async (origin: string, destination: string) => {
    const metrics = await resolveRouteMetrics(origin, destination);

    if (metrics.distancia_km === null || metrics.duracao_horas === null) {
      toast.warning("Não foi possível resolver a rota agora.");
    } else {
      toast.success("Métricas da rota atualizadas.");
    }

    return metrics;
  };

  const handleSave = async (formData: RouteFormData) => {
    if (!canManageRoutes) {
      toast.error("Seu acesso nesta area e somente leitura.");
      return;
    }

    const confirmTitle = editingRoute ? "Salvar alterações desta rota?" : "Cadastrar esta nova rota?";
    if (!confirmAction(confirmTitle)) {
      return;
    }

    const originValue = formData.origem.trim();
    const destinationValue = formData.destino.trim();

    if (!originValue || !destinationValue) {
      toast.error("Informe origem e destino da rota.");
      return;
    }

    const manualDistance = parseOptionalNumber(formData.distancia_km);
    const manualDuration = parseOptionalNumber(formData.duracao_horas);
    const resolvedMetrics =
      manualDistance !== null && manualDuration !== null
        ? { distancia_km: manualDistance, duracao_horas: manualDuration }
        : await resolveRouteMetrics(originValue, destinationValue);

    const distanciaKm = manualDistance ?? resolvedMetrics.distancia_km;
    const duracaoHoras = manualDuration ?? resolvedMetrics.duracao_horas;

    if (distanciaKm === null || duracaoHoras === null) {
      toast.error("Não foi possível salvar sem distância e duração.");
      return;
    }

    const payload = {
      origem: originValue,
      destino: destinationValue,
      distancia_km: distanciaKm,
      duracao_horas: duracaoHoras,
      tempo_estimado_horas: parseOptionalNumber(formData.tempo_estimado_horas) ?? duracaoHoras,
      perfil_padrao: trimTextOrNull(formData.perfil_padrao),
      valor_padrao: parseMoneyInput(formData.valor_padrao),
      bonus_padrao: parseMoneyInput(formData.bonus_padrao),
      ativa: formData.ativa,
      observacoes: trimTextOrNull(formData.observacoes),
    };

    let cascadedCargaCount = 0;

    try {
      const response = editingRoute?.persisted
        ? await updateOperatorRoute(editingRoute.id, payload)
        : await createOperatorRoute(payload);

      response.warnings?.forEach((warning) => {
        toast.warning(warning);
      });
      cascadedCargaCount = response.cascadedCargaCount ?? 0;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erro ao salvar rota");
      return;
    }

    if (cascadedCargaCount > 0) {
      toast.success(
        `Rota atualizada! ${cascadedCargaCount} carga${cascadedCargaCount > 1 ? "s" : ""} aberta${cascadedCargaCount > 1 ? "s" : ""} ${cascadedCargaCount > 1 ? "foram atualizadas" : "foi atualizada"} automaticamente.`,
      );
    } else {
      toast.success(editingRoute ? "Rota atualizada!" : "Rota cadastrada!");
    }
    setModalOpen(false);
    setEditingRoute(null);
    await refreshRoutes();
  };

  return (
    <div>
      <DashboardHeader title="Rotas Padrão" />

      <main className="space-y-5 p-6 lg:p-8">
        <section className="admin-panel overflow-hidden p-5 lg:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="space-y-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-primary/60">Catálogo operacional</p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
                  Rotas com distancia, tempo estimado e valores de referencia
                </h2>
              </div>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                Cadastre as rotas padrão da operação para manter origem, destino, distancia, duracao, valor, bonus e perfil sugerido em um único lugar.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Card className="border-primary/10 bg-primary/5 shadow-none">
                <CardContent className="p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary/70">Total</p>
                  <p className="mt-2 text-3xl font-black tracking-tight text-primary">{totalRoutes}</p>
                </CardContent>
              </Card>
              <Card className="border-border/70 bg-white/80 shadow-none">
                <CardContent className="p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">Ativas</p>
                  <p className="mt-2 text-3xl font-black tracking-tight text-foreground">{activeRoutes}</p>
                </CardContent>
              </Card>
              <Card className="border-border/70 bg-white/80 shadow-none">
                <CardContent className="p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">Base da planilha</p>
                  <p className="mt-2 text-3xl font-black tracking-tight text-foreground">{baseRoutesCount}</p>
                </CardContent>
              </Card>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-primary/12 bg-primary/6 px-4 py-3 text-sm text-primary">
            As rotas base deste painel estao vindo da lista oficial enviada anteriormente, com valores carregados da planilha.
          </div>

          {!supportsCatalogFields ? (
            <div className="mt-5 rounded-2xl border border-amber-300/45 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200">
              O catálogo completo de rotas precisa da migration nova no banco para liberar valor padrão, bônus, perfil sugerido e observações.
            </div>
          ) : null}

          <div className="mt-5 flex flex-col gap-3 xl:flex-row xl:items-center">
            <div className="relative min-w-[280px] flex-1">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Pesquisar por origem, destino, perfil ou observacao..."
                className="h-12 rounded-2xl border-border/80 bg-white/92 pl-11 pr-4"
              />
            </div>

            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="h-12 rounded-2xl border border-border/80 bg-white/92 px-4 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
            >
              <option value="ativas">Somente ativas</option>
              <option value="inativas">Somente inativas</option>
              <option value="todas">Todas</option>
            </select>

            {canManageRoutes ? (
              <button
                type="button"
                onClick={() => {
                  setEditingRoute(null);
                  setModalOpen(true);
                }}
                className="admin-primary-button inline-flex h-12 items-center justify-center gap-2 rounded-2xl px-5 text-sm font-semibold text-white"
              >
                <Plus className="h-4 w-4" />
                Nova rota
              </button>
            ) : (
              <div className="inline-flex h-12 items-center justify-center rounded-2xl border border-border/80 bg-white/92 px-4 text-sm font-semibold text-muted-foreground">
                {getOperatorAccessLevelLabel(operatorAccessLevel)}: somente leitura
              </div>
            )}
          </div>

          {isRefreshing ? (
            <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-primary/12 bg-primary/8 px-3 py-1 text-xs font-semibold text-primary">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              Atualizando rotas
            </div>
          ) : null}
        </section>

        {!canManageRoutes ? (
          <section className="rounded-2xl border border-amber-300/45 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200">
            Seu perfil pode visualizar todo o catalogo operacional, mas apenas operadores com acesso avancado podem criar ou editar rotas padrao.
          </section>
        ) : null}

        {loading ? (
          <div className="grid gap-4 xl:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={`route-loading-${index}`} className="h-[360px] rounded-[28px]" />
            ))}
          </div>
        ) : routes.length === 0 ? (
          <section className="admin-panel flex min-h-[260px] flex-col items-center justify-center gap-4 p-10 text-center">
            <Route className="h-14 w-14 text-muted-foreground/35" />
            <div className="space-y-1">
              <p className="text-lg font-bold text-foreground">Nenhuma rota encontrada</p>
              <p className="text-sm text-muted-foreground">Ajuste os filtros ou cadastre uma nova rota padrão para a operação.</p>
            </div>
          </section>
        ) : (
          <section className="grid gap-4 xl:grid-cols-2">
            {routes.map((routeItem) => {
              return (
                <article
                  key={routeItem.id}
                  className="admin-panel overflow-hidden rounded-[28px] border border-white/80 bg-white/92 p-5 shadow-[0_24px_60px_-40px_hsl(215_25%_12%/0.24)]"
                >
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="space-y-3">
                        <div className="flex flex-wrap gap-2">
                          <Badge className={routeItem.ativa ? "bg-accent/10 text-accent" : "bg-muted text-muted-foreground"}>
                            {routeItem.ativa ? "Ativa" : "Inativa"}
                          </Badge>
                          {routeItem.source === "base" || routeItem.source === "base+db" ? (
                            <Badge className="bg-primary/10 text-primary">Base da planilha</Badge>
                          ) : null}
                          {routeItem.source === "db" ? (
                            <Badge className="bg-slate-100 text-slate-700">Manual</Badge>
                          ) : null}
                          <Badge variant="outline" className="border-border/60 bg-white/70 text-foreground">
                            {routeItem.perfil_padrao || "Sem perfil"}
                          </Badge>
                        </div>

                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary/60">Trecho padrão</p>
                          <h3 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                            {routeItem.origem} {"\u2192"} {routeItem.destino}
                          </h3>
                          {routeItem.base_route_label ? (
                            <p className="mt-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                              {routeItem.base_route_label}
                            </p>
                          ) : null}
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setDetailRoute(routeItem)}
                          className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-border/80 bg-white/80 px-4 text-sm font-semibold text-foreground transition-colors duration-200 hover:bg-muted dark:bg-muted/40"
                        >
                          Detalhes
                        </button>
                        {canManageRoutes ? (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingRoute(routeItem);
                              setModalOpen(true);
                            }}
                            className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-primary/10 bg-primary/5 px-4 text-sm font-semibold text-primary transition-colors duration-200 hover:bg-primary/10"
                          >
                            <Pencil className="h-4 w-4" />
                            Editar rota
                          </button>
                        ) : (
                          <span className="inline-flex h-11 items-center justify-center rounded-2xl border border-border/70 bg-white/80 px-4 text-sm font-semibold text-muted-foreground">
                            Somente leitura
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </section>
        )}

        <AdminPagination
          page={meta.page}
          totalPages={meta.totalPages}
          totalCount={meta.totalCount}
          pageSize={meta.pageSize}
          itemLabel={`rota${meta.totalCount === 1 ? "" : "s"}`}
          isFetching={isRefreshing}
          onPrevious={() => setPage((currentPage) => Math.max(currentPage - 1, 1))}
          onNext={() => setPage((currentPage) => Math.min(currentPage + 1, meta.totalPages))}
        />
      </main>

      {canManageRoutes ? (
        <RouteModal
          open={modalOpen}
          onClose={() => {
            setModalOpen(false);
            setEditingRoute(null);
          }}
          onSave={handleSave}
          onResolveMetrics={resolveMetricsForModal}
          supportsCatalogFields={supportsCatalogFields}
          initialData={editingRoute ? mapRouteToFormData(editingRoute) : null}
        />
      ) : null}

      <Dialog open={detailRoute !== null} onOpenChange={(open) => !open && setDetailRoute(null)}>
        <DialogContent className="max-w-3xl">
          {detailRoute ? (() => {
            const effectiveEstimatedHours = detailRoute.tempo_estimado_horas ?? detailRoute.duracao_horas;
            const routeObservations = trimTextOrNull(detailRoute.observacoes) || "Sem observações adicionais para essa rota padrão.";
            const updatedAtLabel = formatDateOnly(detailRoute.updated_at, "Base importada");

            return (
              <>
                <DialogHeader>
                  <DialogTitle>
                    {detailRoute.origem} {"\u2192"} {detailRoute.destino}
                  </DialogTitle>
                  <DialogDescription>
                    {detailRoute.ativa ? "Rota ativa" : "Rota inativa"} · Perfil: {detailRoute.perfil_padrao || "Não definido"}
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <Card className="border-border/60 bg-muted/20 shadow-none">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        <MapPinned className="h-3.5 w-3.5 text-primary" />
                        Distância
                      </div>
                      <p className="mt-2 text-sm font-semibold text-foreground">{formatRouteMetric(detailRoute.distancia_km, "km")}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/60 bg-muted/20 shadow-none">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        <Navigation className="h-3.5 w-3.5 text-primary" />
                        Duração
                      </div>
                      <p className="mt-2 text-sm font-semibold text-foreground">{formatRouteDurationHours(detailRoute.duracao_horas)}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/60 bg-muted/20 shadow-none">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        <Clock3 className="h-3.5 w-3.5 text-primary" />
                        Tempo estimado
                      </div>
                      <p className="mt-2 text-sm font-semibold text-foreground">{formatRouteDurationHours(effectiveEstimatedHours)}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/60 bg-muted/20 shadow-none">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        <CreditCard className="h-3.5 w-3.5 text-primary" />
                        Valor padrão
                      </div>
                      <p className="mt-2 text-sm font-semibold text-foreground">
                        {formatRouteCurrency(detailRoute.valor_padrao, "Sem valor padrão")}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Bonus: {formatRouteCurrency(detailRoute.bonus_padrao, "Sem bônus padrão")}
                      </p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/60 bg-muted/20 shadow-none">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        <Truck className="h-3.5 w-3.5 text-primary" />
                        Perfil sugerido
                      </div>
                      <p className="mt-2 text-sm font-semibold text-foreground">{detailRoute.perfil_padrao || "Não definido"}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/60 bg-muted/20 shadow-none">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                        Atualizacao
                      </div>
                      <p className="mt-2 text-sm font-semibold text-foreground">{updatedAtLabel}</p>
                    </CardContent>
                  </Card>
                </div>
                <div className="rounded-[24px] border border-border/60 bg-white/80 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary/60">Observações da rota</p>
                  <p className="mt-3 text-sm leading-relaxed text-foreground">{routeObservations}</p>
                </div>
              </>
            );
          })() : null}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ManageRoutes;
