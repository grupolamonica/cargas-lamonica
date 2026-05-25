import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ClipboardList, Filter } from "lucide-react";

import AdminPagination from "@/components/AdminPagination";
import DashboardHeader from "@/components/DashboardHeader";
import { useAuth } from "@/hooks/useAuth";
import { getOperatorAccessLevel } from "@/lib/operatorAccess";
import { fetchOperatorAuditLogs, type OperatorAuditLogItem } from "@/services/readModels";

const PAGE_SIZE = 50;

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function daysAgoIso(days: number) {
  const now = new Date();
  now.setDate(now.getDate() - days);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function formatEventLabel(eventType: string): string {
  const mapping: Record<string, string> = {
    "operator.cargo.created": "Carga cadastrada",
    "operator.cargo.updated": "Carga atualizada",
    "operator.cargo.duplicated": "Carga duplicada",
    "operator.cargo.status_toggled": "Carga: status alterado",
    "operator.cargo.deleted": "Carga excluída",
    "operator.cliente.created": "Cliente cadastrado",
    "operator.cliente.updated": "Cliente atualizado",
    "operator.cliente.deleted": "Cliente excluído",
    "operator.route.saved": "Rota salva",
    "operator.route.updated": "Rota atualizada",
    "operator.driver.profile.updated": "Motorista atualizado",
    "public-leads.pii.redacted": "PII de lead redigido",
    "operator.request.denied": "Requisição negada",
    "system.route_catalog.imported": "Catálogo de rotas importado",
  };
  return mapping[eventType] || eventType;
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const dt = new Date(iso);
    if (!Number.isFinite(dt.getTime())) return "—";
    return dt.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" });
  } catch {
    return "—";
  }
}

