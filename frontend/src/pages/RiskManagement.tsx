import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ShieldAlert,
  Truck,
  UsersRound,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import DashboardHeader from "@/components/DashboardHeader";
import { fetchGrAlertas, type GrAlertaItem, type GrAlertasSummary } from "@/services/readModels";
import { formatDateOnly, formatShortDateTime } from "@/lib/dateDisplay";

const GR_ALERTAS_QUERY_KEY = ["operator", "gr-alertas-read-model"] as const;

const EMPTY_SUMMARY: GrAlertasSummary = {
  drivers: { total: 0, ok: 0, atencao: 0, critico: 0, semDado: 0 },
  vehicles: { total: 0, expiringSoon: 0, expired: 0 },
  alertas: { total: 0, criticos: 0, atencao: 0 },
};

type MainTab = "alertas" | "motoristas" | "veiculos";

const PLATE_ROLE_LABEL: Record<string, string> = {
  HORSE: "Cavalo",
  TRAILER_1: "Carreta",
  TRAILER_2: "2ª carreta",
};

const SOURCE_LABEL: Record<GrAlertaItem["source"], string> = {
  ANGELLIRA: "Angellira",
  BRK: "BRK",
  SPX: "SPX",
};

function SummaryCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="admin-panel flex items-center gap-4 p-4 lg:p-5">
      <div className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl", color)}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-2xl font-bold tracking-tight tabular-nums text-foreground">{value}</p>
        <p className="mt-0.5 whitespace-normal text-xs font-medium leading-tight text-muted-foreground" title={label}>
          {label}
        </p>
      </div>
    </div>
  );
}

function SeverityChip({ severity, message }: { severity: GrAlertaItem["severity"]; message: string }) {
  if (severity === "crit") {
    return (
      <div className="admin-tint-danger inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold">
        <XCircle className="h-3.5 w-3.5 shrink-0" />
        {message}
      </div>
    );
  }
  return (
    <div className="admin-tint-warning inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      {message}
    </div>
  );
}

export default function RiskManagement() {
  const [mainTab, setMainTab] = useState<MainTab>("alertas");

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: GR_ALERTAS_QUERY_KEY,
    queryFn: () => fetchGrAlertas(),
    staleTime: 30_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: keepPreviousData,
  });

  const items = data?.items ?? [];
  const summary = data?.summary ?? EMPTY_SUMMARY;

  const counts = useMemo(
    () => ({
      alertas: items.length,
      motoristas: items.filter((a) => a.entityType === "motorista").length,
      veiculos: items.filter((a) => a.entityType === "veiculo").length,
    }),
    [items],
  );

  const visibleItems = useMemo(() => {
    if (mainTab === "motoristas") return items.filter((a) => a.entityType === "motorista");
    if (mainTab === "veiculos") return items.filter((a) => a.entityType === "veiculo");
    return items;
  }, [items, mainTab]);

  const tabs: { id: MainTab; label: string; icon: LucideIcon; count: number }[] = [
    { id: "alertas", label: "Alertas", icon: ShieldAlert, count: counts.alertas },
    { id: "motoristas", label: "Motoristas", icon: UsersRound, count: counts.motoristas },
    { id: "veiculos", label: "Veículos", icon: Truck, count: counts.veiculos },
  ];

  const emptyLabel =
    mainTab === "motoristas" ? "de motorista" : mainTab === "veiculos" ? "de veículo" : "";

  return (
    <div>
      <DashboardHeader
        title="Gerenciamento de Risco"
        subtitle="Monitoramento de vigências e alertas por motorista e veículo"
        actions={
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-60"
          >
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
            Atualizar
          </button>
        }
      />

      {/* Abas — segmented control */}
      <div className="px-6 pt-3 pb-1 lg:px-8">
        <div className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 p-1">
          {tabs.map(({ id, label, icon: Icon, count }) => (
            <button
              key={id}
              type="button"
              onClick={() => setMainTab(id)}
              className={cn(
                "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors",
                mainTab === id ? "bg-background text-primary shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
              <span
                className={cn(
                  "ml-0.5 flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold tabular-nums",
                  mainTab === id ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                )}
              >
                {count}
              </span>
            </button>
          ))}
        </div>
      </div>

      <main className="min-w-0 space-y-5 p-6 lg:p-8">
        {/* Faixa de KPIs */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
          <SummaryCard
            icon={UsersRound}
            label="Motoristas monitorados"
            value={summary.drivers.total}
            color="bg-primary/10 text-primary"
          />
          <SummaryCard
            icon={Truck}
            label="Veículos monitorados"
            value={summary.vehicles.total}
            color="bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200"
          />
          <SummaryCard
            icon={XCircle}
            label="Alertas críticos"
            value={summary.alertas.criticos}
            color="bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-200"
          />
          <SummaryCard
            icon={AlertTriangle}
            label="Em atenção"
            value={summary.alertas.atencao}
            color="bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200"
          />
        </section>

        {error ? (
          <section className="admin-panel flex min-h-[200px] flex-col items-center justify-center gap-3 p-10 text-center">
            <XCircle className="h-12 w-12 text-rose-500/50" />
            <p className="text-base font-bold text-foreground">Não foi possível carregar os alertas</p>
            <p className="max-w-lg text-sm text-muted-foreground">
              {error instanceof Error ? error.message : "Erro inesperado ao consultar o gerenciamento de risco."}
            </p>
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-2 inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              <RefreshCw className="h-4 w-4" />
              Tentar de novo
            </button>
          </section>
        ) : (
          <section className="admin-panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 bg-primary/[0.04] text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    <th className="px-4 py-3">Entidade</th>
                    <th className="px-4 py-3">Fonte</th>
                    <th className="px-4 py-3">Situação</th>
                    <th className="px-4 py-3 text-right">Verificado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {isLoading && !items.length ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">
                        Carregando alertas...
                      </td>
                    </tr>
                  ) : visibleItems.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-12 text-center text-sm text-muted-foreground">
                        <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-emerald-500/50" />
                        Nenhum alerta {emptyLabel} no momento.
                      </td>
                    </tr>
                  ) : (
                    visibleItems.map((a) => (
                      <tr key={a.id} className="hover:bg-primary/[0.03]">
                        <td className="px-4 py-3 align-top">
                          {a.entityType === "motorista" ? (
                            <div className="flex flex-col">
                              <span className="font-semibold text-foreground">{a.displayName ?? "—"}</span>
                              {a.document ? (
                                <span className="text-xs tabular-nums text-muted-foreground">{a.document}</span>
                              ) : null}
                            </div>
                          ) : (
                            <div className="flex flex-col">
                              <span className="font-semibold text-foreground">{a.plate ?? a.displayName ?? "—"}</span>
                              <span className="text-xs text-muted-foreground">
                                {(a.plateRole && PLATE_ROLE_LABEL[a.plateRole]) || "Veículo"}
                                {a.linkedDriver?.name ? ` · ${a.linkedDriver.name}` : ""}
                              </span>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 align-top">
                          <span className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {SOURCE_LABEL[a.source]}
                          </span>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <SeverityChip severity={a.severity} message={a.message} />
                          {a.alertType === "EXPIRY" && a.dueDate ? (
                            <p className="mt-1 text-xs text-muted-foreground">Vence em {formatDateOnly(a.dueDate)}</p>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 align-top text-right text-xs text-muted-foreground">
                          {a.checkedAt ? formatShortDateTime(a.checkedAt) : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
