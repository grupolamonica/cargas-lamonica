import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  BadgeCheck,
  CalendarRange,
  CheckCircle2,
  Clock,
  MessageCircle,
  TrendingUp,
  UserRound,
  Users,
  XCircle,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  fetchDriverFlowMetrics,
  type DriverFlowMetricsResponse,
} from "@/services/readModels";

const WEEK_DAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function formatInt(value: number) {
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
}

function formatPercent(part: number, total: number) {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

function formatSecondsHuman(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) {
    const m = Math.floor(minutes);
    const s = Math.round(seconds - m * 60);
    return `${m}m${s > 0 ? ` ${s}s` : ""}`;
  }
  const hours = minutes / 60;
  const h = Math.floor(hours);
  const m = Math.round(minutes - h * 60);
  return `${h}h${m > 0 ? ` ${m}m` : ""}`;
}

function todayIso() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function daysAgoIso(days: number) {
  const now = new Date();
  now.setDate(now.getDate() - days);
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

interface BarRowProps {
  label: string;
  count: number;
  max: number;
  highlight?: boolean;
}

function BarRow({ label, count, max, highlight }: BarRowProps) {
  const percent = max > 0 ? (count / max) * 100 : 0;
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-12 shrink-0 font-mono text-muted-foreground">{label}</span>
      <div className="relative h-3 flex-1 overflow-hidden rounded-full bg-muted/60">
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full transition-[width] duration-500",
            highlight ? "bg-primary" : "bg-primary/50",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="w-10 shrink-0 text-right font-semibold tabular-nums text-foreground">
        {formatInt(count)}
      </span>
    </div>
  );
}

function FunnelStep({
  label,
  value,
  total,
  icon: Icon,
}: {
  label: string;
  value: number;
  total: number;
  icon: typeof Users;
}) {
  const percent = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-foreground">{label}</span>
          <span className="text-xs font-semibold tabular-nums text-muted-foreground">
            {formatInt(value)} ({formatPercent(value, total)})
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted/70">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    </div>
  );
}

interface DriverFlowInsightsProps {
  className?: string;
}