function shortenId(id: string | null | undefined): string {
  if (!id) return "—";
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function OperatorAuditLogRow({ log }: { log: OperatorAuditLogItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasMetadata = log.metadata && Object.keys(log.metadata).length > 0;
  return (
    <>
      <tr
        className="border-b border-border/60 text-sm transition-colors hover:bg-primary/[0.03]"
      >
        <td className="px-4 py-3 whitespace-nowrap align-top text-xs text-muted-foreground">
          {formatDateTime(log.createdAt)}
        </td>
        <td className="px-4 py-3 align-top text-xs text-foreground">
          {log.actorDisplayName || log.actorEmail || (
            <span className="font-mono text-muted-foreground">{shortenId(log.actorUserId)}</span>
          )}
          {log.actorDisplayName && log.actorEmail ? (
            <div className="mt-0.5 text-[11px] text-muted-foreground">{log.actorEmail}</div>
          ) : null}
        </td>
        <td className="px-4 py-3 align-top text-sm font-semibold text-foreground">
          {formatEventLabel(log.eventType)}
          {log.severity && log.severity !== "info" ? (
            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
              {log.severity}
            </span>
          ) : null}
        </td>
        {/*
          Bugfix: a coluna RECURSO mostrava textos longos como
          "pending_driver_documents_audit/abc12345…" cortados sem
          indicacao visual de truncamento e sem hover-to-full. Aplicamos
          truncate explicito com max-width e title attribute carregando o
          valor completo (resourceType + resourceId NAO encurtado). O
          operador agora pode ler a string inteira no hover.
        */}
        <td
          className="max-w-[220px] truncate px-4 py-3 align-top text-xs text-muted-foreground"
          title={
            log.resourceType && log.resourceId
              ? `${log.resourceType}/${log.resourceId}`
              : log.resourceType || ""
          }
        >
          {log.resourceType && log.resourceId
            ? `${log.resourceType}/${shortenId(log.resourceId)}`
            : log.resourceType || "—"}
        </td>
        <td className="px-4 py-3 align-top text-xs text-muted-foreground">
          {log.outcome || "—"}
        </td>
        <td className="px-4 py-3 align-top text-xs text-muted-foreground font-mono">
          {log.requestIp || "—"}
        </td>
        <td className="px-4 py-3 align-top text-right">
          {hasMetadata ? (
            <button
              type="button"
              onClick={() => setExpanded((current) => !current)}
              className="rounded-full border border-border/70 bg-white/80 px-3 py-1 text-xs font-semibold text-foreground transition-colors hover:bg-muted dark:bg-muted/40"
            >
              {expanded ? "Ocultar" : "Detalhes"}
            </button>
          ) : (
            <span className="text-xs text-muted-foreground/60">—</span>
          )}
        </td>
      </tr>
      {expanded && hasMetadata ? (
        <tr className="border-b border-border/60 bg-muted/30">
          <td colSpan={7} className="px-4 py-3">
            <pre className="max-h-80 overflow-auto rounded-lg border border-border/60 bg-white/80 p-3 text-[11px] leading-relaxed text-foreground dark:bg-muted/40">
              {JSON.stringify(log.metadata, null, 2)}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

const OperatorAuditLogs = () => {
  const { user } = useAuth();
  const accessLevel = getOperatorAccessLevel(user);
  const [dateFrom, setDateFrom] = useState<string>(daysAgoIso(1));
  const [dateTo, setDateTo] = useState<string>(todayIso());
  const [operatorFilter, setOperatorFilter] = useState<string>("");
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["operator", "audit-logs", dateFrom, dateTo, operatorFilter, page],
    queryFn: () =>
      fetchOperatorAuditLogs({
        dateFrom,
        dateTo,
        operatorId: operatorFilter || undefined,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    enabled: accessLevel === "advanced",
  });

  const meta = data?.meta;
  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const operators = useMemo(() => data?.operators ?? [], [data?.operators]);

  if (accessLevel !== "advanced") {
    return (
      <div>
        <DashboardHeader title="Logs de atividades" />
        <main className="space-y-5 p-6 lg:p-8">
          <section className="admin-panel flex min-h-[260px] flex-col items-center justify-center gap-3 p-10 text-center">
            <ClipboardList className="h-14 w-14 text-muted-foreground/40" />
            <p className="text-lg font-bold text-foreground">Acesso restrito</p>
            <p className="max-w-lg text-sm text-muted-foreground">
              Esta área é exclusiva de operadores com acesso avançado. Solicite ao administrador do sistema caso precise auditar atividades.
            </p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div>
      <DashboardHeader title="Logs de atividades" />
      <main className="space-y-5 p-6 lg:p-8">
        <section className="admin-panel p-5 lg:p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-primary/60">Auditoria</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                Atividades dos operadores
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Registro detalhado de ações no painel: criações, edições, exclusões e acessos. Use os filtros para investigar por período ou operador.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Filter className="h-4 w-4" />
              <input
                type="date"
                value={dateFrom}
                max={dateTo}
                onChange={(event) => {
                  setDateFrom(event.target.value);
                  setPage(1);
                }}
                className="rounded-xl border border-border/70 bg-white/80 px-3 py-2 text-xs dark:bg-muted/40"
                aria-label="Data inicial"
              />
              <span>até</span>
              <input
                type="date"
                value={dateTo}
                min={dateFrom}
                max={todayIso()}
                onChange={(event) => {
                  setDateTo(event.target.value);
                  setPage(1);
                }}
                className="rounded-xl border border-border/70 bg-white/80 px-3 py-2 text-xs dark:bg-muted/40"
                aria-label="Data final"
              />
              <select
                value={operatorFilter}
                onChange={(event) => {
                  setOperatorFilter(event.target.value);
                  setPage(1);
                }}
                className="rounded-xl border border-border/70 bg-white/80 px-3 py-2 text-xs dark:bg-muted/40"
                aria-label="Operador"
              >
                <option value="">Todos os operadores</option>
                {operators.map((op) => {
                  const label = op.displayName || op.email || shortenId(op.id);
                  const levelSuffix =
                    op.accessLevel === "advanced"
                      ? " (avançado)"
                      : op.accessLevel === "intermediate"
                        ? " (intermediário)"
                        : "";
                  return (
                    <option key={op.id} value={op.id}>
                      {label}
                      {levelSuffix}
                    </option>
                  );
                })}
              </select>
              <button
                type="button"
                onClick={() => {
                  setDateFrom(daysAgoIso(1));
                  setDateTo(todayIso());
                  setOperatorFilter("");
                  setPage(1);
                }}
                className="rounded-xl border border-border/70 bg-white/80 px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted dark:bg-muted/40"
              >
                Limpar filtros
              </button>
            </div>
          </div>
        </section>

        {error ? (
          <section className="admin-panel min-h-[140px] p-6 text-sm text-rose-600 dark:text-rose-300">
            {error instanceof Error ? error.message : "Erro ao carregar os logs."}
          </section>
        ) : (
          <section className="admin-panel overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 bg-primary/[0.04] text-left text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    <th className="px-4 py-3">Quando</th>
                    <th className="px-4 py-3">Operador</th>
                    <th className="px-4 py-3">Ação</th>
                    <th className="px-4 py-3">Recurso</th>
                    <th className="px-4 py-3">Resultado</th>
                    <th className="px-4 py-3">IP</th>
                    <th className="px-4 py-3 text-right">Detalhes</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading && !items.length ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                        Carregando...
                      </td>
                    </tr>
                  ) : items.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                        Nenhum evento encontrado no período.
                      </td>
                    </tr>
                  ) : (
                    items.map((log) => <OperatorAuditLogRow key={log.id} log={log} />)
                  )}
                </tbody>
              </table>
            </div>

            {meta ? (
              <div className="border-t border-border/60 p-4">
                <AdminPagination
                  page={meta.page}
                  totalPages={meta.totalPages}
                  totalCount={meta.totalCount}
                  pageSize={meta.pageSize}
                  itemLabel="registro"
                  isFetching={isFetching}
                  onPrevious={() => setPage((current) => Math.max(1, current - 1))}
                  onNext={() => setPage((current) => Math.min(meta.totalPages, current + 1))}
                />
              </div>
            ) : null}
          </section>
        )}
      </main>
    </div>
  );
};

export default OperatorAuditLogs;
