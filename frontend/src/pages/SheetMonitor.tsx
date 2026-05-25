import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  FileSpreadsheet,
  Filter,
  Loader2,
  MapPin,
  RefreshCw,
  Search,
  ShieldX,
  Sparkles,
  Truck,
  UserCheck,
  X,
  XCircle,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import DashboardHeader from "@/components/DashboardHeader";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  enrichSheetMonitor,
  fetchSheetMonitor,
  type SheetMonitorEnrichedRow,
  type SheetMonitorRow as SheetMonitorRowType,
  type SheetMonitorSummary,
} from "@/services/readModels";

const SHEET_MONITOR_QUERY_KEY = ["admin", "sheet-monitor"] as const;

const PAGE_SIZE = 50;
const EMPTY_ROWS: SheetMonitorRowType[] = [];
const EMPTY_ENRICHED: Record<string, SheetMonitorEnrichedRow> = {};

const SHEET_MONITOR_QUERY_OPTIONS = {
  staleTime: 30_000,
  gcTime: 60_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  structuralSharing: false,
  retry: 2,
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8000),
} as const;

// ─── Status styles ────────────────────────────────────────────────────────────

function resolveSheetStatusStyle(status: string) {
  const trimmed = (status || "").trim();
  const normalized = trimmed.toLowerCase();

  const exact: Record<string, { dot: string; bg: string; label: string }> = {
    "":            { dot: "bg-blue-500",    bg: "bg-blue-50 text-blue-800 dark:bg-blue-500/15 dark:text-blue-200",            label: "Disponivel" },
    "Reservado":   { dot: "bg-violet-500", bg: "bg-violet-50 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200",    label: "Reservado" },
    "Em aberto":   { dot: "bg-amber-500",   bg: "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",        label: "Em aberto" },
    "Aprovado":    { dot: "bg-emerald-500", bg: "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200", label: "Aprovado" },
    "Em transito": { dot: "bg-indigo-500",  bg: "bg-indigo-50 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-200",    label: "Em transito" },
    "Entregue":    { dot: "bg-teal-500",    bg: "bg-teal-50 text-teal-800 dark:bg-teal-500/15 dark:text-teal-200",             label: "Entregue" },
    "Cancelado":   { dot: "bg-red-400",     bg: "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-200",                 label: "Cancelado" },
    "Concluido":   { dot: "bg-green-600",   bg: "bg-green-50 text-green-800 dark:bg-green-500/15 dark:text-green-200",         label: "Concluido" },
  };

  if (exact[trimmed]) return exact[trimmed];

  if (!trimmed || /dispon[ií]vel/.test(normalized))
    return { dot: "bg-blue-500",    bg: "bg-blue-50 text-blue-800 dark:bg-blue-500/20 dark:text-blue-100",      label: trimmed || "Disponivel" };
  if (/descarregado|entregue/.test(normalized))
    return { dot: "bg-teal-500",    bg: "bg-teal-50 text-teal-800 dark:bg-teal-500/20 dark:text-teal-100",      label: trimmed };
  if (/descarregando/.test(normalized))
    return { dot: "bg-cyan-500",    bg: "bg-cyan-50 text-cyan-800 dark:bg-cyan-500/20 dark:text-cyan-100",       label: trimmed };
  if (/cancel/.test(normalized))
    return { dot: "bg-red-400",     bg: "bg-red-50 text-red-700 dark:bg-red-500/20 dark:text-red-100",           label: trimmed };
  if (/no\s*show/.test(normalized))
    return { dot: "bg-rose-500",    bg: "bg-rose-50 text-rose-800 dark:bg-rose-500/20 dark:text-rose-100",       label: trimmed };
  if (/cte\s+enviado/.test(normalized))
    return { dot: "bg-sky-500",     bg: "bg-sky-50 text-sky-800 dark:bg-sky-500/20 dark:text-sky-100",           label: trimmed };
  if (/cte\s+em\s+emiss/.test(normalized))
    return { dot: "bg-violet-500",  bg: "bg-violet-50 text-violet-800 dark:bg-violet-500/20 dark:text-violet-100", label: trimmed };
  if (/aguardando\s+chegar/.test(normalized))
    return { dot: "bg-amber-500",   bg: "bg-amber-50 text-amber-800 dark:bg-amber-500/20 dark:text-amber-100",   label: trimmed };
  if (/aguardando\s+carreg/.test(normalized))
    return { dot: "bg-orange-500",  bg: "bg-orange-50 text-orange-800 dark:bg-orange-500/20 dark:text-orange-100", label: trimmed };
  if (/aguardando\s+descarg/.test(normalized))
    return { dot: "bg-fuchsia-500", bg: "bg-fuchsia-50 text-fuchsia-800 dark:bg-fuchsia-500/20 dark:text-fuchsia-100", label: trimmed };
  if (/aguardando/.test(normalized))
    return { dot: "bg-amber-500",   bg: "bg-amber-50 text-amber-800 dark:bg-amber-500/20 dark:text-amber-100",   label: trimmed };
  if (/carregando|em\s+tr[aâ]nsito/.test(normalized))
    return { dot: "bg-indigo-500",  bg: "bg-indigo-50 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-100", label: trimmed };
  if (/finaliz|conclu/.test(normalized))
    return { dot: "bg-green-600",   bg: "bg-green-50 text-green-800 dark:bg-green-500/20 dark:text-green-100",   label: trimmed };

  return { dot: "bg-slate-400", bg: "bg-slate-100 text-slate-700 dark:bg-slate-500/25 dark:text-slate-100", label: trimmed || "—" };
}

