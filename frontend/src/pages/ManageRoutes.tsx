import { useDeferredValue, useEffect, useMemo, useState } from "react";
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
  Truck,
} from "lucide-react";
import { toast } from "sonner";

import AdminPagination from "@/components/AdminPagination";
import RouteModal, { type RouteFormData, type RouteTarifaFormRow } from "@/components/RouteModal";
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
import { confirmAction } from "@/lib/confirm";
import { formatVehicleProfileLabel } from "@/lib/vehicleProfiles";
import { canWriteOperatorRoutes, getOperatorAccessLevel, getOperatorAccessLevelLabel } from "@/lib/operatorAccess";
import {
  formatRouteCurrency,
  formatRouteDurationHours,
  formatRouteMetric,
  parseMoneyInput,
  parseOptionalNumber,
  trimTextOrNull,
} from "@/lib/routeCatalog";
import { attachClienteRota, saveRouteTrecho, type RouteTrechoPayload } from "@/services/operatorAdmin";
import { fetchOperatorClientes, fetchOperatorRoutes, type OperatorRouteListItem } from "@/services/readModels";

// Uma rota do painel = um trecho (origem→destino) com N tarifas por veículo.
// As linhas planas de route_metrics_cache (uma por perfil+eixos) são agrupadas
// aqui por trecho — o read-model continua devolvendo flat (assignableRoutes usa).
interface RouteTrechoGroup {
  key: string;
  origem: string;
  destino: string;
  distancia_km: number | null;
  duracao_horas: number | null;
  tempo_estimado_horas: number | null;
  ativa: boolean;
  cliente_id: string | null;
  rota_id: string | null;
  base_route_label: string | null;
  source: "base" | "base+db" | "db";
  persisted: boolean;
  updated_at: string | null;
  tarifas: OperatorRouteListItem[];
}

const ROUTES_QUERY_KEY = ["admin", "routes-read-model"] as const;
const GROUPS_PER_PAGE = 8;
// Catálogo de rotas é pequeno e limitado (base + manuais). Buscamos tudo e
// agrupamos/paginamos por trecho no cliente — evita um trecho ser partido
// entre páginas do servidor (que pagina linhas planas).
const FETCH_PAGE_SIZE = "200";

function groupRoutesByTrecho(items: OperatorRouteListItem[]): RouteTrechoGroup[] {
  const groups = new Map<string, RouteTrechoGroup>();

  for (const item of items) {
    const key = `${item.origin_key}|${item.destination_key}`;
    let group = groups.get(key);

    if (!group) {
      group = {
        key,
        origem: item.origem,
        destino: item.destino,
        distancia_km: item.distancia_km,
        duracao_horas: item.duracao_horas,
        tempo_estimado_horas: item.tempo_estimado_horas,
        ativa: item.ativa,
        cliente_id: item.cliente_id ?? null,
        rota_id: item.rota_id ?? null,
        base_route_label: item.base_route_label ?? null,
        source: item.source,
        persisted: item.persisted,
        updated_at: item.updated_at,
        tarifas: [],
      };
      groups.set(key, group);
    }

    // Métricas do trecho: prefere valores não-nulos de qualquer variante.
    group.distancia_km = group.distancia_km ?? item.distancia_km;
    group.duracao_horas = group.duracao_horas ?? item.duracao_horas;
    group.tempo_estimado_horas = group.tempo_estimado_horas ?? item.tempo_estimado_horas;
    group.cliente_id = group.cliente_id ?? item.cliente_id ?? null;
    group.rota_id = group.rota_id ?? item.rota_id ?? null;
    group.base_route_label = group.base_route_label ?? item.base_route_label ?? null;
    group.ativa = group.ativa || item.ativa;
    group.persisted = group.persisted || item.persisted;
    if (item.source === "db" || item.source === "base+db") group.source = item.source;

    // Só linhas com perfil definido são tarifas reais (rotas base sem perfil não).
    if (item.perfil_padrao) {
      group.tarifas.push(item);
    }
  }

  return Array.from(groups.values());
}

