import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  AlertTriangle,
  Copy,
  CreditCard,
  ExternalLink,
  Link2,
  MapPinned,
  Package,
  Route,
  Search,
  Truck,
} from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import DashboardHeader from "@/components/DashboardHeader";
import {
  fetchAssignableRoutes,
  resolveAssignableRouteForCargo,
} from "@/lib/assignableRoutes";
import { resolveCargoPublicationReadiness } from "@/lib/loadPublication";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { buildCargoPublicPath, buildCargoShareUrl } from "@/lib/cargoLinks";
import { formatCargoStatusLabel } from "@/lib/cargoStatus";
import { formatCurrency, buildTotalPayment } from "@/lib/currency";
import { buildLoadingDateTime, buildOperationalDateLabel, formatEstimatedTime } from "@/lib/estimatedTime";
import { formatCityDisplay } from "@/hooks/useDriverLoads";
import {
  type OperatorDashboardItem,
  fetchOperatorClientes,
  fetchOperatorDashboard,
} from "@/services/readModels";

const OPEN_STATUS = "OPEN";
const PAGE_SIZE = 8;
const ROUTES_QUERY_KEY = ["admin", "assignable-routes"] as const;
const ADMIN_ROUTES_QUERY_OPTIONS = {
  staleTime: 60_000,
  gcTime: 10 * 60_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  placeholderData: keepPreviousData,
} as const;

function formatMaybeText(value?: string | null, fallback = "Não informado") {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : fallback;
}

function buildRouteMetric(value: number | null, unit: string, prefix = "") {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "A confirmar";
  }

  return `${prefix}${value.toLocaleString("pt-BR", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  })} ${unit}`;
}

function buildPaymentBreakdownLabel({
  valor,
  bonus,
  total,
  source,
}: {
  valor: number | null;
  bonus: number | null;
  total: number | null;
  source: "cargo" | "route" | "mixed" | "none";
}) {
  if (total === null) {
    return "Sem valor e bônus configurados";
  }

  if (typeof bonus === "number" && bonus > 0) {
    if (typeof valor === "number" && Number.isFinite(valor)) {
      return `Base ${formatCurrency(valor)} + bônus ${formatCurrency(bonus)}`;
    }

    return `Bônus ${formatCurrency(bonus)} liberado`;
  }

  if (source === "route" || source === "mixed") {
    return "Valor padrão da rota atribuído";
  }

  return "Sem bônus configurado";
}

function LoadingGrid() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={`operator-card-${index}`} className="h-[420px] rounded-[28px]" />
      ))}
    </div>
  );
}

function PaginationControls({
  page,
  totalPages,
  totalCount,
  pageSize,
  isFetching,
  onPrevious,
  onNext,
}: {
  page: number;
  totalPages: number;
  totalCount: number;
  pageSize: number;
  isFetching: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  if (totalCount === 0) {
    return null;
  }

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalCount);

  return (
    <div className="admin-card-surface mt-5 flex flex-col gap-3 rounded-[28px] border px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-semibold text-foreground">
          Exibindo {start} a {end} de {totalCount} carga{totalCount === 1 ? "" : "s"}
        </p>
        <p className="text-xs text-muted-foreground">
          Página {page} de {Math.max(totalPages, 1)}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="rounded-full"
          onClick={onPrevious}
          disabled={page <= 1 || isFetching}
        >
          Anterior
        </Button>
        <Button
          type="button"
          className="rounded-full"
          onClick={onNext}
          disabled={page >= totalPages || isFetching}
        >
          Próxima
        </Button>
      </div>
    </div>
  );
}

