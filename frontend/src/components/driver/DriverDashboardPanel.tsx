import {
  ArrowUpRight,
  BriefcaseBusiness,
  CircleDollarSign,
  Gauge,
  Map,
  Truck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { DriverDashboardSnapshot } from "@/lib/driverDashboardMetrics";

interface DriverDashboardPanelProps {
  snapshot?: DriverDashboardSnapshot;
  isLoading?: boolean;
  hasActiveFilters?: boolean;
  onClearFilters?: () => void;
  errorMessage?: string | null;
}

function formatCurrency(value: number) {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  });
}

function formatCompactCurrency(value: number) {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    notation: "compact",
    maximumFractionDigits: value >= 100000 ? 1 : 0,
  });
}

function formatMetric(value: number, suffix: string, fractionDigits = 1) {
  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  })} ${suffix}`;
}

function MetricCard({
  label,
  value,
  note,
  icon: Icon,
}: {
  label: string;
  value: string;
  note: string;
  icon: typeof CircleDollarSign;
}) {
  return (
    <div className="admin-card-surface rounded-[28px] border p-4 shadow-[0_18px_34px_-28px_rgba(15,23,42,0.18)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
          <p className="mt-3 text-2xl font-black tracking-tight text-foreground">{value}</p>
        </div>
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Icon className="h-4.5 w-4.5" />
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{note}</p>
    </div>
  );
}

function DriverDashboardLoadingState() {
  return (
    <section className="mb-6 grid gap-4 lg:mb-8">
      <Skeleton className="h-[180px] rounded-[32px]" />
      <div className="grid gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={`driver-dashboard-metric-${index}`} className="h-[148px] rounded-[28px]" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <Skeleton className="h-[320px] rounded-[28px]" />
        <Skeleton className="h-[320px] rounded-[28px]" />
      </div>
    </section>
  );
}

const DriverDashboardPanel = ({
  snapshot,
  isLoading,
  hasActiveFilters,
  onClearFilters,
  errorMessage,
}: DriverDashboardPanelProps) => {
  if (isLoading) {
    return <DriverDashboardLoadingState />;
  }

  if (errorMessage) {
    return (
      <section className="mb-6 lg:mb-8">
        <div className="admin-tint-warning rounded-[32px] border p-6 text-sm shadow-[0_18px_34px_-28px_rgba(120,53,15,0.18)]">
          <p className="text-base font-bold">Não foi possível montar a visão analítica do motorista</p>
          <p className="mt-2 leading-relaxed text-amber-900/80">{errorMessage}</p>
        </div>
      </section>
    );
  }

  if (!snapshot || snapshot.hero.openLoads === 0) {
    return null;
  }

  const topRoute = snapshot.topRoutes[0];
  const departurePeak = snapshot.departureWindows.reduce((max, item) => Math.max(max, item.payout), 0);

  return (
    <section className="mb-6 grid gap-4 lg:mb-8">
      <div className="relative overflow-hidden rounded-[32px] border border-white/80 bg-[linear-gradient(135deg,hsl(220_46%_14%),hsl(221_58%_22%))] p-5 text-white shadow-[0_26px_64px_-34px_rgba(15,23,42,0.48)] sm:p-6">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,hsl(191_91%_43%/0.18),transparent_28%),radial-gradient(circle_at_bottom_left,hsl(224_94%_37%/0.28),transparent_34%)]" />
        <div className="relative grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_300px] xl:items-end">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-white/14 bg-white/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/82">
              Painel de bolso do motorista
            </div>
            <h2 className="mt-4 text-[1.9rem] font-black leading-tight tracking-tight sm:text-[2.5rem]">
              {topRoute
                ? `Melhor leitura agora: ${topRoute.route}`
                : "Visão de oportunidade em tempo real"}
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-white/78 sm:text-base">
              {topRoute
                ? `A rota com melhor relação de ganho no momento sai em ${topRoute.departureLabel} e combina pagamento, distancia e janela operacional.`
                : "A leitura cruza pagamento, bônus, perfis e saídas próximas para ajudar o motorista a decidir mais rápido."}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="rounded-full border border-white/12 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/84">
                {snapshot.hero.openLoads} cargas abertas
              </span>
              <span className="rounded-full border border-white/12 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/84">
                {snapshot.hero.uniqueCorridors} corredores ativos
              </span>
              <span className="rounded-full border border-white/12 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/84">
                {snapshot.hero.uniqueClients} clientes operando
              </span>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <div className="rounded-[24px] border border-white/12 bg-white/10 px-4 py-4 backdrop-blur">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/62">Bolso aberto</p>
              <p className="mt-2 text-2xl font-black tracking-tight text-white">
                {formatCompactCurrency(snapshot.hero.totalPayout)}
              </p>
              <p className="mt-1 text-sm text-white/74">Tudo o que está disponível agora no recorte atual.</p>
            </div>
            <div className="rounded-[24px] border border-white/12 bg-white/10 px-4 py-4 backdrop-blur">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/62">Saídas nas próximas 24h</p>
              <p className="mt-2 text-2xl font-black tracking-tight text-white">
                {formatCompactCurrency(snapshot.hero.next24hPayout)}
              </p>
              <p className="mt-1 text-sm text-white/74">
                {snapshot.hero.next24hLoads} carga{snapshot.hero.next24hLoads === 1 ? "" : "s"} mais imediata{snapshot.hero.next24hLoads === 1 ? "" : "s"}.
              </p>
            </div>
          </div>
        </div>

        {hasActiveFilters && onClearFilters ? (
          <div className="relative mt-5 flex items-center justify-between gap-3 rounded-[24px] border border-white/12 bg-white/8 px-4 py-3 text-sm text-white/78">
            <p>A leitura acima respeita os filtros ativos do motorista.</p>
            <Button
              type="button"
              variant="secondary"
              onClick={onClearFilters}
              className="h-9 rounded-full border-0 bg-white text-[hsl(223_58%_18%)] hover:bg-white/90"
            >
              Limpar filtros
            </Button>
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-4">
        <MetricCard
          label="Ticket médio"
          value={snapshot.hero.averageTicket !== null ? formatCurrency(snapshot.hero.averageTicket) : "A combinar"}
          note="Média de pagamento total por carga considerando bônus."
          icon={CircleDollarSign}
        />
        <MetricCard
          label="Valor por km"
          value={
            snapshot.hero.averagePayPerKm !== null
              ? formatMetric(snapshot.hero.averagePayPerKm, "R$/km", 2)
              : "A confirmar"
          }
          note="Régua de atratividade para comparar trechos curtos e longos."
          icon={Gauge}
        />
        <MetricCard
          label="Bônus no ar"
          value={formatCompactCurrency(snapshot.hero.bonusTotal)}
          note={`${snapshot.hero.bonusLoads} carga${snapshot.hero.bonusLoads === 1 ? "" : "s"} com bônus habilitado agora.`}
          icon={ArrowUpRight}
        />
        <MetricCard
          label="Cobertura"
          value={`${snapshot.hero.uniqueStates} UFs`}
          note={`${snapshot.hero.uniqueProfiles} perfis e ${snapshot.hero.uniqueCorridors} corredores em operação.`}
          icon={Map}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)]">
        <Card className="overflow-hidden border-white/80 bg-white/92">
          <CardHeader>
            <CardDescription className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/60">
              Janela de saída
            </CardDescription>
            <CardTitle className="text-2xl tracking-tight">Quando o dinheiro entra na janela curta</CardTitle>
            <CardDescription>
              Quanto mais cheio o bloco, maior o volume financeiro aberto para aquele dia.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {snapshot.departureWindows.map((window) => {
              const width =
                departurePeak > 0 ? Math.max((window.payout / departurePeak) * 100, window.loads > 0 ? 14 : 0) : 0;

              return (
                <div key={window.shortLabel} className="rounded-[24px] border border-border/70 bg-muted/15 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{window.label}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {window.loads} carga{window.loads === 1 ? "" : "s"} com saída prevista
                      </p>
                    </div>
                    <p className="text-sm font-bold text-foreground">{formatCompactCurrency(window.payout)}</p>
                  </div>
                  <div className="mt-3 h-2 rounded-full bg-muted/55">
                    <div
                      className="h-2 rounded-full bg-[linear-gradient(90deg,hsl(224_94%_37%),hsl(191_91%_43%))]"
                      style={{ width: `${width}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card className="overflow-hidden border-white/80 bg-white/92">
          <CardHeader>
            <CardDescription className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/60">
              Rotas para atacar
            </CardDescription>
            <CardTitle className="text-2xl tracking-tight">Melhores oportunidades agora</CardTitle>
            <CardDescription>
              Ranking pelo equilíbrio entre pagamento e valor relativo por quilômetro.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {snapshot.topRoutes.map((route) => (
              <div key={route.id} className="rounded-[24px] border border-border/70 bg-white p-4 shadow-[0_16px_30px_-28px_rgba(15,23,42,0.18)]">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-base font-semibold tracking-tight text-foreground">{route.route}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {route.clientName} | Saída {route.departureLabel}
                    </p>
                  </div>
                  {route.hasBonus ? (
                    <span className="rounded-full bg-accent/12 px-2.5 py-1 text-[11px] font-semibold text-accent">
                      Bônus
                    </span>
                  ) : null}
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-border/60 bg-muted/15 px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pagamento</p>
                    <p className="mt-2 text-sm font-semibold text-foreground">
                      {route.totalPayment !== null ? formatCurrency(route.totalPayment) : "A combinar"}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-border/60 bg-muted/15 px-3 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Leitura da rota</p>
                    <p className="mt-2 text-sm font-semibold text-foreground">
                      {route.payPerKm !== null ? formatMetric(route.payPerKm, "R$/km", 2) : "KM pendente"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {route.distanceKm ? `${route.distanceKm.toLocaleString("pt-BR")} km` : "Distância a confirmar"}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="overflow-hidden border-white/80 bg-white/92">
          <CardHeader>
            <CardDescription className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/60">
              Perfis quentes
            </CardDescription>
            <CardTitle className="text-2xl tracking-tight">Onde o ticket esta mais forte</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {snapshot.topProfiles.map((profile) => (
              <div key={profile.profile} className="flex items-center justify-between gap-3 rounded-[22px] border border-border/70 bg-muted/15 px-4 py-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <Truck className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{profile.profile}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {profile.loads} carga{profile.loads === 1 ? "" : "s"} aberta{profile.loads === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-foreground">{formatCurrency(profile.averageTicket)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{formatCompactCurrency(profile.totalPayout)}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="overflow-hidden border-white/80 bg-white/92">
          <CardHeader>
            <CardDescription className="text-xs font-semibold uppercase tracking-[0.2em] text-primary/60">
              Massa por cliente
            </CardDescription>
            <CardTitle className="text-2xl tracking-tight">Quem concentra mais oportunidade</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {snapshot.topClients.map((client) => (
              <div key={client.clientName} className="rounded-[22px] border border-border/70 bg-muted/15 px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                      <BriefcaseBusiness className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-foreground">{client.clientName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {client.loads} carga{client.loads === 1 ? "" : "s"} na malha atual
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-foreground">{formatCompactCurrency(client.totalPayout)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {(client.share * 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}% do bolso aberto
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </section>
  );
};

export default DriverDashboardPanel;
