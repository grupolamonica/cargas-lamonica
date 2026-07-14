import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRight, ClipboardList, Download, Filter, Loader2 } from "lucide-react";
import { toast } from "sonner";

import AdminPagination from "@/components/AdminPagination";
import DashboardHeader from "@/components/DashboardHeader";
import { MultiSelectFilter } from "@/components/operator/MultiSelectFilter";
import { useAuth } from "@/hooks/useAuth";
import { getOperatorAccessLevel } from "@/lib/operatorAccess";
import { downloadCsv, csvTimestamp } from "@/lib/csv";
import {
  formatAuditValue,
  formatOutcomeLabel,
  formatResourceLabel,
  formatSeverityLabel,
  friendlyMetadataEntries,
} from "@/lib/auditDisplay";
import {
  fetchOperatorAuditLogs,
  type OperatorAuditLogChange,
  type OperatorAuditLogItem,
} from "@/services/readModels";

const PAGE_SIZE = 50;
// Teto de linhas no export CSV — evita puxar histórico ilimitado de uma vez.
const EXPORT_MAX_ROWS = 5000;
const EXPORT_PAGE_SIZE = 200;

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function daysAgoIso(days: number) {
  const now = new Date();
  now.setDate(now.getDate() - days);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
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

/** Resumo textual das mudanças para o CSV (valores já humanizados por campo). */
function changesToText(changes: OperatorAuditLogChange[] | null): string {
  if (!changes || changes.length === 0) return "";
  return changes
    .map((c) => `${c.label}: ${formatAuditValue(c.field, c.before)} → ${formatAuditValue(c.field, c.after)}`)
    .join(" | ");
}

function operatorLabel(log: OperatorAuditLogItem): string {
  return log.actorDisplayName || log.actorEmail || shortenId(log.actorUserId);
}

/** DC-184: tabela compacta "antes → depois". */
function ChangeDiff({ changes }: { changes: OperatorAuditLogChange[] }) {
  return (
    <div className="mb-3 space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        Alterações
      </p>
      <div className="space-y-1.5">
        {changes.map((change) => (
          <div key={change.field} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="min-w-[110px] font-semibold text-foreground">{change.label}</span>
            <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[11px] text-rose-700 line-through decoration-rose-400/70 dark:bg-rose-500/20 dark:text-rose-200">
              {formatAuditValue(change.field, change.before)}
            </span>
            <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200">
              {formatAuditValue(change.field, change.after)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OperatorAuditLogRow({ log }: { log: OperatorAuditLogItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasChanges = Boolean(log.changes && log.changes.length > 0);
  const hasMetadata = log.metadata && Object.keys(log.metadata).length > 0;
  const canExpand = hasChanges || hasMetadata;
  // Evita mostrar as mudanças duas vezes: o ChangeDiff já renderiza `changes`,
  // então o JSON cru abaixo omite essa chave (mantém o resto da metadata).
  const metadataForDisplay = useMemo(() => {
    if (!log.metadata) return null;
    if (!hasChanges) return log.metadata;
    const rest: Record<string, unknown> = { ...log.metadata };
    delete rest.changes;
    return rest;
  }, [log.metadata, hasChanges]);
  const hasDisplayMetadata = Boolean(metadataForDisplay && Object.keys(metadataForDisplay).length > 0);
  const severityLabel = formatSeverityLabel(log.severity);
  // Contexto amigável (só chaves úteis) p/ eventos sem antes→depois.
  const contextEntries = useMemo(
    () => (hasChanges ? [] : friendlyMetadataEntries(log.metadata)),
    [hasChanges, log.metadata],
  );
  return (
    <>
      <tr className="border-b border-border/60 text-sm transition-colors hover:bg-primary/[0.03]">
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
          {log.eventLabel || log.eventType}
          {severityLabel ? (
            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
              {severityLabel}
            </span>
          ) : null}
          {hasChanges ? (
            <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
              {log.changes!.length} {log.changes!.length === 1 ? "alteração" : "alterações"}
            </span>
          ) : null}
        </td>
        <td className="px-4 py-3 align-top text-xs">
          <span className="inline-flex rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {log.categoryLabel}
          </span>
        </td>
        {/*
          Recurso legível ao operador: mostra só o tipo em pt-BR ("Rota",
          "Carga", "Motorista"...) — o UUID técnico fica no title (hover) para
          suporte, sem poluir a tela com código.
        */}
        <td
          className="max-w-[220px] truncate px-4 py-3 align-top text-xs text-muted-foreground"
          title={
            log.resourceType && log.resourceId
              ? `${log.resourceType}/${log.resourceId}`
              : log.resourceType || ""
          }
        >
          {formatResourceLabel(log.resourceType)}
        </td>
        <td className="px-4 py-3 align-top text-xs text-muted-foreground">
          {formatOutcomeLabel(log.outcome)}
        </td>
        <td className="px-4 py-3 align-top text-xs text-muted-foreground font-mono">
          {log.requestIp || "—"}
        </td>
        <td className="px-4 py-3 align-top text-right">
          {canExpand ? (
            <button
              type="button"
              aria-expanded={expanded}
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
      {expanded && canExpand ? (
        <tr className="border-b border-border/60 bg-muted/30">
          <td colSpan={8} className="px-4 py-3">
            {hasChanges ? <ChangeDiff changes={log.changes!} /> : null}
            {contextEntries.length > 0 ? (
              <div className="mb-3 space-y-1 text-xs">
                {contextEntries.map((entry) => (
                  <div key={entry.label} className="flex flex-wrap gap-2">
                    <span className="min-w-[110px] font-semibold text-foreground">{entry.label}</span>
                    <span className="text-muted-foreground">{entry.value}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {hasDisplayMetadata ? (
              <details>
                <summary className="cursor-pointer select-none text-[11px] font-semibold text-muted-foreground/70 transition-colors hover:text-muted-foreground">
                  Dados técnicos
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-border/60 bg-white/80 p-3 text-[11px] leading-relaxed text-foreground dark:bg-muted/40">
                  {JSON.stringify(metadataForDisplay, null, 2)}
                </pre>
              </details>
            ) : null}
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
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [isExporting, setIsExporting] = useState(false);

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["operator", "audit-logs", dateFrom, dateTo, operatorFilter, selectedCategories, page],
    queryFn: () =>
      fetchOperatorAuditLogs({
        dateFrom,
        dateTo,
        operatorId: operatorFilter || undefined,
        categories: selectedCategories.length ? selectedCategories : undefined,
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
  const categories = useMemo(() => data?.categories ?? [], [data?.categories]);
  const categoryOptions = useMemo(
    () => categories.map((c) => ({ value: c.key, label: c.label })),
    [categories],
  );

  // DC-186: exporta TODAS as linhas que batem com os filtros (não só a página
  // atual), paginando o read-model até o teto. Respeita período/operador/tipo.
  const handleExport = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const collected: OperatorAuditLogItem[] = [];
      let exportPage = 1;
      let totalPages = 1;
      do {
        const chunk = await fetchOperatorAuditLogs({
          dateFrom,
          dateTo,
          operatorId: operatorFilter || undefined,
          categories: selectedCategories.length ? selectedCategories : undefined,
          page: String(exportPage),
          pageSize: String(EXPORT_PAGE_SIZE),
        });
        collected.push(...chunk.items);
        totalPages = chunk.meta.totalPages;
        exportPage += 1;
      } while (exportPage <= totalPages && collected.length < EXPORT_MAX_ROWS);

      // Dedup por id: paginação por OFFSET num log append-only pode repetir
      // linhas se novos eventos chegarem entre a busca de uma página e a próxima.
      const seen = new Set<string>();
      const unique = collected.filter((log) => {
        if (seen.has(log.id)) return false;
        seen.add(log.id);
        return true;
      });

      if (unique.length === 0) {
        toast.info("Nenhum registro no período/filtros para exportar.");
        return;
      }

      const truncated = collected.length >= EXPORT_MAX_ROWS && exportPage <= totalPages;
      const headers = [
        "Quando",
        "Operador",
        "Email",
        "Categoria",
        "Ação",
        "Recurso",
        "Resultado",
        "IP",
        "Alterações",
        "Correlation ID",
      ];
      const rows = unique.map((log) => [
        formatDateTime(log.createdAt),
        operatorLabel(log),
        log.actorEmail || "",
        log.categoryLabel,
        log.eventLabel || log.eventType,
        formatResourceLabel(log.resourceType),
        formatOutcomeLabel(log.outcome),
        log.requestIp || "",
        changesToText(log.changes),
        log.correlationId || "",
      ]);

      downloadCsv(`auditoria-${csvTimestamp()}.csv`, headers, rows);
      toast.success(
        `${unique.length} registro${unique.length === 1 ? "" : "s"} exportado${unique.length === 1 ? "" : "s"}.` +
          (truncated ? ` (limite de ${EXPORT_MAX_ROWS} — refine os filtros)` : ""),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao exportar o CSV.");
    } finally {
      setIsExporting(false);
    }
  };

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
                Registro detalhado de ações no painel: criações, edições, exclusões e acessos. Use os filtros para investigar por período, operador ou tipo de log.
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
              {/* DC-185: filtro multiselect por tipo de log (categoria). */}
              <MultiSelectFilter
                label="Tipo de log"
                options={categoryOptions}
                selected={selectedCategories}
                onChange={(next) => {
                  setSelectedCategories(next);
                  setPage(1);
                }}
                searchPlaceholder="Buscar tipo..."
                emptyText="Nenhum tipo."
                className="min-w-[150px] rounded-xl px-3 py-2 text-xs"
              />
              <button
                type="button"
                onClick={() => {
                  setDateFrom(daysAgoIso(1));
                  setDateTo(todayIso());
                  setOperatorFilter("");
                  setSelectedCategories([]);
                  setPage(1);
                }}
                className="rounded-xl border border-border/70 bg-white/80 px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted dark:bg-muted/40"
              >
                Limpar filtros
              </button>
              {/* DC-186: exportar log filtrado para CSV. */}
              <button
                type="button"
                onClick={handleExport}
                disabled={isExporting}
                title="Exporta o log filtrado (todas as páginas) para CSV — abre no Excel"
                className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/50 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-500/20 disabled:opacity-60 dark:bg-emerald-500/15 dark:text-emerald-200"
              >
                {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                {isExporting ? "Exportando..." : "Exportar CSV"}
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
                    <th className="px-4 py-3">Tipo</th>
                    <th className="px-4 py-3">Recurso</th>
                    <th className="px-4 py-3">Resultado</th>
                    <th className="px-4 py-3">IP</th>
                    <th className="px-4 py-3 text-right">Detalhes</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading && !items.length ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                        Carregando...
                      </td>
                    </tr>
                  ) : items.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">
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