function mapGroupToFormData(group: RouteTrechoGroup): RouteFormData {
  const tarifas: RouteTarifaFormRow[] = group.tarifas.map((tarifa) => ({
    key: crypto.randomUUID(),
    perfil: tarifa.perfil_padrao || "CARRETA",
    eixos: tarifa.eixos ?? 0,
    valor: tarifa.valor_padrao !== null ? String(tarifa.valor_padrao) : "",
    bonus: tarifa.bonus_padrao !== null ? String(tarifa.bonus_padrao) : "",
    bonus_exigencias: tarifa.bonus_exigencias ?? "",
  }));

  return {
    origem: group.origem,
    destino: group.destino,
    distancia_km: group.distancia_km !== null ? String(group.distancia_km) : "",
    tempo_estimado_horas:
      group.tempo_estimado_horas !== null
        ? String(group.tempo_estimado_horas)
        : group.duracao_horas !== null
        ? String(group.duracao_horas)
        : "",
    ativa: group.ativa,
    cliente_id: group.cliente_id,
    tarifas,
  };
}

const ManageRoutes = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ativas");
  const [clienteFilter, setClienteFilter] = useState("todos");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<RouteTrechoGroup | null>(null);
  const [detailGroup, setDetailGroup] = useState<RouteTrechoGroup | null>(null);
  const [page, setPage] = useState(1);
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());

  useEffect(() => {
    setPage(1);
  }, [deferredSearch, statusFilter, clienteFilter]);

  const { data, error, isFetching, isLoading } = useQuery({
    queryKey: [...ROUTES_QUERY_KEY, deferredSearch, statusFilter, clienteFilter],
    queryFn: () =>
      fetchOperatorRoutes({
        page: "1",
        pageSize: FETCH_PAGE_SIZE,
        search: deferredSearch,
        status: statusFilter,
        ...(clienteFilter && clienteFilter !== "todos" ? { clienteId: clienteFilter } : {}),
      }),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: keepPreviousData,
  });

  const { data: clientesData } = useQuery({
    queryKey: ["admin", "clientes-options-for-routes"] as const,
    queryFn: () => fetchOperatorClientes({ page: "1", pageSize: "200" }),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const clienteOptions = (clientesData?.items ?? [])
    .map((c) => ({ id: c.id, nome: c.nome }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

  useEffect(() => {
    if (error) {
      toast.error("Erro ao carregar rotas");
    }
  }, [error]);

  const allGroups = useMemo(() => groupRoutesByTrecho(data?.items ?? []), [data?.items]);
  const totalGroups = allGroups.length;
  const totalPages = Math.max(Math.ceil(totalGroups / GROUPS_PER_PAGE), 1);
  const currentPage = Math.min(page, totalPages);
  const pageGroups = allGroups.slice((currentPage - 1) * GROUPS_PER_PAGE, currentPage * GROUPS_PER_PAGE);

  const operatorAccessLevel = getOperatorAccessLevel(user);
  const canManageRoutes = canWriteOperatorRoutes(user);
  const supportsCatalogFields = data?.supportsCatalogFields ?? true;
  const activeGroups = allGroups.filter((group) => group.ativa).length;
  const baseGroups = allGroups.filter((group) => group.source === "base" || group.source === "base+db").length;
  const loading = isLoading && !data;
  const isRefreshing = isFetching && !loading;

  const refreshRoutes = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ROUTES_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ["admin", "assignable-routes"] }),
      queryClient.invalidateQueries({ queryKey: ["admin", "cargas-read-model"] }),
      queryClient.invalidateQueries({ queryKey: ["operator", "dashboard-read-model"] }),
      queryClient.invalidateQueries({ queryKey: ["driver", "loads-read-model"] }),
      queryClient.invalidateQueries({ queryKey: ["driver", "loads-facets"] }),
    ]);
  };

  const handleSave = async (formData: RouteFormData) => {
    if (!canManageRoutes) {
      toast.error("Seu acesso nesta area e somente leitura.");
      return;
    }

    const originValue = formData.origem.trim();
    const destinationValue = formData.destino.trim();

    if (!originValue || !destinationValue) {
      toast.error("Informe origem e destino da rota.");
      return;
    }

    const distanciaKm = parseOptionalNumber(formData.distancia_km);
    const tempoEstimadoHoras = parseOptionalNumber(formData.tempo_estimado_horas);

    if (distanciaKm === null) {
      toast.error("Informe a distância da rota.");
      return;
    }

    if (tempoEstimadoHoras === null) {
      toast.error("Informe o tempo estimado da rota.");
      return;
    }

    if (formData.tarifas.length === 0) {
      toast.error("Cadastre ao menos uma tarifa (perfil + valor).");
      return;
    }

    // (perfil + eixos) é a identidade da tarifa; duplicata seria ambígua.
    const dedupeKeys = formData.tarifas.map((tarifa) => `${tarifa.perfil}|${tarifa.eixos}`);
    if (new Set(dedupeKeys).size !== dedupeKeys.length) {
      toast.error("Há tarifas repetidas (mesmo perfil e nº de eixos).");
      return;
    }

    const confirmTitle = editingGroup ? "Salvar alterações desta rota?" : "Cadastrar esta nova rota?";
    if (!confirmAction(confirmTitle)) {
      return;
    }

    const payload: RouteTrechoPayload = {
      origem: originValue,
      destino: destinationValue,
      distancia_km: distanciaKm,
      duracao_horas: tempoEstimadoHoras,
      tempo_estimado_horas: tempoEstimadoHoras,
      ativa: formData.ativa,
      observacoes: null,
      tarifas: formData.tarifas.map((tarifa) => ({
        perfil: tarifa.perfil,
        eixos: tarifa.eixos,
        valor: parseMoneyInput(tarifa.valor),
        bonus: parseMoneyInput(tarifa.bonus),
        bonus_exigencias: trimTextOrNull(tarifa.bonus_exigencias),
      })),
    };

    let savedRouteId: string | null = null;
    let cascadedCargaCount = 0;

    try {
      const response = await saveRouteTrecho(payload);
      response.warnings?.forEach((warning) => toast.warning(warning));
      savedRouteId = response.rota_id ?? editingGroup?.rota_id ?? null;
      cascadedCargaCount = response.cascadedCargaCount ?? 0;
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : "Erro ao salvar rota");
      return;
    }

    if (formData.cliente_id && savedRouteId) {
      try {
        const attachResult = await attachClienteRota(formData.cliente_id, savedRouteId);
        if (attachResult.transferred) {
          toast.info("Rota transferida para o novo cliente.");
        } else if (!attachResult.already_attached) {
          toast.success("Rota vinculada ao cliente.");
        }
      } catch (attachError) {
        toast.error(attachError instanceof Error ? attachError.message : "Rota salva, mas falha ao vincular cliente.");
      }
    }

    if (cascadedCargaCount > 0) {
      toast.success(
        `Rota salva! ${cascadedCargaCount} carga${cascadedCargaCount > 1 ? "s" : ""} aberta${cascadedCargaCount > 1 ? "s" : ""} ${cascadedCargaCount > 1 ? "foram atualizadas" : "foi atualizada"} automaticamente.`,
      );
    } else {
      toast.success(editingGroup ? "Rota atualizada!" : "Rota cadastrada!");
    }

    setModalOpen(false);
    setEditingGroup(null);
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
                  Rotas com distância, tempo estimado e tarifa por veículo
                </h2>
              </div>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                Cada rota reúne origem, destino, distância e uma tarifa (valor + bônus) para cada tipo de veículo que roda no trecho.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Card className="border-primary/10 bg-primary/5 shadow-none">
                <CardContent className="p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary/70">Trechos</p>
                  <p className="mt-2 text-3xl font-black tracking-tight text-primary">{totalGroups}</p>
                </CardContent>
              </Card>
              <Card className="border-border/70 bg-white/80 shadow-none">
                <CardContent className="p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">Ativos</p>
                  <p className="mt-2 text-3xl font-black tracking-tight text-foreground">{activeGroups}</p>
                </CardContent>
              </Card>
              <Card className="border-border/70 bg-white/80 shadow-none">
                <CardContent className="p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">Base da planilha</p>
                  <p className="mt-2 text-3xl font-black tracking-tight text-foreground">{baseGroups}</p>
                </CardContent>
              </Card>
            </div>
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
                placeholder="Pesquisar por origem, destino, perfil ou observação..."
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

            <select
              value={clienteFilter}
              onChange={(event) => setClienteFilter(event.target.value)}
              className="h-12 rounded-2xl border border-border/80 bg-white/92 px-4 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
              aria-label="Filtrar por cliente"
            >
              <option value="todos">Todos os clientes</option>
              <option value="sem-cliente">Sem cliente vinculado</option>
              {clienteOptions.map((cliente) => (
                <option key={cliente.id} value={cliente.id}>
                  {cliente.nome}
                </option>
              ))}
            </select>

            {canManageRoutes ? (
              <button
                type="button"
                onClick={() => {
                  setEditingGroup(null);
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
            Seu perfil pode visualizar todo o catálogo operacional, mas apenas operadores com acesso avançado podem criar ou editar rotas padrão.
          </section>
        ) : null}

        {loading ? (
          <div className="grid gap-4 xl:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={`route-loading-${index}`} className="h-[320px] rounded-[28px]" />
            ))}
          </div>
        ) : totalGroups === 0 ? (
          <section className="admin-panel flex min-h-[260px] flex-col items-center justify-center gap-4 p-10 text-center">
            <Route className="h-14 w-14 text-muted-foreground/35" />
            <div className="space-y-1">
              <p className="text-lg font-bold text-foreground">Nenhuma rota encontrada</p>
              <p className="text-sm text-muted-foreground">Ajuste os filtros ou cadastre uma nova rota padrão para a operação.</p>
            </div>
          </section>
        ) : (
          <section className="grid gap-4 xl:grid-cols-2">
            {pageGroups.map((group) => (
              <article
                key={group.key}
                className="admin-panel overflow-hidden rounded-[28px] border border-white/80 bg-white/92 p-5 shadow-[0_24px_60px_-40px_hsl(215_25%_12%/0.24)]"
              >
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-2">
                        <Badge className={group.ativa ? "bg-accent/10 text-accent" : "bg-muted text-muted-foreground"}>
                          {group.ativa ? "Ativa" : "Inativa"}
                        </Badge>
                        {group.source === "base" || group.source === "base+db" ? (
                          <Badge className="bg-primary/10 text-primary">Base da planilha</Badge>
                        ) : (
                          <Badge className="bg-slate-100 text-slate-700">Manual</Badge>
                        )}
                        <Badge variant="outline" className="border-border/60 bg-white/70 text-foreground">
                          {group.tarifas.length} {group.tarifas.length === 1 ? "veículo" : "veículos"}
                        </Badge>
                      </div>

                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary/60">Trecho padrão</p>
                        <h3 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                          {group.origem} {"→"} {group.destino}
                        </h3>
                        {group.base_route_label ? (
                          <p className="mt-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                            {group.base_route_label}
                          </p>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setDetailGroup(group)}
                        className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-border/80 bg-white/80 px-4 text-sm font-semibold text-foreground transition-colors duration-200 hover:bg-muted dark:bg-muted/40"
                      >
                        Detalhes
                      </button>
                      {canManageRoutes ? (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingGroup(group);
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

                  {group.tarifas.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {group.tarifas.map((tarifa) => (
                        <div
                          key={tarifa.id}
                          className="flex items-center gap-2 rounded-xl border border-border/60 bg-secondary/50 px-3 py-1.5"
                        >
                          <Truck className="h-3.5 w-3.5 text-primary/70" />
                          <span className="text-xs font-semibold text-foreground">
                            {formatVehicleProfileLabel(tarifa.perfil_padrao)}
                            {tarifa.eixos ? ` · ${tarifa.eixos}e` : ""}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatRouteCurrency(tarifa.valor_padrao, "sem valor")}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-xl border border-dashed border-border/70 bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
                      Nenhuma tarifa cadastrada ainda — edite a rota para adicionar valores por veículo.
                    </p>
                  )}
                </div>
              </article>
            ))}
          </section>
        )}

        <AdminPagination
          page={currentPage}
          totalPages={totalPages}
          totalCount={totalGroups}
          pageSize={GROUPS_PER_PAGE}
          itemLabel={`rota${totalGroups === 1 ? "" : "s"}`}
          isFetching={isRefreshing}
          onPrevious={() => setPage((prev) => Math.max(prev - 1, 1))}
          onNext={() => setPage((prev) => Math.min(prev + 1, totalPages))}
        />
      </main>

      {canManageRoutes ? (
        <RouteModal
          open={modalOpen}
          onClose={() => {
            setModalOpen(false);
            setEditingGroup(null);
          }}
          onSave={handleSave}
          supportsCatalogFields={supportsCatalogFields}
          initialData={editingGroup ? mapGroupToFormData(editingGroup) : null}
          clientes={clienteOptions}
        />
      ) : null}

      <Dialog open={detailGroup !== null} onOpenChange={(open) => !open && setDetailGroup(null)}>
        <DialogContent className="max-w-3xl">
          {detailGroup ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {detailGroup.origem} {"→"} {detailGroup.destino}
                </DialogTitle>
                <DialogDescription>
                  {detailGroup.ativa ? "Rota ativa" : "Rota inativa"} · {detailGroup.tarifas.length}{" "}
                  {detailGroup.tarifas.length === 1 ? "veículo cadastrado" : "veículos cadastrados"}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-3 sm:grid-cols-3">
                <Card className="border-border/60 bg-muted/20 shadow-none">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      <MapPinned className="h-3.5 w-3.5 text-primary" />
                      Distância
                    </div>
                    <p className="mt-2 text-sm font-semibold text-foreground">{formatRouteMetric(detailGroup.distancia_km, "km")}</p>
                  </CardContent>
                </Card>
                <Card className="border-border/60 bg-muted/20 shadow-none">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      <Navigation className="h-3.5 w-3.5 text-primary" />
                      Duração
                    </div>
                    <p className="mt-2 text-sm font-semibold text-foreground">{formatRouteDurationHours(detailGroup.duracao_horas)}</p>
                  </CardContent>
                </Card>
                <Card className="border-border/60 bg-muted/20 shadow-none">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      <Clock3 className="h-3.5 w-3.5 text-primary" />
                      Tempo estimado
                    </div>
                    <p className="mt-2 text-sm font-semibold text-foreground">
                      {formatRouteDurationHours(detailGroup.tempo_estimado_horas ?? detailGroup.duracao_horas)}
                    </p>
                  </CardContent>
                </Card>
              </div>

              <div className="mt-2 overflow-hidden rounded-2xl border border-border/60">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/40 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2.5">Veículo</th>
                      <th className="px-4 py-2.5">Eixos</th>
                      <th className="px-4 py-2.5">Valor</th>
                      <th className="px-4 py-2.5">Bônus</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailGroup.tarifas.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="px-4 py-4 text-center text-xs text-muted-foreground">
                          Nenhuma tarifa cadastrada.
                        </td>
                      </tr>
                    ) : (
                      detailGroup.tarifas.map((tarifa) => (
                        <tr key={tarifa.id} className="border-t border-border/50">
                          <td className="px-4 py-2.5 font-medium text-foreground">
                            <span className="inline-flex items-center gap-1.5">
                              <Truck className="h-3.5 w-3.5 text-primary/70" />
                              {formatVehicleProfileLabel(tarifa.perfil_padrao)}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">{tarifa.eixos ? `${tarifa.eixos} eixos` : "—"}</td>
                          <td className="px-4 py-2.5 font-semibold text-foreground">
                            <span className="inline-flex items-center gap-1.5">
                              <CreditCard className="h-3.5 w-3.5 text-primary/70" />
                              {formatRouteCurrency(tarifa.valor_padrao, "Sem valor")}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground">{formatRouteCurrency(tarifa.bonus_padrao, "—")}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ManageRoutes;