function StatusBadge({ status }: { status: string }) {
  const cfg = resolveSheetStatusStyle(status);
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.68rem] font-semibold", cfg.bg)}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", cfg.dot)} />
      {cfg.label}
    </span>
  );
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function SummaryCard({ icon: Icon, label, value, color }: { icon: typeof FileSpreadsheet; label: string; value: number; color: string }) {
  return (
    <div className="admin-panel flex items-center gap-4 p-4 lg:p-5">
      <div className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl", color)}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-bold tracking-tight text-foreground">{value}</p>
        <p className="mt-0.5 truncate text-xs font-medium text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

function StatusBreakdown({ statuses }: { statuses: Record<string, number> }) {
  const entries = Object.entries(statuses).sort(([, a], [, b]) => b - a);
  if (entries.length === 0) return null;
  return (
    <div className="admin-panel space-y-3 p-4 lg:p-5">
      <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">Status na planilha</h3>
      <div className="flex flex-wrap gap-2">
        {entries.map(([status, count]) => {
          const cfg = resolveSheetStatusStyle(status === "Sem status" ? "" : status);
          return (
            <span key={status} className={cn("inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold", cfg.bg)}>
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", cfg.dot)} />
              <span className="uppercase tracking-[0.08em]">{cfg.label}</span>
              <span className="rounded-full bg-black/10 px-1.5 py-0.5 text-[0.68rem] font-bold text-current dark:bg-white/15">{count}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function formatCurrency(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

// ─── Enriched status dot ──────────────────────────────────────────────────────

function AngelliraDot({ found }: { found: boolean | null | undefined }) {
  if (found === null || found === undefined)
    return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/20" title="Não consultado" />;
  return found
    ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" title="Angellira: aprovado" />
    : <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" title="Angellira: não aprovado" />;
}

// ─── Table row ────────────────────────────────────────────────────────────────

const ROW_VIRTUALIZATION_STYLE = { contentVisibility: "auto" as const, containIntrinsicSize: "0 48px" as const };

const SheetMonitorRow = memo(function SheetMonitorRow({
  row,
  enriched,
  selected,
  onSelect,
}: {
  row: SheetMonitorRowType;
  enriched: SheetMonitorEnrichedRow | undefined;
  selected: boolean;
  onSelect: (row: SheetMonitorRowType) => void;
}) {
  return (
    <tr
      style={ROW_VIRTUALIZATION_STYLE}
      onClick={() => onSelect(row)}
      className={cn(
        "cursor-pointer transition-colors duration-100",
        selected
          ? "bg-primary/10 dark:bg-primary/20"
          : row.hasDriver
            ? "hover:bg-emerald-50/60 dark:hover:bg-emerald-500/10"
            : "hover:bg-primary/[0.04]",
      )}
    >
      {/* Status */}
      <td className="px-3 py-2"><StatusBadge status={!row.status && row.motoristas ? "Reservado" : row.status} /></td>

      {/* LH + Tipo */}
      <td className="px-3 py-2">
        <span className="block font-mono text-xs font-semibold text-foreground/80">{row.lh}</span>
        {row.tipo && <span className="block text-[0.62rem] text-muted-foreground">{row.tipo}</span>}
      </td>

      {/* Rota */}
      <td className="px-3 py-2 max-w-[180px]">
        <p className="truncate text-xs font-medium text-foreground">{row.origem || "—"}</p>
        <p className="truncate text-[0.62rem] text-muted-foreground">{row.destino || "—"}</p>
      </td>

      {/* Agenda: carga + descarga */}
      <td className="px-3 py-2">
        {row.carregamentoLabel ? (
          <div>
            <p className="text-[0.58rem] font-semibold uppercase tracking-wide text-muted-foreground/50">Carga</p>
            <p className="text-xs text-foreground">{row.carregamentoLabel}</p>
          </div>
        ) : null}
        {row.descargaLabel ? (
          <div className={row.carregamentoLabel ? "mt-1" : ""}>
            <p className="text-[0.58rem] font-semibold uppercase tracking-wide text-muted-foreground/50">Descarga</p>
            <p className="text-xs text-muted-foreground">{row.descargaLabel}</p>
          </div>
        ) : null}
        {!row.carregamentoLabel && !row.descargaLabel && (
          <span className="text-xs text-muted-foreground/40">—</span>
        )}
      </td>

      {/* Motorista + Placa + enriched dots */}
      <td className="px-3 py-2">
        {row.motoristas ? (
          <div className="flex items-center gap-1.5">
            <AngelliraDot found={enriched?.angellira_driver_found} />
            <span className="truncate text-xs font-medium text-foreground">{row.motoristas}</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground/50">Sem motorista</span>
        )}
        {row.cavalo && (
          <div className="flex items-center gap-1.5 mt-0.5">
            <AngelliraDot found={enriched?.cavalo_angellira_found} />
            <span className="truncate text-[0.62rem] text-muted-foreground">
              {row.cavalo}{row.carreta ? ` · ${row.carreta}` : ""}
            </span>
          </div>
        )}
      </td>
    </tr>
  );
});

// ─── Table wrapper ────────────────────────────────────────────────────────────

function SheetMonitorTable({
  rows,
  enrichedByLh,
  selectedLh,
  loading,
  onSelect,
}: {
  rows: SheetMonitorRowType[];
  enrichedByLh: Record<string, SheetMonitorEnrichedRow>;
  selectedLh: string | null;
  loading: boolean;
  onSelect: (row: SheetMonitorRowType) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="h-12 animate-pulse rounded-xl bg-muted/40" />)}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
        <FileSpreadsheet className="h-10 w-10 opacity-30" />
        <p className="text-sm font-medium">Nenhuma linha encontrada na planilha.</p>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="overflow-x-auto overscroll-x-contain pb-1">
        <table className="w-full min-w-[680px] table-fixed text-sm">
          <colgroup>
            <col className="w-[130px]" />
            <col className="w-[100px]" />
            <col />
            <col className="w-[140px]" />
            <col className="w-[190px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border/60 bg-primary/[0.028]">
              {(["Status", "LH", "Rota", "Agenda", "Motorista / Placa"] as const).map((col) => (
                <th key={col} className="px-3 py-2.5 text-left text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {rows.map((row, idx) => (
              <SheetMonitorRow
                key={`${row.lh}-${idx}`}
                row={row}
                enriched={enrichedByLh[row.lh]}
                selected={row.lh === selectedLh}
                onSelect={onSelect}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to l from-background/80 to-transparent" />
    </div>
  );
}

// ─── Modal helpers ────────────────────────────────────────────────────────────

function ModalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border/50 px-6 py-4 last:border-0">
      <h3 className="mb-3 text-[0.62rem] font-bold uppercase tracking-[0.18em] text-muted-foreground/60">{title}</h3>
      {children}
    </div>
  );
}

function ModalRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-0.5">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-xs font-medium text-foreground">{value ?? <span className="text-muted-foreground/40">—</span>}</span>
    </div>
  );
}

function BoolBadge({ value }: { value: boolean | null | undefined }) {
  if (value == null) return <span className="text-xs text-muted-foreground/40">—</span>;
  return value ? (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
      <BadgeCheck className="h-3.5 w-3.5" />Sim
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-500 dark:text-red-400">
      <XCircle className="h-3.5 w-3.5" />Não
    </span>
  );
}

function AngelliraStatusBadge({ found, statusText }: { found: boolean | null | undefined; statusText?: string | null }) {
  if (found == null)
    return <span className="text-xs text-muted-foreground/40">Não consultado</span>;
  if (found)
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
        <BadgeCheck className="h-3.5 w-3.5" />{statusText ?? "Aprovado"}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-500 dark:text-red-400">
      <ShieldX className="h-3.5 w-3.5" />{statusText ?? "Não aprovado"}
    </span>
  );
}

function SourceBadge({ source }: { source: string | null | undefined }) {
  if (!source) return null;
  const map: Record<string, string> = {
    db: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    angellira: "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
    not_found: "bg-slate-100 text-slate-500 dark:bg-slate-500/20 dark:text-slate-300",
  };
  const labels: Record<string, string> = { db: "Banco", angellira: "Angellira", not_found: "Não encontrado" };
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[0.6rem] font-semibold uppercase", map[source] ?? map.not_found)}>
      {labels[source] ?? source}
    </span>
  );
}

// ─── Detail Modal ─────────────────────────────────────────────────────────────

function RowDetailModal({
  row,
  enriched,
  open,
  onClose,
}: {
  row: SheetMonitorRowType | null;
  enriched: SheetMonitorEnrichedRow | undefined;
  open: boolean;
  onClose: () => void;
}) {
  if (!row) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl p-0 overflow-hidden">
        <div className="flex flex-col" style={{ maxHeight: "88vh" }}>

          {/* Fixed header */}
          <DialogHeader className="shrink-0 border-b border-border/60 px-6 py-4 pr-14 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <DialogTitle className="font-mono text-base font-bold text-foreground">{row.lh}</DialogTitle>
              {row.tipo && (
                <span className="rounded-full bg-muted/70 px-2.5 py-0.5 text-[0.65rem] font-semibold text-muted-foreground">
                  {row.tipo}
                </span>
              )}
            </div>
            <StatusBadge status={row.status} />
          </DialogHeader>

          {/* Scrollable body */}
          <div className="min-h-0 flex-1 overflow-y-auto">

            {/* ── Viagem ── */}
            <ModalSection title="Viagem">
              <div className="space-y-1">
                <div className="flex items-start gap-2 mb-3">
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-foreground">{row.origem || "—"}</p>
                    <p className="text-[0.65rem] text-muted-foreground">↓ {row.destino || "—"}</p>
                  </div>
                </div>
                {row.carregamentoLabel && <ModalRow label="Carga" value={row.carregamentoLabel} />}
                {row.descargaLabel && <ModalRow label="Descarga" value={row.descargaLabel} />}
                {row.valor !== undefined && <ModalRow label="Valor" value={formatCurrency(row.valor)} />}
                {row.checklistCavalo && <ModalRow label="Checklist cavalo" value={row.checklistCavalo} />}
                {row.checklistCarreta && <ModalRow label="Checklist carreta" value={row.checklistCarreta} />}
              </div>
            </ModalSection>

            {/* ── Motorista ── */}
            <ModalSection title="Motorista">
              {!row.motoristas ? (
                <p className="text-xs text-muted-foreground/50">Sem motorista nesta viagem.</p>
              ) : (
                <div className="space-y-1">
                  <ModalRow label="Nome (planilha)" value={<span className="font-semibold">{row.motoristas}</span>} />
                  {enriched ? (
                    <>
                      {enriched.aspx_display_name && (
                        <ModalRow label="Nome (ASPX)" value={enriched.aspx_display_name} />
                      )}
                      {enriched.aspx_cpf ? (
                        <ModalRow label="CPF (ASPX)" value={<span className="font-mono">{enriched.aspx_cpf}</span>} />
                      ) : (
                        <ModalRow
                          label="CPF (ASPX)"
                          value={
                            <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                              <AlertTriangle className="h-3 w-3" />Não encontrado no ASPX
                            </span>
                          }
                        />
                      )}
                      <ModalRow
                        label="Angellira"
                        value={<AngelliraStatusBadge found={enriched.angellira_driver_found} statusText={enriched.angellira_driver_status_text} />}
                      />
                      {enriched.angellira_driver_valid_until && (
                        <ModalRow label="Validade" value={enriched.angellira_driver_valid_until} />
                      )}
                    </>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground/50 italic">Consulta Angellira/ASPX pendente.</p>
                  )}
                </div>
              )}
            </ModalSection>

            {/* ── Veículos ── */}
            <ModalSection title="Veículos">
              {!row.cavalo && !row.carreta ? (
                <p className="text-xs text-muted-foreground/50">Nenhuma placa informada.</p>
              ) : (
                <div className="space-y-3">
                  {/* Cavalo */}
                  {row.cavalo && (
                    <div className="rounded-xl border border-border/60 bg-muted/20 p-3 space-y-1">
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-1.5">
                          <Truck className="h-3.5 w-3.5 text-muted-foreground/50" />
                          <span className="font-mono text-xs font-bold text-foreground">{row.cavalo}</span>
                          <span className="text-[0.6rem] text-muted-foreground/50">cavalo</span>
                        </div>
                        {enriched && <SourceBadge source={enriched.cavalo_source} />}
                      </div>
                      {enriched ? (
                        <>
                          {enriched.cavalo_type && <ModalRow label="Tipo" value={enriched.cavalo_type} />}
                          <ModalRow
                            label="Angellira"
                            value={<AngelliraStatusBadge found={enriched.cavalo_angellira_found} statusText={enriched.cavalo_angellira_status_text} />}
                          />
                          {enriched.cavalo_angellira_valid_until && <ModalRow label="Validade" value={enriched.cavalo_angellira_valid_until} />}
                          {enriched.cavalo_angellira_display && <ModalRow label="Proprietário" value={enriched.cavalo_angellira_display} />}
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground/50 italic">Consulta pendente.</p>
                      )}
                    </div>
                  )}

                  {/* Carreta */}
                  {row.carreta && (
                    <div className="rounded-xl border border-border/60 bg-muted/20 p-3 space-y-1">
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-1.5">
                          <Truck className="h-3.5 w-3.5 text-muted-foreground/50" />
                          <span className="font-mono text-xs font-bold text-foreground">{row.carreta}</span>
                          <span className="text-[0.6rem] text-muted-foreground/50">carreta</span>
                        </div>
                        {enriched && <SourceBadge source={enriched.carreta_source} />}
                      </div>
                      {enriched ? (
                        <>
                          {enriched.carreta_type && <ModalRow label="Tipo" value={enriched.carreta_type} />}
                          <ModalRow
                            label="Angellira"
                            value={<AngelliraStatusBadge found={enriched.carreta_angellira_found} statusText={enriched.carreta_angellira_status_text} />}
                          />
                          {enriched.carreta_angellira_valid_until && <ModalRow label="Validade" value={enriched.carreta_angellira_valid_until} />}
                          {enriched.carreta_angellira_display && <ModalRow label="Proprietário" value={enriched.carreta_angellira_display} />}
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground/50 italic">Consulta pendente.</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </ModalSection>

          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SheetMonitor() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [tipoFilter, setTipoFilter] = useState("todos");
  const [assignmentFilter, setAssignmentFilter] = useState("todos");
  const [dateFromFilter, setDateFromFilter] = useState("");
  const [dateToFilter, setDateToFilter] = useState("");
  const [page, setPage] = useState(0);
  const [selectedRow, setSelectedRow] = useState<SheetMonitorRowType | null>(null);
  const deferredSearch = useDeferredValue(search);

  // Enrich loop state
  const enrichingRef = useRef(false);
  const [enrichProgress, setEnrichProgress] = useState<{ done: number; total: number } | null>(null);

  const { data: monitorData, error: queryError, isFetching, isLoading } = useQuery({
    queryKey: [...SHEET_MONITOR_QUERY_KEY],
    queryFn: fetchSheetMonitor,
    ...SHEET_MONITOR_QUERY_OPTIONS,
  });

  const items = monitorData?.items ?? EMPTY_ROWS;
  const enrichedByLh = monitorData?.enrichedByLh ?? EMPTY_ENRICHED;
  const sheetConfigured = monitorData?.meta?.sheetConfigured ?? true;
  const noSnapshot = monitorData?.meta?.noSnapshot ?? false;
  const cachedAt = monitorData?.meta?.cachedAt;
  const snapshotSaveFailed = monitorData?.meta?.snapshotSaved === false;
  const snapshotSaveError = monitorData?.meta?.snapshotSaveError;

  const pendingEnrich = items.length > 0
    ? items.length - Object.keys(enrichedByLh).length
    : 0;

  const summary = useMemo(() => {
    if (items.length === 0) {
      return { total: 0, available: 0, assigned: 0, withStatus: 0, statuses: {} as Record<string, number>, tipos: {} as Record<string, number> } satisfies SheetMonitorSummary;
    }
    const statuses: Record<string, number> = {};
    const tipos: Record<string, number> = {};
    let available = 0, assigned = 0, withStatus = 0;
    for (const row of items) {
      if (!row.motoristas && !row.status) available += 1;
      if (row.motoristas) assigned += 1;
      if (row.status) withStatus += 1;
      const sk = row.status || "Sem status";
      statuses[sk] = (statuses[sk] ?? 0) + 1;
      if (row.tipo) tipos[row.tipo] = (tipos[row.tipo] ?? 0) + 1;
    }
    return { total: items.length, available, assigned, withStatus, statuses, tipos } satisfies SheetMonitorSummary;
  }, [items]);

  const statusOptions = useMemo(() => {
    const s = new Set<string>();
    items.forEach((item) => s.add(item.status || "Sem status"));
    return Array.from(s).sort();
  }, [items]);

  const tipoOptions = useMemo(() => {
    const s = new Set<string>();
    items.forEach((item) => { if (item.tipo) s.add(item.tipo); });
    return Array.from(s).sort();
  }, [items]);

  const filteredRows = useMemo(() => {
    let result = items;

    if (deferredSearch.trim()) {
      const q = deferredSearch.trim().toLowerCase();
      result = result.filter((r) =>
        r.lh.toLowerCase().includes(q) || r.origem.toLowerCase().includes(q) ||
        r.destino.toLowerCase().includes(q) || r.motoristas.toLowerCase().includes(q) || r.cavalo.toLowerCase().includes(q),
      );
    }

    if (statusFilter !== "todos")
      result = statusFilter === "Sem status" ? result.filter((r) => r.status === "") : result.filter((r) => r.status === statusFilter);

    if (tipoFilter !== "todos")
      result = result.filter((r) => r.tipo === tipoFilter);

    if (assignmentFilter === "com_motorista") result = result.filter((r) => Boolean(r.motoristas));
    else if (assignmentFilter === "sem_motorista") result = result.filter((r) => !r.motoristas);
    else if (assignmentFilter === "disponiveis") result = result.filter((r) => !r.motoristas && !r.status);

    if (dateFromFilter || dateToFilter) {
      const fromTs = dateFromFilter ? new Date(dateFromFilter).getTime() : null;
      const toTs = dateToFilter ? new Date(dateToFilter).getTime() : null;
      result = result.filter((row) => {
        if (!row.data) return false;
        const horario = row.horario || "00:00:00";
        const iso = `${row.data}T${horario.length === 5 ? `${horario}:00` : horario}`;
        const ts = new Date(iso).getTime();
        if (!Number.isFinite(ts)) return false;
        if (fromTs !== null && ts < fromTs) return false;
        if (toTs !== null && ts > toTs) return false;
        return true;
      });
    }

    return result;
  }, [items, deferredSearch, statusFilter, tipoFilter, assignmentFilter, dateFromFilter, dateToFilter]);

  const hasActiveFilters =
    deferredSearch.trim().length > 0 || statusFilter !== "todos" || tipoFilter !== "todos" ||
    assignmentFilter !== "todos" || dateFromFilter.length > 0 || dateToFilter.length > 0;

  useEffect(() => { setPage(0); }, [deferredSearch, statusFilter, tipoFilter, assignmentFilter, dateFromFilter, dateToFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const paginatedRows = useMemo(() => filteredRows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE), [filteredRows, safePage]);
  const pageStart = filteredRows.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const pageEnd = Math.min(filteredRows.length, (safePage + 1) * PAGE_SIZE);

  // ── Refresh sheet ────────────────────────────────────────────────────────────
  const refreshMutation = useMutation({
    mutationFn: () => fetchSheetMonitor({ refresh: true }),
    onSuccess: (freshData) => {
      queryClient.setQueryData([...SHEET_MONITOR_QUERY_KEY], freshData);
      // Fila operacional usa status da planilha — invalidar para refletir status novo apos sync.
      queryClient.invalidateQueries({ queryKey: ["operator", "public-load-leads"] });
      handleStartEnrich(true);
    },
  });

  // ── Enrich loop ──────────────────────────────────────────────────────────────
  const enrichForceRef = useRef(false);
  const forceSessionStartRef = useRef<string | null>(null);

  const enrichMutation = useMutation({
    mutationFn: () => enrichSheetMonitor({
      force: enrichForceRef.current,
      forceSessionStart: forceSessionStartRef.current ?? undefined,
    }),
    onSuccess: (data) => {
      setEnrichProgress((p) => ({
        done: (p?.done ?? 0) + data.enriched,
        total: p?.total ?? data.enriched + data.remaining,
      }));
      if (data.remaining > 0 && enrichingRef.current) {
        setTimeout(() => enrichMutation.mutate(), 200);
      } else {
        enrichingRef.current = false;
        queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] });
      }
    },
    onError: () => {
      enrichingRef.current = false;
    },
  });

  const handleStartEnrich = (force = false) => {
    enrichingRef.current = true;
    enrichForceRef.current = force;
    forceSessionStartRef.current = force ? new Date().toISOString() : null;
    setEnrichProgress(null);
    enrichMutation.mutate();
  };

  const handleStopEnrich = () => {
    enrichingRef.current = false;
  };

  const isEnriching = enrichMutation.isPending && enrichingRef.current;
  const loading = isLoading && items.length === 0;
  const isRefreshing = (isFetching && !loading) || refreshMutation.isPending;

  const handleSelectRow = (row: SheetMonitorRowType) => {
    setSelectedRow((prev) => (prev?.lh === row.lh ? null : row));
  };

  return (
    <div>
      <DashboardHeader title="Monitor" subtitle="Visao completa dos dados do Google Sheets" />

      <main className="space-y-5 p-6 lg:p-8">

        {/* ── Alerts ── */}
        {!sheetConfigured && (
          <div className="admin-panel flex items-center gap-3 border-amber-200 bg-amber-50 p-4">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
            <p className="text-sm text-amber-800">
              Google Sheet ID não configurado. Configure <code className="font-mono font-bold">GOOGLE_SHEET_ID</code>.
            </p>
          </div>
        )}

        {queryError && (
          <div className="admin-panel flex items-center gap-3 border-red-200 bg-red-50 p-4">
            <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
            <p className="text-sm text-red-800">
              Erro ao carregar: {queryError instanceof Error ? queryError.message : "Erro desconhecido"}
            </p>
            <button type="button" onClick={() => refreshMutation.mutate()}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-red-100 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-200">
              <RefreshCw className="h-3.5 w-3.5" /> Tentar novamente
            </button>
          </div>
        )}

        {noSnapshot && !queryError && (
          <div className="admin-panel flex items-center gap-3 border-blue-200 bg-blue-50 p-4">
            <FileSpreadsheet className="h-5 w-5 shrink-0 text-blue-600" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-blue-800">Nenhum dado carregado ainda</p>
              <p className="text-xs text-blue-700 mt-0.5">Clique em "Atualizar planilha" para importar os dados do Google Sheets.</p>
            </div>
            <button type="button" onClick={() => refreshMutation.mutate()} disabled={refreshMutation.isPending}
              className="ml-auto shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60">
              <RefreshCw className={cn("h-3.5 w-3.5", refreshMutation.isPending && "animate-spin")} />
              {refreshMutation.isPending ? "Carregando..." : "Atualizar planilha"}
            </button>
          </div>
        )}

        {refreshMutation.isError && (
          <div className="admin-panel flex items-center gap-3 border-red-200 bg-red-50 p-4">
            <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
            <p className="text-sm text-red-800">Não foi possível buscar os dados da planilha. Verifique a conexão e tente novamente.</p>
          </div>
        )}

        {snapshotSaveFailed && (
          <div className="admin-panel flex items-start gap-3 border-amber-200 bg-amber-50 p-4">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-amber-800">Planilha carregada, mas não foi salva no banco</p>
              <p className="mt-0.5 text-xs text-amber-700">
                {snapshotSaveError ? `Detalhe: ${snapshotSaveError}.` : ""}{" "}
                Verifique a migration <code className="font-mono font-bold">sheet_monitor_snapshot</code>.
              </p>
            </div>
          </div>
        )}

        {/* ── Enrich progress banner ── */}
        {isEnriching && enrichProgress && (
          <div className="admin-panel flex items-center gap-4 border-sky-200 bg-sky-50 p-4 dark:border-sky-500/30 dark:bg-sky-500/10">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-600 dark:text-sky-400" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-sky-800 dark:text-sky-200">
                Consultando Angellira / ASPX — {enrichProgress.done} de {enrichProgress.total} linhas
              </p>
              <div className="mt-1.5 h-1.5 w-full rounded-full bg-sky-200 dark:bg-sky-500/30">
                <div
                  className="h-1.5 rounded-full bg-sky-600 dark:bg-sky-400 transition-all duration-500"
                  style={{ width: `${Math.min(100, Math.round((enrichProgress.done / enrichProgress.total) * 100))}%` }}
                />
              </div>
            </div>
            <button type="button" onClick={handleStopEnrich}
              className="shrink-0 rounded-lg border border-sky-200 bg-white px-3 py-1.5 text-xs font-semibold text-sky-700 hover:bg-sky-50 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
              Parar
            </button>
          </div>
        )}

        {!isEnriching && enrichProgress && enrichProgress.done > 0 && (
          <div className="admin-panel flex items-center gap-3 border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
            <BadgeCheck className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">
              Consulta concluída — {enrichProgress.done} linhas atualizadas no banco.
            </p>
          </div>
        )}

        {/* ── Summary cards ── */}
        {!noSnapshot && (
          <>
            <section className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
              <SummaryCard icon={FileSpreadsheet} label="Total de linhas" value={summary.total} color="bg-primary/10 text-primary" />
              <SummaryCard icon={Truck} label="Disponiveis (sem motorista)" value={summary.available} color="bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200" />
              <SummaryCard icon={UserCheck} label="Com motorista atribuido" value={summary.assigned} color="bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200" />
              <SummaryCard icon={Filter} label="Com status definido" value={summary.withStatus} color="bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200" />
            </section>
            <StatusBreakdown statuses={summary.statuses} />
          </>
        )}

        {/* ── Filters ── */}
        {!noSnapshot && (
          <section className="admin-panel overflow-hidden p-5 lg:p-6">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-[240px] flex-1">
                <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input type="text" placeholder="Pesquisar por LH, rota, motorista, placa..."
                  value={search} onChange={(e) => setSearch(e.target.value)}
                  className="w-full rounded-xl border border-border/80 bg-white/92 py-2.5 pl-10 pr-4 text-sm outline-none transition-all placeholder:text-muted-foreground focus:border-primary/30 focus:ring-4 focus:ring-primary/10" />
              </div>

              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded-xl border border-border/80 bg-white/92 px-3 py-2.5 text-sm outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10">
                <option value="todos">Todos os status</option>
                {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>

              <select value={tipoFilter} onChange={(e) => setTipoFilter(e.target.value)}
                className="rounded-xl border border-border/80 bg-white/92 px-3 py-2.5 text-sm outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10">
                <option value="todos">Todos os tipos</option>
                {tipoOptions.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>

              <select value={assignmentFilter} onChange={(e) => setAssignmentFilter(e.target.value)}
                className="rounded-xl border border-border/80 bg-white/92 px-3 py-2.5 text-sm outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40">
                <option value="todos">Todos</option>
                <option value="com_motorista">Com motorista</option>
                <option value="sem_motorista">Sem motorista</option>
                <option value="disponiveis">Disponiveis p/ importacao</option>
              </select>

              <input type="datetime-local" value={dateFromFilter} onChange={(e) => setDateFromFilter(e.target.value)}
                className="rounded-xl border border-border/80 bg-white/92 px-3 py-2.5 text-sm outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40"
                title="Carregamento a partir de" aria-label="Carregamento a partir de" />
              <input type="datetime-local" value={dateToFilter} onChange={(e) => setDateToFilter(e.target.value)} min={dateFromFilter || undefined}
                className="rounded-xl border border-border/80 bg-white/92 px-3 py-2.5 text-sm outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40"
                title="Carregamento até" aria-label="Carregamento até" />

              {hasActiveFilters && (
                <button type="button"
                  onClick={() => { setSearch(""); setStatusFilter("todos"); setTipoFilter("todos"); setAssignmentFilter("todos"); setDateFromFilter(""); setDateToFilter(""); }}
                  className="inline-flex items-center gap-1 rounded-xl border border-border/80 bg-white px-3 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground dark:bg-muted/40">
                  <X className="h-3.5 w-3.5" />Limpar
                </button>
              )}


              <button type="button" onClick={() => refreshMutation.mutate()} disabled={isRefreshing}
                className="inline-flex items-center gap-1.5 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2.5 text-xs font-semibold text-primary hover:bg-primary/10 disabled:opacity-50">
                <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} />
                {refreshMutation.isPending ? "Buscando planilha..." : "Atualizar planilha"}
              </button>
            </div>

            {cachedAt && (
              <p className="mt-2 text-[0.68rem] text-muted-foreground/60">
                Dados do banco atualizados em{" "}
                <span className="font-medium text-muted-foreground">
                  {new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(cachedAt))}
                </span>
              </p>
            )}

            {hasActiveFilters && (
              <p className="mt-3 text-xs text-muted-foreground">
                Mostrando <span className="font-bold text-foreground">{filteredRows.length}</span> de{" "}
                <span className="font-bold text-foreground">{items.length}</span> linhas
              </p>
            )}
          </section>
        )}

        {/* ── Table ── */}
        {!noSnapshot && (
          <section className="admin-panel overflow-hidden">
            <SheetMonitorTable
              rows={paginatedRows}
              enrichedByLh={enrichedByLh}
              selectedLh={selectedRow?.lh ?? null}
              loading={loading}
              onSelect={handleSelectRow}
            />
            {!loading && filteredRows.length > PAGE_SIZE && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/40 px-4 py-3 text-xs text-muted-foreground">
                <span>
                  Mostrando <span className="font-semibold text-foreground">{pageStart}</span>–
                  <span className="font-semibold text-foreground">{pageEnd}</span> de{" "}
                  <span className="font-semibold text-foreground">{filteredRows.length}</span>
                </span>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={safePage === 0}
                    className="inline-flex items-center gap-1 rounded-lg border border-border/80 bg-white px-2.5 py-1.5 font-medium text-foreground hover:bg-muted/50 disabled:opacity-40">
                    <ChevronLeft className="h-3.5 w-3.5" />Anterior
                  </button>
                  <span className="tabular-nums">
                    Página <span className="font-semibold text-foreground">{safePage + 1}</span> de{" "}
                    <span className="font-semibold text-foreground">{totalPages}</span>
                  </span>
                  <button type="button" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}
                    className="inline-flex items-center gap-1 rounded-lg border border-border/80 bg-white px-2.5 py-1.5 font-medium text-foreground hover:bg-muted/50 disabled:opacity-40">
                    Próxima<ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      {/* ── Detail modal ── */}
      <RowDetailModal
        row={selectedRow}
        enriched={selectedRow ? enrichedByLh[selectedRow.lh] : undefined}
        open={selectedRow !== null}
        onClose={() => setSelectedRow(null)}
      />
    </div>
  );
}
