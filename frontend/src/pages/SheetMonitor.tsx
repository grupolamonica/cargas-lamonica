import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileSpreadsheet,
  Filter,
  GripVertical,
  Loader2,
  Lock,
  MapPin,
  MessageCircle,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldX,
  Trash2,
  Truck,
  UserCheck,
  UserPlus,
  X,
  XCircle,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "sonner";

import DashboardHeader from "@/components/DashboardHeader";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { allocEditPolicy, isSpxTrip } from "@/lib/monitorEditPolicy";
import {
  assignAspxAllocations,
  createMonitorCargo,
  descendQueueCascade,
  enrichSheetMonitorRow,
  fetchOperatorDrivers,
  fetchOperatorVehicles,
  fetchSheetMonitor,
  previewAspxAllocation,
  reassignMonitorAllocations,
  assignReservaToCarga,
  createReserva,
  deleteReserva,
  fetchRouteDriverHistory,
  setMonitorAllocationPin,
  updateMonitorAllocation,
  updateMonitorCargo,
  updateReserva,
  type AspxAllocationItem,
  type AspxAllocationPreview,
  type RouteDriverHistoryEntry,
  type SheetMonitorAllocation,
  type SheetMonitorEnrichedRow,
  type SheetMonitorRow as SheetMonitorRowType,
  type SheetMonitorSummary,
  fetchCargoHistory,
  type CargoHistoryEvent,
  fetchVehicleChecklist,
  fetchVehicleChecklistLevels,
  type VehicleChecklistEntry,
  type VehicleChecklistLevel,
  type VehicleChecklistLevelEntry,
} from "@/services/readModels";

const SHEET_MONITOR_QUERY_KEY = ["admin", "sheet-monitor"] as const;

const PAGE_SIZE = 50;
const EMPTY_ROWS: SheetMonitorRowType[] = [];
const EMPTY_ENRICHED: Record<string, SheetMonitorEnrichedRow> = {};
const EMPTY_ALLOC: Record<string, SheetMonitorAllocation> = {};

// Status operacional canônico da planilha (mesma terminologia, sem os valores
// com encoding corrompido que aparecem nos dados crus). Ordem = pipeline da viagem.
// "Disponível" (1º) é a ação de REABRIR: marcar numa carga sem motorista devolve
// a carga pro painel do motorista (backend força cargas.status = OPEN).
const OPERATIONAL_STATUS_OPTIONS = [
  "Disponível",
  "AGUARDANDO CARREGAMENTO",
  "CARREGADO",
  "AGUARDANDO CHEGAR NO CLIENTE",
  "AGUARDANDO DESCARGA",
  "DESCARREGANDO",
  "DESCARREGADO",
  "CTE EM EMISSÃO",
  "CTE ENVIADO",
  "NO SHOW",
  "CANCELADO",
] as const;

const SHEET_MONITOR_QUERY_OPTIONS = {
  staleTime: 30_000,
  gcTime: 60_000,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  structuralSharing: false,
  retry: 2,
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8000),
} as const;

// DC-238: o backend já reesincroniza o snapshot da planilha (inclusive a coluna
// "Status") a cada ~5 min (SHEET_SYNC_INTERVAL_MIN em main.js), mas o cliente só
// buscava uma vez ao montar → o operador precisava recarregar a página pra ver o
// status novo. Este intervalo faz o Monitor repuxar sozinho o caminho de LEITURA
// barato (refresh=false, só lê o snapshot do banco — NÃO reprocessa o CSV da
// planilha) numa cadência menor que a do sync, mantendo o Status fresco.
const MONITOR_STATUS_POLL_MS = 2 * 60_000;

// ─── Status styles ────────────────────────────────────────────────────────────

// `row` = tint suave da LINHA inteira do Monitor na mesma cor do badge de status
// (pedido do operador: identificar o status pela cor da linha). Inclui o hover
// um pouco mais forte pra manter o feedback de clique.
function resolveSheetStatusStyle(status: string) {
  const trimmed = (status || "").trim();
  const normalized = trimmed.toLowerCase();

  const exact: Record<string, { dot: string; bg: string; row: string; label: string }> = {
    "":            { dot: "bg-blue-500",    bg: "bg-blue-50 text-blue-800 dark:bg-blue-500/15 dark:text-blue-200",            row: "bg-blue-500/[0.07] hover:bg-blue-500/[0.15] dark:bg-blue-500/10 dark:hover:bg-blue-500/20",             label: "Disponivel" },
    "Reservado":   { dot: "bg-violet-500", bg: "bg-violet-50 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200",    row: "bg-violet-500/[0.07] hover:bg-violet-500/[0.15] dark:bg-violet-500/10 dark:hover:bg-violet-500/20",     label: "Reservado" },
    "Em aberto":   { dot: "bg-amber-500",   bg: "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",        row: "bg-amber-500/[0.08] hover:bg-amber-500/[0.16] dark:bg-amber-500/10 dark:hover:bg-amber-500/20",         label: "Em aberto" },
    "Aprovado":    { dot: "bg-emerald-500", bg: "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200", row: "bg-emerald-500/[0.08] hover:bg-emerald-500/[0.16] dark:bg-emerald-500/10 dark:hover:bg-emerald-500/20", label: "Aprovado" },
    "Em transito": { dot: "bg-indigo-500",  bg: "bg-indigo-50 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-200",    row: "bg-indigo-500/[0.08] hover:bg-indigo-500/[0.16] dark:bg-indigo-500/10 dark:hover:bg-indigo-500/20",     label: "Em transito" },
    "Entregue":    { dot: "bg-teal-500",    bg: "bg-teal-50 text-teal-800 dark:bg-teal-500/15 dark:text-teal-200",             row: "bg-teal-500/[0.08] hover:bg-teal-500/[0.16] dark:bg-teal-500/10 dark:hover:bg-teal-500/20",             label: "Entregue" },
    "Cancelado":   { dot: "bg-red-400",     bg: "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-200",                 row: "bg-red-500/[0.08] hover:bg-red-500/[0.16] dark:bg-red-500/10 dark:hover:bg-red-500/20",                 label: "Cancelado" },
    "Concluido":   { dot: "bg-green-600",   bg: "bg-green-50 text-green-800 dark:bg-green-500/15 dark:text-green-200",         row: "bg-green-500/[0.08] hover:bg-green-500/[0.16] dark:bg-green-500/10 dark:hover:bg-green-500/20",         label: "Concluido" },
    "RESERVA":     { dot: "bg-amber-500",   bg: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-100",        row: "bg-amber-500/[0.10] hover:bg-amber-500/[0.18] dark:bg-amber-500/15 dark:hover:bg-amber-500/25",         label: "Reserva" },
    "Fechado":     { dot: "bg-slate-400",   bg: "bg-slate-100 text-slate-600 dark:bg-slate-500/20 dark:text-slate-300",       row: "bg-slate-500/[0.06] hover:bg-slate-500/[0.12] dark:bg-slate-500/10 dark:hover:bg-slate-500/20",         label: "Fechado" },
  };

  if (exact[trimmed]) return exact[trimmed];

  if (!trimmed || /dispon[ií]vel/.test(normalized))
    return { dot: "bg-blue-500",    bg: "bg-blue-50 text-blue-800 dark:bg-blue-500/20 dark:text-blue-100",      row: "bg-blue-500/[0.07] hover:bg-blue-500/[0.15] dark:bg-blue-500/10 dark:hover:bg-blue-500/20",             label: trimmed || "Disponivel" };
  if (/fechad|expirad/.test(normalized))
    return { dot: "bg-slate-400",   bg: "bg-slate-100 text-slate-600 dark:bg-slate-500/20 dark:text-slate-300", row: "bg-slate-500/[0.06] hover:bg-slate-500/[0.12] dark:bg-slate-500/10 dark:hover:bg-slate-500/20",         label: trimmed };
  if (/descarregado|entregue/.test(normalized))
    return { dot: "bg-teal-500",    bg: "bg-teal-50 text-teal-800 dark:bg-teal-500/20 dark:text-teal-100",      row: "bg-teal-500/[0.08] hover:bg-teal-500/[0.16] dark:bg-teal-500/10 dark:hover:bg-teal-500/20",             label: trimmed };
  if (/descarregando/.test(normalized))
    return { dot: "bg-cyan-500",    bg: "bg-cyan-50 text-cyan-800 dark:bg-cyan-500/20 dark:text-cyan-100",       row: "bg-cyan-500/[0.08] hover:bg-cyan-500/[0.16] dark:bg-cyan-500/10 dark:hover:bg-cyan-500/20",             label: trimmed };
  if (/cancel/.test(normalized))
    return { dot: "bg-red-400",     bg: "bg-red-50 text-red-700 dark:bg-red-500/20 dark:text-red-100",           row: "bg-red-500/[0.08] hover:bg-red-500/[0.16] dark:bg-red-500/10 dark:hover:bg-red-500/20",                 label: trimmed };
  if (/no\s*show/.test(normalized))
    return { dot: "bg-rose-500",    bg: "bg-rose-50 text-rose-800 dark:bg-rose-500/20 dark:text-rose-100",       row: "bg-rose-500/[0.08] hover:bg-rose-500/[0.16] dark:bg-rose-500/10 dark:hover:bg-rose-500/20",             label: trimmed };
  if (/cte\s+enviado/.test(normalized))
    return { dot: "bg-sky-500",     bg: "bg-sky-50 text-sky-800 dark:bg-sky-500/20 dark:text-sky-100",           row: "bg-sky-500/[0.08] hover:bg-sky-500/[0.16] dark:bg-sky-500/10 dark:hover:bg-sky-500/20",                 label: trimmed };
  if (/cte\s+em\s+emiss/.test(normalized))
    return { dot: "bg-violet-500",  bg: "bg-violet-50 text-violet-800 dark:bg-violet-500/20 dark:text-violet-100", row: "bg-violet-500/[0.07] hover:bg-violet-500/[0.15] dark:bg-violet-500/10 dark:hover:bg-violet-500/20",     label: trimmed };
  if (/aguardando\s+chegar/.test(normalized))
    return { dot: "bg-amber-500",   bg: "bg-amber-50 text-amber-800 dark:bg-amber-500/20 dark:text-amber-100",   row: "bg-amber-500/[0.08] hover:bg-amber-500/[0.16] dark:bg-amber-500/10 dark:hover:bg-amber-500/20",         label: trimmed };
  if (/aguardando\s+carreg/.test(normalized))
    return { dot: "bg-orange-500",  bg: "bg-orange-50 text-orange-800 dark:bg-orange-500/20 dark:text-orange-100", row: "bg-orange-500/[0.08] hover:bg-orange-500/[0.16] dark:bg-orange-500/10 dark:hover:bg-orange-500/20",     label: trimmed };
  if (/aguardando\s+descarg/.test(normalized))
    return { dot: "bg-fuchsia-500", bg: "bg-fuchsia-50 text-fuchsia-800 dark:bg-fuchsia-500/20 dark:text-fuchsia-100", row: "bg-fuchsia-500/[0.08] hover:bg-fuchsia-500/[0.16] dark:bg-fuchsia-500/10 dark:hover:bg-fuchsia-500/20", label: trimmed };
  if (/aguardando/.test(normalized))
    return { dot: "bg-amber-500",   bg: "bg-amber-50 text-amber-800 dark:bg-amber-500/20 dark:text-amber-100",   row: "bg-amber-500/[0.08] hover:bg-amber-500/[0.16] dark:bg-amber-500/10 dark:hover:bg-amber-500/20",         label: trimmed };
  if (/carregando|em\s+tr[aâ]nsito/.test(normalized))
    return { dot: "bg-indigo-500",  bg: "bg-indigo-50 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-100", row: "bg-indigo-500/[0.08] hover:bg-indigo-500/[0.16] dark:bg-indigo-500/10 dark:hover:bg-indigo-500/20",     label: trimmed };
  if (/finaliz|conclu/.test(normalized))
    return { dot: "bg-green-600",   bg: "bg-green-50 text-green-800 dark:bg-green-500/20 dark:text-green-100",   row: "bg-green-500/[0.08] hover:bg-green-500/[0.16] dark:bg-green-500/10 dark:hover:bg-green-500/20",         label: trimmed };

  return { dot: "bg-slate-400", bg: "bg-slate-100 text-slate-700 dark:bg-slate-500/25 dark:text-slate-100", row: "bg-slate-500/[0.06] hover:bg-slate-500/[0.12] dark:bg-slate-500/10 dark:hover:bg-slate-500/20", label: trimmed || "—" };
}

function StatusBadge({ status, dense = false }: { status: string; dense?: boolean }) {
  const cfg = resolveSheetStatusStyle(status);
  return (
    // dense (linha da tabela): fica em UMA linha (max-w-full + label truncado) para
    // status longos como "AGUARDANDO CHEGAR NO CLIENTE" não engordarem a linha. O
    // texto completo vai no tooltip. Fora da tabela (modal), mostra inteiro.
    <span
      title={dense ? cfg.label : undefined}
      className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.66rem] font-semibold leading-tight", cfg.bg, dense && "max-w-full")}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", cfg.dot)} />
      <span className={dense ? "min-w-0 truncate" : undefined}>{cfg.label}</span>
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
      {/*
        Bugfix: o label antes usava `truncate` em min-w-0 e cortava textos
        como "Total de linhas", "Disponiveis (sem motorista)", etc para
        "Total de li...", "Disponiv...". Trocamos por `whitespace-normal`
        + `leading-tight` para o label quebrar em 2 linhas quando o card
        ficar estreito (grid 2-col no mobile, 4-col no desktop). O `title`
        garante tooltip nativo no hover para o caso de overflow extremo.
      */}
      <div className="min-w-0 flex-1">
        <p className="text-2xl font-bold tracking-tight text-foreground">{value}</p>
        <p
          className="mt-0.5 whitespace-normal text-xs font-medium leading-tight text-muted-foreground"
          title={label}
        >
          {label}
        </p>
      </div>
    </div>
  );
}

// Ordem ESTÁVEL dos chips de status, independente da contagem. Sem isso os chips
// eram ordenados por contagem e "pulavam de lugar" a cada edição de status (a
// contagem muda → reordena → o flex-wrap rebobina → tudo abaixo se desloca). Aqui
// a ordem segue o pipeline operacional e fica fixa; a contagem só atualiza o número
// no lugar. Regex no status normalizado p/ ser robusto às variantes de texto.
function statusStableRank(statusKey: string): number {
  if (statusKey === "Sem status") return 0; // Disponível
  const s = statusKey.toLowerCase();
  if (/dispon/.test(s)) return 0;
  if (/reserv/.test(s)) return 1;
  if (/em aberto/.test(s)) return 2;
  if (/aguardando\s+carreg/.test(s)) return 3;
  if (/aguardando\s+chegar/.test(s)) return 4;
  if (/aguardando/.test(s)) return 5;
  if (/descarregando/.test(s)) return 7;
  if (/descarregad|entregue/.test(s)) return 8;
  if (/carregad|carregando|tr[aâ]nsito/.test(s)) return 6;
  if (/cte\s+em\s+emiss/.test(s)) return 9;
  if (/cte\s+enviad/.test(s)) return 10;
  if (/no\s*show/.test(s)) return 11;
  if (/cancel/.test(s)) return 12;
  if (/fechad|expirad/.test(s)) return 13;
  if (/finaliz|conclu/.test(s)) return 14;
  return 90; // desconhecido → fim
}