const DriverFlowInsights = ({ className }: DriverFlowInsightsProps) => {
  const [dateFrom, setDateFrom] = useState<string>(daysAgoIso(7));
  const [dateTo, setDateTo] = useState<string>(todayIso());

  const query = useQuery({
    queryKey: ["operator", "driver-flow-metrics", dateFrom, dateTo],
    queryFn: () => fetchDriverFlowMetrics({ dateFrom, dateTo }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const data = query.data as DriverFlowMetricsResponse | undefined;

  const peakHour = useMemo(() => {
    if (!data) return null;
    let best = { hour: -1, total: 0 };
    for (const row of data.accessPeaks.byHour) {
      if (row.total > best.total) best = row;
    }
    return best.hour >= 0 ? best : null;
  }, [data]);

  const maxHour = useMemo(() => {
    if (!data) return 0;
    return Math.max(0, ...data.accessPeaks.byHour.map((row) => row.total));
  }, [data]);

  const maxDow = useMemo(() => {
    if (!data) return 0;
    return Math.max(0, ...data.accessPeaks.byDow.map((row) => row.total));
  }, [data]);

  const portalPeakHour = useMemo(() => {
    if (!data?.portalVisits) return null;
    let best = { hour: -1, total: 0 };
    for (const row of data.portalVisits.byHour) {
      if (row.total > best.total) best = row;
    }
    return best.hour >= 0 && best.total > 0 ? best : null;
  }, [data]);

  const maxPortalHour = useMemo(() => {
    if (!data?.portalVisits) return 0;
    return Math.max(0, ...data.portalVisits.byHour.map((row) => row.total));
  }, [data]);

  const maxPortalDow = useMemo(() => {
    if (!data?.portalVisits) return 0;
    return Math.max(0, ...data.portalVisits.byDow.map((row) => row.total));
  }, [data]);

  const handleQuickRange = (days: number) => {
    setDateFrom(daysAgoIso(days - 1));
    setDateTo(todayIso());
  };

  const handleClearFilter = () => {
    // Esvazia inputs; backend default de 7 dias assume quando string vazia.
    setDateFrom("");
    setDateTo("");
  };

  return (
    <section className={cn("space-y-5", className)}>
      {/* Header + date range */}
      <div className="admin-panel flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary/60">Fluxo de motoristas</p>
            <h3 className="mt-1 text-xl font-semibold tracking-tight text-foreground">
              Insights de acesso, funil e validação
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Candidaturas, conversão, picos de acesso e qualidade das validações Angellira/ASPX.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-2xl border border-border/70 bg-white/70 p-1 text-xs dark:bg-muted/40">
            <button
              type="button"
              onClick={() => handleQuickRange(1)}
              className="rounded-xl px-3 py-1.5 font-semibold text-muted-foreground transition-colors hover:bg-muted"
            >
              24h
            </button>
            <button
              type="button"
              onClick={() => handleQuickRange(7)}
              className="rounded-xl px-3 py-1.5 font-semibold text-muted-foreground transition-colors hover:bg-muted"
            >
              7d
            </button>
            <button
              type="button"
              onClick={() => handleQuickRange(30)}
              className="rounded-xl px-3 py-1.5 font-semibold text-muted-foreground transition-colors hover:bg-muted"
            >
              30d
            </button>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CalendarRange className="h-4 w-4" />
            <input
              type="date"
              value={dateFrom}
              max={dateTo}
              onChange={(event) => setDateFrom(event.target.value)}
              className="rounded-xl border border-border/70 bg-white/80 px-3 py-2 text-xs dark:bg-muted/40 dark:text-foreground"
            />
            <span>até</span>
            <input
              type="date"
              value={dateTo}
              min={dateFrom}
              max={todayIso()}
              onChange={(event) => setDateTo(event.target.value)}
              className="rounded-xl border border-border/70 bg-white/80 px-3 py-2 text-xs dark:bg-muted/40 dark:text-foreground"
            />
            <button
              type="button"
              onClick={handleClearFilter}
              className="rounded-xl border border-border/70 bg-white/80 px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted dark:bg-muted/40"
            >
              Limpar filtro
            </button>
          </div>
        </div>
      </div>

      {query.isLoading && !data ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <Skeleton className="h-[320px] rounded-[28px]" />
          <Skeleton className="h-[320px] rounded-[28px]" />
          <Skeleton className="h-[320px] rounded-[28px]" />
          <Skeleton className="h-[320px] rounded-[28px]" />
        </div>
      ) : query.error ? (
        <Card className="admin-panel border border-amber-200 bg-amber-50/70 shadow-none">
          <CardContent className="flex items-center gap-3 p-5 text-sm text-amber-900">
            <AlertTriangle className="h-5 w-5" />
            <span>
              {query.error instanceof Error
                ? query.error.message
                : "Não foi possível carregar os insights de fluxo agora."}
            </span>
          </CardContent>
        </Card>
      ) : data ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {/* Pico de candidatura (pr\u00e9-registros) */}
          <Card className="admin-panel shadow-none">
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <TrendingUp className="h-4 w-4 text-primary" />
                Pico de candidatura
              </div>
              <p className="text-xs text-muted-foreground">
                Baseado em pré-registros de candidatura (envio de CPF/placas).
              </p>

              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Por hora do dia</p>
                <div className="space-y-1">
                  {data.accessPeaks.byHour.map((row) => (
                    <BarRow
                      key={row.hour}
                      label={`${String(row.hour).padStart(2, "0")}h`}
                      count={row.total}
                      max={maxHour}
                      highlight={peakHour?.hour === row.hour}
                    />
                  ))}
                </div>
                {peakHour ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Pico às {String(peakHour.hour).padStart(2, "0")}h com {formatInt(peakHour.total)} candidatura{peakHour.total === 1 ? "" : "s"}.
                  </p>
                ) : null}
              </div>

              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Por dia da semana</p>
                <div className="space-y-1">
                  {data.accessPeaks.byDow.map((row) => (
                    <BarRow
                      key={row.dow}
                      label={WEEK_DAYS[row.dow] || String(row.dow)}
                      count={row.total}
                      max={maxDow}
                    />
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Pico de acesso (page views do portal p\u00fablico) */}
          <Card className="admin-panel shadow-none">
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Clock className="h-4 w-4 text-primary" />
                Pico de acesso
              </div>
              <p className="text-xs text-muted-foreground">
                Motoristas que entraram na tela pública (portal) — {formatInt(data.portalVisits?.total ?? 0)} visita{(data.portalVisits?.total ?? 0) === 1 ? "" : "s"} no período.
              </p>

              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Por hora do dia</p>
                <div className="space-y-1">
                  {(data.portalVisits?.byHour ?? []).map((row) => (
                    <BarRow
                      key={row.hour}
                      label={`${String(row.hour).padStart(2, "0")}h`}
                      count={row.total}
                      max={maxPortalHour}
                      highlight={portalPeakHour?.hour === row.hour}
                    />
                  ))}
                </div>
                {portalPeakHour ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Pico às {String(portalPeakHour.hour).padStart(2, "0")}h com {formatInt(portalPeakHour.total)} acesso{portalPeakHour.total === 1 ? "" : "s"}.
                  </p>
                ) : null}
              </div>

              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Por dia da semana</p>
                <div className="space-y-1">
                  {(data.portalVisits?.byDow ?? []).map((row) => (
                    <BarRow
                      key={row.dow}
                      label={WEEK_DAYS[row.dow] || String(row.dow)}
                      count={row.total}
                      max={maxPortalDow}
                    />
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Funil de candidatura */}
          <Card className="admin-panel shadow-none">
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <TrendingUp className="h-4 w-4 text-primary" />
                Funil de candidatura
              </div>
              <div className="space-y-3">
                <FunnelStep label="Pré-registros" value={data.funnel.preRegistered} total={data.funnel.preRegistered} icon={Users} />
                <FunnelStep label="Na fila" value={data.funnel.queued} total={data.funnel.preRegistered} icon={Clock} />
                <FunnelStep label="Clicou no WhatsApp" value={data.funnel.whatsappClicked} total={data.funnel.preRegistered} icon={MessageCircle} />
                <FunnelStep label="Aprovado pelo operador" value={data.funnel.approved} total={data.funnel.preRegistered} icon={CheckCircle2} />
              </div>
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pré-reg → WhatsApp</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">
                    {formatSecondsHuman(data.funnel.avgPreregToWhatsappSeconds)}
                  </p>
                </div>
                <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pré-reg → Aprovado</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">
                    {formatSecondsHuman(data.funnel.avgPreregToApprovedSeconds)}
                  </p>
                </div>
              </div>
              {data.funnel.cancelled > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {formatInt(data.funnel.cancelled)} candidatura{data.funnel.cancelled === 1 ? "" : "s"} cancelada{data.funnel.cancelled === 1 ? "" : "s"} no período.
                </p>
              ) : null}
            </CardContent>
          </Card>

          {/* Qualidade da validação */}
          <Card className="admin-panel shadow-none">
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <BadgeCheck className="h-4 w-4 text-primary" />
                Qualidade da validação
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-2xl border border-emerald-200/70 bg-emerald-50/60 p-3 dark:border-emerald-400/30 dark:bg-emerald-500/10">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-800 dark:text-emerald-200">Angellira OK</p>
                  <p className="mt-1 text-xl font-black text-emerald-700 dark:text-emerald-100">
                    {formatPercent(data.validation.angeliraFound, data.validation.total)}
                  </p>
                  <p className="text-[11px] text-emerald-800/80 dark:text-emerald-200/80">
                    {formatInt(data.validation.angeliraFound)} / {formatInt(data.validation.total)}
                  </p>
                </div>
                <div className="rounded-2xl border border-sky-200/70 bg-sky-50/60 p-3 dark:border-sky-400/30 dark:bg-sky-500/10">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-800 dark:text-sky-200">ASPX OK</p>
                  <p className="mt-1 text-xl font-black text-sky-700 dark:text-sky-100">
                    {formatPercent(data.validation.aspxFound, data.validation.total)}
                  </p>
                  <p className="text-[11px] text-sky-800/80 dark:text-sky-200/80">
                    {formatInt(data.validation.aspxFound)} / {formatInt(data.validation.total)}
                  </p>
                </div>
                <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pendentes</p>
                  <p className="mt-1 text-xl font-black text-foreground">
                    {formatInt(data.validation.pending)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">Aguardando processamento</p>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Status geral</p>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 font-semibold text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-100">
                    <CheckCircle2 className="h-3 w-3" />
                    Válidos {formatInt(data.validation.valid)}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-800 dark:bg-amber-500/20 dark:text-amber-100">
                    <AlertTriangle className="h-3 w-3" />
                    Vencendo {formatInt(data.validation.expiring)}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-1 font-semibold text-red-800 dark:bg-red-500/20 dark:text-red-100">
                    <XCircle className="h-3 w-3" />
                    Inválidos {formatInt(data.validation.invalid)}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-700 dark:bg-slate-500/25 dark:text-slate-100">
                    Não encontrados {formatInt(data.validation.notFound)}
                  </span>
                  {data.validation.plateMismatch > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2.5 py-1 font-semibold text-orange-800 dark:bg-orange-500/20 dark:text-orange-100">
                      Placa divergente {formatInt(data.validation.plateMismatch)}
                    </span>
                  ) : null}
                </div>
              </div>

              {data.validation.topWarnings.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Principais motivos de alerta</p>
                  <ul className="space-y-1 text-xs">
                    {data.validation.topWarnings.map((item) => (
                      <li key={item.warning} className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-white/70 px-3 py-2">
                        <span className="truncate text-foreground">{item.warning}</span>
                        <span className="shrink-0 font-semibold text-muted-foreground">{formatInt(item.total)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/* Recorrência */}
          <Card className="admin-panel shadow-none xl:col-span-2">
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <UserRound className="h-4 w-4 text-primary" />
                Recorrência de motorista
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">CPFs únicos</p>
                  <p className="mt-1 text-2xl font-black text-foreground">{formatInt(data.recurrence.uniqueCpfs)}</p>
                </div>
                <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Candidaturas</p>
                  <p className="mt-1 text-2xl font-black text-foreground">{formatInt(data.recurrence.totalCandidaturas)}</p>
                </div>
                <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Média por motorista</p>
                  <p className="mt-1 text-2xl font-black text-foreground">{data.recurrence.avgPerCpf.toFixed(1)}</p>
                </div>
                <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Recorde</p>
                  <p className="mt-1 text-2xl font-black text-foreground">{formatInt(data.recurrence.maxPerCpf)}</p>
                </div>
              </div>

              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Novos vs recorrentes</p>
                {data.recurrence.uniqueCpfs > 0 ? (
                  <>
                    <div className="flex h-3 overflow-hidden rounded-full bg-muted/60">
                      <div
                        className="bg-primary"
                        style={{ width: `${(data.recurrence.newDrivers / data.recurrence.uniqueCpfs) * 100}%` }}
                      />
                      <div
                        className="bg-emerald-500"
                        style={{ width: `${(data.recurrence.recurringDrivers / data.recurrence.uniqueCpfs) * 100}%` }}
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs">
                      <span className="inline-flex items-center gap-2 text-foreground">
                        <span className="h-2 w-2 rounded-full bg-primary" />
                        Novos {formatInt(data.recurrence.newDrivers)} ({formatPercent(data.recurrence.newDrivers, data.recurrence.uniqueCpfs)})
                      </span>
                      <span className="inline-flex items-center gap-2 text-foreground">
                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                        Recorrentes {formatInt(data.recurrence.recurringDrivers)} ({formatPercent(data.recurrence.recurringDrivers, data.recurrence.uniqueCpfs)})
                      </span>
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">Sem CPFs no período.</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </section>
  );
};

export default DriverFlowInsights;
