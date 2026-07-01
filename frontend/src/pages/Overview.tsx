import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Layers3,
  MapPinned,
  MessagesSquare,
  ShieldCheck,
  Swords,
  TimerReset,
  Truck,
  UserX,
} from "lucide-react";
import { format } from "date-fns";

import DashboardHeader from "@/components/DashboardHeader";
import DriverFlowInsights from "@/components/DriverFlowInsights";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  buildOverviewSnapshot,
  type OverviewClaimRow,
  type OverviewCargoRow,
  type OverviewDashboardSnapshot,
  type OverviewLeadRow,
} from "@/lib/overviewMetrics";
import { supabase } from "@/integrations/supabase/client";

const OVERVIEW_CARGO_SELECT =
  "id, data, horario, origem, destino, distancia_km, duracao_horas, perfil, valor, bonus, status, is_template, created_at, updated_at, sheet_data_carregamento, cliente:clientes(id, nome, prazo_pagamento, forma_pagamento, reputacao_bom_pagador, reputacao_pagamento_rapido)";
const OVERVIEW_LEAD_SELECT =
  "id, load_id, status, created_at, queued_at, approved_at, whatsapp_clicked_at, vehicle_type";
const OVERVIEW_CLAIM_SELECT =
  "id, load_id, status, created_at, claimed_at, promoted_at, confirmed_at, queue_position";

function formatNumber(value: number) {
  return value.toLocaleString("pt-BR", {
    maximumFractionDigits: 0,
  });
}