const OperatorDashboard = () => {
  const [search, setSearch] = useState("");
  const [clienteFilter, setClienteFilter] = useState("");
  const [page, setPage] = useState(1);
  const [detailCargo, setDetailCargo] = useState<OperatorDashboardItem | null>(null);
  // Gerador de link por rota (origem/destino → /motorista?origem=..&destino=..).
  const [routeOrigem, setRouteOrigem] = useState("");
  const [routeDestino, setRouteDestino] = useState("");
  const [routeLinkCopied, setRouteLinkCopied] = useState(false);
  // Debounce de busca para evitar disparar um refetch por keystroke. useDeferredValue
  // só adia render — não gate fetch. 300ms é o sweet spot para typing humano.
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const deferredSearch = useDeferredValue(debouncedSearch);
  const deferredClienteFilter = useDeferredValue(clienteFilter);
  const hasActiveFilters = deferredSearch.length > 0 || deferredClienteFilter.length > 0;

  useEffect(() => {
    setPage(1);
  }, [deferredSearch, deferredClienteFilter]);

  const {
    data,
    error,
    isFetching,
    isLoading,
  } = useQuery({
    // onlyOpenToDrivers: a tela de Links mostra SOMENTE cargas abertas ao
    // motorista (espelha o portal) — fechadas/reservadas/expiradas/alocadas
    // não aparecem, evitando compartilhar link de carga indisponível.
    queryKey: ["operator", "dashboard-read-model", "open-to-drivers", deferredSearch, deferredClienteFilter, page],
    queryFn: () =>
      fetchOperatorDashboard({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        search: deferredSearch,
        onlyOpenToDrivers: "true",
        ...(deferredClienteFilter ? { clienteId: deferredClienteFilter } : {}),
      }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const {
    data: routes = [],
    error: routesError,
    isFetching: routesFetching,
  } = useQuery({
    queryKey: ROUTES_QUERY_KEY,
    queryFn: fetchAssignableRoutes,
    ...ADMIN_ROUTES_QUERY_OPTIONS,
  });

  // Origens/destinos de TODAS as rotas do catálogo (não só das cargas abertas)
  // — alimentam os selects do gerador de link por rota. O valor é a parte
  // canônica do base_route_label ("ORIGEM X DESTINO", ASCII maiúsculo): é
  // contra ela que o filtro do portal casa por substring. Rotas sem label
  // canônico caem no origem/destino sem o sufixo "/UF" (best-effort).
  const { origens: routeOrigemOptions, destinos: routeDestinoOptions } = useMemo(() => {
    const origens = new Map<string, string>();
    const destinos = new Map<string, string>();
    const add = (map: Map<string, string>, raw: string | null | undefined) => {
      const value = (raw ?? "").replace(/\s*\/\s*[A-Za-z]{2}\s*$/, "").trim().toUpperCase();
      if (value && !map.has(value)) map.set(value, formatCityDisplay(value));
    };
    routes.forEach((route) => {
      if (route.base_route_label?.includes(" X ")) {
        const [origin, destination] = route.base_route_label.split(" X ");
        add(origens, origin);
        add(destinos, destination);
      } else {
        add(origens, route.origem);
        add(destinos, route.destino);
      }
    });
    const toSorted = (map: Map<string, string>) =>
      Array.from(map.entries())
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
    return { origens: toSorted(origens), destinos: toSorted(destinos) };
  }, [routes]);

  const { data: clientesData } = useQuery({
    queryKey: ["operator", "clientes-selector"],
    queryFn: () => fetchOperatorClientes({ pageSize: "200" }),
    staleTime: 5 * 60_000,
  });
  const clienteOptions = clientesData?.items ?? [];

  useEffect(() => {
    if (error) {
      toast.error("Erro ao carregar o painel do operador");
    }
  }, [error]);

  useEffect(() => {
    if (routesError) {
      toast.error("Erro ao carregar o catálogo de rotas");
    }
  }, [routesError]);

  const cargos = useMemo(() => data?.items ?? [], [data?.items]);
  // Memoiza derivação cargo×routes (route match + publication readiness +
  // share URLs) — evita recomputação O(N·R) em cada keystroke/render.
  // Recalcula apenas quando cargos ou routes mudam.
  const cargoComputed = useMemo(() => {
    if (typeof window === "undefined") return [];
    const origin = window.location.origin;
    return cargos.map((cargo: OperatorDashboardItem) => {
      const matchedRoute = resolveAssignableRouteForCargo(routes, {
        route_key: "",
        origem: cargo.origem,
        destino: cargo.destino,
      });
      const publication = resolveCargoPublicationReadiness(
        {
          perfil: cargo.perfil,
          valor: cargo.valor,
          bonus: cargo.bonus,
          distancia_km: cargo.distancia_km,
          duracao_horas: cargo.duracao_horas,
        },
        matchedRoute,
      );
      const loadingDate = buildLoadingDateTime(cargo.sheet_data_carregamento, cargo.data, cargo.horario);
      const sharePath = buildCargoPublicPath(cargo.id);
      const shareUrl = buildCargoShareUrl(origin, cargo.id);
      const totalPayment =
        publication.totalPayment !== null ? publication.totalPayment : buildTotalPayment(cargo.valor, cargo.bonus);
      const distanceKm = publication.distancia_km;
      const durationHours = publication.tempo_estimado_horas ?? publication.duracao_horas;
      const isShareReady = cargo.status === OPEN_STATUS && !cargo.is_template && publication.isReady;
      return {
        cargo,
        matchedRoute,
        publication,
        loadingDate,
        sharePath,
        shareUrl,
        totalPayment,
        distanceKm,
        durationHours,
        isShareReady,
      };
    });
  }, [cargos, routes]);
  const summary = data?.summary || {
    activeCount: 0,
    draftCount: 0,
    templateCount: 0,
  };
  const meta = data?.meta || {
    page,
    pageSize: PAGE_SIZE,
    totalCount: 0,
    totalPages: 1,
    hasNextPage: false,
    maxPageSize: PAGE_SIZE,
    correlationId: "",
  };
  const loading = isLoading && !cargos.length;

  const copyText = async (value: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(successMessage);
    } catch {
      toast.error("Não foi possível copiar agora");
    }
  };

  // Link da ROTA no portal do motorista. Aceita rota parcial (só origem ou só
  // destino). Vazio quando nenhum dos dois foi escolhido.
  const routeShareUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    if (!routeOrigem && !routeDestino) return "";
    const params = new URLSearchParams();
    if (routeOrigem) params.set("origem", routeOrigem);
    if (routeDestino) params.set("destino", routeDestino);
    return `${window.location.origin}/motorista?${params.toString()}`;
  }, [routeOrigem, routeDestino]);

  const copyRouteLink = async () => {
    if (!routeShareUrl) return;
    try {
      await navigator.clipboard.writeText(routeShareUrl);
      setRouteLinkCopied(true);
      setTimeout(() => setRouteLinkCopied(false), 2000);
      toast.success("Link da rota copiado");
    } catch {
      toast.error("Não foi possível copiar agora");
    }
  };

  return (
    <div>
      <DashboardHeader title="Links" />

      <main className="space-y-5 p-6 lg:p-8">
        <section className="admin-panel overflow-hidden p-5 lg:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div className="space-y-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-primary/60">Distribuição de links</p>
                <h2 className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
                  Central para compartilhar cargas específicas com o motorista
                </h2>
              </div>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                Envie o link de uma carga específica diretamente para o motorista. Ao acessar, ele verá os detalhes e poderá se candidatar.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Card className="border-primary/10 bg-primary/5 shadow-none">
                <CardContent className="p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary/70">Ativas</p>
                  <p className="mt-2 text-3xl font-black tracking-tight text-primary">{summary.activeCount}</p>
                </CardContent>
              </Card>
              <Card className="border-border/70 bg-white/80 shadow-none">
                <CardContent className="p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-muted-foreground">Rascunhos</p>
                  <p className="mt-2 text-3xl font-black tracking-tight text-foreground">{summary.draftCount}</p>
                </CardContent>
              </Card>
            </div>
          </div>

          <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Pesquisar por ID, cliente, origem, destino ou perfil..."
                className="h-12 rounded-2xl border-border/80 bg-white/92 pl-11 pr-4"
              />
            </div>

            <select
              value={clienteFilter}
              onChange={(event) => setClienteFilter(event.target.value)}
              className="h-12 rounded-2xl border border-border/80 bg-white/92 px-4 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
            >
              <option value="">Todos os clientes</option>
              {clienteOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.nome}</option>
              ))}
            </select>

            <Button
              type="button"
              variant="outline"
              className="h-12 rounded-2xl"
              onClick={() => {
                setSearch("");
                setClienteFilter("");
              }}
              disabled={!hasActiveFilters}
            >
              Limpar filtros
            </Button>
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            Mostrando apenas cargas abertas ao motorista (as fechadas, reservadas, expiradas ou já alocadas não aparecem aqui).
          </p>

          {(isFetching || routesFetching) && !loading ? (
            <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-primary/12 bg-primary/8 px-3 py-1 text-xs font-semibold text-primary">
              Atualizando página do painel
            </div>
          ) : null}
        </section>

        {/* Gerador de link por ROTA — operador escolhe origem/destino e copia o
            link do portal com o filtro de rota já aplicado. */}
        <section className="admin-panel overflow-hidden p-5 lg:p-6">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Route className="h-5 w-5" />
            </span>
            <div className="space-y-1">
              <h3 className="text-lg font-semibold tracking-tight text-foreground">Link por rota</h3>
              <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Escolha origem e/ou destino e gere um link que abre o portal do motorista já filtrado por essa rota.
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Origem</label>
              <select
                value={routeOrigem}
                onChange={(event) => setRouteOrigem(event.target.value)}
                className="h-12 w-full rounded-2xl border border-border/80 bg-white/92 px-4 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
              >
                <option value="">Todas as origens</option>
                {routeOrigemOptions.map((origem) => (
                  <option key={origem.value} value={origem.value}>{origem.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Destino</label>
              <select
                value={routeDestino}
                onChange={(event) => setRouteDestino(event.target.value)}
                className="h-12 w-full rounded-2xl border border-border/80 bg-white/92 px-4 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10"
              >
                <option value="">Todos os destinos</option>
                {routeDestinoOptions.map((destino) => (
                  <option key={destino.value} value={destino.value}>{destino.label}</option>
                ))}
              </select>
            </div>
          </div>

          {routeShareUrl ? (
            <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-border/70 bg-muted/20 p-4 lg:flex-row lg:items-center lg:justify-between">
              <code className="break-all text-xs text-foreground/80 lg:text-sm">{routeShareUrl}</code>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button type="button" variant="outline" className="rounded-full" onClick={() => void copyRouteLink()}>
                  <Link2 className="h-4 w-4" />
                  {routeLinkCopied ? "Copiado!" : "Copiar link"}
                </Button>
                <Button asChild className="rounded-full">
                  <a href={routeShareUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4" />
                    Abrir
                  </a>
                </Button>
              </div>
            </div>
          ) : (
            <p className="mt-4 rounded-2xl border border-dashed border-border/70 bg-muted/10 px-4 py-3 text-sm text-muted-foreground">
              Selecione uma origem e/ou um destino para gerar o link da rota.
            </p>
          )}
        </section>

        {loading ? (
          <LoadingGrid />
        ) : cargos.length === 0 ? (
          <section className="admin-panel flex min-h-[260px] flex-col items-center justify-center gap-4 p-10 text-center">
            <Package className="h-14 w-14 text-muted-foreground/35" />
            <div className="space-y-1">
              <p className="text-lg font-bold text-foreground">Nenhuma carga encontrada</p>
              <p className="text-sm text-muted-foreground">
                {hasActiveFilters
                  ? "Ajuste os filtros para encontrar a carga ou o cliente que você quer compartilhar."
                  : "Ajuste a busca para encontrar a carga ou o cliente que você quer compartilhar."}
              </p>
            </div>
          </section>
        ) : (
          <>
            <section className="grid gap-4 xl:grid-cols-2">
              {cargoComputed.map(({ cargo, publication, sharePath, shareUrl, isShareReady }) => {
                return (
                  <article
                    key={cargo.id}
                    className="admin-panel overflow-hidden rounded-[28px] border border-white/80 bg-white/92 p-5 shadow-[0_24px_60px_-40px_hsl(215_25%_12%/0.24)]"
                  >
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-3">
                          <div className="flex flex-wrap gap-2">
                            <Badge className={cargo.status === OPEN_STATUS ? "bg-accent/10 text-accent" : "bg-muted text-muted-foreground"}>
                              {formatCargoStatusLabel(cargo.status)}
                            </Badge>
                            {!publication.isReady ? <Badge className="bg-amber-100 text-amber-900">Pendente no portal</Badge> : null}
                            <Badge
                              className={
                                cargo.driver_visibility === "PREMIUM"
                                  ? "bg-[hsl(34_94%_52%/0.12)] text-[hsl(28_92%_45%)]"
                                  : "bg-sky-100 text-sky-800"
                              }
                            >
                              {cargo.driver_visibility === "PREMIUM" ? "Premium" : "Pública"}
                            </Badge>
                            <Badge variant="outline" className="border-border/60 bg-white/70 text-foreground">
                              {cargo.sheet_lh ? `LH ${cargo.sheet_lh}` : `ID ${cargo.id}`}
                            </Badge>
                          </div>

                          <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary/60">Carga específica</p>
                            <h3 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                              {cargo.origem} {"\u2192"} {cargo.destino}
                            </h3>
                            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                              Cliente: {formatMaybeText(cargo.cliente?.nome, "Não vinculado")} | Perfil: {publication.perfil || "A confirmar"}
                            </p>
                          </div>

                          {!publication.isReady ? (
                            <div className="admin-tint-warning rounded-[22px] border p-4 shadow-none">
                              <div className="flex items-start gap-3">
                                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-700">
                                  <AlertTriangle className="h-4 w-4" />
                                </span>
                                <div className="space-y-1">
                                  <p className="text-sm font-semibold">Publicacao pausada para motorista</p>
                                  <p className="text-xs leading-relaxed text-amber-900/80">
                                    {publication.alertSummary || "Complete os dados da carga antes de compartilhar este link."}
                                  </p>
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            className="rounded-full"
                            onClick={() => void copyText(cargo.id, "ID da carga copiado")}
                          >
                            <Copy className="h-4 w-4" />
                            Copiar ID
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            className="rounded-full"
                            disabled={!isShareReady}
                            onClick={() => void copyText(shareUrl, "Link direto copiado")}
                          >
                            <Link2 className="h-4 w-4" />
                            Copiar link
                          </Button>
                          {isShareReady ? (
                            <Button asChild className="rounded-full">
                              <Link to={sharePath} target="_blank" rel="noreferrer">
                                <ExternalLink className="h-4 w-4" />
                                Abrir carga
                              </Link>
                            </Button>
                          ) : (
                            <Button type="button" className="rounded-full" disabled>
                              <ExternalLink className="h-4 w-4" />
                              Abrir carga
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="outline"
                            className="rounded-full"
                            onClick={() => setDetailCargo(cargo)}
                          >
                            Detalhes
                          </Button>
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </section>

            <PaginationControls
              page={meta.page}
              totalPages={meta.totalPages}
              totalCount={meta.totalCount}
              pageSize={meta.pageSize}
              isFetching={isFetching}
              onPrevious={() => setPage((currentPage) => Math.max(currentPage - 1, 1))}
              onNext={() => setPage((currentPage) => Math.min(currentPage + 1, meta.totalPages))}
            />
          </>
        )}
      </main>

      <Dialog open={detailCargo !== null} onOpenChange={(open) => !open && setDetailCargo(null)}>
        <DialogContent className="max-w-3xl">
          {detailCargo ? (() => {
            const matchedRoute = resolveAssignableRouteForCargo(routes, {
              route_key: "",
              origem: detailCargo.origem,
              destino: detailCargo.destino,
            });
            const publication = resolveCargoPublicationReadiness(
              {
                perfil: detailCargo.perfil,
                valor: detailCargo.valor,
                bonus: detailCargo.bonus,
                distancia_km: detailCargo.distancia_km,
                duracao_horas: detailCargo.duracao_horas,
              },
              matchedRoute,
            );
            const loadingDate = buildLoadingDateTime(detailCargo.sheet_data_carregamento, detailCargo.data, detailCargo.horario);
            const totalPayment = publication.totalPayment !== null ? publication.totalPayment : buildTotalPayment(detailCargo.valor, detailCargo.bonus);
            const distanceKm = publication.distancia_km;
            const durationHours = publication.tempo_estimado_horas ?? publication.duracao_horas;

            return (
              <>
                <DialogHeader>
                  <DialogTitle>
                    {detailCargo.origem} {"\u2192"} {detailCargo.destino}
                  </DialogTitle>
                  <DialogDescription>
                    {detailCargo.sheet_lh ? `LH ${detailCargo.sheet_lh}` : `ID ${detailCargo.id}`}
                    {" \u00b7 "}
                    Cliente: {formatMaybeText(detailCargo.cliente?.nome, "Não vinculado")}
                    {" \u00b7 "}
                    Perfil: {publication.perfil || "A confirmar"}
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <Card className="border-border/60 bg-muted/20 shadow-none">
                    <CardContent className="p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Carregamento</p>
                      <p className="mt-2 text-sm font-semibold text-foreground">
                        {buildOperationalDateLabel(detailCargo.sheet_data_carregamento, detailCargo.data, detailCargo.horario)}
                      </p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/60 bg-muted/20 shadow-none">
                    <CardContent className="p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Descarga</p>
                      <p className="mt-2 text-sm font-semibold text-foreground">
                        {buildOperationalDateLabel(detailCargo.sheet_data_descarga)}
                      </p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/60 bg-muted/20 shadow-none">
                    <CardContent className="p-4">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Tempo estimado</p>
                      <p className="mt-2 text-sm font-semibold text-foreground">
                        {formatEstimatedTime(loadingDate, detailCargo.sheet_data_descarga)}
                      </p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/60 bg-muted/20 shadow-none">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        <MapPinned className="h-3.5 w-3.5 text-primary" />
                        Distância
                      </div>
                      <p className="mt-2 text-sm font-semibold text-foreground">{buildRouteMetric(distanceKm, "km")}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{buildRouteMetric(durationHours, "h", "~")}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/60 bg-muted/20 shadow-none">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        <CreditCard className="h-3.5 w-3.5 text-primary" />
                        Pagamento
                      </div>
                      <p className="mt-2 text-sm font-semibold text-foreground">
                        {totalPayment !== null ? formatCurrency(totalPayment) : "Sem valor definido"}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {buildPaymentBreakdownLabel({
                          valor: publication.valor,
                          bonus: publication.bonus,
                          total: publication.totalPayment,
                          source: publication.compensationSource,
                        })}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatMaybeText(detailCargo.cliente?.forma_pagamento)} | {formatMaybeText(detailCargo.cliente?.prazo_pagamento)}
                      </p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/60 bg-muted/20 shadow-none">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        <Truck className="h-3.5 w-3.5 text-primary" />
                        Cliente e veículo
                      </div>
                      <p className="mt-2 text-sm font-semibold text-foreground">{formatMaybeText(detailCargo.cliente?.nome, "Não vinculado")}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatMaybeText(detailCargo.cliente?.tipo_veiculo)} | Peso: {formatMaybeText(detailCargo.cliente?.peso)}
                      </p>
                    </CardContent>
                  </Card>
                </div>
              </>
            );
          })() : null}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default OperatorDashboard;