// Breakdown de status = FILTRO clicável (substitui o antigo dropdown "Todos os
// status"). Cada chip filtra as linhas do Monitor pelo seu status; clicar de novo
// no chip ativo limpa. As contagens são facetas: refletem os DEMAIS filtros
// (busca, tipo, rota, data…) mas não o próprio filtro de status, para o operador
// enxergar quantas linhas cada status tem e trocar de um para o outro.
function StatusBreakdown({
  statuses,
  selected,
  onToggle,
  onClear,
}: {
  statuses: Record<string, number>;
  selected: string[]; // status selecionados (multi-select). Vazio = todos.
  onToggle: (statusKey: string) => void;
  onClear: () => void;
}) {
  // Ordem FIXA (pipeline), não por contagem — os chips não trocam de lugar quando
  // o operador edita um status; só o número muda. Empate → alfabético estável.
  const entries = Object.entries(statuses).sort((a, b) => {
    const r = statusStableRank(a[0]) - statusStableRank(b[0]);
    return r !== 0 ? r : a[0].localeCompare(b[0], "pt-BR");
  });
  if (entries.length === 0) return null;
  const hasActive = selected.length > 0;
  return (
    <div className="admin-panel space-y-3 p-4 lg:p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">Status na planilha</h3>
        {hasActive && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.68rem] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-3 w-3" /> limpar filtro
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {entries.map(([status, count]) => {
          const cfg = resolveSheetStatusStyle(status === "Sem status" ? "" : status);
          const isActive = selected.includes(status);
          // Chip com contagem 0 (nenhuma linha no filtro atual) fica esmaecido, mas
          // MANTÉM o lugar — o conjunto de chips é fixo p/ a seção não mudar de altura.
          const dimmed = !isActive && (count === 0 || hasActive);
          return (
            <button
              key={status}
              type="button"
              aria-pressed={isActive}
              onClick={() => onToggle(status)}
              title={isActive ? "Clique para remover do filtro" : `Filtrar por ${cfg.label} (soma vários)`}
              className={cn(
                "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold transition-all",
                cfg.bg,
                isActive
                  ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                  : dimmed
                    ? "opacity-45 hover:opacity-100"
                    : "hover:opacity-80",
              )}
            >
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", cfg.dot)} />
              <span className="uppercase tracking-[0.08em]">{cfg.label}</span>
              <span className="rounded-full bg-black/10 px-1.5 py-0.5 text-[0.68rem] font-bold text-current dark:bg-white/15">{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Filtro multi-seleção (dropdown com checkboxes) — substitui os <select> únicos
// da barra de filtros do Monitor. Vazio = "todos". Semântica OR entre os
// selecionados. Trigger mostra "Rótulo · N" com a contagem de selecionados.
type MultiOption = { value: string; label: string };

// Normaliza texto p/ busca no filtro: sem acentos + minúsculo.
function normalizeFilterText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  widthClass,
  searchable = false,
}: {
  label: string;
  options: MultiOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  widthClass?: string;
  /** Mostra um campo de busca no topo (útil quando há muitas opções, ex.: rotas). */
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const count = selected.length;
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  // Ao fechar, limpa a busca — a próxima abertura começa com a lista completa.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const normalizedQuery = searchable ? normalizeFilterText(query.trim()) : "";
  const visibleOptions = normalizedQuery
    ? options.filter((o) => normalizeFilterText(o.label).includes(normalizedQuery))
    : options;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          className={cn(
            "inline-flex items-center justify-between gap-1.5 rounded-xl border bg-white/92 px-3 py-2.5 text-sm outline-none transition-colors focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40",
            count > 0 ? "border-primary/40 text-foreground" : "border-border/80 text-muted-foreground",
            widthClass,
          )}
        >
          <span className="truncate">
            {label}
            {count > 0 && <span className="ml-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[0.68rem] font-bold text-primary">{count}</span>}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[22rem] max-w-[92vw] p-1.5">
        {searchable && (
          <div className="relative mb-1.5">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Buscar ${label.toLowerCase()}…`}
              className="w-full rounded-md border border-border/70 bg-background py-1.5 pl-7 pr-2 text-sm outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/10"
            />
          </div>
        )}
        <div className="max-h-64 overflow-y-auto">
          {options.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Nenhuma opção</p>
          ) : visibleOptions.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Nenhum resultado para “{query.trim()}”.</p>
          ) : (
            visibleOptions.map((o) => {
              const active = selected.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(o.value)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                      active ? "border-primary bg-primary text-primary-foreground" : "border-input",
                    )}
                  >
                    {active && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-normal break-words leading-snug" title={o.label}>{o.label}</span>
                </button>
              );
            })
          )}
        </div>
        {count > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="mt-1 flex w-full items-center gap-1 border-t border-border/40 px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-3 w-3" /> Limpar
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

const ASSIGNMENT_OPTIONS: MultiOption[] = [
  { value: "com_motorista", label: "Com motorista" },
  { value: "sem_motorista", label: "Sem motorista" },
  { value: "disponiveis", label: "Disponíveis p/ importação" },
];
const EDIT_OPTIONS: MultiOption[] = [
  { value: "editaveis", label: "Editáveis (motorista/veículo)" },
  { value: "bloqueadas", label: "Bloqueadas (atribuído no ASPX)" },
];

function formatCurrency(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

// Data/hora em que o motorista entrou em standby (created_at da reserva, ISO UTC)
// → "DD/MM HH:MM" no fuso de São Paulo.
function formatStandby(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo",
  }).format(d);
}

// Cor do marcador do histórico por tipo de evento — pista visual do que
// aconteceu (verde = reservado/gravado, âmbar = na fila, vermelho = cancelado).
function cargoHistoryDotClass(tipo: string): string {
  switch (tipo) {
    case "APPROVED":
    case "ALLOC_OPERADOR":
      return "bg-emerald-500";
    case "SHEET_WRITEBACK":
      return "bg-sky-500";
    case "QUEUED":
    case "PRE_REGISTERED":
    case "WHATSAPP_CLICKED":
      return "bg-amber-500";
    case "CANCELLED":
      return "bg-red-500";
    default:
      return "bg-primary/60";
  }
}

// Faixa de datas (ms epoch; null = sem limite naquele extremo). carFrom/carTo
// filtram por carregamento (row.data + row.horario); desFrom/desTo por descarga
// (row.descargaAt). Reservas não têm data → sempre visíveis.
type DateRangeFilter = { carFrom: number | null; carTo: number | null; desFrom: number | null; desTo: number | null };
function rowMatchesDateRanges(row: SheetMonitorRowType, r: DateRangeFilter): boolean {
  if (r.carFrom === null && r.carTo === null && r.desFrom === null && r.desTo === null) return true;
  if (row.reserva) return true; // reservas não têm data — sempre visíveis
  const parse = (iso: string | null | undefined): number | null => {
    const t = iso ? new Date(iso).getTime() : NaN;
    return Number.isFinite(t) ? t : null;
  };
  if (r.carFrom !== null || r.carTo !== null) {
    const h = row.horario || "00:00:00";
    const carTs = row.data ? parse(`${row.data}T${h.length === 5 ? `${h}:00` : h}`) : null;
    if (carTs === null) return false;
    if (r.carFrom !== null && carTs < r.carFrom) return false;
    if (r.carTo !== null && carTs > r.carTo) return false;
  }
  if (r.desFrom !== null || r.desTo !== null) {
    const desTs = parse(row.descargaAt);
    if (desTs === null) return false;
    if (r.desFrom !== null && desTs < r.desFrom) return false;
    if (r.desTo !== null && desTs > r.desTo) return false;
  }
  return true;
}

// "10/02/2026 07:00" → "10/02 07:00": tira o ano para a agenda caber em UMA linha.
// O label completo (com ano) fica no tooltip.
function shortAgenda(label: string | null | undefined): string {
  return (label || "").replace(/(\d{2}\/\d{2})\/\d{4}/, "$1");
}

// ─── Enriched status dot ──────────────────────────────────────────────────────

// Selo de PRESENÇA (igual à tela de Motoristas): encontrado=azul, não=vermelho,
// não consultado (null)=cinza. A cor reflete só se foi ENCONTRADO no Angellira —
// validade vencida NÃO deixa o selo vermelho (aparece no detalhe/modal). Antes a
// vigência derrubava o selo p/ vermelho mesmo conforme → divergia do Motoristas.
function presenceState(found: boolean | null | undefined): boolean | null {
  return found ?? null;
}
// Cadastro no ASPX (motorista): tem CPF/nome no diretório do ASPX. null = não enriquecido.
function aspxCadastroState(e: SheetMonitorEnrichedRow | undefined): boolean | null {
  if (!e) return null;
  return Boolean(e.aspx_cpf || e.aspx_display_name);
}

// ── Selo por MOTORISTA/PLACA (não por carga) ──────────────────────────────────
// O selo Angellira/ASPX é do MOTORISTA/VEÍCULO, não da carga. Resolvendo por
// nome/placa, trocar a fila reflete NA HORA (o selo do motorista movido já é
// conhecido de onde ele estava), sem esperar o re-enrich assíncrono (que era o
// motivo do "não consultado" pós-troca).
const normNameKey = (s: string | null | undefined) =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const normPlateKey = (s: string | null | undefined) => (s ?? "").replace(/[\s\-.]/g, "").toUpperCase();

type VehSelo = { plate: string; found: boolean | null; valid_until: string | null; status_text: string | null; display: string | null; type: string | null; source: string | null; details: unknown };
type SeloMaps = { driverByName: Record<string, SheetMonitorEnrichedRow>; vehByPlate: Record<string, VehSelo> };

function buildSeloMaps(
  enrichedByLh: Record<string, SheetMonitorEnrichedRow>,
  enrichedByCargoId: Record<string, SheetMonitorEnrichedRow>,
): SeloMaps {
  const driverByName: SeloMaps["driverByName"] = {};
  const vehByPlate: SeloMaps["vehByPlate"] = {};
  const driverScore = (e: SheetMonitorEnrichedRow) => (e.angellira_driver_found != null ? 2 : 0) + (e.aspx_cpf ? 1 : 0);
  const consider = (e: SheetMonitorEnrichedRow) => {
    if (e.driver_name) {
      const k = normNameKey(e.driver_name);
      const prev = driverByName[k];
      if (!prev || driverScore(e) > driverScore(prev)) driverByName[k] = e;
    }
    for (const side of ["cavalo", "carreta"] as const) {
      const plate = e[`${side}_plate`];
      if (!plate) continue;
      const k = normPlateKey(plate);
      const found = e[`${side}_angellira_found`];
      const prev = vehByPlate[k];
      if (!prev || (prev.found == null && found != null)) {
        vehByPlate[k] = {
          plate,
          found: found ?? null,
          valid_until: e[`${side}_angellira_valid_until`] ?? null,
          status_text: e[`${side}_angellira_status_text`] ?? null,
          display: e[`${side}_angellira_display`] ?? null,
          type: e[`${side}_type`] ?? null,
          source: e[`${side}_source`] ?? null,
          details: e[`${side}_details`] ?? null,
        };
      }
    }
  };
  for (const e of Object.values(enrichedByLh)) consider(e);
  for (const e of Object.values(enrichedByCargoId)) consider(e);
  return { driverByName, vehByPlate };
}

// Monta um registro de selo (shape SheetMonitorEnrichedRow) para a linha a partir
// do motorista/placa EFETIVOS — independe do lh, então a troca aparece na hora.
function resolveRowSelo(row: SheetMonitorRowType, maps: SeloMaps): SheetMonitorEnrichedRow | undefined {
  const d = row.motoristas ? maps.driverByName[normNameKey(row.motoristas)] : null;
  const cav = row.cavalo ? maps.vehByPlate[normPlateKey(row.cavalo)] : null;
  const car = row.carreta ? maps.vehByPlate[normPlateKey(row.carreta)] : null;
  if (!d && !cav && !car) return undefined;
  return {
    lh: row.lh,
    driver_name: row.motoristas || null,
    aspx_cpf: d?.aspx_cpf ?? null,
    aspx_display_name: d?.aspx_display_name ?? null,
    angellira_driver_found: d?.angellira_driver_found ?? null,
    angellira_driver_status: d?.angellira_driver_status ?? null,
    angellira_driver_valid_until: d?.angellira_driver_valid_until ?? null,
    angellira_driver_status_text: d?.angellira_driver_status_text ?? null,
    angellira_driver_details: d?.angellira_driver_details ?? null,
    cavalo_plate: cav?.plate ?? (row.cavalo ? normPlateKey(row.cavalo) : null),
    cavalo_source: cav?.source ?? null,
    cavalo_type: cav?.type ?? null,
    cavalo_angellira_found: cav?.found ?? null,
    cavalo_angellira_valid_until: cav?.valid_until ?? null,
    cavalo_angellira_status_text: cav?.status_text ?? null,
    cavalo_angellira_display: cav?.display ?? null,
    cavalo_details: cav?.details ?? null,
    carreta_plate: car?.plate ?? (row.carreta ? normPlateKey(row.carreta) : null),
    carreta_source: car?.source ?? null,
    carreta_type: car?.type ?? null,
    carreta_angellira_found: car?.found ?? null,
    carreta_angellira_valid_until: car?.valid_until ?? null,
    carreta_angellira_status_text: car?.status_text ?? null,
    carreta_angellira_display: car?.display ?? null,
    carreta_details: car?.details ?? null,
  } as SheetMonitorEnrichedRow;
}

// Check compacto (letra + cor) — substitui os selos com rótulo p/ ocupar bem menos
// espaço na linha. Verde = ok, vermelho = não, cinza = não consultado. O detalhe
// completo (validade, status text) continua no modal da linha; o tooltip resume.
function MiniCheck({ letter, found, label }: { letter: string; found: boolean | null | undefined; label: string }) {
  const state = found === true ? "ok" : found === false ? "no" : "na";
  const stateLabel = state === "ok" ? "ok" : state === "no" ? "não" : "não consultado";
  return (
    <span
      title={`${label}: ${stateLabel}`}
      aria-label={`${label}: ${stateLabel}`}
      className={cn(
        "inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded text-[0.6rem] font-bold leading-none",
        state === "ok" && "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
        state === "no" && "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300",
        state === "na" && "bg-muted text-muted-foreground",
      )}
    >
      {letter}
    </span>
  );
}

// Selos do MOTORISTA (compactos): A = Angellira, S = cadastro no ASPX.
// O selo "S" (ASPX) só aparece em cargas do SPX/Shopee (aspxRelevant): Nestlé & cia
// não vão para o ASPX, então mostrar cadastro no ASPX ali é ruído enganoso.
function DriverChecks({ enriched, aspxRelevant }: { enriched: SheetMonitorEnrichedRow | undefined; aspxRelevant: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <MiniCheck letter="A" found={presenceState(enriched?.angellira_driver_found)} label="Angellira" />
      {aspxRelevant && <MiniCheck letter="S" found={aspxCadastroState(enriched)} label="ASPX" />}
    </span>
  );
}

// Selos do VEÍCULO (compactos): C = cavalo, R = carreta (Angellira). ASPX é só do motorista.
function VehicleChecks({ enriched, hasCavalo, hasCarreta }: { enriched: SheetMonitorEnrichedRow | undefined; hasCavalo: boolean; hasCarreta: boolean }) {
  if (!hasCavalo && !hasCarreta) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      {hasCavalo && <MiniCheck letter="C" found={presenceState(enriched?.cavalo_angellira_found)} label="Cavalo (Angellira)" />}
      {hasCarreta && <MiniCheck letter="R" found={presenceState(enriched?.carreta_angellira_found)} label="Carreta (Angellira)" />}
    </span>
  );
}

// Cor do ícone de veículo por status do checklist (semáforo).
const CHECKLIST_ICON_COLOR: Record<VehicleChecklistLevel, string> = {
  ok: "text-emerald-500",
  warning: "text-amber-500",
  overdue: "text-red-500",
  unknown: "text-muted-foreground/30",
};

// Resumo curto p/ o tooltip do ícone (checklistSummary é function declaration
// hoisted, definida mais abaixo).
function checklistIconTitle(papel: string, plate: string, entry: VehicleChecklistLevelEntry | undefined): string {
  const label = entry ? checklistSummary(entry.level, entry.daysToDue) : "Sem dados de checklist";
  return `${papel} ${plate} — checklist: ${label}`;
}

// Ícone de caminhão para cavalo e carreta, tintado pelo status do checklist de
// cada um (verde=ok, amarelo=próximo a vencer, vermelho=vencido/problema,
// cinza=sem dados). Visão rápida na linha, sem abrir o modal.
function VehicleChecklistIcons({ cavalo, carreta, cavaloChecklist, carretaChecklist }: {
  cavalo: string | null;
  carreta: string | null;
  cavaloChecklist?: VehicleChecklistLevelEntry;
  carretaChecklist?: VehicleChecklistLevelEntry;
}) {
  const vehicles: Array<{ papel: string; plate: string; entry?: VehicleChecklistLevelEntry }> = [];
  if (cavalo) vehicles.push({ papel: "Cavalo", plate: cavalo, entry: cavaloChecklist });
  if (carreta) vehicles.push({ papel: "Carreta", plate: carreta, entry: carretaChecklist });
  if (!vehicles.length) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      {vehicles.map(({ papel, plate, entry }) => (
        <span
          key={papel}
          className={cn("flex items-center", CHECKLIST_ICON_COLOR[entry?.level ?? "unknown"])}
          title={checklistIconTitle(papel, plate, entry)}
        >
          <Truck className="h-3.5 w-3.5" />
        </span>
      ))}
    </span>
  );
}

// ─── Inline allocation editor (combobox por linha) ─────────────────────────────

// Os ids dos <datalist> ficam montados uma única vez na tabela; cada editor de
// linha referencia via `list=`. Datalist = combobox nativo: autocomplete dos
// cadastrados + texto livre, sem problemas de posicionamento dentro da tabela
// com scroll (que um Popover teria).
const DRIVER_DATALIST_ID = "monitor-driver-options";
const CAVALO_DATALIST_ID = "monitor-cavalo-options";
const CARRETA_DATALIST_ID = "monitor-carreta-options";
const TIPO_DATALIST_ID = "monitor-tipo-options";

const INLINE_INPUT_CLASS =
  "h-7 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring";

function InlineAllocEditor({
  initial,
  saving,
  onSave,
  onCancel,
}: {
  initial: { motorista: string; cavalo: string; carreta: string; tipo: string };
  saving: boolean;
  onSave: (value: { motorista: string; cavalo: string; carreta: string; tipo: string }) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(initial);
  return (
    // stopPropagation: evita que cliques no editor disparem o onClick da linha
    // (que abriria o modal / alternaria a seleção).
    <div className="space-y-1.5" onClick={(e) => e.stopPropagation()}>
      <input
        list={DRIVER_DATALIST_ID}
        value={form.motorista}
        onChange={(e) => setForm((f) => ({ ...f, motorista: e.target.value }))}
        placeholder="Motorista"
        autoFocus
        className={INLINE_INPUT_CLASS}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
      />
      <input
        list={TIPO_DATALIST_ID}
        value={form.tipo}
        onChange={(e) => setForm((f) => ({ ...f, tipo: e.target.value }))}
        placeholder="Tipo (ForeCast, Spot…)"
        className={INLINE_INPUT_CLASS}
        onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
      />
      <div className="grid grid-cols-2 gap-1">
        <input
          list={CAVALO_DATALIST_ID}
          value={form.cavalo}
          onChange={(e) => setForm((f) => ({ ...f, cavalo: e.target.value.toUpperCase() }))}
          placeholder="Cavalo"
          className={cn(INLINE_INPUT_CLASS, "font-mono uppercase")}
          onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
        />
        <input
          list={CARRETA_DATALIST_ID}
          value={form.carreta}
          onChange={(e) => setForm((f) => ({ ...f, carreta: e.target.value.toUpperCase() }))}
          placeholder="Carreta"
          className={cn(INLINE_INPUT_CLASS, "font-mono uppercase")}
          onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
        />
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onSave(form)}
          disabled={saving}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[0.68rem] font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Salvar
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="inline-flex items-center gap-1 rounded-md border border-border/80 px-2 py-1 text-[0.68rem] font-medium text-muted-foreground hover:text-foreground disabled:opacity-60"
        >
          Cancelar
        </button>
      </div>
    </div>
  );
}

// Os <datalist> são montados uma única vez na página (ids fixos) e referenciados
// por todos os editores inline — na tabela plana E na visão por rota.
function MonitorDatalists({
  driverOptions,
  cavaloOptions,
  carretaOptions,
  tipoOptions,
}: {
  driverOptions: string[];
  cavaloOptions: string[];
  carretaOptions: string[];
  tipoOptions: string[];
}) {
  return (
    <>
      <datalist id={DRIVER_DATALIST_ID}>{driverOptions.map((o) => <option key={o} value={o} />)}</datalist>
      <datalist id={CAVALO_DATALIST_ID}>{cavaloOptions.map((o) => <option key={o} value={o} />)}</datalist>
      <datalist id={CARRETA_DATALIST_ID}>{carretaOptions.map((o) => <option key={o} value={o} />)}</datalist>
      <datalist id={TIPO_DATALIST_ID}>{tipoOptions.map((o) => <option key={o} value={o} />)}</datalist>
    </>
  );
}

// Regra de edição por status (Disponível/Reservado/"aguardando chegar no
// cliente" editam; demais travam — já em atribuição no ASPX) em
// @/lib/monitorEditPolicy (allocEditPolicy), para ser testável.

// Texto do pop-up de confirmação para cargas já em atribuição/execução no ASPX
// (motorista/veículo já no ASPX). Pergunta antes de efetivar a troca.
function aspxConfirmDescription(count: number) {
  return count > 1
    ? `${count} cargas já estão em atribuição/execução no ASPX — o motorista e o veículo já estão no ASPX. Tem certeza de que quer fazer a troca?`
    : `Esta carga já está em atribuição/execução no ASPX — o motorista e o veículo já estão no ASPX. Tem certeza de que quer fazer a troca?`;
}

// Pop-up de confirmação genérico (sim/cancelar) sobre o Dialog existente.
function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Sim, trocar",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            {title}
          </DialogTitle>
          <DialogDescription className="pt-1 text-sm leading-relaxed text-muted-foreground">
            {description}
          </DialogDescription>
        </DialogHeader>
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-border/80 px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-700"
          >
            {confirmLabel}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Confirmação de TROCA de motorista/veículo com DESCRIÇÃO obrigatória (motivo).
// Aparece sempre que o operador troca o motorista/veículo no Monitor (inline ou
// modal). Quando a carga já está em atribuição/execução no ASPX, mostra também o
// aviso do ASPX. O "Salvar troca" só habilita com o motivo preenchido.
function ChangeReasonDialog({
  open,
  aspxWarning = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  aspxWarning?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => { if (open) setReason(""); }, [open]);
  const canConfirm = reason.trim().length > 0;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            Confirmar troca de motorista/veículo
          </DialogTitle>
          <DialogDescription className="pt-1 text-sm leading-relaxed text-muted-foreground">
            {aspxWarning
              ? "Esta carga já está em atribuição/execução no ASPX — o motorista e o veículo já estão no ASPX. Descreva o motivo da troca."
              : "Descreva o motivo da troca de motorista/veículo."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-foreground">
            Descrição <span className="text-red-500">*</span>
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            autoFocus
            maxLength={500}
            placeholder="Ex.: motorista titular desistiu; troca de veículo por manutenção…"
            className="w-full resize-none rounded-lg border border-border/80 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
          />
        </div>
        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-border/80 px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => { if (canConfirm) onConfirm(reason.trim()); }}
            disabled={!canConfirm}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Salvar troca
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Atribuir no ASPX ───────────────────────────────────────────────────────
// Pré-visualização (dry-run) + confirmação da atribuição no ASPX. Mostra ao
// operador, por carga, se vai atribuir / já está / está pendente, e quem será
// atribuído. Nada vai pro ASPX até o operador confirmar (e só de verdade se o
// kill switch estiver ligado no backend; senão roda em simulação/dry-run).

function aspxStateMeta(state: AspxAllocationItem["state"]) {
  switch (state) {
    case "assign":
      return { label: "Vai atribuir", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300", Icon: CheckCircle2 };
    case "pending":
      return { label: "Pendente", cls: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300", Icon: AlertTriangle };
    case "assigned":
      return { label: "Já atribuída", cls: "bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300", Icon: Check };
    case "in_progress":
      return { label: "Em operação", cls: "bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300", Icon: Truck };
    case "done":
      return { label: "Concluída", cls: "bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300", Icon: Check };
    case "cancelled":
      return { label: "Cancelada", cls: "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300", Icon: XCircle };
    case "not_ready":
      return { label: "Não liberada", cls: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300", Icon: AlertTriangle };
    case "unknown":
      return { label: "Não confirmada", cls: "bg-slate-100 text-slate-500 dark:bg-slate-500/15 dark:text-slate-400", Icon: Ban };
    default:
      return { label: state, cls: "bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300", Icon: Ban };
  }
}

function AspxAssignModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<Awaited<ReturnType<typeof assignAspxAllocations>> | null>(null);
  const [confirmReal, setConfirmReal] = useState(false);

  const previewQuery = useQuery<AspxAllocationPreview>({
    queryKey: ["admin", "aspx-preview"],
    queryFn: previewAspxAllocation,
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const data = previewQuery.data;

  // Ao carregar a pré-visualização, pré-seleciona tudo que "vai atribuir".
  useEffect(() => {
    if (data) {
      setSelected(new Set(data.items.filter((i) => i.state === "assign").map((i) => i.lh)));
      setResult(null);
    }
  }, [data]);

  // Reseta ao fechar.
  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setResult(null);
      setConfirmReal(false);
    }
  }, [open]);

  const assignMutation = useMutation({
    mutationFn: assignAspxAllocations,
    onSuccess: (r) => {
      setResult(r);
      if (r.dryRun) toast.info(`Dry-run: ${r.summary.dryRun} carga(s) montada(s), nada enviado ao ASPX.`);
      else toast.success(`${r.summary.assigned} carga(s) atribuída(s) no ASPX.`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Falha ao atribuir no ASPX."),
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  // Selecionáveis = vão atribuir (assign) + divergentes que dá pra TROCAR (reassignable).
  const assignable = useMemo(() => items.filter((i) => i.state === "assign" || i.reassignable === true), [items]);
  const allSelected = assignable.length > 0 && assignable.every((i) => selected.has(i.lh));

  const toggle = (lh: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(lh)) next.delete(lh);
      else next.add(lh);
      return next;
    });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(assignable.map((i) => i.lh)));

  const resultByLh = useMemo(() => {
    const m = new Map<string, string>();
    (result?.results ?? []).forEach((r) => m.set(r.lh, r.state));
    return m;
  }, [result]);

  const realMode = Boolean(data?.writeEnabled);
  // Enquanto a prévia carrega, `data` é undefined → NÃO cair em "Simular (dry-run)"
  // (engana: parece que o envio real está off). Mostra estado de carregando; só
  // depois de carregar o rótulo reflete o modo real (Aplicar) ou simulação.
  const confirmLabel = previewQuery.isLoading || !data
    ? "Carregando prévia…"
    : realMode
      ? `Aplicar ${selected.size} no ASPX`
      : `Simular ${selected.size} (dry-run)`;
  const submit = () => {
    if (selected.size === 0) return;
    if (realMode) setConfirmReal(true); // envio REAL → confirma antes
    else assignMutation.mutate({ lhs: Array.from(selected) });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[88vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Send className="h-4 w-4 shrink-0 text-primary" />
            Atribuir no ASPX
          </DialogTitle>
          <DialogDescription className="pt-1 text-sm leading-relaxed text-muted-foreground">
            Cargas alocadas no sistema. Confira quem vai ser atribuído no ASPX antes de confirmar — nada é enviado até você confirmar.
          </DialogDescription>
        </DialogHeader>

        {/* Banner de modo (envio desligado / kill switch) */}
        {data && !data.writeEnabled && (
          <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Envio ao ASPX desligado (kill switch). A confirmação roda em dry-run — monta o pedido sem enviar.
            </span>
          </div>
        )}

        {/* Aviso de dados incompletos (station/cap/aba) */}
        {data && data.warnings.length > 0 && (
          <div className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-5 py-2.5 text-xs text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {data.warnings.includes("assignable_empty") && "A lista de viagens atribuíveis veio VAZIA — provável estação errada ou sessão SPX. Os estados podem não refletir o ASPX. "}
              {data.warnings.includes("index_unavailable") && "Não foi possível ler o status real das viagens (índice fora do ar) — os já atribuídos aparecem como 'não confirmada'. "}
              {data.warnings.includes("index_truncated") && "O índice de viagens foi truncado (muitas viagens) — alguns LHs podem aparecer como 'não confirmada'. "}
              {data.warnings.includes("index_partial") && "Parte das abas de viagem não respondeu — alguns LHs podem aparecer como 'não confirmada'. "}
              {data.warnings.includes("index_gaps") && `${data.summary.unknown} carga(s) alocada(s) não foram encontradas no ASPX (fora do índice) — se uma troca de motorista não aparece aqui, confira direto no portal. `}
            </span>
          </div>
        )}

        {/* Resumo — foco no que muda / diverge */}
        {data && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-5 py-3 text-xs">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" />{data.summary.willAssign} vão ser atribuídas
            </span>
            {data.summary.pending > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" />{data.summary.pending} pendentes
              </span>
            )}
            {data.summary.divergent > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-300">
                <AlertTriangle className="h-3.5 w-3.5" />{data.summary.divergent} divergentes do ASPX
              </span>
            )}
            {data.summary.hidden > 0 && (
              <span className="ml-auto text-[0.68rem] text-muted-foreground/70">
                {data.summary.hidden} já em dia (ocultas) · {data.summary.totalCandidates} no total
              </span>
            )}
          </div>
        )}

        {/* Lista */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {previewQuery.isLoading && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando pré-visualização…
            </div>
          )}
          {previewQuery.isError && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4" /> Erro ao carregar a pré-visualização.
            </div>
          )}
          {data && items.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-1 py-12 text-center text-sm text-muted-foreground">
              <CheckCircle2 className="h-5 w-5 text-emerald-500/70" />
              Tudo em dia — nenhuma carga a atribuir ou divergente do ASPX.
              {data.summary.totalCandidates > 0 && (
                <span className="text-[0.7rem] text-muted-foreground/60">{data.summary.totalCandidates} cargas conferidas</span>
              )}
            </div>
          )}

          {data && items.length > 0 && (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-[0.68rem] uppercase tracking-wide text-muted-foreground">
                  <th className="w-8 px-2 py-2">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={assignable.length === 0}
                      title="Selecionar todas as atribuíveis" aria-label="Selecionar todas as atribuíveis" />
                  </th>
                  <th className="px-2 py-2">LH</th>
                  <th className="px-2 py-2">Rota</th>
                  <th className="px-2 py-2">Agenda</th>
                  <th className="px-2 py-2">Motorista</th>
                  <th className="px-2 py-2">Veículo</th>
                  <th className="px-2 py-2">Estado</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const meta = aspxStateMeta(it.state);
                  const selectable = it.state === "assign" || it.reassignable === true;
                  const sentState = resultByLh.get(it.lh);
                  return (
                    <tr key={it.lh} className={cn("border-t border-border/40", !selectable && "opacity-60", it.divergent && "bg-red-50/50 dark:bg-red-500/10")}>
                      <td className="px-2 py-2 align-top">
                        <input type="checkbox" disabled={!selectable}
                          checked={selected.has(it.lh)} onChange={() => toggle(it.lh)}
                          aria-label={`Selecionar ${it.lh}`} />
                      </td>
                      <td className="px-2 py-2 align-top font-mono font-semibold text-foreground">{it.lh}</td>
                      <td className="px-2 py-2 align-top text-muted-foreground">
                        {(it.origem || "—")} → {(it.destino || "—")}
                      </td>
                      <td className="px-2 py-2 align-top text-muted-foreground">
                        {it.carregamentoLabel ? (
                          <span className="block"><span className="text-[0.6rem] uppercase text-muted-foreground/50">carga </span>{it.carregamentoLabel}</span>
                        ) : null}
                        {it.descargaLabel ? (
                          <span className="block"><span className="text-[0.6rem] uppercase text-muted-foreground/50">desc </span>{it.descargaLabel}</span>
                        ) : null}
                        {!it.carregamentoLabel && !it.descargaLabel && "—"}
                      </td>
                      <td className="px-2 py-2 align-top">
                        <span className="font-medium text-foreground">{it.motorista || "—"}</span>
                        {it.pinned && <Pin className="ml-1 inline h-3 w-3 text-primary" aria-label="Fixado" />}
                        {it.assignedDriver && it.assignedDriver.trim().toUpperCase() !== (it.motorista || "").trim().toUpperCase() && (
                          <span className="block text-[0.66rem] font-semibold text-red-700 dark:text-red-300">no ASPX: {it.assignedDriver}</span>
                        )}
                      </td>
                      <td className="px-2 py-2 align-top text-muted-foreground">
                        {[it.cavalo, it.carreta].filter(Boolean).join(" / ") || "—"}
                      </td>
                      <td className="px-2 py-2 align-top">
                        {it.divergent ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-300">
                            <AlertTriangle className="h-3 w-3" />Divergente
                          </span>
                        ) : (
                          <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold", meta.cls)}>
                            <meta.Icon className="h-3 w-3" />{meta.label}
                          </span>
                        )}
                        {sentState && (
                          <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-semibold text-primary">
                            {sentState === "assigned" ? "enviado" : sentState === "dry_run" ? "dry-run" : sentState}
                          </span>
                        )}
                        {it.reason && <span className="ml-1 block text-[0.66rem] text-muted-foreground/70">{it.reason}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Rodapé */}
        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-5 py-3">
          <span className="text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{selected.size}</span> selecionada(s)
          </span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose}
              className="rounded-lg border border-border/80 px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground">
              Fechar
            </button>
            <button type="button" onClick={submit}
              disabled={selected.size === 0 || assignMutation.isPending || previewQuery.isLoading}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-colors disabled:opacity-50",
                realMode ? "bg-red-600 hover:bg-red-700" : "bg-primary text-primary-foreground hover:bg-primary/90",
              )}>
              {assignMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              {confirmLabel}
            </button>
          </div>
        </div>
      </DialogContent>

      {/* Confirmação de ENVIO REAL ao ASPX (escreve na produção da Shopee) */}
      <ConfirmDialog
        open={confirmReal}
        title="Enviar de verdade ao ASPX?"
        confirmLabel={`Sim, aplicar ${selected.size}`}
        description={`Isto vai ALTERAR o ASPX (produção Shopee) de ${selected.size} carga(s) — atribuir/trocar motorista de verdade. Confirme apenas se tiver certeza.`}
        onConfirm={() => { setConfirmReal(false); assignMutation.mutate({ lhs: Array.from(selected) }); }}
        onCancel={() => setConfirmReal(false)}
      />
    </Dialog>
  );
}

// ─── Carga do SISTEMA: editar / criar (grid unificado) ──────────────────────
// Cargas do sistema (sheet_lh nulo) são editadas como uma planilha: Status, LH,
// Rota, Agenda, Motorista/Placa — todos editáveis (a carga é a fonte da verdade).

type CargoForm = { lh: string; status: string; tipo: string; origem: string; destino: string; carregamento: string; descarga: string; motorista: string; cavalo: string; carreta: string; vinculo: string };

function MonitorCargoFields({ form, setForm, statusOptions }: {
  form: CargoForm;
  setForm: React.Dispatch<React.SetStateAction<CargoForm>>;
  statusOptions: readonly string[];
}) {
  const set = (k: keyof CargoForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const field = "w-full rounded-lg border border-border/80 bg-white/92 px-3 py-2 text-sm outline-none focus:border-primary/30 focus:ring-2 focus:ring-primary/10 dark:bg-muted/40";
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="col-span-1 text-xs font-medium text-muted-foreground">LH (livre)
        <input className={field} value={form.lh} onChange={set("lh")} placeholder="opcional" maxLength={120} />
      </label>
      <label className="col-span-1 text-xs font-medium text-muted-foreground">Status
        <select className={field} value={form.status} onChange={set("status")}>
          <option value="">(sem status)</option>
          {statusOptions.map((s) => (
            <option key={s} value={s}>{s === "Disponível" ? "Disponível (reabrir p/ motorista)" : s}</option>
          ))}
        </select>
      </label>
      <label className="col-span-2 text-xs font-medium text-muted-foreground">Tipo (ForeCast, Spot…)
        <input list={TIPO_DATALIST_ID} className={field} value={form.tipo} onChange={set("tipo")} placeholder="opcional" maxLength={60} />
      </label>
      <label className="col-span-1 text-xs font-medium text-muted-foreground">Origem
        <input className={field} value={form.origem} onChange={set("origem")} maxLength={180} />
      </label>
      <label className="col-span-1 text-xs font-medium text-muted-foreground">Destino
        <input className={field} value={form.destino} onChange={set("destino")} maxLength={180} />
      </label>
      <label className="col-span-1 text-xs font-medium text-muted-foreground">Carregamento (data + hora)
        <input type="datetime-local" className={field} value={form.carregamento} onChange={set("carregamento")} />
      </label>
      <label className="col-span-1 text-xs font-medium text-muted-foreground">Descarga (data + hora)
        <input type="datetime-local" className={field} value={form.descarga} onChange={set("descarga")} />
      </label>
      <label className="col-span-2 text-xs font-medium text-muted-foreground">Motorista
        <input list={DRIVER_DATALIST_ID} autoComplete="off" className={field} value={form.motorista} onChange={set("motorista")} placeholder="digite p/ buscar nos cadastrados" maxLength={180} />
      </label>
      <label className="col-span-1 text-xs font-medium text-muted-foreground">Cavalo
        <input list={CAVALO_DATALIST_ID} autoComplete="off" className={field} value={form.cavalo} onChange={set("cavalo")} maxLength={40} />
      </label>
      <label className="col-span-1 text-xs font-medium text-muted-foreground">Carreta
        <input list={CARRETA_DATALIST_ID} autoComplete="off" className={field} value={form.carreta} onChange={set("carreta")} maxLength={40} />
      </label>
      <label className="col-span-2 text-xs font-medium text-muted-foreground">Vínculo
        <input list="monitor-vinculo-datalist" autoComplete="off" className={field} value={form.vinculo} onChange={set("vinculo")} placeholder="Ex.: AGREGADO DEDICADO, TERCEIRO, PME…" maxLength={80} />
      </label>
    </div>
  );
}

const EMPTY_CARGO_FORM: CargoForm = { lh: "", status: "", tipo: "", origem: "", destino: "", carregamento: "", descarga: "", motorista: "", cavalo: "", carreta: "", vinculo: "" };

// datetime-local 'YYYY-MM-DDTHH:MM' → { data:'YYYY-MM-DD', horario:'HH:MM' }
function splitCarregamento(dt: string): { data: string; horario: string } {
  const [d, t] = (dt || "").split("T");
  return { data: d || "", horario: (t || "").slice(0, 5) };
}

// Filtro de data (datetime-local): ao ESCOLHER/mudar a data no calendário o
// navegador preenche o horário ATUAL. Aqui forçamos o padrão 00:00 quando a data
// muda (ou o campo estava vazio); se o operador editar só o horário na MESMA data,
// o valor digitado é preservado — mantendo a opção de escolher o horário.
function dateFilterWithMidnight(prev: string, next: string): string {
  if (!next) return next; // limpou
  const [nd] = next.split("T");
  const [pd = ""] = (prev || "").split("T");
  return nd !== pd ? `${nd}T00:00` : next;
}

// Data de HOJE no fuso local do operador (BRT), no formato do <input datetime-local>.
function todayLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function SystemCargoEditModal({ row, open, onClose, statusOptions }: {
  row: SheetMonitorRowType | null;
  open: boolean;
  onClose: () => void;
  statusOptions: readonly string[];
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_CARGO_FORM);
  const [confirmChange, setConfirmChange] = useState(false);

  useEffect(() => {
    if (open && row) {
      setForm({
        lh: row.lh ?? "",
        status: row.status ?? "",
        // "SISTEMA" é o rótulo padrão (sem tipo) — não pré-preenche o campo com ele.
        tipo: row.tipo && row.tipo !== "SISTEMA" ? row.tipo : "",
        origem: row.origem ?? "",
        destino: row.destino ?? "",
        carregamento: row.cargaAt ?? (row.data ? `${row.data}T${(row.horario ?? "00:00").slice(0, 5)}` : ""),
        descarga: row.descargaAt ?? "",
        motorista: row.motoristas ?? "",
        cavalo: row.cavalo ?? "",
        carreta: row.carreta ?? "",
        vinculo: row.vinculo ?? "",
      });
    }
  }, [open, row]);

  const mutation = useMutation({
    mutationFn: updateMonitorCargo,
    onSuccess: () => {
      toast.success("Carga atualizada.");
      void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Não foi possível salvar a carga."),
  });

  // Trocou motorista/veículo? (comparado ao que veio na linha) → exige o motivo.
  const mvChanged =
    form.motorista.trim() !== (row?.motoristas ?? "").trim() ||
    form.cavalo.trim() !== (row?.cavalo ?? "").trim() ||
    form.carreta.trim() !== (row?.carreta ?? "").trim();

  const buildAndMutate = (descricao = "") => {
    if (!row?.cargoId) return;
    const { data, horario } = splitCarregamento(form.carregamento);
    if (form.origem.trim().length < 2 || form.destino.trim().length < 2 || !data || !horario) {
      toast.error("Rota e carregamento (origem, destino, data + hora) são obrigatórios.");
      return;
    }
    // "Disponível" reabre a carga pro painel — só faz sentido SEM motorista. Com
    // motorista, BLOQUEIA (o operador remove o motorista antes; nunca removemos sozinho).
    if (/^dispon[ií]vel$/i.test(form.status.trim()) && form.motorista.trim()) {
      toast.error("Esta carga tem motorista. Remova o motorista antes de deixá-la Disponível.");
      return;
    }
    mutation.mutate({
      cargoId: row.cargoId,
      lh: form.lh.trim(),
      status: form.status.trim(),
      tipo: form.tipo.trim(),
      origem: form.origem.trim(),
      destino: form.destino.trim(),
      data,
      horario,
      descarga: form.descarga, // datetime-local ou '' (limpa)
      motorista: form.motorista.trim(),
      cavalo: form.cavalo.trim(),
      carreta: form.carreta.trim(),
      vinculo: form.vinculo.trim(),
      ...(descricao ? { descricao } : {}),
    });
  };

  const save = () => {
    if (!row?.cargoId) return;
    // Validação de rota/agenda antes de abrir o modal de motivo.
    const { data, horario } = splitCarregamento(form.carregamento);
    if (form.origem.trim().length < 2 || form.destino.trim().length < 2 || !data || !horario) {
      toast.error("Rota e carregamento (origem, destino, data + hora) são obrigatórios.");
      return;
    }
    if (mvChanged) setConfirmChange(true); // trocou m/v → pede o motivo (obrigatório)
    else buildAndMutate();
  };

  return (
    <>
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Pencil className="h-4 w-4 shrink-0 text-sky-500" />
            Editar carga do sistema
          </DialogTitle>
          <DialogDescription className="pt-1 text-sm text-muted-foreground">
            Carga criada no sistema (fora da planilha). Edite como uma planilha — tudo é editável.
          </DialogDescription>
        </DialogHeader>
        {/* Motivo da última troca de motorista/veículo (descrição do operador). */}
        {row?.descricao && (
          <div className="rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/10">
            <p className="text-[0.6rem] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
              Motivo da última troca de motorista/veículo
            </p>
            <p className="mt-0.5 whitespace-pre-wrap text-sm leading-snug text-foreground">{row.descricao}</p>
          </div>
        )}
        <MonitorCargoFields form={form} setForm={setForm} statusOptions={statusOptions} />
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-border/80 px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground">Cancelar</button>
          <button type="button" onClick={save} disabled={mutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Salvar
          </button>
        </div>
      </DialogContent>
    </Dialog>

    <ChangeReasonDialog
      open={confirmChange}
      onConfirm={(reason) => { setConfirmChange(false); buildAndMutate(reason); }}
      onCancel={() => setConfirmChange(false)}
    />
    </>
  );
}

function NewCargoModal({ open, onClose, statusOptions }: { open: boolean; onClose: () => void; statusOptions: readonly string[] }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_CARGO_FORM);

  useEffect(() => { if (open) setForm(EMPTY_CARGO_FORM); }, [open]);

  const mutation = useMutation({
    mutationFn: async () => {
      // Cria a carga (rota + carregamento + descarga) e, se o operador já preencheu
      // motorista/placa/status/LH, aplica via updateMonitorCargo na sequência.
      const { data, horario } = splitCarregamento(form.carregamento);
      const created = await createMonitorCargo({
        origem: form.origem.trim(),
        destino: form.destino.trim(),
        data,
        horario,
        descarga: form.descarga ? form.descarga.replace("T", " ") : undefined,
      });
      const cargoId = created?.cargo?.id || created?.id;
      const extra = form.motorista || form.cavalo || form.carreta || form.status || form.lh || form.tipo;
      if (cargoId && extra) {
        await updateMonitorCargo({
          cargoId,
          lh: form.lh.trim(),
          status: form.status.trim(),
          tipo: form.tipo.trim(),
          motorista: form.motorista.trim(),
          cavalo: form.cavalo.trim(),
          carreta: form.carreta.trim(),
        });
      }
      return created;
    },
    onSuccess: () => {
      toast.success("Carga criada no sistema.");
      void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Não foi possível criar a carga."),
  });

  const create = () => {
    const { data, horario } = splitCarregamento(form.carregamento);
    if (form.origem.trim().length < 2 || form.destino.trim().length < 2 || !data || !horario) {
      toast.error("Origem, destino e carregamento (data + hora) são obrigatórios.");
      return;
    }
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileSpreadsheet className="h-4 w-4 shrink-0 text-primary" />
            Nova carga (sistema)
          </DialogTitle>
          <DialogDescription className="pt-1 text-sm text-muted-foreground">
            Cria uma carga no sistema (fora da planilha Shopee), visível e editável no Monitor.
          </DialogDescription>
        </DialogHeader>
        <MonitorCargoFields form={form} setForm={setForm} statusOptions={statusOptions} />
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-border/80 px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground">Cancelar</button>
          <button type="button" onClick={create} disabled={mutation.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            Criar carga
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Conteúdo da célula Motorista/Placa — visualização (com alça de arrastar) +
// edição inline. A alça arrasta a ALOCAÇÃO (motorista+placa) para reatribuir
// entre cargas; o lápis abre a edição inline.
type AllocCellProps = {
  row: SheetMonitorRowType;
  enriched: SheetMonitorEnrichedRow | undefined;
  cavaloChecklist?: VehicleChecklistLevelEntry;
  carretaChecklist?: VehicleChecklistLevelEntry;
  editing: boolean;
  saving: boolean;
  pinning: boolean;
  allocStatus: string | null;
  onStartEdit: (lh: string) => void;
  onCancelEdit: () => void;
  onSaveInline: (payload: { lh: string; motorista: string; cavalo: string; carreta: string; status: string }) => void;
  onTogglePin: (lh: string, pinned: boolean) => void;
  onDragStartHandle: (lh: string) => void;
  onDragEndHandle: () => void;
  // true enquanto este standby está sendo puxado pra uma carga (request em voo).
  assigningReserva?: boolean;
  // nº de standbys da MESMA rota desta carga; >0 habilita o botão "puxar standby".
  routeStandbyCount?: number;
  onPullStandby?: (lh: string) => void;
};

function AllocCell({ row, enriched, cavaloChecklist, carretaChecklist, editing, saving, pinning, allocStatus, onStartEdit, onCancelEdit, onSaveInline, onTogglePin, onDragStartHandle, onDragEndHandle, assigningReserva, routeStandbyCount = 0, onPullStandby }: AllocCellProps) {
  // Linha de RESERVA (standby na rota) — exibe o motorista/veículo e um punho de
  // arrasto: o operador puxa o standby para uma carga da MESMA rota (alocar).
  if (row.reserva) {
    return (
      <div className="group/rsv flex items-start gap-1.5 border-l-2 border-amber-400 pl-2">
        {row.reservaId && (
          <button
            type="button"
            aria-label="Arrastar reserva para uma carga"
            title={assigningReserva ? "Enviando…" : "Arraste para uma carga da mesma rota para alocar esta reserva"}
            draggable={!assigningReserva}
            onClick={(e) => e.stopPropagation()}
            onDragStart={(e) => { if (assigningReserva) { e.preventDefault(); return; } e.stopPropagation(); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", `reserva:${row.reservaId}`); onDragStartHandle(`reserva:${row.reservaId}`); }}
            onDragEnd={onDragEndHandle}
            className={cn(
              "mt-0.5 shrink-0 rounded p-0.5 text-amber-500/70 transition-colors",
              assigningReserva
                ? "cursor-wait opacity-40"
                : "cursor-grab hover:bg-muted hover:text-amber-600 active:cursor-grabbing",
            )}
          >
            {assigningReserva ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GripVertical className="h-3.5 w-3.5" />}
          </button>
        )}
        <div className="min-w-0 flex-1">
          {row.motoristas ? (
            <span className="truncate text-xs font-medium text-foreground">{row.motoristas}</span>
          ) : (
            <span className="text-xs text-muted-foreground/50">—</span>
          )}
          {row.cavalo && (
            <div className="truncate text-[0.62rem] text-muted-foreground">
              {row.cavalo}{row.carreta ? ` · ${row.carreta}` : ""}
            </div>
          )}
          <span className="mt-0.5 inline-flex items-center gap-1 text-[0.58rem] font-semibold text-amber-600 dark:text-amber-400">
            {assigningReserva ? "puxando p/ a carga…" : "reserva — arraste p/ uma carga"}
          </span>
        </div>
      </div>
    );
  }
  // Carga do SISTEMA — motorista/veículo exibidos read-only aqui; a edição (de
  // tudo: status/LH/rota/agenda/motorista/placa) é feita pelo modal ao clicar na
  // linha. Evita o keying por LH do editor inline (cargas do sistema têm LH livre).
  if (row.source === "sistema") {
    return (
      <div className="flex items-start gap-1.5 border-l-2 border-sky-400 pl-2">
        <div className="min-w-0 flex-1">
          {row.motoristas ? (
            <span className="truncate text-xs font-medium text-foreground">{row.motoristas}</span>
          ) : (
            <span className="text-xs text-muted-foreground/50">—</span>
          )}
          {row.cavalo && (
            <div className="truncate text-[0.62rem] text-muted-foreground">
              {row.cavalo}{row.carreta ? ` · ${row.carreta}` : ""}
            </div>
          )}
          <span className="mt-0.5 inline-flex items-center gap-1 text-[0.58rem] font-semibold text-sky-600 dark:text-sky-400">
            clique p/ editar
          </span>
        </div>
      </div>
    );
  }
  const { editable, aspxWarning } = allocEditPolicy(row);
  const pinned = !!row.pinned;
  // Fixo trava motorista/veículo (intocável). Status-lock (ASPX) também trava.
  const canEditAlloc = editable && !pinned;
  if (editing) {
    return (
      <InlineAllocEditor
        initial={{ motorista: row.motoristas ?? "", cavalo: row.cavalo ?? "", carreta: row.carreta ?? "", tipo: row.tipo ?? "" }}
        saving={saving}
        onSave={(v) => onSaveInline({ lh: row.lh, ...v, status: allocStatus ?? "" })}
        onCancel={onCancelEdit}
      />
    );
  }
  return (
    <div className="group/alloc flex items-center gap-1">
      {canEditAlloc ? (
        <button
          type="button"
          aria-label="Arrastar alocação (trocar / mover na fila)"
          title="Arraste para o corpo de outra carga (trocar). Solte na borda de uma carga ABAIXO para descer a fila (empurra os de baixo; o último sobra vira reserva)."
          draggable
          onClick={(e) => e.stopPropagation()}
          onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", row.lh); onDragStartHandle(row.lh); }}
          onDragEnd={onDragEndHandle}
          className="mt-0.5 shrink-0 cursor-grab rounded p-0.5 text-muted-foreground/40 opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/alloc:opacity-100 active:cursor-grabbing"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
      ) : pinned ? (
        <span
          aria-label="Alocação fixada"
          title="Fixado: motorista e veículo travados nesta carga (não muda por arrasto, edição ou cascata)"
          className="mt-0.5 shrink-0 p-0.5 text-amber-500"
        >
          <Pin className="h-3.5 w-3.5 fill-current" />
        </span>
      ) : (
        <span
          aria-label="Alocação travada"
          title="Travado: já em atribuição no ASPX (este status não permite alterar motorista/veículo)"
          className="mt-0.5 shrink-0 p-0.5 text-muted-foreground/30"
        >
          <Lock className="h-3.5 w-3.5" />
        </span>
      )}
      {/* Clique direto no motorista/placas abre a edição INLINE (sem precisar do
          lápis). stopPropagation: não deixa o clique subir pra linha (que abriria
          o modal). Quando não-editável (travada/fixada), o clique sobe normal. */}
      <div
        className={cn("min-w-0 flex-1", canEditAlloc && "cursor-text rounded-sm px-0.5 -mx-0.5 transition-colors hover:bg-background/70 hover:ring-1 hover:ring-border")}
        title={canEditAlloc ? "Clique para editar motorista/veículo" : undefined}
        onClick={canEditAlloc ? (e) => { e.stopPropagation(); onStartEdit(row.lh); } : undefined}
      >
        {/* Linha única: motorista + placa + checks compactos + selos de estado (fixado / ASPX). */}
        <div className="flex items-center gap-1.5">
          {/* DC-239: nome com largura FIXA → a placa começa sempre no mesmo x
              (placas alinhadas verticalmente entre as linhas). Trunca c/ tooltip. */}
          {row.motoristas ? (
            <span className="w-[46%] shrink-0 truncate text-xs font-medium text-foreground" title={row.motoristas}>{row.motoristas}</span>
          ) : (
            <span className="w-[46%] shrink-0 truncate text-xs text-muted-foreground/50">Sem motorista</span>
          )}
          {/* Placa (cavalo · carreta) em SLOT de largura FIXA, sempre presente
              (vazio sem veículo) → alinhamento vertical das placas. */}
          <span
            className="w-[116px] shrink-0 truncate font-mono text-[0.6rem] text-muted-foreground"
            title={row.cavalo ? `${row.cavalo}${row.carreta ? ` · ${row.carreta}` : ""}` : undefined}
          >
            {row.cavalo ? `${row.cavalo}${row.carreta ? ` · ${row.carreta}` : ""}` : ""}
          </span>
          {/* Selos logo após a placa (sem ml-auto) — vão junto, sem vão grande.
              Começam num x consistente (nome+placa têm largura fixa) e não
              deslocam a placa. */}
          <span className="flex shrink-0 items-center gap-1.5">
            {row.motoristas && <DriverChecks enriched={enriched} aspxRelevant={isSpxTrip(row.lh)} />}
            <VehicleChecks enriched={enriched} hasCavalo={Boolean(row.cavalo)} hasCarreta={Boolean(row.carreta)} />
            <VehicleChecklistIcons cavalo={row.cavalo} carreta={row.carreta} cavaloChecklist={cavaloChecklist} carretaChecklist={carretaChecklist} />
            {/* Slot FIXO do marcador de estado (fixado / atribuído no ASPX) — DC-226. */}
            <span
              className="flex h-3 w-3 shrink-0 items-center justify-center"
              title={pinned ? "Fixado nesta carga (motorista/veículo travados)" : aspxWarning ? "Motorista já atribuído no ASPX" : undefined}
            >
              {pinned ? (
                <Pin className="h-3 w-3 fill-current text-amber-500" />
              ) : aspxWarning ? (
                // DC-227: já atribuído no ASPX = estado normal → selo positivo (pessoa+check),
                // não triângulo de alerta (reservado a avisos que pedem ação).
                <UserCheck className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
              ) : null}
            </span>
          </span>
        </div>
      </div>
      {/* Ações à direita em SLOTS de largura FIXA: a presença/ausência do fixar, do
          editar e do badge de reserva (👤 N) NÃO desloca as placas e os selos das
          demais linhas — cada controle ocupa um slot de largura constante (DC-226).
          O badge fica por último (mais à direita), com espaço próprio/reservado. */}
      <div className="flex shrink-0 items-center gap-0.5">
        {/* Slot: fixar/desafixar alocação. */}
        <span className="flex w-6 shrink-0 justify-center">
          {(row.motoristas || pinned) && (
            <button
              type="button"
              title={pinned ? "Desafixar (liberar para mover na fila)" : "Fixar motorista/veículo nesta carga"}
              aria-label={pinned ? "Desafixar alocação" : "Fixar alocação"}
              disabled={pinning}
              onClick={(e) => { e.stopPropagation(); onTogglePin(row.lh, !pinned); }}
              className={cn(
                "rounded p-1 transition-opacity hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
                pinned
                  ? "text-amber-500 hover:text-amber-600"
                  : "text-muted-foreground/40 opacity-0 hover:text-foreground focus:opacity-100 group-hover/alloc:opacity-100",
              )}
            >
              {pinning ? <Loader2 className="h-3 w-3 animate-spin" /> : pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
            </button>
          )}
        </span>
        {/* Slot: editar alocação na linha. */}
        <span className="flex w-6 shrink-0 justify-center">
          {canEditAlloc && (
            <button
              type="button"
              title="Editar alocação na linha"
              aria-label="Editar alocação"
              onClick={(e) => { e.stopPropagation(); onStartEdit(row.lh); }}
              className="rounded p-1 text-muted-foreground/40 opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus:opacity-100 group-hover/alloc:opacity-100"
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
        </span>
        {/* Slot: puxar reserva (👤 N) — reservado mesmo quando a rota não tem reserva. */}
        <span className="flex w-10 shrink-0 justify-end">
          {canEditAlloc && routeStandbyCount > 0 && onPullStandby && (
            <button
              type="button"
              title={`Puxar um motorista em reserva desta rota (${routeStandbyCount} disponíve${routeStandbyCount === 1 ? "l" : "is"})`}
              aria-label="Puxar reserva para esta carga"
              onClick={(e) => { e.stopPropagation(); onPullStandby(row.lh); }}
              className="inline-flex items-center gap-0.5 whitespace-nowrap rounded px-1 py-0.5 text-[0.6rem] font-semibold text-amber-600 transition-colors hover:bg-amber-50 hover:text-amber-700 dark:text-amber-400 dark:hover:bg-amber-500/10"
            >
              <UserPlus className="h-3 w-3" /> {routeStandbyCount}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

// ─── Table row ────────────────────────────────────────────────────────────────

const ROW_VIRTUALIZATION_STYLE = { contentVisibility: "auto" as const, containIntrinsicSize: "0 48px" as const };

type RowDropIntent = "swap" | "before" | "after" | null;

const SheetMonitorRow = memo(function SheetMonitorRow({
  row,
  enriched,
  cavaloChecklist,
  carretaChecklist,
  selected,
  editing,
  saving,
  pinning,
  allocStatus,
  isDragSource,
  dropIntent,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onSaveInline,
  onTogglePin,
  onDragStartHandle,
  onDragEndHandle,
  onRowDragOver,
  onRowDrop,
  assigningReserva,
  standbyCountByRoute,
  onPullStandby,
}: {
  row: SheetMonitorRowType;
  enriched: SheetMonitorEnrichedRow | undefined;
  cavaloChecklist?: VehicleChecklistLevelEntry;
  carretaChecklist?: VehicleChecklistLevelEntry;
  selected: boolean;
  editing: boolean;
  saving: boolean;
  pinning: boolean;
  // alloc_status atual do override — reenviado no save inline para NÃO apagar o
  // status operacional ao editar só motorista/placa.
  allocStatus: string | null;
  isDragSource: boolean;
  dropIntent: RowDropIntent;
  onSelect: (row: SheetMonitorRowType) => void;
  onStartEdit: (lh: string) => void;
  onCancelEdit: () => void;
  onSaveInline: (payload: { lh: string; motorista: string; cavalo: string; carreta: string; status: string }) => void;
  onTogglePin: (lh: string, pinned: boolean) => void;
  onDragStartHandle: (lh: string) => void;
  onDragEndHandle: () => void;
  onRowDragOver: (e: React.DragEvent, row: SheetMonitorRowType) => void;
  onRowDrop: (e: React.DragEvent, row: SheetMonitorRowType) => void;
  assigningReserva: boolean;
  standbyCountByRoute: Map<string, number>;
  onPullStandby: (lh: string) => void;
}) {
  // Standbys da MESMA rota (de toda a base, não só desta página) → habilita o
  // botão "puxar standby" em cargas editáveis, independente da paginação.
  const routeStandbyCount = row.reserva || row.source === "sistema" ? 0 : (standbyCountByRoute.get(routeKeyOf(row)) ?? 0);
  return (
    <tr
      style={ROW_VIRTUALIZATION_STYLE}
      onClick={() => { if (!row.reserva) onSelect(row); }}
      onDragOver={(e) => onRowDragOver(e, row)}
      onDrop={(e) => onRowDrop(e, row)}
      className={cn(
        "transition-colors duration-100",
        row.reserva ? "cursor-default" : "cursor-pointer",
        // Soltar no CORPO = trocar → linha toda azul.
        dropIntent === "swap"
          ? "bg-blue-500/20"
          : selected
            ? "bg-primary/10 dark:bg-primary/20"
            : row.reserva
              ? "bg-amber-50/70 dark:bg-amber-500/10"
              // Linha inteira na cor do STATUS (mesma cor do badge) — visual rápido
              // pro operador. Mesma expressão de status efetivo do StatusBadge.
              : resolveSheetStatusStyle(!row.status && row.motoristas ? "Reservado" : row.status).row,
        // Soltar na BORDA = descer/subir a fila → só a borda azul.
        dropIntent === "before" && "[&>td]:border-t-[3px] [&>td]:border-blue-600",
        dropIntent === "after" && "[&>td]:border-b-[3px] [&>td]:border-blue-600",
        isDragSource && "opacity-40",
      )}
    >
      {/* Status */}
      <td className="px-3 py-1.5 align-middle">
        <StatusBadge dense status={!row.status && row.motoristas ? "Reservado" : row.status} />
      </td>

      {/* LH + Tipo (linha única) — trunca na linha; o LH completo fica no modal (título) */}
      <td className="px-3 py-1.5 align-middle">
        {row.reserva ? (
          <span className="text-[0.62rem] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">reserva</span>
        ) : (
          <div className="min-w-0" title={row.tipo ? `${row.lh} · ${row.tipo}` : row.lh}>
            <div className="truncate font-mono text-xs font-semibold text-foreground/80">{row.lh || "—"}</div>
            {row.tipo && <div className="truncate text-[0.62rem] text-muted-foreground">{row.tipo}</div>}
          </div>
        )}
      </td>

      {/* Cliente */}
      <td className="px-3 py-1.5 align-middle">
        <span className="block truncate text-xs font-medium text-foreground/90" title={row.cliente ?? undefined}>{row.cliente || "—"}</span>
      </td>

      {/* Rota em DUAS linhas: origem (com código da rota na frente) em cima,
          destino embaixo — layout de 2 linhas por viagem. */}
      <td className="px-3 py-1.5 align-middle">
        <div className="flex items-start gap-1" title={`${row.origem || "—"} → ${row.destino || "—"}`}>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-foreground">
              {row.routeCodigo != null && (
                <span className="mr-1 font-mono text-[0.58rem] font-semibold text-muted-foreground/70" title="Código da rota">R{row.routeCodigo}</span>
              )}
              {row.origem || "—"}
            </div>
            <div className="truncate text-xs text-muted-foreground">{row.destino || "—"}</div>
          </div>
          {row.routeRegistered === false && (
            <span title="O trajeto origem→destino não tem rota cadastrada no catálogo" className="mt-0.5 shrink-0 text-orange-500">
              <AlertTriangle className="h-3 w-3" />
            </span>
          )}
        </div>
      </td>

      {/* Agenda em DUAS linhas: carregamento em cima, descarga embaixo.
          tabular-nums = dígitos de largura fixa → as datas alinham verticalmente.
          DC-239: px-1 (folga lateral mínima — a coluna é estreita). */}
      <td className="px-1 py-1.5 align-middle">
        {row.carregamentoLabel || row.descargaLabel ? (
          <div
            className="text-xs text-foreground tabular-nums"
            title={[
              row.carregamentoLabel ? `Carregamento: ${row.carregamentoLabel}` : null,
              row.descargaLabel ? `Descarga: ${row.descargaLabel}` : null,
            ].filter(Boolean).join("  ·  ")}
          >
            <div className="truncate">{shortAgenda(row.carregamentoLabel) || "—"}</div>
            {row.descargaLabel && <div className="truncate text-muted-foreground">{shortAgenda(row.descargaLabel)}</div>}
          </div>
        ) : row.reserva && row.standbyAt ? (
          <span className="text-xs text-amber-700 dark:text-amber-300" title={`Em reserva desde ${formatStandby(row.standbyAt)}`}>
            reserva {formatStandby(row.standbyAt)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/40">—</span>
        )}
      </td>

      {/* Motorista + Placa — editável inline (combobox).
          DC-239: px-2 (nome começa mais à esquerda). */}
      <td className="px-2 py-1.5 align-middle">
        <AllocCell
          row={row}
          enriched={enriched}
          cavaloChecklist={cavaloChecklist}
          carretaChecklist={carretaChecklist}
          editing={editing}
          saving={saving}
          pinning={pinning}
          allocStatus={allocStatus}
          onStartEdit={onStartEdit}
          onCancelEdit={onCancelEdit}
          onSaveInline={onSaveInline}
          onTogglePin={onTogglePin}
          onDragStartHandle={onDragStartHandle}
          onDragEndHandle={onDragEndHandle}
          assigningReserva={assigningReserva}
          routeStandbyCount={routeStandbyCount}
          onPullStandby={onPullStandby}
        />
      </td>
    </tr>
  );
});

// ─── Table wrapper ────────────────────────────────────────────────────────────

function SheetMonitorTable({
  rows,
  resolveEnriched,
  resolveChecklistLevel,
  allocByLh,
  selectedLh,
  editingLh,
  savingLh,
  pinningLh,
  loading,
  reassigning,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onSaveInline,
  onTogglePin,
  onReassign,
  onDescendQueue,
  getRouteQueue,
  onAssignReserva,
  assigningReservaId,
  standbyCountByRoute,
  onPullStandby,
  agendaSortDir,
  onToggleAgendaSort,
}: {
  rows: SheetMonitorRowType[];
  resolveEnriched: (row: SheetMonitorRowType) => SheetMonitorEnrichedRow | undefined;
  resolveChecklistLevel: (plate: string | null | undefined) => VehicleChecklistLevelEntry | undefined;
  allocByLh: Record<string, SheetMonitorAllocation>;
  selectedLh: string | null;
  editingLh: string | null;
  savingLh: string | null;
  pinningLh: string | null;
  loading: boolean;
  reassigning: boolean;
  onSelect: (row: SheetMonitorRowType) => void;
  onStartEdit: (lh: string) => void;
  onCancelEdit: () => void;
  onSaveInline: (payload: { lh: string; motorista: string; cavalo: string; carreta: string; status: string }) => void;
  onTogglePin: (lh: string, pinned: boolean) => void;
  onReassign: (moves: Array<{ lh?: string; cargoId?: string; motorista: string; cavalo: string; carreta: string }>) => void;
  onDescendQueue: (input: { sourceLh: string; targetLh: string; orderedLhs: string[]; pinnedInPath: string[]; aspxInPath: string[] }) => void;
  getRouteQueue: (routeKey: string) => SheetMonitorRowType[];
  onAssignReserva: (input: { reservaId: string; targetLh: string }) => void;
  assigningReservaId: string | null;
  standbyCountByRoute: Map<string, number>;
  onPullStandby: (lh: string) => void;
  agendaSortDir: "asc" | "desc";
  onToggleAgendaSort: () => void;
}) {
  // Arrastar a fila de motoristas/veículos entre cargas (as viagens são fixas).
  // Modo auto-identificável pelo ponto de soltura: corpo da linha = trocar
  // (linha azul); borda da linha = descer/subir a fila (borda azul).
  const [dragLh, setDragLh] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ key: string; intent: "swap" | "before" | "after" } | null>(null);
  const dragLhRef = useRef<string | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const handleDragStartHandle = useCallback((lh: string) => { dragLhRef.current = lh; setDragLh(lh); }, []);
  const handleDragEndHandle = useCallback(() => { dragLhRef.current = null; setDragLh(null); setDropTarget(null); }, []);

  const handleRowDragOver = useCallback((e: React.DragEvent, targetRow: SheetMonitorRowType) => {
    const dragging = dragLhRef.current;
    if (!dragging) return;
    const block = () => { e.preventDefault(); e.dataTransfer.dropEffect = "none"; setDropTarget(null); };
    const allowSwap = () => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTarget((prev) => (prev && prev.key === targetRow.rowKey && prev.intent === "swap" ? prev : { key: targetRow.rowKey, intent: "swap" }));
    };
    // Arrastando um STANDBY (reserva) → solta numa carga da PLANILHA (mesma rota),
    // editável e não fixa. Sempre "swap" (linha toda destacada = aloca aqui).
    if (dragging.startsWith("reserva:")) {
      const reservaRow = rowsRef.current.find((r) => r.reserva && `reserva:${r.reservaId}` === dragging);
      // fail-closed: sem a reserva na página (refetch no meio do arrasto), nega.
      if (!targetRow || targetRow.source === "sistema" || targetRow.reserva ||
          !allocEditPolicy(targetRow).editable || targetRow.pinned ||
          reservaRow == null || routeKeyOf(targetRow) !== routeKeyOf(reservaRow)) return block();
      return allowSwap();
    }
    // Arrastando a ALOCAÇÃO de uma carga da planilha. Não solta em reserva, linha
    // travada (ASPX) nem fixa.
    if (!targetRow || targetRow.reserva || !allocEditPolicy(targetRow).editable || targetRow.pinned) return block();
    // Só dentro da MESMA rota — vale também p/ carga do sistema como alvo.
    const sourceRow = rowsRef.current.find((r) => r.lh === dragging);
    if (sourceRow && routeKeyOf(targetRow) !== routeKeyOf(sourceRow)) return block();
    // Carga do SISTEMA como alvo: só troca (não tem posição na fila) → swap.
    if (targetRow.source === "sistema") {
      if (!targetRow.cargoId) return block();
      return allowSwap();
    }
    // Carga da planilha alvo: soltar aqui DESCE a fila a partir desta carga — o
    // motorista ASSUME esta carga (ela e as de baixo descem). O indicador é a
    // LINHA DE CIMA (before) da carga de destino ("o motorista vai para esta
    // posição"), independente do sentido do arrasto.
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (targetRow.lh === dragging) { setDropTarget(null); return; }
    setDropTarget((prev) => (prev && prev.key === targetRow.rowKey && prev.intent === "before" ? prev : { key: targetRow.rowKey, intent: "before" }));
  }, []);

  const handleRowDrop = useCallback((e: React.DragEvent, targetRow: SheetMonitorRowType) => {
    e.preventDefault();
    const src = dragLhRef.current;
    dragLhRef.current = null;
    setDragLh(null);
    setDropTarget(null);
    if (!src || !targetRow) return;
    // Arrastando um STANDBY (reserva) → puxa para a carga de destino (mesma rota).
    if (src.startsWith("reserva:")) {
      if (targetRow.source === "sistema" || targetRow.reserva) { toast.error("Solte a reserva numa carga da planilha."); return; }
      const reservaId = src.slice("reserva:".length);
      const reservaRow = rowsRef.current.find((r) => r.reserva && `reserva:${r.reservaId}` === src);
      if (targetRow.pinned) { toast.error("A carga de destino está fixada. Desafixe antes de puxar a reserva."); return; }
      if (!allocEditPolicy(targetRow).editable) { toast.error("A carga de destino está travada (já em atribuição no ASPX)."); return; }
      if (!reservaRow) { toast.error("A lista atualizou durante o arrasto. Tente puxar a reserva de novo."); return; }
      if (routeKeyOf(targetRow) !== routeKeyOf(reservaRow)) {
        toast.error("A reserva é de outra rota. Puxe para uma carga da mesma rota (origem → destino).");
        return;
      }
      onAssignReserva({ reservaId, targetLh: targetRow.lh });
      return;
    }
    const list = rowsRef.current;
    const srcRow = list.find((r) => r.lh === src);
    if (!srcRow || targetRow.reserva) return;

    // ALVO = carga do SISTEMA → troca (swap) a alocação entre a carga da planilha
    // (origem do arrasto) e a carga do sistema. Mesma rota é obrigatório.
    if (targetRow.source === "sistema") {
      if (!targetRow.cargoId) { toast.error("Carga do sistema sem identificador."); return; }
      if (targetRow.pinned) { toast.error("A carga do sistema está fixada. Desafixe antes."); return; }
      if (!allocEditPolicy(targetRow).editable) { toast.error("A carga do sistema está travada (já em atribuição no ASPX)."); return; }
      if (routeKeyOf(targetRow) !== routeKeyOf(srcRow)) {
        toast.error("Só dá pra arrastar para uma carga do sistema da MESMA rota (origem → destino).");
        return;
      }
      // swap: o sistema recebe o motorista/veículo da planilha; a planilha fica com
      // quem estava no sistema (vazia, se o sistema estava sem motorista).
      onReassign([
        { lh: srcRow.lh, motorista: targetRow.motoristas || "", cavalo: targetRow.cavalo || "", carreta: targetRow.carreta || "" },
        { cargoId: targetRow.cargoId, motorista: srcRow.motoristas || "", cavalo: srcRow.cavalo || "", carreta: srcRow.carreta || "" },
      ]);
      return;
    }

    // ALVO = carga da PLANILHA → DESCER A FILA "a partir de onde soltei".
    // Solto em qualquer ponto de qualquer carga (acima OU abaixo) da mesma rota: o
    // motorista assume a carga de destino e, dali pra baixo, todos descem uma carga;
    // carga FIXADA/travada é PULADA (fica no lugar), a carga em branco absorve e o
    // que sobra vira reserva. O backend é AUTORITATIVO (lê pinned/status reais) —
    // carga fixada NUNCA bloqueia. Usa a fila COMPLETA da rota (respeita os filtros).
    const queue = getRouteQueue(routeKeyOf(srcRow));
    const srcQIdx = queue.findIndex((r) => r.lh === src);
    const tgtQIdx = queue.findIndex((r) => r.lh === targetRow.lh);
    if (srcQIdx < 0 || srcQIdx === tgtQIdx) return; // origem passada/fora, ou soltou nela mesma
    if (tgtQIdx < 0) {
      // Destino fora da fila acionável (carga já passada, afundada no fim).
      toast.error("Essa carga já passou — a descida vale só para as cargas atuais/futuras.");
      return;
    }

    // Origem precisa poder mover (não fixada/travada). Na prática nem tem alça.
    if (srcRow.pinned || !allocEditPolicy(srcRow).editable) {
      toast.error(srcRow.pinned
        ? "Carga fixada não desce na fila. Desafixe antes."
        : "Carga travada (já em operação) não desce na fila.");
      return;
    }
    // Detecção best-effort do que a cascata vai pular/tocar (só p/ o modal avisar);
    // a verdade é do backend. O ripple vai do DESTINO pra baixo (até a origem, se
    // subir; até o fim, se descer).
    const orderedLhs = queue.map((r) => r.lh);
    const rippleRange = tgtQIdx < srcQIdx ? queue.slice(tgtQIdx, srcQIdx + 1) : queue.slice(tgtQIdx);
    const pinnedInPath = rippleRange.filter((r) => r.pinned).map((r) => r.lh);
    const aspxInPath = rippleRange.filter((r) => !r.pinned && r.lh !== src && allocEditPolicy(r).aspxWarning).map((r) => r.lh);
    onDescendQueue({ sourceLh: src, targetLh: targetRow.lh, orderedLhs, pinnedInPath, aspxInPath });
  }, [onDescendQueue, getRouteQueue, onAssignReserva, onReassign]);

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
      {reassigning && (
        <div className="absolute right-3 top-2 z-10 inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-2.5 py-1 text-[0.62rem] font-semibold text-white shadow">
          <Loader2 className="h-3 w-3 animate-spin" /> Reordenando…
        </div>
      )}
      <div className="overflow-x-auto overscroll-x-contain pb-1">
        {/* table-fixed + w-full SEM min-width: a tabela SEMPRE cabe na viewport
            (sem rolagem lateral) e as colunas escalam com a janela. Conteúdo longo
            (LH, rota, agenda) trunca na linha — o LH completo aparece no modal. */}
        <table className="w-full table-fixed text-sm">
          <colgroup>
            {/* Status | LH | Cliente | Rota | Agenda | Motorista/Placa.
                DC-239: colunas ajustadas para tirar folga. A Rota (24%) sobrava
                muito espaço à direita (texto curto, alinhado à esquerda) → vão
                grande antes da Agenda; estreitamos Rota (24→18%). Agenda 14→8%
                (padding px-1) e Motorista 32→44% (padding px-2, nome mais à
                esquerda e com espaço). */}
            <col className="w-[12%]" />
            <col className="w-[10%]" />
            <col className="w-[8%]" />
            <col className="w-[18%]" />
            <col className="w-[8%]" />
            <col className="w-[44%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border/60 bg-primary/[0.028]">
              {(["Status", "LH", "Cliente", "Rota", "Agenda", "Motorista / Placa"] as const).map((label) => (
                <th key={label} className={`${label === "Agenda" ? "px-1" : label === "Motorista / Placa" ? "px-2" : "px-3"} py-2 text-left text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70`}>
                  {label === "Agenda" ? (
                    <button
                      type="button"
                      onClick={onToggleAgendaSort}
                      title={
                        agendaSortDir === "asc"
                          ? "Agenda: do primeiro ao último (mais antiga no topo). Clique para inverter."
                          : "Agenda: do último ao primeiro (mais nova no topo). Clique para inverter."
                      }
                      className="group inline-flex items-center gap-1 uppercase tracking-[0.16em] text-muted-foreground/70 transition-colors hover:text-foreground"
                    >
                      {label}
                      {agendaSortDir === "asc" ? (
                        <ArrowUp className="h-3 w-3 text-primary" />
                      ) : (
                        <ArrowDown className="h-3 w-3 text-primary" />
                      )}
                    </button>
                  ) : (
                    label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {rows.map((row, idx) => (
              <SheetMonitorRow
                key={row.rowKey ?? `${row.lh}-${idx}`}
                row={row}
                enriched={resolveEnriched(row)}
                cavaloChecklist={resolveChecklistLevel(row.cavalo)}
                carretaChecklist={resolveChecklistLevel(row.carreta)}
                selected={row.lh === selectedLh}
                editing={row.lh === editingLh}
                saving={row.lh === savingLh}
                pinning={row.lh === pinningLh}
                allocStatus={allocByLh[row.lh]?.alloc_status ?? null}
                isDragSource={row.lh === dragLh}
                dropIntent={dropTarget?.key === row.rowKey ? dropTarget.intent : null}
                onSelect={onSelect}
                onStartEdit={onStartEdit}
                onCancelEdit={onCancelEdit}
                onSaveInline={onSaveInline}
                onTogglePin={onTogglePin}
                onDragStartHandle={handleDragStartHandle}
                onDragEndHandle={handleDragEndHandle}
                onRowDragOver={handleRowDragOver}
                onRowDrop={handleRowDrop}
                assigningReserva={!!row.reserva && !!row.reservaId && row.reservaId === assigningReservaId}
                standbyCountByRoute={standbyCountByRoute}
                onPullStandby={onPullStandby}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to l from-background/80 to-transparent" />
    </div>
  );
}

// ─── Filtro por rota ────────────────────────────────────────────────────────────

// Chave de rota = "ORIGEM → DESTINO" (usada no filtro de rota). Sem rota → "—".
function routeKeyOf(row: SheetMonitorRowType) {
  const o = (row.origem || "").trim();
  const d = (row.destino || "").trim();
  if (!o && !d) return "—";
  return `${o || "—"} → ${d || "—"}`;
}

// ── Ordem da fila do Monitor (compartilhada entre a exibição e a cascata) ───────
// "Agora" no fuso de São Paulo (BRT), no formato "YYYY-MM-DD HH:MM:SS" — cargas
// data/horario são horário de parede do Brasil; comparamos sem conversão.
function monitorNowKeySaoPaulo(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
  return `${p("year")}-${p("month")}-${p("day")} ${p("hour")}:${p("minute")}:${p("second")}`;
}
// Normaliza horário p/ "HH:MM:SS" (planilha manda HH:MM:SS, sistema HH:MM).
function monitorTimeKey(h: string | null | undefined): string {
  const [hh = "00", mm = "00", ss = "00"] = String(h ?? "").split(":");
  return `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:${ss.padStart(2, "0")}`;
}
// Chave de data+horário da carga p/ decidir se é PASSADA (afundada) vs acionável —
// usada pela fila da cascata "descer a fila" (routeQueue) para não remanejar cargas
// já carregadas. A ORDEM de exibição em si é o sort de `filteredRows` (agendaSortDir).
function monitorDtKey(r: SheetMonitorRowType): string {
  return r.data ? `${String(r.data).slice(0, 10)} ${monitorTimeKey(r.horario)}` : "";
}


// ─── Modal helpers ────────────────────────────────────────────────────────────

function ModalSection({ title, children, collapsible = false, defaultOpen = true, storageKey }: {
  title: string;
  children: React.ReactNode;
  // DC-237: quando collapsible, o título vira um botão minimizar/expandir. A
  // preferência persiste em localStorage (storageKey) — vale para todas as
  // cargas, igual à ordenação da agenda.
  collapsible?: boolean;
  defaultOpen?: boolean;
  storageKey?: string;
}) {
  const [open, setOpen] = useState(() => {
    if (!collapsible) return true;
    if (storageKey && typeof window !== "undefined") {
      const v = window.localStorage.getItem(storageKey);
      if (v === "1") return true;
      if (v === "0") return false;
    }
    return defaultOpen;
  });
  const toggle = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      if (storageKey) {
        try { window.localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* localStorage indisponível */ }
      }
      return next;
    });
  }, [storageKey]);

  if (!collapsible) {
    return (
      <div className="border-b border-border/50 px-6 py-4 last:border-0">
        <h3 className="mb-3 text-[0.62rem] font-bold uppercase tracking-[0.18em] text-muted-foreground/60">{title}</h3>
        {children}
      </div>
    );
  }

  return (
    <div className="border-b border-border/50 px-6 py-4 last:border-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title={open ? "Minimizar" : "Expandir"}
        className={cn(
          "flex w-full items-center justify-between gap-2 text-left transition-colors hover:text-foreground",
          open && "mb-3",
        )}
      >
        <h3 className="text-[0.62rem] font-bold uppercase tracking-[0.18em] text-muted-foreground/60">{title}</h3>
        {open
          ? <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />}
      </button>
      {open && children}
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

// Semáforo do checklist do veículo (verde/amarelo/vermelho/cinza).
const CHECKLIST_LEVEL_STYLE: Record<VehicleChecklistLevel, { dot: string; badge: string }> = {
  ok: { dot: "bg-emerald-500", badge: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600" },
  warning: { dot: "bg-amber-500", badge: "border-amber-500/40 bg-amber-500/10 text-amber-600" },
  overdue: { dot: "bg-red-500", badge: "border-red-500/40 bg-red-500/10 text-red-600" },
  unknown: { dot: "bg-muted-foreground/40", badge: "border-border bg-muted/40 text-muted-foreground" },
};

// Resumo em linguagem do operador do nível de um veículo/item.
function checklistSummary(level: VehicleChecklistLevel, daysToDue: number | null): string {
  if (level === "ok") return daysToDue != null ? `Em dia · vence em ${daysToDue} dia(s)` : "Em dia";
  if (level === "warning") return daysToDue != null ? `Vence em ${daysToDue} dia(s)` : "Próximo a vencer";
  if (level === "overdue") {
    if (daysToDue != null && daysToDue < 0) return `Vencido há ${Math.abs(daysToDue)} dia(s)`;
    return "Reprovado / problema";
  }
  return "Sem dados de checklist";
}

function ChecklistDot({ level }: { level: VehicleChecklistLevel }) {
  return <span className={`mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${CHECKLIST_LEVEL_STYLE[level].dot}`} />;
}

// Card visual do checklist de uma placa (cavalo/carreta): semáforo + itens.
function VehicleChecklistCard({
  placa,
  papel,
  entry,
  loading,
}: {
  placa: string;
  papel: "cavalo" | "carreta";
  entry: VehicleChecklistEntry | undefined;
  loading: boolean;
}) {
  const level: VehicleChecklistLevel = entry?.level ?? "unknown";
  const style = CHECKLIST_LEVEL_STYLE[level];
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} />
          <span className="font-mono text-xs font-bold text-foreground">{placa}</span>
          <span className="text-[0.6rem] text-muted-foreground/50">{papel}</span>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[0.62rem] font-semibold ${style.badge}`}>
          {loading ? "…" : checklistSummary(level, entry?.daysToDue ?? null)}
        </span>
      </div>
      {loading ? null : !entry || !entry.found ? (
        <p className="text-[0.7rem] italic text-muted-foreground/50">Sem checklist para esta placa na planilha.</p>
      ) : (
        <ul className="space-y-1">
          {entry.items.map((item, index) => (
            <li key={index} className="flex items-start gap-2 text-[0.7rem]">
              <ChecklistDot level={item.level} />
              <div className="min-w-0 leading-snug">
                <span className="font-medium text-foreground">{item.statusRaw || "—"}</span>
                {item.tipoVeiculo ? <span className="text-muted-foreground"> · {item.tipoVeiculo}</span> : null}
                <span className="block text-muted-foreground/70">
                  {checklistSummary(item.level, item.daysToDue)}
                  {item.dataInclusao ? ` · consultado ${item.dataInclusao.split(" ")[0]}` : ""}
                  {item.proprietario ? ` · ${item.proprietario}` : ""}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RowDetailModal({
  row,
  enriched,
  alloc,
  open,
  onClose,
}: {
  row: SheetMonitorRowType | null;
  enriched: SheetMonitorEnrichedRow | undefined;
  alloc: SheetMonitorAllocation | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [allocForm, setAllocForm] = useState({ motorista: "", cavalo: "", carreta: "", status: "", tipo: "", vinculo: "" });
  const [confirmChange, setConfirmChange] = useState(false);

  // Pré-preenche com a alocação EFETIVA: override do operador (alloc_*) ?? planilha.
  useEffect(() => {
    if (!row) return;
    setAllocForm({
      // Override vazio ("" OU null) → cai pra planilha (mesma regra da linha): o
      // modal pré-preenche com o EFETIVO exibido, não com o override vazio.
      motorista: alloc?.alloc_motorista || row.motoristas || "",
      cavalo: alloc?.alloc_cavalo || row.cavalo || "",
      carreta: alloc?.alloc_carreta || row.carreta || "",
      status: alloc?.alloc_status || row.status || "",
      tipo: alloc?.alloc_tipo ?? (row.tipo && row.tipo !== "SISTEMA" ? row.tipo : "") ?? "",
      vinculo: alloc?.alloc_vinculo ?? row.vinculo ?? "",
    });
  }, [row, alloc, open]);

  const saveAllocation = useMutation({
    mutationFn: updateMonitorAllocation,
    onSuccess: () => {
      toast.success("Alocação salva no sistema.");
      void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] });
      // O selo Angellira/ASPX é re-enriquecido no backend em background (motorista
      // efetivo) — refetch atrasado p/ ele aparecer sem ficar "não consultado".
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] }), 2000);
      onClose();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar a alocação.");
    },
  });

  const pinMutation = useMutation({
    mutationFn: setMonitorAllocationPin,
    onSuccess: (data) => {
      toast.success(data.pinned ? "Carga fixada — motorista/veículo travados." : "Carga desafixada.");
      void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Não foi possível fixar a carga.");
    },
  });

  // DC-230: consulta Angellira/ASPX só DESTE item (a linha selecionada), sem
  // varrer a planilha inteira. Escopo por cargoId (carga do sistema) ou lh
  // (carga da planilha). Ao concluir, invalida o Monitor p/ atualizar os selos.
  const consultItem = useMutation({
    mutationFn: () => {
      if (!row) return Promise.resolve({ enriched: 0, remaining: 0 });
      // Envia o motorista/veículo EFETIVO exibido (cobre cargas fora do snapshot,
      // ex.: Nestlé/importadas, cujo lh não é achado pelo resolvedor por snapshot).
      return enrichSheetMonitorRow(
        row.source === "sistema" && row.cargoId
          ? { cargoId: row.cargoId }
          : { lh: row.lh, motorista: row.motoristas ?? "", cavalo: row.cavalo ?? "", carreta: row.carreta ?? "" },
      );
    },
    onSuccess: () => {
      toast.success("Consulta deste item atualizada.");
      // Selos Angellira/ASPX são eventualmente-consistentes (cache TTL curto +
      // single-flight no backend). Como o modal fica ABERTO, invalida agora e de
      // novo com atraso p/ o selo novo aparecer no lugar de "Consulta pendente"
      // (mesmo padrão da edição de alocação, que fecha o modal e não sofria disso).
      void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] });
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] }), 2000);
      // DC-230: "Consultar item" também atualiza o checklist do veículo (semáforo
      // GRIFFI) — refetch do card do modal (["admin","vehicle-checklist",placas])
      // e dos ícones de semáforo da linha (["admin","vehicle-checklist-levels"]).
      void queryClient.invalidateQueries({ queryKey: ["admin", "vehicle-checklist"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "vehicle-checklist-levels"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Não foi possível consultar este item.");
    },
  });

  // Histórico da carga (eventos: fila, reserva/aprovação, write-back na planilha)
  // — "as mudanças feitas em cada etapa". Por LH; só busca com o modal aberto.
  const historyEvents = useQuery({
    queryKey: ["admin", "cargo-history", row?.lh ?? ""],
    queryFn: () => fetchCargoHistory(row!.lh),
    enabled: open && !!row?.lh,
    staleTime: 30_000,
  });

  // Checklist do veículo (semáforo) por placa EFETIVA (override do operador ?? planilha).
  const checklistCavalo = (alloc?.alloc_cavalo || row?.cavalo || "").trim();
  const checklistCarreta = (alloc?.alloc_carreta || row?.carreta || "").trim();
  const checklistPlacas = [checklistCavalo, checklistCarreta].filter(Boolean);
  const vehicleChecklist = useQuery({
    queryKey: ["admin", "vehicle-checklist", checklistCavalo, checklistCarreta],
    queryFn: () => fetchVehicleChecklist(checklistPlacas),
    enabled: open && checklistPlacas.length > 0,
    staleTime: 30_000,
  });

  if (!row) return null;

  // Trava motorista/veículo conforme o status (mesma regra da tabela) E pelo
  // "fixo". O status operacional continua editável (o bloqueio é só de m/v).
  const { editable, aspxWarning } = allocEditPolicy(row);
  const pinned = Boolean(alloc?.alloc_pinned ?? row.pinned);
  const allocEditable = editable && !pinned;

  // Trocou o motorista/veículo em relação ao EFETIVO (override ?? planilha)?
  // (mudança só de status/tipo não pede motivo — e não regrava motorista/veículo.)
  const mvChanged =
    allocForm.motorista !== (alloc?.alloc_motorista || row.motoristas || "") ||
    allocForm.cavalo !== (alloc?.alloc_cavalo || row.cavalo || "") ||
    allocForm.carreta !== (alloc?.alloc_carreta || row.carreta || "");

  const doSave = (descricao = "") => {
    // Motorista EFETIVO (override do operador OU planilha) — usado no guard abaixo.
    // Considera o motorista da planilha também: não dá pra deixar "Disponível" uma
    // carga que a planilha ainda escala (o portal a ofereceria = duplo-booking).
    const savedMotorista = ((allocEditable ? allocForm.motorista : alloc?.alloc_motorista) || row.motoristas || "").trim();
    // "Disponível" reabre a carga pro painel — e só faz sentido SEM motorista. Com
    // motorista, BLOQUEIA: o operador precisa remover o motorista primeiro (regra do
    // usuário: nunca remover o motorista automaticamente, apenas impedir "Disponível").
    if (/^dispon[ií]vel$/i.test(allocForm.status.trim()) && savedMotorista) {
      toast.error("Esta carga tem motorista. Remova o motorista antes de deixá-la Disponível.");
      return;
    }
    // Só grava `status` quando o operador REALMENTE mudou. O campo vem
    // pré-preenchido com o status EFETIVO (alloc_status ?? planilha); reenviá-lo
    // sem mudança persistia o status da planilha em alloc_status e o "congelava"
    // — depois a planilha avançava (ex.: CTE ENVIADO) e o override velho mascarava
    // o valor real (bug do LT0Q7F02AY781). Omitir → o backend preserva o
    // alloc_status atual (null = segue refletindo a planilha).
    const initialStatus = alloc?.alloc_status ?? row.status ?? "";
    const statusChanged = allocForm.status !== initialStatus;
    saveAllocation.mutate({
      lh: row.lh,
      // Status só vai quando o operador REALMENTE mudou (gating do #186 — evita
      // "congelar" o status da planilha em alloc_status). Motorista/veículo seguem
      // a mesma ideia logo abaixo (só quando editável E trocado).
      ...(statusChanged ? { status: allocForm.status } : {}),
      tipo: allocForm.tipo, // tipo é livre (não trava por pinned/status)
      // Vínculo (col H): sempre enviado (prefilled com o valor efetivo) — o
      // backend espelha na planilha; se não mudou, reescreve o mesmo valor.
      vinculo: allocForm.vinculo,
      // Motorista/veículo SÓ vão no payload quando a linha é editável E o operador
      // REALMENTE trocou (mvChanged). Editar só o status NÃO reenvia o motorista →
      // o backend preserva o override atual (has()=false). Antes reenviávamos o
      // valor pré-preenchido (efetivo = planilha), o que "congelava" o motorista da
      // planilha como override e voltaria a escondê-lo se a Shopee re-escalasse.
      ...(allocEditable && mvChanged
        ? { motorista: allocForm.motorista, cavalo: allocForm.cavalo, carreta: allocForm.carreta }
        : {}),
      // Motivo da troca — só quando o motorista/veículo mudou (o modal exige).
      ...(descricao ? { descricao } : {}),
    });
  };
  const requestSave = () => {
    // Trocou m/v → exige o modal "Confirmar troca" com a descrição (motivo).
    if (allocEditable && mvChanged) setConfirmChange(true);
    else doSave();
  };

  return (
    <>
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
              {/* DC-230: consultar Angellira/ASPX só desta carga (sem varrer a planilha). */}
              <button
                type="button"
                onClick={() => consultItem.mutate()}
                disabled={consultItem.isPending}
                title="Consultar Angellira/ASPX apenas desta carga (não varre a planilha inteira)"
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border/80 px-2.5 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {consultItem.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {consultItem.isPending ? "Consultando…" : "Consultar item"}
              </button>
            </div>
            <StatusBadge status={row.status} />
          </DialogHeader>

          {/* Scrollable body */}
          <div className="min-h-0 flex-1 overflow-y-auto">

            {/* Motivo da última troca de motorista/veículo (descrição do operador). */}
            {alloc?.alloc_descricao && (
              <div className="mx-4 mt-3 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/10">
                <p className="text-[0.6rem] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                  Motivo da última troca de motorista/veículo
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm leading-snug text-foreground">{alloc.alloc_descricao}</p>
              </div>
            )}

            {/* ── Histórico (reserva, aprovação, write-back na planilha) ── */}
            {/* DC-237: minimizável (a timeline fica longa e empurra as seções de
                ação); começa aberto e a preferência persiste por operador. */}
            <ModalSection title="Histórico" collapsible storageKey="lamonica-monitor-hist-open">
              {historyEvents.isLoading ? (
                <p className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando…
                </p>
              ) : (historyEvents.data?.items?.length ?? 0) === 0 ? (
                <p className="py-1 text-xs text-muted-foreground">Sem histórico registrado para esta carga.</p>
              ) : (
                <ol className="space-y-2.5">
                  {(historyEvents.data?.items ?? []).map((ev: CargoHistoryEvent, i: number) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <span
                        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${cargoHistoryDotClass(ev.tipo)}`}
                      />
                      <div className="min-w-0 leading-snug">
                        <span className="font-semibold text-foreground">{ev.titulo}</span>
                        {ev.detalhe ? (
                          <span className="block text-foreground/80">{ev.detalhe}</span>
                        ) : null}
                        <span className="block text-[0.65rem] text-muted-foreground/70">
                          {ev.por ? `por ${ev.por}` : ""}
                          {ev.por && ev.quando ? " · " : ""}
                          {ev.quando ? (formatStandby(ev.quando) ?? "") : ""}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </ModalSection>

            {/* ── Alocação (editável no sistema) ── */}
            <ModalSection title="Alocação · editar no sistema">
              <div className="space-y-2">
                {/* Fixar/desafixar — trava o motorista/veículo nesta carga. */}
                <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5">
                  <span className="text-[0.62rem] font-medium leading-tight text-muted-foreground">
                    {pinned
                      ? "Fixada — motorista/veículo travados (não muda por arrasto, edição ou cascata)."
                      : "Fixe para travar o motorista/veículo nesta carga."}
                  </span>
                  <button
                    type="button"
                    onClick={() => pinMutation.mutate({ lh: row.lh, pinned: !pinned })}
                    disabled={pinMutation.isPending}
                    className={cn(
                      "inline-flex shrink-0 items-center gap-1 rounded-lg border px-2.5 py-1 text-[0.7rem] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      pinned
                        ? "border-amber-400 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
                        : "border-border/80 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {pinMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                    {pinned ? "Desafixar" : "Fixar"}
                  </button>
                </div>
                {!allocEditable && (
                  <p className="flex items-start gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[0.62rem] font-medium leading-tight text-muted-foreground">
                    <Lock className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      {pinned
                        ? "Carga fixada: motorista e veículo travados. Desafixe para editar. Só o status operacional pode ser alterado."
                        : "Motorista e veículo travados neste status (já em atribuição no ASPX). Só o status operacional pode ser alterado."}
                    </span>
                  </p>
                )}
                <div>
                  <label className="mb-1 block text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground/60">Motorista</label>
                  <Input
                    list={DRIVER_DATALIST_ID}
                    value={allocForm.motorista}
                    onChange={(e) => setAllocForm((f) => ({ ...f, motorista: e.target.value }))}
                    placeholder="Nome do motorista alocado"
                    disabled={!allocEditable}
                    className="h-8 text-xs disabled:cursor-not-allowed disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground/60">Tipo (ForeCast, Spot…)</label>
                  <Input
                    list={TIPO_DATALIST_ID}
                    value={allocForm.tipo}
                    onChange={(e) => setAllocForm((f) => ({ ...f, tipo: e.target.value }))}
                    placeholder="opcional"
                    className="h-8 text-xs"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="mb-1 block text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground/60">Cavalo</label>
                    <Input
                      list={CAVALO_DATALIST_ID}
                      value={allocForm.cavalo}
                      onChange={(e) => setAllocForm((f) => ({ ...f, cavalo: e.target.value }))}
                      placeholder="Placa cavalo"
                      disabled={!allocEditable}
                      className="h-8 text-xs font-mono disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground/60">Carreta</label>
                    <Input
                      list={CARRETA_DATALIST_ID}
                      value={allocForm.carreta}
                      onChange={(e) => setAllocForm((f) => ({ ...f, carreta: e.target.value }))}
                      placeholder="Placa carreta"
                      disabled={!allocEditable}
                      className="h-8 text-xs font-mono disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground/60">Status operacional</label>
                  <select
                    value={allocForm.status}
                    onChange={(e) => setAllocForm((f) => ({ ...f, status: e.target.value }))}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">— sem status (usa a planilha) —</option>
                    {/* Preserva um valor já salvo que não esteja na lista canônica (ex.: legado). */}
                    {allocForm.status && !OPERATIONAL_STATUS_OPTIONS.includes(allocForm.status as (typeof OPERATIONAL_STATUS_OPTIONS)[number]) && (
                      <option value={allocForm.status}>{allocForm.status}</option>
                    )}
                    {OPERATIONAL_STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>{s === "Disponível" ? "Disponível (reabrir p/ motorista)" : s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[0.6rem] font-semibold uppercase tracking-wide text-muted-foreground/60">Vínculo</label>
                  <Input
                    list="monitor-vinculo-datalist"
                    value={allocForm.vinculo}
                    onChange={(e) => setAllocForm((f) => ({ ...f, vinculo: e.target.value }))}
                    placeholder="Ex.: AGREGADO DEDICADO, TERCEIRO, PME, FROTA…"
                    className="h-8 text-xs"
                  />
                  <datalist id="monitor-vinculo-datalist">
                    {["AGREGADO DEDICADO", "TERCEIRO DEDICADO", "TERCEIRO", "PME", "FROTA", "PX"].map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                </div>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="text-[0.58rem] leading-tight text-muted-foreground/60">
                    {alloc?.alloc_updated_at
                      ? "Editado no sistema — sobrepõe a planilha."
                      : "Campo vazio usa o valor da planilha. Salvar grava no sistema."}
                  </span>
                  <button
                    type="button"
                    onClick={requestSave}
                    disabled={saveAllocation.isPending}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {saveAllocation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                    Salvar
                  </button>
                </div>
              </div>
            </ModalSection>

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
                      {/* CPF confirmado no Angellira — sempre disponível p/ re-consultar,
                          mesmo quando o motorista não está no ASPX. */}
                      {(() => {
                        const d = enriched.angellira_driver_details as { cpf?: string | null } | null;
                        const angCpf = d?.cpf ?? null;
                        if (enriched.aspx_cpf || !angCpf) return null;
                        return <ModalRow label="CPF (Angellira)" value={<span className="font-mono">{angCpf}</span>} />;
                      })()}
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

            {/* ── Checklist do veículo (semáforo verde/amarelo/vermelho) ── */}
            {(checklistCavalo || checklistCarreta) && (
              <ModalSection title="Checklist do veículo">
                <div className="space-y-3">
                  {checklistCavalo && (
                    <VehicleChecklistCard
                      placa={checklistCavalo}
                      papel="cavalo"
                      entry={vehicleChecklist.data?.byPlaca?.[checklistCavalo]}
                      loading={vehicleChecklist.isLoading}
                    />
                  )}
                  {checklistCarreta && (
                    <VehicleChecklistCard
                      placa={checklistCarreta}
                      papel="carreta"
                      entry={vehicleChecklist.data?.byPlaca?.[checklistCarreta]}
                      loading={vehicleChecklist.isLoading}
                    />
                  )}
                </div>
              </ModalSection>
            )}

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

    <ChangeReasonDialog
      open={confirmChange}
      aspxWarning={allocEditable && aspxWarning}
      onConfirm={(reason) => { setConfirmChange(false); doSave(reason); }}
      onCancel={() => setConfirmChange(false)}
    />
    </>
  );
}

// Link de WhatsApp p/ um telefone brasileiro (só dígitos; prefixo 55). null se vazio.
function whatsappHref(telefone: string | null | undefined): string | null {
  const digits = (telefone || "").replace(/\D/g, "");
  return digits ? `https://wa.me/55${digits}` : null;
}

// Renderiza telefone com link de WhatsApp, ou "sem telefone" quando ausente.
function PhoneLink({ telefone }: { telefone: string | null | undefined }) {
  const href = whatsappHref(telefone);
  if (!href) return <span className="text-[0.7rem] text-muted-foreground/60">sem telefone</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-[0.7rem] font-medium text-emerald-600 hover:underline dark:text-emerald-400"
    >
      <MessageCircle className="h-3 w-3" />
      {telefone}
    </a>
  );
}

// Painel de reserva — gerencia (CRUD) os motoristas em reserva desta rota e sugere
// quem já rodou a rota (histórico). Alternativa ao arrastar: puxa a reserva pra
// carga mesmo com o standby noutra página. Faz query/mutations internas.
function ReservaPanelModal({ open, carga, reservas, onPull, onClose }: {
  open: boolean;
  carga: SheetMonitorRowType | null;
  reservas: SheetMonitorRowType[];
  onPull: (reservaId: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  // Congela o último conteúdo durante a animação de saída (mesma razão do modal
  // anterior: conteúdo vazio no render de fechamento trava o Radix Presence).
  const lastRef = useRef<{ carga: SheetMonitorRowType | null; reservas: SheetMonitorRowType[] }>({ carga: null, reservas: [] });
  if (open && carga) lastRef.current = { carga, reservas };
  const viewCarga = open ? carga : lastRef.current.carga;
  const viewReservas = open ? reservas : lastRef.current.reservas;
  const origem = viewCarga?.origem ?? "";
  const destino = viewCarga?.destino ?? "";

  // Formulário de adição (Seção 1) + edição inline por reservaId.
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ motorista: "", cavalo: "", carreta: "" });
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ motorista: "", cavalo: "", carreta: "" });
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Reset dos formulários ao (re)abrir o modal.
  useEffect(() => {
    if (open) { setAddOpen(false); setAddForm({ motorista: "", cavalo: "", carreta: "" }); setEditId(null); setConfirmDeleteId(null); }
  }, [open]);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] });
  }, [queryClient]);

  const historyQuery = useQuery({
    queryKey: ["admin", "route-driver-history", origem, destino],
    queryFn: () => fetchRouteDriverHistory({ origem, destino }),
    enabled: open && Boolean(origem) && Boolean(destino),
    staleTime: 30_000,
  });

  const createMut = useMutation({
    mutationFn: createReserva,
    onSuccess: () => {
      toast.success("Adicionado à reserva.");
      setAddOpen(false);
      setAddForm({ motorista: "", cavalo: "", carreta: "" });
      invalidate();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Não foi possível adicionar à reserva."),
  });
  const updateMut = useMutation({
    mutationFn: updateReserva,
    onSuccess: () => { toast.success("Reserva atualizada."); setEditId(null); invalidate(); },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Não foi possível atualizar a reserva."),
  });
  const deleteMut = useMutation({
    mutationFn: deleteReserva,
    onSuccess: () => { toast.success("Reserva removida."); setConfirmDeleteId(null); invalidate(); },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Não foi possível remover a reserva."),
  });

  const submitAdd = () => {
    const motorista = addForm.motorista.trim();
    if (!motorista || !origem || !destino) return;
    createMut.mutate({ motorista, cavalo: addForm.cavalo.trim() || undefined, carreta: addForm.carreta.trim() || undefined, origem, destino });
  };
  const startEdit = (r: SheetMonitorRowType) => {
    setEditId(r.reservaId ?? null);
    setEditForm({ motorista: r.motoristas ?? "", cavalo: r.cavalo ?? "", carreta: r.carreta ?? "" });
  };
  const submitEdit = () => {
    if (!editId) return;
    updateMut.mutate({ reservaId: editId, motorista: editForm.motorista.trim(), cavalo: editForm.cavalo.trim(), carreta: editForm.carreta.trim() });
  };
  const addFromHistory = (h: RouteDriverHistoryEntry) => {
    if (!origem || !destino) return;
    createMut.mutate({ motorista: h.motorista, cavalo: h.cavalo || undefined, carreta: h.carreta || undefined, origem, destino });
  };

  // Dedupe: nomes já em reserva (Seção 1) não precisam reaparecer na Seção 2.
  const reservaNames = useMemo(
    () => new Set(viewReservas.map((r) => (r.motoristas ?? "").trim().toLowerCase()).filter(Boolean)),
    [viewReservas],
  );
  const historyEntries = (historyQuery.data?.drivers ?? []).filter(
    (h) => !reservaNames.has((h.motorista ?? "").trim().toLowerCase()),
  );

  const inputClass = "w-full rounded-lg border border-border/70 bg-white/92 px-2.5 py-1.5 text-xs outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/10 dark:bg-muted/40";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-4 w-4 text-amber-500" /> Puxar reserva para a carga
          </DialogTitle>
          <DialogDescription className="pt-1 text-sm text-muted-foreground">
            {viewCarga ? (
              <>Carga <span className="font-mono font-semibold text-foreground">{viewCarga.lh}</span> — {routeKeyOf(viewCarga)}</>
            ) : "—"}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          {/* ── Seção 1 — Em reserva nesta rota ── */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground/80">Em reserva nesta rota</h3>
              <button
                type="button"
                onClick={() => setAddOpen((v) => !v)}
                className="inline-flex items-center gap-1 rounded-lg border border-amber-400/50 bg-amber-50/60 px-2 py-1 text-[0.7rem] font-semibold text-amber-700 hover:bg-amber-100/70 dark:bg-amber-500/10 dark:text-amber-300"
              >
                <Plus className="h-3 w-3" /> Adicionar reserva
              </button>
            </div>

            {addOpen && (
              <div className="space-y-2 rounded-lg border border-amber-400/40 bg-amber-50/40 p-2.5 dark:bg-amber-500/[0.06]">
                <input className={inputClass} placeholder="Motorista *" value={addForm.motorista}
                  onChange={(e) => setAddForm((f) => ({ ...f, motorista: e.target.value }))} />
                <div className="flex gap-2">
                  <input className={inputClass} placeholder="Cavalo" value={addForm.cavalo}
                    onChange={(e) => setAddForm((f) => ({ ...f, cavalo: e.target.value }))} />
                  <input className={inputClass} placeholder="Carreta" value={addForm.carreta}
                    onChange={(e) => setAddForm((f) => ({ ...f, carreta: e.target.value }))} />
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setAddOpen(false)}
                    className="rounded-lg px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground">Cancelar</button>
                  <button type="button" disabled={!addForm.motorista.trim() || createMut.isPending} onClick={submitAdd}
                    className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-600 disabled:opacity-50">
                    {createMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />} Adicionar
                  </button>
                </div>
              </div>
            )}

            {viewReservas.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Nenhum motorista em reserva nesta rota.</p>
            ) : (
              <div className="space-y-1.5">
                {viewReservas.map((s) => {
                  const rid = s.reservaId ?? null;
                  const isEditing = editId != null && editId === rid;
                  const isConfirming = confirmDeleteId != null && confirmDeleteId === rid;
                  return (
                    <div key={rid ?? s.rowKey} className="rounded-lg border border-border/60 px-3 py-2">
                      {isEditing ? (
                        <div className="space-y-2">
                          <input className={inputClass} placeholder="Motorista *" value={editForm.motorista}
                            onChange={(e) => setEditForm((f) => ({ ...f, motorista: e.target.value }))} />
                          <div className="flex gap-2">
                            <input className={inputClass} placeholder="Cavalo" value={editForm.cavalo}
                              onChange={(e) => setEditForm((f) => ({ ...f, cavalo: e.target.value }))} />
                            <input className={inputClass} placeholder="Carreta" value={editForm.carreta}
                              onChange={(e) => setEditForm((f) => ({ ...f, carreta: e.target.value }))} />
                          </div>
                          <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => setEditId(null)}
                              className="rounded-lg px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground">Cancelar</button>
                            <button type="button" disabled={!editForm.motorista.trim() || updateMut.isPending} onClick={submitEdit}
                              className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                              {updateMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Salvar
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 space-y-0.5">
                            <p className="truncate text-sm font-semibold text-foreground">{s.motoristas || "—"}</p>
                            <p className="truncate font-mono text-[0.7rem] text-muted-foreground">
                              {s.cavalo || "—"}{s.carreta ? ` · ${s.carreta}` : ""}
                            </p>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <PhoneLink telefone={s.telefone} />
                              {s.standbyAt && (
                                <span className="text-[0.7rem] text-amber-700 dark:text-amber-300">em reserva desde {formatStandby(s.standbyAt)}</span>
                              )}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button type="button" disabled={!rid} onClick={() => { if (rid) { onPull(rid); onClose(); } }}
                              className="inline-flex items-center gap-1 rounded-lg border border-amber-400/60 bg-amber-50/70 px-2 py-1 text-[0.7rem] font-semibold text-amber-700 hover:bg-amber-100/80 disabled:opacity-50 dark:bg-amber-500/10 dark:text-amber-300">
                              <UserPlus className="h-3 w-3" /> Puxar p/ carga
                            </button>
                            <button type="button" disabled={!rid} onClick={() => startEdit(s)} title="Editar"
                              className="rounded-lg border border-border/60 p-1 text-muted-foreground hover:text-foreground disabled:opacity-50">
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button type="button" disabled={!rid} onClick={() => setConfirmDeleteId(rid)} title="Excluir"
                              className="rounded-lg border border-border/60 p-1 text-muted-foreground hover:text-red-600 disabled:opacity-50">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      )}
                      {isConfirming && !isEditing && (
                        <div className="mt-2 flex items-center justify-end gap-2 border-t border-border/50 pt-2">
                          <span className="mr-auto text-[0.7rem] text-muted-foreground">Excluir esta reserva?</span>
                          <button type="button" onClick={() => setConfirmDeleteId(null)}
                            className="rounded-lg px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground">Cancelar</button>
                          <button type="button" disabled={deleteMut.isPending} onClick={() => { if (rid) deleteMut.mutate({ reservaId: rid }); }}
                            className="inline-flex items-center gap-1 rounded-lg bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50">
                            {deleteMut.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} Excluir
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ── Seção 2 — Já rodaram esta rota ── */}
          <section className="space-y-2">
            <h3 className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground/80">Já rodaram esta rota</h3>
            {historyQuery.isLoading ? (
              <p className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Carregando histórico…
              </p>
            ) : historyEntries.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Nenhum motorista no histórico desta rota.</p>
            ) : (
              <div className="space-y-1.5">
                {historyEntries.map((h, i) => (
                  <div key={`${h.motorista}-${i}`} className="flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-2">
                    <div className="min-w-0 space-y-0.5">
                      <p className="truncate text-sm font-medium text-foreground">{h.motorista || "—"}</p>
                      <p className="truncate font-mono text-[0.7rem] text-muted-foreground">
                        {h.cavalo || "—"}{h.carreta ? ` · ${h.carreta}` : ""}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <PhoneLink telefone={h.telefone} />
                        <span className="text-[0.7rem] text-muted-foreground">última {h.ultimaAgendaLabel || h.ultimaData || "—"}</span>
                        <span className="text-[0.7rem] text-muted-foreground/70">{h.runCount} corrida(s)</span>
                      </div>
                    </div>
                    <button type="button" disabled={createMut.isPending} onClick={() => addFromHistory(h)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-amber-400/60 bg-amber-50/70 px-2 py-1 text-[0.7rem] font-semibold text-amber-700 hover:bg-amber-100/80 disabled:opacity-50 dark:bg-amber-500/10 dark:text-amber-300">
                      <Plus className="h-3 w-3" /> Adicionar à reserva
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SheetMonitor() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  // Filtros multi-seleção (vazio = "todos"; semântica OR entre os selecionados).
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [tipoFilter, setTipoFilter] = useState<string[]>([]);
  const [vinculoFilter, setVinculoFilter] = useState<string[]>([]);
  const [assignmentFilter, setAssignmentFilter] = useState<string[]>([]);
  const [routeFilter, setRouteFilter] = useState<string[]>([]);
  const [editFilter, setEditFilter] = useState<string[]>([]);
  const [clienteFilter, setClienteFilter] = useState<string[]>([]);
  // Filtro de carregamento começa em HOJE (dia único: 00:00–23:59) ao abrir a
  // tela — mostra só a agenda do dia, não as datas futuras. É só o valor
  // inicial; o operador pode limpar ou ampliar o intervalo (ex.: subir o "até").
  const [dateFromFilter, setDateFromFilter] = useState(() => `${todayLocalDate()}T00:00`);
  const [dateToFilter, setDateToFilter] = useState(() => `${todayLocalDate()}T23:59`);
  const [descargaFromFilter, setDescargaFromFilter] = useState("");
  const [descargaToFilter, setDescargaToFilter] = useState("");
  const [page, setPage] = useState(0);
  // Ordenação da agenda (Coleta) estilo planilha, escolhida pelo operador:
  // "asc" = mais ANTIGA primeiro (do primeiro ao último) — PADRÃO; "desc" = mais
  // NOVA primeiro. A preferência salva sobrepõe o padrão.
  const [agendaSortDir, setAgendaSortDir] = useState<"asc" | "desc">(() => {
    if (typeof window === "undefined") return "asc";
    return window.localStorage.getItem("lamonica-monitor-agenda-sort") === "desc" ? "desc" : "asc";
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("lamonica-monitor-agenda-sort", agendaSortDir);
    } catch {
      /* localStorage indisponível — segue só em memória */
    }
  }, [agendaSortDir]);
  const toggleAgendaSort = useCallback(() => {
    setPage(0);
    setAgendaSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
  }, []);
  const [selectedRow, setSelectedRow] = useState<SheetMonitorRowType | null>(null);
  const [editingLh, setEditingLh] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(search);

  const { data: monitorData, error: queryError, isFetching, isLoading } = useQuery({
    queryKey: [...SHEET_MONITOR_QUERY_KEY],
    queryFn: fetchSheetMonitor,
    ...SHEET_MONITOR_QUERY_OPTIONS,
    // DC-238: repuxa o Status sozinho (sem reload). Pausa enquanto o operador
    // edita uma linha inline pra não descartar o rascunho, e não faz polling com
    // a aba em segundo plano pra economizar egress.
    refetchInterval: editingLh ? false : MONITOR_STATUS_POLL_MS,
    refetchIntervalInBackground: false,
  });

  const rawItems = monitorData?.items ?? EMPTY_ROWS;
  const enrichedByLh = monitorData?.enrichedByLh ?? EMPTY_ENRICHED;
  const enrichedByCargoId = monitorData?.enrichedByCargoId ?? EMPTY_ENRICHED;
  const allocByLh = monitorData?.allocByLh ?? EMPTY_ALLOC;
  // Selo resolvido por MOTORISTA/PLACA (não por lh) → troca na fila reflete na hora.
  const seloMaps = useMemo(() => buildSeloMaps(enrichedByLh, enrichedByCargoId), [enrichedByLh, enrichedByCargoId]);
  const resolveEnriched = useCallback((row: SheetMonitorRowType) => resolveRowSelo(row, seloMaps), [seloMaps]);

  // Mapa de níveis do checklist (uma chamada p/ todas as placas) → ícones de
  // semáforo por linha. Status calculado ao vivo no backend; TTL curto.
  const vehicleChecklistLevelsQuery = useQuery({
    queryKey: ["admin", "vehicle-checklist-levels"],
    queryFn: fetchVehicleChecklistLevels,
    staleTime: 60_000,
    gcTime: 120_000,
    refetchOnWindowFocus: false,
  });
  const checklistLevelsByPlate = vehicleChecklistLevelsQuery.data?.byPlaca;
  const resolveChecklistLevel = useCallback(
    (plate: string | null | undefined): VehicleChecklistLevelEntry | undefined => {
      if (!plate || !checklistLevelsByPlate) return undefined;
      // Normaliza igual ao backend (só alfanumérico maiúsculo).
      return checklistLevelsByPlate[plate.toUpperCase().replace(/[^A-Z0-9]/g, "")];
    },
    [checklistLevelsByPlate],
  );

  // Alocação efetiva: o override do operador (alloc_*) sobrepõe o valor da
  // planilha. Reflete na tabela/contadores o que foi editado no Monitor.
  const items = useMemo(() => {
    if (Object.keys(allocByLh).length === 0) return rawItems;
    return rawItems.map((row) => {
      const a = allocByLh[row.lh];
      if (!a) return row;
      // Override VAZIO ("" OU null) = "sem decisão" → cai pro valor da planilha
      // (row.*). Usa `||` (não `??`): um override vazio parado NÃO pode mais ESCONDER
      // motorista/veículo/status vivos da planilha — a Shopee re-escala/avança a
      // viagem depois que a alocação foi esvaziada (ex.: cascata de cancelamento).
      // Só um valor REAL do operador sobrepõe a planilha. (O "" continua sendo o
      // marcador de "vaga" da cascata NO BACKEND; aqui é só exibição.)
      const motoristas = a.alloc_motorista || row.motoristas;
      const status = a.alloc_status || row.status;
      return {
        ...row,
        motoristas,
        cavalo: a.alloc_cavalo || row.cavalo,
        carreta: a.alloc_carreta || row.carreta,
        status,
        tipo: a.alloc_tipo ?? row.tipo,
        pinned: a.alloc_pinned ?? false,
        hasDriver: Boolean(motoristas),
        isAvailable: !motoristas && !status,
      };
    });
  }, [rawItems, allocByLh]);

  // Ref dos itens (status efetivo) p/ os handlers de save/reassign checarem a
  // política de edição sem virar dependência (mantém os callbacks estáveis).
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Standbys (reservas ativas) agrupados por rota — de TODA a base (não só da
  // página atual), p/ o botão "puxar standby" listar os candidatos mesmo quando
  // o standby cairia noutra página da paginação.
  const standbysByRoute = useMemo(() => {
    const m = new Map<string, SheetMonitorRowType[]>();
    for (const r of items) {
      if (!r.reserva || !r.reservaId) continue;
      const k = routeKeyOf(r);
      const arr = m.get(k);
      if (arr) arr.push(r); else m.set(k, [r]);
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.standbyAt ?? "").localeCompare(b.standbyAt ?? ""));
    return m;
  }, [items]);
  const standbyCountByRoute = useMemo(() => {
    const m = new Map<string, number>();
    for (const [k, arr] of standbysByRoute) m.set(k, arr.length);
    return m;
  }, [standbysByRoute]);
  // Carga-alvo do seletor de standby (botão "puxar standby" → modal de escolha).
  const [standbyPickerLh, setStandbyPickerLh] = useState<string | null>(null);
  const handlePullStandby = useCallback((lh: string) => setStandbyPickerLh(lh), []);
  const standbyPickerCarga = standbyPickerLh ? items.find((r) => r.lh === standbyPickerLh) ?? null : null;
  const standbyPickerList = standbyPickerCarga ? (standbysByRoute.get(routeKeyOf(standbyPickerCarga)) ?? []) : [];
  // Ação pendente aguardando confirmação no pop-up de ASPX (edição inline / arrastar).
  const [aspxConfirm, setAspxConfirm] = useState<{ count: number; run: () => void } | null>(null);
  // Troca de motorista/veículo pela edição INLINE → pede o motivo (obrigatório).
  const [inlineReason, setInlineReason] = useState<{ aspxWarning: boolean; run: (reason: string) => void } | null>(null);
  // Confirmação de "descer a fila" quando há carga fixada (não será alterada) ou
  // carga "aguardando…" (ASPX) no caminho da descida.
  const [descendConfirm, setDescendConfirm] = useState<{ pinnedLhs: string[]; aspxCount: number; run: () => void } | null>(null);
  const [aspxAssignOpen, setAspxAssignOpen] = useState(false);
  const [editingSystemRow, setEditingSystemRow] = useState<SheetMonitorRowType | null>(null);
  const [newCargoOpen, setNewCargoOpen] = useState(false);

  const sheetConfigured = monitorData?.meta?.sheetConfigured ?? true;
  const noSnapshot = monitorData?.meta?.noSnapshot ?? false;
  const cachedAt = monitorData?.meta?.cachedAt;
  const snapshotSaveFailed = monitorData?.meta?.snapshotSaved === false;
  const snapshotSaveError = monitorData?.meta?.snapshotSaveError;

  // ── Sugestões do combobox inline (autocomplete dos cadastrados) ───────────────
  // Busca uma página dos motoristas/veículos cadastrados uma vez (cacheada),
  // só quando há snapshot. Alimenta os <datalist> da edição inline; o operador
  // ainda pode digitar um valor novo (texto livre).
  const { data: suggestionsData } = useQuery({
    queryKey: ["admin", "monitor-alloc-suggestions"],
    queryFn: async () => {
      const [drivers, vehicles] = await Promise.all([
        fetchOperatorDrivers({ pageSize: "300" }),
        fetchOperatorVehicles({ pageSize: "300" }),
      ]);
      return { drivers: drivers.items, vehicles: vehicles.items };
    },
    enabled: !noSnapshot,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  // Opções = valores já presentes nas linhas (planilha/alocação) + cadastrados.
  const { driverOptions, cavaloOptions, carretaOptions } = useMemo(() => {
    const drivers = new Set<string>();
    const cavalos = new Set<string>();
    const carretas = new Set<string>();
    for (const r of items) {
      if (r.motoristas) drivers.add(r.motoristas);
      if (r.cavalo) cavalos.add(r.cavalo);
      if (r.carreta) carretas.add(r.carreta);
    }
    for (const d of suggestionsData?.drivers ?? []) {
      if (d.displayName) drivers.add(d.displayName);
    }
    for (const v of suggestionsData?.vehicles ?? []) {
      if (!v.plate) continue;
      if (v.plateRole === "HORSE") cavalos.add(v.plate);
      else carretas.add(v.plate);
    }
    const sort = (s: Set<string>) => Array.from(s).sort((a, b) => a.localeCompare(b, "pt-BR"));
    return { driverOptions: sort(drivers), cavaloOptions: sort(cavalos), carretaOptions: sort(carretas) };
  }, [items, suggestionsData]);

  // ── Edição inline da alocação ─────────────────────────────────────────────────
  const {
    mutate: mutateInlineAlloc,
    isPending: inlineAllocPending,
    variables: inlineAllocVars,
  } = useMutation({
    mutationFn: updateMonitorAllocation,
    onSuccess: () => {
      toast.success("Alocação salva no sistema.");
      setEditingLh(null);
      void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] });
      // Selo re-enriquecido em background → refetch atrasado p/ aparecer.
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] }), 2000);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar a alocação.");
    },
  });
  const savingLh = inlineAllocPending ? (inlineAllocVars?.lh ?? null) : null;

  const handleStartEdit = useCallback((lh: string) => setEditingLh(lh), []);
  const handleCancelEdit = useCallback(() => setEditingLh(null), []);
  const handleSaveInline = useCallback(
    (payload: { lh: string; motorista: string; cavalo: string; carreta: string; status: string; tipo: string }) => {
      const target = itemsRef.current.find((r) => r.lh === payload.lh);
      const mvChanged =
        !target ||
        payload.motorista !== (target.motoristas ?? "") ||
        payload.cavalo !== (target.cavalo ?? "") ||
        payload.carreta !== (target.carreta ?? "");
      // Trocou motorista/veículo → exige o modal "Confirmar troca" com o motivo
      // (mostra o aviso do ASPX quando a carga está "aguardando chegar no cliente").
      if (mvChanged) {
        setInlineReason({
          aspxWarning: !!(target && allocEditPolicy(target).aspxWarning),
          run: (descricao) => mutateInlineAlloc({ ...payload, descricao }),
        });
      } else {
        mutateInlineAlloc(payload); // só status/tipo → sem motivo
      }
    },
    [mutateInlineAlloc],
  );

  // ── Reordenar a fila de motoristas/veículos (F3) ──────────────────────────────
  const { mutate: mutateReassign, isPending: reassigning } = useMutation({
    mutationFn: reassignMonitorAllocations,
    // OTIMISTA: aplica a troca NA HORA no cache (allocByLh) — a fila reordenada
    // aparece instantâneo p/ o operador; o servidor confirma logo em seguida e o
    // selo (resolvido por motorista/placa) já acompanha. Rollback se falhar.
    onMutate: async (moves) => {
      await queryClient.cancelQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] });
      const prev = queryClient.getQueryData<Awaited<ReturnType<typeof fetchSheetMonitor>>>([...SHEET_MONITOR_QUERY_KEY]);
      queryClient.setQueryData<Awaited<ReturnType<typeof fetchSheetMonitor>>>([...SHEET_MONITOR_QUERY_KEY], (old) => {
        if (!old) return old;
        const allocByLh = { ...(old.allocByLh ?? {}) };
        const now = new Date().toISOString();
        for (const m of moves) {
          // Otimismo só nas cargas da PLANILHA (allocByLh é keyed por sheet_lh). Cargas
          // do sistema (cargoId) atualizam no refetch — não entram aqui.
          if (!m.lh) continue;
          const base = allocByLh[m.lh] ?? { sheet_lh: m.lh, alloc_status: null, alloc_tipo: null, alloc_pinned: false, alloc_updated_at: null };
          allocByLh[m.lh] = { ...base, alloc_motorista: m.motorista, alloc_cavalo: m.cavalo, alloc_carreta: m.carreta, alloc_updated_at: now };
        }
        return { ...old, allocByLh };
      });
      return { prev };
    },
    onError: (err, _moves, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData([...SHEET_MONITOR_QUERY_KEY], ctx.prev);
      toast.error(err instanceof Error ? err.message : "Não foi possível reordenar a fila.");
    },
    onSuccess: (data) => {
      toast.success(`Fila atualizada — ${data.count} carga${data.count === 1 ? "" : "s"} realocada${data.count === 1 ? "" : "s"}.`);
      void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] });
      // Selos das linhas movidas são re-enriquecidos em background → refetch atrasado.
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] }), 2000);
    },
  });
  const handleReassign = useCallback(
    (moves: Array<{ lh?: string; cargoId?: string; motorista: string; cavalo: string; carreta: string }>) => {
      const run = () => mutateReassign(moves);
      const aspxCount = moves.filter((m) => {
        const r = m.lh ? itemsRef.current.find((x) => x.lh === m.lh) : itemsRef.current.find((x) => x.cargoId === m.cargoId);
        return r && allocEditPolicy(r).aspxWarning;
      }).length;
      // Se a troca/reordenação toca alguma carga "aguardando chegar no cliente",
      // confirma antes (motorista/veículo no ASPX).
      if (aspxCount > 0) setAspxConfirm({ count: aspxCount, run });
      else run();
    },
    [mutateReassign],
  );

  // ── Descer a fila (cascata) — arrastar o motorista p/ outra carga da fila ───────
  // O backend é AUTORITATIVO (lê pinned/status reais) e DEVOLVE os moves aplicados.
  // Aplicamos esses moves DIRETO no cache (fila atualiza na hora, sem refetch pesado
  // do read model — que era o que deixava lento). Um refresh leve em segundo plano
  // depois só traz a reserva sintética + os selos re-enriquecidos.
  const { mutate: mutateDescend, isPending: descending } = useMutation({
    mutationFn: descendQueueCascade,
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Não foi possível descer a fila.");
    },
    onSuccess: (data) => {
      // Aplica os moves autoritativos do servidor no cache — instantâneo.
      if (data.moves && data.moves.length > 0) {
        queryClient.setQueryData<Awaited<ReturnType<typeof fetchSheetMonitor>>>([...SHEET_MONITOR_QUERY_KEY], (old) => {
          if (!old) return old;
          const allocByLh = { ...(old.allocByLh ?? {}) };
          const now = new Date().toISOString();
          for (const m of data.moves) {
            const base = allocByLh[m.lh] ?? { sheet_lh: m.lh, alloc_status: null, alloc_tipo: null, alloc_pinned: false, alloc_updated_at: null };
            allocByLh[m.lh] = { ...base, alloc_motorista: m.motorista, alloc_cavalo: m.cavalo, alloc_carreta: m.carreta, alloc_updated_at: now };
          }
          return { ...old, allocByLh };
        });
      }
      const parts: string[] = ["Fila descida"];
      if (data.reserva) parts.push("o último motorista foi para a reserva");
      if (data.skippedPinned && data.skippedPinned.length > 0) parts.push("carga(s) fixada(s) mantida(s) no lugar");
      toast.success(`${parts.join(" — ")}.`);
      // Refresh leve em segundo plano (reserva sintética + selos) — NÃO bloqueia a
      // fila, que já refletiu os moves acima. Só um, atrasado.
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] }), 1500);
    },
  });
  const handleDescendQueue = useCallback(
    (input: { sourceLh: string; targetLh: string; orderedLhs: string[]; pinnedInPath: string[]; aspxInPath: string[] }) => {
      const run = () => mutateDescend({ sourceLh: input.sourceLh, targetLh: input.targetLh, orderedLhs: input.orderedLhs });
      // SEMPRE confirma antes de descer (o operador pediu para perguntar toda vez).
      // O modal ainda destaca carga fixada no caminho (que não muda) e cargas em
      // atribuição no ASPX, quando houver.
      setDescendConfirm({ pinnedLhs: input.pinnedInPath, aspxCount: input.aspxInPath.length, run });
    },
    [mutateDescend],
  );

  // ── Puxar um standby (reserva) para uma carga (arrastar reserva → carga) ───────
  const { mutate: mutateAssignReserva, isPending: assigningReserva, variables: assignReservaVars } = useMutation({
    mutationFn: assignReservaToCarga,
    onSuccess: (data) => {
      toast.success(
        data.bumped
          ? "Reserva alocada — o motorista anterior voltou para a reserva."
          : "Reserva alocada na carga.",
      );
      void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] });
      // O selo Angellira/ASPX da carga é re-enriquecido em background → refetch atrasado.
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] }), 2000);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Não foi possível puxar a reserva para a carga.");
    },
  });
  const handleAssignReserva = useCallback(
    (input: { reservaId: string; targetLh: string }) => {
      const run = () => mutateAssignReserva(input);
      // Se a carga de destino está "aguardando chegar no cliente", confirma antes.
      const target = itemsRef.current.find((x) => x.lh === input.targetLh);
      if (target && allocEditPolicy(target).aspxWarning) setAspxConfirm({ count: 1, run });
      else run();
    },
    [mutateAssignReserva],
  );
  // reservaId em voo (puxando pra carga) → trava o punho desse standby p/ não
  // arrastar de novo enquanto a request não volta (evita toast confuso de "já usada").
  const assigningReservaId = assigningReserva ? (assignReservaVars?.reservaId ?? null) : null;

  // ── Fixar / desafixar a alocação (fixo) ───────────────────────────────────────
  const {
    mutate: mutatePin,
    isPending: pinPending,
    variables: pinVars,
  } = useMutation({
    mutationFn: setMonitorAllocationPin,
    onSuccess: (data) => {
      toast.success(data.pinned ? "Carga fixada — motorista/veículo travados." : "Carga desafixada.");
      void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Não foi possível fixar a carga.");
    },
  });
  const pinningLh = pinPending ? (pinVars?.lh ?? null) : null;
  const handleTogglePin = useCallback(
    (lh: string, pinned: boolean) => mutatePin({ lh, pinned }),
    [mutatePin],
  );

  const summary = useMemo(() => {
    if (items.length === 0) {
      return { total: 0, available: 0, assigned: 0, withStatus: 0, statuses: {} as Record<string, number>, tipos: {} as Record<string, number> } satisfies SheetMonitorSummary;
    }
    const statuses: Record<string, number> = {};
    const tipos: Record<string, number> = {};
    let available = 0, assigned = 0, withStatus = 0;
    for (const row of items) {
      if (row.reserva) continue; // reserva é linha sintética — não conta nos KPIs
      if (!row.motoristas && !row.status) available += 1;
      if (row.motoristas) assigned += 1;
      if (row.status) withStatus += 1;
      const sk = row.status || "Sem status";
      statuses[sk] = (statuses[sk] ?? 0) + 1;
      if (row.tipo) tipos[row.tipo] = (tipos[row.tipo] ?? 0) + 1;
    }
    return { total: items.length, available, assigned, withStatus, statuses, tipos } satisfies SheetMonitorSummary;
  }, [items]);

  const tipoOptions = useMemo(() => {
    const s = new Set<string>();
    items.forEach((item) => { if (item.tipo) s.add(item.tipo); });
    return Array.from(s).sort();
  }, [items]);

  // Vínculos presentes no dataset (ex.: FROTA, AGREGADO, TERCEIRO da Nestlé) —
  // para o filtro multi-seleção dedicado. Shopee normalmente não tem vínculo.
  const vinculoOptions = useMemo(() => {
    const s = new Set<string>();
    items.forEach((item) => { if (item.vinculo) s.add(item.vinculo); });
    return Array.from(s).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [items]);

  // Clientes presentes no dataset (ex.: Shopee, Nestle) — para o filtro multi-seleção.
  const clienteOptions = useMemo(() => {
    const s = new Set<string>();
    items.forEach((item) => { if (item.cliente) s.add(item.cliente); });
    return Array.from(s).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [items]);

  // Rotas do filtro: quando há filtro de DATA, mostra só as rotas que têm carga
  // no intervalo (as "principais" do dia) — não todas. Mesma lógica de data do
  // filteredRows; reserva (standby, sem data) sempre entra.
  const routeOptions = useMemo(() => {
    const carFrom = dateFromFilter ? new Date(dateFromFilter).getTime() : null;
    const carTo = dateToFilter ? new Date(dateToFilter).getTime() : null;
    const desFrom = descargaFromFilter ? new Date(descargaFromFilter).getTime() : null;
    const desTo = descargaToFilter ? new Date(descargaToFilter).getTime() : null;
    const inDate = (row: SheetMonitorRowType) => rowMatchesDateRanges(row, { carFrom, carTo, desFrom, desTo });
    const byKey = new Map<string, number | null>();
    items.forEach((item) => {
      if (!inDate(item)) return;
      const k = routeKeyOf(item);
      if (!byKey.has(k)) byKey.set(k, item.routeCodigo ?? null);
    });
    // Ordena por CÓDIGO da rota (operator-only); rotas sem código ainda por nome.
    return Array.from(byKey.entries())
      .map(([key, codigo]) => ({ key, codigo }))
      .sort((a, b) => {
        if (a.codigo != null && b.codigo != null) return a.codigo - b.codigo;
        if (a.codigo != null) return -1;
        if (b.codigo != null) return 1;
        return a.key.localeCompare(b.key, "pt-BR");
      });
  }, [items, dateFromFilter, dateToFilter, descargaFromFilter, descargaToFilter]);

  // Se a rota selecionada deixar de existir (ex.: filtro de data a removeu),
  // volta para "todos" pra não ficar travado num filtro sem resultado.
  useEffect(() => {
    setRouteFilter((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.filter((k) => routeOptions.some((r) => r.key === k));
      return next.length === prev.length ? prev : next;
    });
  }, [routeOptions]);

  // Opções (shape do MultiSelectFilter) para os filtros de tipo e rota.
  const tipoSelectOptions = useMemo<MultiOption[]>(() => tipoOptions.map((t) => ({ value: t, label: t })), [tipoOptions]);
  const vinculoSelectOptions = useMemo<MultiOption[]>(() => vinculoOptions.map((v) => ({ value: v, label: v })), [vinculoOptions]);
  const clienteSelectOptions = useMemo<MultiOption[]>(() => clienteOptions.map((c) => ({ value: c, label: c })), [clienteOptions]);
  const routeSelectOptions = useMemo<MultiOption[]>(
    () => routeOptions.map((r) => ({ value: r.key, label: r.codigo != null ? `R${r.codigo} — ${r.key}` : r.key })),
    [routeOptions],
  );

  // Linhas após TODOS os filtros MENOS o de status. Base para (a) as contagens
  // clicáveis do "Status na planilha" (facetas) e (b) o filtro de status por cima
  // — assim os chips mostram quantas linhas cada status tem sob os demais filtros.
  const preStatusRows = useMemo(() => {
    // Linhas de RESERVA (standby) não entram mais na tabela — só poluíam a lista.
    // Continuam disponíveis via `items` para o painel de reserva e o botão
    // "puxar standby" (standbysByRoute), que seguem enxergando todos os standbys.
    let result = items.filter((r) => !r.reserva);

    if (deferredSearch.trim()) {
      const q = deferredSearch.trim().toLowerCase();
      result = result.filter((r) =>
        r.lh.toLowerCase().includes(q) || r.origem.toLowerCase().includes(q) ||
        r.destino.toLowerCase().includes(q) || r.motoristas.toLowerCase().includes(q) || r.cavalo.toLowerCase().includes(q),
      );
    }

    if (tipoFilter.length > 0)
      result = result.filter((r) => r.tipo != null && tipoFilter.includes(r.tipo));

    if (vinculoFilter.length > 0)
      result = result.filter((r) => r.vinculo != null && vinculoFilter.includes(r.vinculo));

    // Cliente — OR entre os selecionados (Shopee, Nestle, …). Linha de reserva
    // (standby, sem cliente) sai quando há filtro de cliente ativo.
    if (clienteFilter.length > 0)
      result = result.filter((r) => r.cliente != null && clienteFilter.includes(r.cliente));

    if (routeFilter.length > 0)
      result = result.filter((r) => routeFilter.includes(routeKeyOf(r)));

    // Atribuição — OR entre os selecionados (com motorista / sem motorista / disponíveis).
    if (assignmentFilter.length > 0)
      result = result.filter((r) =>
        assignmentFilter.some((a) =>
          a === "com_motorista" ? Boolean(r.motoristas)
            : a === "sem_motorista" ? !r.motoristas
              : a === "disponiveis" ? (!r.motoristas && !r.status)
                : false,
        ),
      );

    // Edição — OR entre editáveis / bloqueadas.
    if (editFilter.length > 0)
      result = result.filter((r) => {
        const canEdit = allocEditPolicy(r).editable && !r.pinned;
        return editFilter.some((e) => (e === "editaveis" ? canEdit : e === "bloqueadas" ? !canEdit : false));
      });

    // Data: duas faixas independentes (carregamento e descarga). Reserva sempre visível.
    const carFrom = dateFromFilter ? new Date(dateFromFilter).getTime() : null;
    const carTo = dateToFilter ? new Date(dateToFilter).getTime() : null;
    const desFrom = descargaFromFilter ? new Date(descargaFromFilter).getTime() : null;
    const desTo = descargaToFilter ? new Date(descargaToFilter).getTime() : null;
    if (carFrom !== null || carTo !== null || desFrom !== null || desTo !== null)
      result = result.filter((row) => rowMatchesDateRanges(row, { carFrom, carTo, desFrom, desTo }));

    return result;
  }, [items, deferredSearch, tipoFilter, vinculoFilter, clienteFilter, routeFilter, assignmentFilter, editFilter, dateFromFilter, dateToFilter, descargaFromFilter, descargaToFilter]);

  // Contagem por status para os chips clicáveis do "Status na planilha" (mesma
  // chave do resumo: status || "Sem status"). Reserva é linha sintética — não conta.
  const statusFacets = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of preStatusRows) {
      if (r.reserva) continue;
      const k = r.status || "Sem status";
      m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  }, [preStatusRows]);

  // Conjunto ESTÁVEL de chips = todos os status do dataset (summary.statuses, NÃO
  // filtrado); a contagem vem das facetas (reflete os demais filtros) ou 0. Assim a
  // seção "Status na planilha" NÃO muda de altura ao filtrar/editar — o conjunto de
  // chips é sempre o mesmo, só os números mudam, no lugar (nada se desloca abaixo).
  const statusChips = useMemo(() => {
    const out: Record<string, number> = {};
    for (const k of Object.keys(summary.statuses)) out[k] = statusFacets[k] ?? 0;
    return out;
  }, [summary.statuses, statusFacets]);

  const filteredRows = useMemo(() => {
    let result = preStatusRows;

    // Multi-select de status (OR). Cada linha usa a mesma chave dos chips/facetas:
    // status || "Sem status". Vazio = todos.
    if (statusFilter.length > 0)
      result = result.filter((r) => statusFilter.includes(r.status === "" ? "Sem status" : r.status));

    // Ordem da fila (pedido do operador): ordem cronológica DECRESCENTE por
    // data+horário — a carga mais NOVA (data/horário mais recente/futura) no topo,
    // as mais antigas embaixo. Sem afundar passadas e sem comparar com "agora".
    //   - standby (reserva, sem data) sempre por último — FIFO (espera mais longa 1º);
    //   - linhas sem data vão para o fim (antes do standby).
    // data/horário das cargas são horário de parede do Brasil (BRT); a comparação é
    // lexical sobre "YYYY-MM-DD HH:MM:SS", sem conversão de fuso.
    //
    // Normaliza o horário p/ "HH:MM:SS" (planilha manda HH:MM:SS, sistema HH:MM) —
    // garante a comparação lexical correta por horário mesmo com formatos mistos.
    const timeKey = (h: string | null | undefined) => {
      const [hh = "00", mm = "00", ss = "00"] = String(h ?? "").split(":");
      return `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}:${ss.padStart(2, "0")}`;
    };
    const dtKey = (r: SheetMonitorRowType) => (r.data ? `${String(r.data).slice(0, 10)} ${timeKey(r.horario)}` : "");
    return [...result].sort((a, b) => {
      // Standby (reserva) sempre por último; entre si, mais ANTIGO primeiro (FIFO).
      if (a.reserva || b.reserva) {
        if (a.reserva && b.reserva) {
          const sa = a.standbyAt || "";
          const sb = b.standbyAt || "";
          if (sa === sb) return 0;
          return sa < sb ? -1 : 1;
        }
        return a.reserva ? 1 : -1;
      }
      const ka = dtKey(a);
      const kb = dtKey(b);
      // Sem data vai para o fim (mas antes do standby).
      if (!ka || !kb) {
        if (!ka && !kb) return 0;
        return ka ? -1 : 1;
      }
      // Cronológica por agenda (data+horário), direção escolhida pelo operador
      // (planilha-style): "desc" = mais nova no topo (padrão), "asc" = mais antiga.
      if (ka === kb) return 0;
      return (ka < kb) === (agendaSortDir === "asc") ? -1 : 1;
    });
  }, [preStatusRows, statusFilter, agendaSortDir]);

  // Fila por rota usada pela cascata "descer a fila" ao arrastar. Derivada de
  // `filteredRows` (NÃO de `items`): a cascata anda exatamente sobre o que o
  // operador VÊ — respeita os filtros ativos e cobre a rota inteira (filteredRows é
  // pré-paginação). Já vem ordenada (compareMonitorQueue). Regras de entrada:
  //  - só cargas da PLANILHA (com LH): sistema e standby não participam;
  //  - só a fila ACIONÁVEL (atuais/futuras): cargas PASSADAS (já carregaram, afundam
  //    no fim) ficam de fora — a planilha guarda todo o histórico (centenas de
  //    cargas por rota), que estouraria o payload/lock e não faz sentido remanejar;
  //  - dedup por LH (o snapshot pode repetir a mesma carga).
  const routeQueue = useMemo(() => {
    // Corta pela DATA (antes de HOJE = histórico), NÃO pelo horário: uma carga de
    // hoje cujo horário agendado já passou mas que ainda está "aguardando
    // carregamento" continua ACIONÁVEL (dá pra descer). Cortar por data+hora tirava
    // essas cargas da fila assim que o relógio passava do horário. Mantém hoje +
    // futuras (fila pequena); o histórico (semanas) fica de fora do payload/lock.
    const todayKey = monitorNowKeySaoPaulo().slice(0, 10); // "YYYY-MM-DD" (São Paulo)
    const m = new Map<string, SheetMonitorRowType[]>();
    const seen = new Set<string>();
    for (const r of filteredRows) {
      if (r.reserva || r.source === "sistema" || !r.lh) continue;
      const dt = monitorDtKey(r);
      if (dt && dt.slice(0, 10) < todayKey) continue; // antes de HOJE → fora (histórico)
      if (seen.has(r.lh)) continue;    // dedup por LH
      seen.add(r.lh);
      const k = routeKeyOf(r);
      const arr = m.get(k);
      if (arr) arr.push(r); else m.set(k, [r]);
    }
    return m;
  }, [filteredRows]);
  const getRouteQueue = useCallback((routeKey: string) => routeQueue.get(routeKey) ?? [], [routeQueue]);

  // Alterna um status no filtro multi-seleção a partir dos chips do "Status na
  // planilha" (soma vários). Substitui o antigo dropdown "Todos os status".
  const handleToggleStatus = useCallback(
    (statusKey: string) =>
      setStatusFilter((prev) => (prev.includes(statusKey) ? prev.filter((s) => s !== statusKey) : [...prev, statusKey])),
    [],
  );
  const handleClearStatus = useCallback(() => setStatusFilter([]), []);

  const hasActiveFilters =
    deferredSearch.trim().length > 0 || statusFilter.length > 0 || tipoFilter.length > 0 || vinculoFilter.length > 0 || clienteFilter.length > 0 ||
    routeFilter.length > 0 || assignmentFilter.length > 0 || editFilter.length > 0 || dateFromFilter.length > 0 || dateToFilter.length > 0 ||
    descargaFromFilter.length > 0 || descargaToFilter.length > 0;

  useEffect(() => { setPage(0); }, [deferredSearch, statusFilter, tipoFilter, vinculoFilter, routeFilter, assignmentFilter, editFilter, dateFromFilter, dateToFilter, descargaFromFilter, descargaToFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const paginatedRows = useMemo(() => filteredRows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE), [filteredRows, safePage]);
  const pageStart = filteredRows.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const pageEnd = Math.min(filteredRows.length, (safePage + 1) * PAGE_SIZE);

  // ── Refresh sheet ────────────────────────────────────────────────────────────
  const refreshMutation = useMutation({
    mutationFn: () => fetchSheetMonitor({ refresh: true }),
    onSuccess: (freshData) => {
      // O botão "Atualizar planilha" SÓ atualiza a planilha — NÃO re-consulta
      // Angellira/ASPX. freshData já traz o enriquecimento salvo (enrichedByLh/
      // ByCargoId) do backend, então os selos NÃO somem. A verificação é feita
      // uma vez (ao abrir o Monitor) e persistida no banco.
      queryClient.setQueryData([...SHEET_MONITOR_QUERY_KEY], freshData);
      // Fila operacional usa status da planilha — invalidar para refletir status novo apos sync.
      queryClient.invalidateQueries({ queryKey: ["operator", "public-load-leads"] });
    },
  });

  const loading = isLoading && items.length === 0;
  const isRefreshing = (isFetching && !loading) || refreshMutation.isPending;

  // Abrir o Monitor NÃO re-consulta nada — apenas LÊ os selos já salvos no banco
  // (enrichedByLh/ByCargoId vêm prontos do backend). A consulta Angellira/ASPX é
  // feita 1x por linha no backend: ao inserir/atualizar carga, ao sincronizar a
  // planilha (linhas novas, em background) e via backfill (script/botão abaixo).
  // Re-consulta manual sob demanda fica no botão "Atualizar consultas".

  const handleSelectRow = useCallback((row: SheetMonitorRowType) => {
    // Carga do sistema → modal de edição (planilha-like); planilha → detalhe.
    if (row.source === "sistema") {
      setEditingSystemRow(row);
      return;
    }
    setSelectedRow((prev) => (prev?.lh === row.lh ? null : row));
  }, []);

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

        {/* ── Summary cards ── */}
        {!noSnapshot && (
          <>
            <section className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
              <SummaryCard icon={FileSpreadsheet} label="Total de linhas" value={summary.total} color="bg-primary/10 text-primary" />
              <SummaryCard icon={Truck} label="Disponiveis (sem motorista)" value={summary.available} color="bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-200" />
              <SummaryCard icon={UserCheck} label="Com motorista atribuido" value={summary.assigned} color="bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200" />
              <SummaryCard icon={Filter} label="Com status definido" value={summary.withStatus} color="bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200" />
            </section>
            <StatusBreakdown statuses={statusChips} selected={statusFilter} onToggle={handleToggleStatus} onClear={handleClearStatus} />
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

              <MultiSelectFilter label="Clientes" options={clienteSelectOptions} selected={clienteFilter} onChange={setClienteFilter} />

              <MultiSelectFilter label="Tipos" options={tipoSelectOptions} selected={tipoFilter} onChange={setTipoFilter} />
              <MultiSelectFilter label="Vínculos" options={vinculoSelectOptions} selected={vinculoFilter} onChange={setVinculoFilter} />

              <MultiSelectFilter label="Rotas" options={routeSelectOptions} selected={routeFilter} onChange={setRouteFilter} widthClass="max-w-[220px]" searchable />

              <MultiSelectFilter label="Atribuição" options={ASSIGNMENT_OPTIONS} selected={assignmentFilter} onChange={setAssignmentFilter} />

              <MultiSelectFilter label="Edição" options={EDIT_OPTIONS} selected={editFilter} onChange={setEditFilter} />

              <div className="flex items-center gap-1">
                <span className="text-[0.6rem] font-semibold uppercase text-muted-foreground/70">Carreg.</span>
                <input type="datetime-local" value={dateFromFilter} onChange={(e) => setDateFromFilter((prev) => dateFilterWithMidnight(prev, e.target.value))}
                  className="rounded-xl border border-border/80 bg-white/92 px-3 py-2.5 text-sm outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40"
                  title="Carregamento a partir de (horário padrão 00:00 — edite se quiser)" aria-label="Carregamento a partir de" />
                <input type="datetime-local" value={dateToFilter} onChange={(e) => setDateToFilter((prev) => dateFilterWithMidnight(prev, e.target.value))} min={dateFromFilter || undefined}
                  className="rounded-xl border border-border/80 bg-white/92 px-3 py-2.5 text-sm outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40"
                  title="Carregamento até (horário padrão 00:00 — edite se quiser)" aria-label="Carregamento até" />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-[0.6rem] font-semibold uppercase text-muted-foreground/70">Descarga</span>
                <input type="datetime-local" value={descargaFromFilter} onChange={(e) => setDescargaFromFilter((prev) => dateFilterWithMidnight(prev, e.target.value))}
                  className="rounded-xl border border-border/80 bg-white/92 px-3 py-2.5 text-sm outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40"
                  title="Descarga a partir de (00:00 padrão)" aria-label="Descarga a partir de" />
                <input type="datetime-local" value={descargaToFilter} onChange={(e) => setDescargaToFilter((prev) => dateFilterWithMidnight(prev, e.target.value))} min={descargaFromFilter || undefined}
                  className="rounded-xl border border-border/80 bg-white/92 px-3 py-2.5 text-sm outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40"
                  title="Descarga até (00:00 padrão)" aria-label="Descarga até" />
              </div>

              {/* "Limpar" sempre presente (desabilitado sem filtro): ocupa slot fixo
                  no fim da linha de filtros, então nada reflui quando um filtro é
                  aplicado/limpo. A busca é flex-1 e absorve a variação de largura. */}
              <button type="button" disabled={!hasActiveFilters}
                onClick={() => { setSearch(""); setStatusFilter([]); setTipoFilter([]); setVinculoFilter([]); setClienteFilter([]); setRouteFilter([]); setAssignmentFilter([]); setEditFilter([]); setDateFromFilter(""); setDateToFilter(""); setDescargaFromFilter(""); setDescargaToFilter(""); }}
                className="inline-flex items-center gap-1 rounded-xl border border-border/80 bg-white px-3 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 dark:bg-muted/40">
                <X className="h-3.5 w-3.5" />Limpar
              </button>
            </div>

            {/* Linha de AÇÕES — separada dos filtros para os botões NÃO se moverem
                quando um filtro é aplicado/limpo (antes era tudo um flex-wrap só, e
                o "Limpar"/"Mostrando" empurravam os botões para outra linha). */}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" onClick={() => setNewCargoOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2.5 text-xs font-semibold text-sky-700 hover:bg-sky-500/20 dark:text-sky-300">
                <FileSpreadsheet className="h-3.5 w-3.5" />
                Nova carga
              </button>

              <button type="button" onClick={() => setAspxAssignOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300">
                <Send className="h-3.5 w-3.5" />
                Atribuir no ASPX
              </button>

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

            {/* Sempre renderizado (mostra o total quando não há filtro) para a linha
                não aparecer/sumir e deslocar a tabela verticalmente. */}
            <p className="mt-3 text-xs text-muted-foreground">
              Mostrando <span className="font-bold text-foreground">{filteredRows.length}</span> de{" "}
              <span className="font-bold text-foreground">{items.length}</span> linhas
            </p>
          </section>
        )}

        {/* ── Tabela + datalists ── */}
        {!noSnapshot && (
          <>
            <MonitorDatalists driverOptions={driverOptions} cavaloOptions={cavaloOptions} carretaOptions={carretaOptions} tipoOptions={tipoOptions} />

            <section className="admin-panel overflow-hidden">
              <SheetMonitorTable
                rows={paginatedRows}
                resolveEnriched={resolveEnriched}
                resolveChecklistLevel={resolveChecklistLevel}
                allocByLh={allocByLh}
                selectedLh={selectedRow?.lh ?? null}
                editingLh={editingLh}
                savingLh={savingLh}
                pinningLh={pinningLh}
                loading={loading}
                reassigning={reassigning || descending}
                onSelect={handleSelectRow}
                onStartEdit={handleStartEdit}
                onCancelEdit={handleCancelEdit}
                onSaveInline={handleSaveInline}
                onTogglePin={handleTogglePin}
                onReassign={handleReassign}
                onDescendQueue={handleDescendQueue}
                getRouteQueue={getRouteQueue}
                onAssignReserva={handleAssignReserva}
                assigningReservaId={assigningReservaId}
                standbyCountByRoute={standbyCountByRoute}
                onPullStandby={handlePullStandby}
                agendaSortDir={agendaSortDir}
                onToggleAgendaSort={toggleAgendaSort}
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
          </>
        )}
      </main>

      {/* ── Detail modal ── */}
      <RowDetailModal
        row={selectedRow}
        enriched={selectedRow ? resolveEnriched(selectedRow) : undefined}
        alloc={selectedRow ? allocByLh[selectedRow.lh] : undefined}
        open={selectedRow !== null}
        onClose={() => setSelectedRow(null)}
      />

      {/* ── Confirmação ASPX (arrastar / puxar standby) ── */}
      <ConfirmDialog
        open={aspxConfirm !== null}
        title="Confirmar troca de motorista/veículo"
        description={aspxConfirm ? aspxConfirmDescription(aspxConfirm.count) : ""}
        onConfirm={() => { aspxConfirm?.run(); setAspxConfirm(null); }}
        onCancel={() => setAspxConfirm(null)}
      />

      {/* ── Confirmar troca c/ descrição obrigatória (edição INLINE do motorista/veículo) ── */}
      <ChangeReasonDialog
        open={inlineReason !== null}
        aspxWarning={inlineReason?.aspxWarning ?? false}
        onConfirm={(reason) => { inlineReason?.run(reason); setInlineReason(null); }}
        onCancel={() => setInlineReason(null)}
      />

      {/* ── Confirmação "descer a fila" (carga fixada / ASPX no caminho) ── */}
      <ConfirmDialog
        open={descendConfirm !== null}
        title="Descer a fila?"
        confirmLabel="Sim, descer a fila"
        description={descendConfirm ? (
          <span className="space-y-2 block">
            <span className="block">
              O motorista vai descer uma carga e empurrar os de baixo; a próxima carga em branco é preenchida e quem sobra vira reserva.
            </span>
            {descendConfirm.pinnedLhs.length > 0 && (
              <span className="block rounded-lg bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
                {descendConfirm.pinnedLhs.length === 1 ? "A carga fixada " : "As cargas fixadas "}
                <span className="font-mono font-semibold">{descendConfirm.pinnedLhs.join(", ")}</span>
                {descendConfirm.pinnedLhs.length === 1 ? " não será alterada" : " não serão alteradas"} — fica{descendConfirm.pinnedLhs.length === 1 ? "" : "m"} no lugar e a fila desce ao redor dela{descendConfirm.pinnedLhs.length === 1 ? "" : "s"}.
              </span>
            )}
            {descendConfirm.aspxCount > 0 && (
              <span className="block">
                {descendConfirm.aspxCount === 1 ? "1 carga já em atribuição no ASPX" : `${descendConfirm.aspxCount} cargas já em atribuição no ASPX`} será(ão) remanejada(s) — depois use "Atribuir no ASPX" para refletir lá.
              </span>
            )}
          </span>
        ) : ""}
        onConfirm={() => { descendConfirm?.run(); setDescendConfirm(null); }}
        onCancel={() => setDescendConfirm(null)}
      />

      {/* ── Atribuir no ASPX (preview + confirmação) ── */}
      <AspxAssignModal open={aspxAssignOpen} onClose={() => setAspxAssignOpen(false)} />

      {/* ── Editar carga do sistema (grid unificado) ── */}
      <SystemCargoEditModal
        row={editingSystemRow}
        open={editingSystemRow !== null}
        onClose={() => setEditingSystemRow(null)}
        statusOptions={OPERATIONAL_STATUS_OPTIONS}
      />

      {/* ── Nova carga (sistema) ── */}
      <NewCargoModal open={newCargoOpen} onClose={() => setNewCargoOpen(false)} statusOptions={OPERATIONAL_STATUS_OPTIONS} />

      {/* ── Painel de reserva: gerenciar reservas da rota + histórico + puxar p/ carga ── */}
      <ReservaPanelModal
        open={standbyPickerLh !== null}
        carga={standbyPickerCarga}
        reservas={standbyPickerList}
        onPull={(reservaId) => { if (standbyPickerLh) handleAssignReserva({ reservaId, targetLh: standbyPickerLh }); }}
        onClose={() => setStandbyPickerLh(null)}
      />
    </div>
  );
}