function KpiCard({
  label,
  value,
  note,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  icon: typeof Layers3;
  tone: "primary" | "accent" | "emerald" | "slate";
}) {
  const toneClasses: Record<typeof tone, string> = {
    primary: "bg-primary/10 text-primary",
    accent: "bg-accent/12 text-accent",
    emerald: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
    slate: "admin-tint-neutral",
  };

  return (
    <div className="group relative overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_18px_44px_-32px_rgba(15,23,42,0.22)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_22px_52px_-30px_rgba(15,23,42,0.28)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">{label}</p>
            <p className="text-3xl font-black tracking-tight text-foreground">{value}</p>
          </div>
          <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${toneClasses[tone]}`}>
            <Icon className="h-5 w-5" />
          </div>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{note}</p>
      </div>
    </div>
  );
}

function SignalCard({
  label,
  value,
  note,
  icon: Icon,
}: {
  label: string;
  value: string;
  note: string;
  icon: typeof Layers3;
}) {
  return (
    <div className="admin-card-surface-strong rounded-xl border px-4 py-4 shadow-[0_14px_32px_-28px_rgba(15,23,42,0.18)] transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
          <p className="mt-1 text-lg font-semibold tracking-tight text-foreground">{value}</p>
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{note}</p>
    </div>
  );
}

function OverviewLoadingState() {
  return (
    <main className="space-y-6 p-6 lg:p-8">
      <Skeleton className="h-[180px] rounded-xl" />
      <div className="grid gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={`overview-kpi-${index}`} className="h-[168px] rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={`overview-signal-${index}`} className="h-[138px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-[340px] rounded-xl" />
      <Skeleton className="h-[340px] rounded-xl" />
    </main>
  );
}

function formatAgeLabel(ageHours: number) {
  if (ageHours < 24) {
    return `${ageHours}h`;
  }
  const days = Math.floor(ageHours / 24);
  return `${days}d`;
}

const MISSING_FIELD_LABELS: Record<string, string> = {
  perfil: "Perfil",
  distancia_km: "Distancia",
  origem: "Origem",
  destino: "Destino",
};

function toOverviewCargoRows(data: unknown): OverviewCargoRow[] {
  if (!Array.isArray(data)) return [];
  return data.filter(Boolean) as OverviewCargoRow[];
}

function toOverviewLeadRows(data: unknown): OverviewLeadRow[] {
  if (!Array.isArray(data)) return [];
  return data.filter(Boolean) as OverviewLeadRow[];
}

function toOverviewClaimRows(data: unknown): OverviewClaimRow[] {
  if (!Array.isArray(data)) return [];
  return data.filter(Boolean) as OverviewClaimRow[];
}

const OVERVIEW_QUERY_KEY = ["operator", "overview-dashboard"] as const;

const Overview = () => {
  const queryClient = useQueryClient();
  const channelRef = useRef(`operator-overview-${Math.random().toString(36).slice(2, 8)}`);
  const overviewQuery = useQuery({
    queryKey: OVERVIEW_QUERY_KEY,
    refetchInterval: 30_000,
    queryFn: async () => {
      const [cargosResult, leadsResult, claimsResult] = await Promise.all([
        supabase.from("cargas").select(OVERVIEW_CARGO_SELECT).order("created_at", { ascending: false }).limit(500),
        supabase.from("load_public_leads").select(OVERVIEW_LEAD_SELECT).order("created_at", { ascending: false }).limit(500),
        supabase.from("load_claims").select(OVERVIEW_CLAIM_SELECT).order("created_at", { ascending: false }).limit(500),
      ]);

      if (cargosResult.error) {
        throw cargosResult.error;
      }

      if (leadsResult.error) {
        throw leadsResult.error;
      }

      if (claimsResult.error) {
        throw claimsResult.error;
      }

      return buildOverviewSnapshot(
        toOverviewCargoRows(cargosResult.data),
        toOverviewLeadRows(leadsResult.data),
        toOverviewClaimRows(claimsResult.data),
      );
    },
  });

  const snapshot = overviewQuery.data;

  const invalidateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Realtime: qualquer mudança em cargas/leads/claims revalida o snapshot
  // com debounce de 1.5s para evitar rajadas em sincronizações em lote.
  useEffect(() => {
    const invalidate = () => {
      if (invalidateTimeoutRef.current) clearTimeout(invalidateTimeoutRef.current);
      invalidateTimeoutRef.current = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY });
      }, 1500);
    };
    const channel = supabase
      .channel(channelRef.current)
      .on("postgres_changes", { event: "*", schema: "public", table: "cargas" }, invalidate)
      .on("postgres_changes", { event: "*", schema: "public", table: "load_public_leads" }, invalidate)
      .on("postgres_changes", { event: "*", schema: "public", table: "load_claims" }, invalidate)
      .subscribe();

    return () => {
      if (invalidateTimeoutRef.current) clearTimeout(invalidateTimeoutRef.current);
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return (
    <div>
      <DashboardHeader title="Painel" />

      {overviewQuery.isLoading ? (
        <OverviewLoadingState />
      ) : overviewQuery.error || !snapshot ? (
        <main className="space-y-6 p-6 lg:p-8">
          <section className="flex min-h-[320px] flex-col items-center justify-center gap-4 rounded-xl border border-border/60 bg-card p-10 text-center shadow-[0_18px_44px_-32px_rgba(15,23,42,0.2)]">
            <ShieldCheck className="h-14 w-14 text-amber-600/70" />
            <div className="space-y-2">
              <p className="text-lg font-bold text-foreground">Nao foi possivel montar o dashboard real</p>
              <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {overviewQuery.error instanceof Error
                  ? overviewQuery.error.message
                  : "Verifique a sessao do operador e as politicas das tabelas de cargas, leads e disputas."}
              </p>
            </div>
          </section>
        </main>
      ) : (
        <main className="space-y-6 p-6 lg:p-8">
          {/* Hero Banner */}
          <section className="relative overflow-hidden rounded-xl border border-white/10 bg-[linear-gradient(135deg,hsl(223_56%_10%),hsl(223_55%_20%))] px-6 py-7 text-white shadow-[0_30px_70px_-34px_rgba(15,23,42,0.55)] lg:px-8">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,hsl(225_100%_65%/0.22),transparent_36%),radial-gradient(circle_at_bottom_left,hsl(198_100%_57%/0.18),transparent_30%)]" />
            <div className="pointer-events-none absolute right-12 top-6 h-44 w-44 rounded-full bg-primary/24 blur-3xl" />
            <div className="pointer-events-none absolute bottom-4 left-6 h-32 w-32 rounded-full bg-accent/18 blur-3xl" />
            <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/40 to-transparent" />

            <div className="relative flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
              <div className="max-w-4xl space-y-4">
                <div className="inline-flex items-center gap-2 rounded-xl border border-white/[0.22] bg-white/[0.14] px-3 py-1.5 shadow-[0_12px_24px_-18px_rgba(3,14,42,0.7)] backdrop-blur-md">
                  <div className="relative flex items-center justify-center">
                    <Activity className="h-3.5 w-3.5 text-accent" />
                    <div className="absolute inset-0 animate-ping">
                      <Activity className="h-3.5 w-3.5 text-accent/50" />
                    </div>
                  </div>
                  <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-white">Ao vivo &middot; Supabase</span>
                </div>
                <div className="space-y-3">
                  <h2 className="text-3xl font-black tracking-tight sm:text-4xl">
                    Painel operacional com leitura real de cargas, fila e disputas.
                  </h2>
                  <p className="max-w-3xl text-sm leading-relaxed text-white/78 sm:text-base">
                    Visao cruzada de cargas ativas, interesse de motoristas na fila de WhatsApp e disputas digitais para
                    acompanhar o ritmo da operacao em tempo real.
                  </p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-white/[0.16] bg-white/[0.1] px-4 py-4 backdrop-blur-xl">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/60">Cargas ativas</p>
                  <p className="mt-2 text-2xl font-black tracking-tight text-white">
                    {formatNumber(snapshot.hero.activeLoads)}
                  </p>
                  <p className="mt-1 text-sm text-white/72">Abertas para motoristas agora</p>
                </div>
                <div className="rounded-xl border border-white/[0.16] bg-white/[0.1] px-4 py-4 backdrop-blur-xl">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/60">Saidas proximas 24h</p>
                  <p className="mt-2 text-2xl font-black tracking-tight text-white">
                    {formatNumber(snapshot.hero.departuresNext24h)}
                  </p>
                  <p className="mt-1 text-sm text-white/72">saidas com janela curta</p>
                </div>
                <div className="rounded-xl border border-white/[0.16] bg-white/[0.1] px-4 py-4 backdrop-blur-xl">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-white/60">Ultimo movimento</p>
                  <p className="mt-2 text-2xl font-black tracking-tight text-white">
                    {snapshot.lastUpdatedAt ? format(new Date(snapshot.lastUpdatedAt), "HH:mm") : "--:--"}
                  </p>
                  <p className="mt-1 text-sm text-white/72">
                    {snapshot.lastUpdatedAt ? format(new Date(snapshot.lastUpdatedAt), "dd/MM/yyyy") : "Sem atividade recente"}
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* 4 KPI Cards */}
          <section className="grid gap-4 xl:grid-cols-4">
            <KpiCard
              label="Cargas ativas"
              value={formatNumber(snapshot.hero.activeLoads)}
              note="Apenas cargas abertas (OPEN) disponíveis para motoristas."
              icon={Layers3}
              tone="primary"
            />
            <KpiCard
              label="Na fila"
              value={formatNumber(snapshot.hero.queuedLeads)}
              note="Cargas sem motorista reservado com motoristas aguardando na fila."
              icon={MessagesSquare}
              tone="accent"
            />
            <KpiCard
              label="Sem motorista"
              value={formatNumber(snapshot.hero.noDriverLoads)}
              note="Cargas abertas sem nenhum interesse de motorista ainda."
              icon={UserX}
              tone="emerald"
            />
            <KpiCard
              label="Disputas ativas"
              value={formatNumber(snapshot.hero.activeClaims)}
              note="Motoristas disputando nas telas de fila (QUEUED + APPROVED em cargas não terminais)."
              icon={Swords}
              tone="slate"
            />
          </section>

          {/* 5 Signal Cards */}
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <SignalCard
              label="Rascunhos pendentes"
              value={formatNumber(snapshot.hero.draftCount)}
              note="Cargas em DRAFT que ainda nao foram publicadas na malha."
              icon={ClipboardList}
            />
            <SignalCard
              label="Cargas fechadas"
              value={formatNumber(snapshot.hero.bookedCount)}
              note="Cargas com status BOOKED ou COMPLETED neste momento."
              icon={CheckCircle2}
            />
            <SignalCard
              label="Aprovados hoje"
              value={formatNumber(snapshot.hero.approvedToday)}
              note="Motoristas aprovados pelo operador no dia corrente."
              icon={CheckCircle2}
            />
            <SignalCard
              label="Cargas em atraso"
              value={formatNumber(snapshot.hero.overdueLoads)}
              note="Cargas OPEN cujo hor\u00e1rio de carregamento j\u00e1 passou."
              icon={AlertTriangle}
            />
            <SignalCard
              label="Reservadas (candidatura)"
              value={formatNumber(snapshot.hero.reservedCount)}
              note="Cargas com motorista reservado via candidatura aguardando confirmacao."
              icon={Truck}
            />
          </section>

          {/* Insight: conversao candidatura \u2192 reserva */}
          {(() => {
            const total = snapshot.hero.activeLoads + snapshot.hero.reservedCount;
            const rate = total > 0 ? Math.round((snapshot.hero.reservedCount / total) * 100) : 0;
            const hasReserved = snapshot.hero.reservedCount > 0;
            return (
              <section className="admin-card-surface-strong rounded-xl border px-5 py-4 shadow-[0_18px_40px_-34px_rgba(15,23,42,0.18)]">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/12 text-emerald-700 dark:text-emerald-300">
                      <Truck className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">Insight &mdash; Candidaturas</p>
                      <p className="mt-0.5 text-sm font-semibold text-foreground">
                        {hasReserved
                          ? `${snapshot.hero.reservedCount} carga${snapshot.hero.reservedCount === 1 ? "" : "s"} reservada${snapshot.hero.reservedCount === 1 ? "" : "s"} via candidatura \u2014 ${rate}% das cargas ativas com motorista confirmado`
                          : "Nenhuma carga reservada via candidatura no momento"}
                      </p>
                    </div>
                  </div>
                  {hasReserved && (
                    <div className="ml-13 sm:ml-0 flex items-center gap-2">
                      <div className="h-2 w-32 overflow-hidden rounded-sm bg-muted/40">
                        <div
                          className="h-full rounded-sm bg-emerald-500 transition-all duration-500"
                          style={{ width: `${rate}%` }}
                        />
                      </div>
                      <span className="text-sm font-bold text-emerald-700 dark:text-emerald-300">{rate}%</span>
                    </div>
                  )}
                </div>
              </section>
            );
          })()}

          <DriverFlowInsights />

          {/* Loads Needing Attention */}
          <Card className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_18px_44px_-32px_rgba(15,23,42,0.2)]">
            <CardHeader className="space-y-3">
              <CardDescription className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">
                Atencao necessaria
              </CardDescription>
              <CardTitle className="text-2xl tracking-tight text-foreground">
                Cargas que precisam de acao
              </CardTitle>
              <CardDescription className="max-w-2xl text-sm leading-relaxed">
                Cargas abertas ha mais de 48h sem interesse ou com dados obrigatorios faltando.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-3">
                {snapshot.attentionLoads.length > 0 ? (
                  snapshot.attentionLoads.map((load) => (
                    <div
                      key={load.id}
                      className="admin-card-surface-strong flex flex-col gap-3 rounded-xl border px-4 py-4 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.18)] transition-all duration-200 hover:border-amber-300/60 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/12 text-amber-700">
                          <AlertTriangle className="h-4 w-4" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-foreground">
                            {load.origem} &rarr; {load.destino}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700 text-xs dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-200">
                              {load.status}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              Criada ha {formatAgeLabel(load.ageHours)}
                            </span>
                            {load.missingFields.length > 0 && (
                              <span className="text-xs text-red-600">
                                Faltando: {load.missingFields.map((f) => MISSING_FIELD_LABELS[f] || f).join(", ")}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl border border-dashed border-border/70 bg-muted/25 px-6 py-10 text-center text-sm text-muted-foreground">
                    Nenhuma carga precisa de atencao neste momento.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Recent Activity (kept as-is) */}
          <Card className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-[0_18px_44px_-32px_rgba(15,23,42,0.2)]">
            <CardHeader className="space-y-3">
              <CardDescription className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">
                Pulso operacional
              </CardDescription>
              <CardTitle className="text-2xl tracking-tight text-foreground">
                Atividade recente da malha, da fila publica e das disputas
              </CardTitle>
              <CardDescription className="max-w-2xl text-sm leading-relaxed">
                Tudo vindo de movimentos reais das tabelas de cargas, leads publicos e claims digitais.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-3">
                {snapshot.recentActivity.length > 0 ? (
                  snapshot.recentActivity.map((activity) => (
                    <div
                      key={activity.id}
                      className="admin-card-surface-strong flex flex-col gap-3 rounded-xl border px-4 py-4 shadow-[0_14px_30px_-26px_rgba(15,23,42,0.18)] transition-all duration-200 hover:border-primary/30 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={`mt-0.5 flex h-10 w-10 items-center justify-center rounded-xl ${
                            activity.type === "lead"
                              ? "bg-accent/12 text-accent"
                              : activity.type === "claim"
                                ? "bg-emerald-500/12 text-emerald-700"
                                : "bg-primary/10 text-primary"
                          }`}
                        >
                          {activity.type === "lead" ? (
                            <MessagesSquare className="h-4 w-4" />
                          ) : activity.type === "claim" ? (
                            <TimerReset className="h-4 w-4" />
                          ) : (
                            <MapPinned className="h-4 w-4" />
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-foreground">{activity.title}</p>
                          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{activity.description}</p>
                        </div>
                      </div>
                      <div className="pl-[52px] text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground sm:pl-0">
                        {activity.relativeTime}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-xl border border-dashed border-border/70 bg-muted/25 px-6 py-10 text-center text-sm text-muted-foreground">
                    Nenhuma atividade recente encontrada nas tabelas monitoradas.
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </main>
      )}
    </div>
  );
};

export default Overview;
