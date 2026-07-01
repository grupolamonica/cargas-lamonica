import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Ban,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  Filter,
  GripVertical,
  Loader2,
  Lock,
  MapPin,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Send,
  ShieldX,
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
import { ExternalValidationPill } from "@/components/ExternalValidationPill";
import { cn } from "@/lib/utils";
import { allocEditPolicy } from "@/lib/monitorEditPolicy";
import { computeShiftMoves, computeSwapMoves } from "@/lib/monitorReorder";
import {
  assignAspxAllocations,
  createMonitorCargo,
  enrichSheetMonitor,
  fetchOperatorDrivers,
  fetchOperatorVehicles,
  fetchSheetMonitor,
  previewAspxAllocation,
  reassignMonitorAllocations,
  assignReservaToCarga,
  setMonitorAllocationPin,
  updateMonitorAllocation,
  updateMonitorCargo,
  type AspxAllocationItem,
  type AspxAllocationPreview,
  type SheetMonitorAllocation,
  type SheetMonitorEnrichedRow,
  type SheetMonitorRow as SheetMonitorRowType,
  type SheetMonitorSummary,
} from "@/services/readModels";

const SHEET_MONITOR_QUERY_KEY = ["admin", "sheet-monitor"] as const;

const PAGE_SIZE = 50;
const EMPTY_ROWS: SheetMonitorRowType[] = [];
const EMPTY_ENRICHED: Record<string, SheetMonitorEnrichedRow> = {};
const EMPTY_ALLOC: Record<string, SheetMonitorAllocation> = {};

// Status operacional canônico da planilha (mesma terminologia, sem os valores
// com encoding corrompido que aparecem nos dados crus). Ordem = pipeline da viagem.
const OPERATIONAL_STATUS_OPTIONS = [
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
    "RESERVA":     { dot: "bg-amber-500",   bg: "bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-100",        label: "Reserva" },
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
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.66rem] font-semibold leading-tight", cfg.bg)}>
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

// Selos do MOTORISTA: Angellira vigente + cadastro no ASPX (mesmo selo da tela de Motoristas).
function DriverChecks({ enriched }: { enriched: SheetMonitorEnrichedRow | undefined }) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      <ExternalValidationPill
        compact scope="motorista" label="Angellira"
        found={presenceState(enriched?.angellira_driver_found)}
      />
      <ExternalValidationPill compact scope="motorista" label="ASPX" found={aspxCadastroState(enriched)} />
    </div>
  );
}

// Selos do VEÍCULO: Angellira do cavalo e da carreta (ASPX é só do motorista).
function VehicleChecks({ enriched, hasCavalo, hasCarreta }: { enriched: SheetMonitorEnrichedRow | undefined; hasCavalo: boolean; hasCarreta: boolean }) {
  if (!hasCavalo && !hasCarreta) return null;
  return (
    <div className="flex shrink-0 items-center gap-1">
      {hasCavalo && (
        <ExternalValidationPill
          compact scope="Angellira do cavalo" label="Cavalo"
          found={presenceState(enriched?.cavalo_angellira_found)}
        />
      )}
      {hasCarreta && (
        <ExternalValidationPill
          compact scope="Angellira da carreta" label="Carreta"
          found={presenceState(enriched?.carreta_angellira_found)}
        />
      )}
    </div>
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

// Texto do pop-up de confirmação para cargas "aguardando chegar no cliente"
// (motorista/veículo já no ASPX). Pergunta antes de efetivar a troca.
function aspxConfirmDescription(count: number) {
  return count > 1
    ? `${count} cargas estão "aguardando chegar no cliente" — o motorista e o veículo já estão no ASPX. Tem certeza de que quer fazer a troca?`
    : `Esta carga está "aguardando chegar no cliente" — o motorista e o veículo já estão no ASPX. Tem certeza de que quer fazer a troca?`;
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
  const confirmLabel = realMode
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

type CargoForm = { lh: string; status: string; tipo: string; origem: string; destino: string; carregamento: string; descarga: string; motorista: string; cavalo: string; carreta: string };

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
          <option value="">(disponível)</option>
          {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
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
    </div>
  );
}

const EMPTY_CARGO_FORM: CargoForm = { lh: "", status: "", tipo: "", origem: "", destino: "", carregamento: "", descarga: "", motorista: "", cavalo: "", carreta: "" };

// datetime-local 'YYYY-MM-DDTHH:MM' → { data:'YYYY-MM-DD', horario:'HH:MM' }
function splitCarregamento(dt: string): { data: string; horario: string } {
  const [d, t] = (dt || "").split("T");
  return { data: d || "", horario: (t || "").slice(0, 5) };
}

function SystemCargoEditModal({ row, open, onClose, statusOptions }: {
  row: SheetMonitorRowType | null;
  open: boolean;
  onClose: () => void;
  statusOptions: readonly string[];
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_CARGO_FORM);

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

  const save = () => {
    if (!row?.cargoId) return;
    const { data, horario } = splitCarregamento(form.carregamento);
    if (form.origem.trim().length < 2 || form.destino.trim().length < 2 || !data || !horario) {
      toast.error("Rota e carregamento (origem, destino, data + hora) são obrigatórios.");
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
    });
  };

  return (
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

function AllocCell({ row, enriched, editing, saving, pinning, allocStatus, onStartEdit, onCancelEdit, onSaveInline, onTogglePin, onDragStartHandle, onDragEndHandle, assigningReserva, routeStandbyCount = 0, onPullStandby }: AllocCellProps) {
  // Linha de RESERVA (standby na rota) — exibe o motorista/veículo e um punho de
  // arrasto: o operador puxa o standby para uma carga da MESMA rota (alocar).
  if (row.reserva) {
    return (
      <div className="group/rsv flex items-start gap-1.5 border-l-2 border-amber-400 pl-2">
        {row.reservaId && (
          <button
            type="button"
            aria-label="Arrastar standby para uma carga"
            title={assigningReserva ? "Enviando…" : "Arraste para uma carga da mesma rota para alocar este standby"}
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
            {assigningReserva ? "puxando p/ a carga…" : "standby — arraste p/ uma carga"}
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
    <div className="group/alloc flex items-start gap-1">
      {canEditAlloc ? (
        <button
          type="button"
          aria-label="Arrastar alocação (trocar / mover na fila)"
          title="Arraste para o corpo de outra carga (trocar) ou para a borda (mover na fila)"
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
      <div className="min-w-0 flex-1">
        {row.motoristas ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={row.motoristas}>{row.motoristas}</span>
            <DriverChecks enriched={enriched} />
          </div>
        ) : (
          <span className="text-xs text-muted-foreground/50">Sem motorista</span>
        )}
        {row.cavalo && (
          <div className="mt-0.5 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[0.62rem] text-muted-foreground" title={`${row.cavalo}${row.carreta ? ` · ${row.carreta}` : ""}`}>
              {row.cavalo}{row.carreta ? ` · ${row.carreta}` : ""}
            </span>
            <VehicleChecks enriched={enriched} hasCavalo={Boolean(row.cavalo)} hasCarreta={Boolean(row.carreta)} />
          </div>
        )}
        {pinned && (
          <span className="mt-0.5 inline-flex items-center gap-1 text-[0.58rem] font-semibold text-amber-600 dark:text-amber-400" title="Fixado nesta carga">
            <Pin className="h-2.5 w-2.5 fill-current" /> fixado
          </span>
        )}
        {aspxWarning && !pinned && (
          <span className="mt-0.5 inline-flex items-center gap-1 text-[0.58rem] font-medium text-amber-600 dark:text-amber-400" title="Já estão atribuindo no ASPX">
            <AlertTriangle className="h-2.5 w-2.5" /> em atribuição no ASPX
          </span>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {canEditAlloc && routeStandbyCount > 0 && onPullStandby && (
          <button
            type="button"
            title={`Puxar um motorista em standby desta rota (${routeStandbyCount} disponíve${routeStandbyCount === 1 ? "l" : "is"})`}
            aria-label="Puxar standby para esta carga"
            onClick={(e) => { e.stopPropagation(); onPullStandby(row.lh); }}
            className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[0.6rem] font-semibold text-amber-600 transition-colors hover:bg-amber-50 hover:text-amber-700 dark:text-amber-400 dark:hover:bg-amber-500/10"
          >
            <UserPlus className="h-3 w-3" /> {routeStandbyCount}
          </button>
        )}
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
      </div>
    </div>
  );
}

// ─── Table row ────────────────────────────────────────────────────────────────

const ROW_VIRTUALIZATION_STYLE = { contentVisibility: "auto" as const, containIntrinsicSize: "0 44px" as const };

type RowDropIntent = "swap" | "before" | "after" | null;

const SheetMonitorRow = memo(function SheetMonitorRow({
  row,
  enriched,
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
              : row.hasDriver
                ? "hover:bg-emerald-50/60 dark:hover:bg-emerald-500/10"
                : "hover:bg-primary/[0.04]",
        // Soltar na BORDA = descer/subir a fila → só a borda azul.
        dropIntent === "before" && "[&>td]:border-t-[3px] [&>td]:border-blue-600",
        dropIntent === "after" && "[&>td]:border-b-[3px] [&>td]:border-blue-600",
        isDragSource && "opacity-40",
      )}
    >
      {/* Status */}
      <td className="px-3 py-2 align-top"><StatusBadge status={!row.status && row.motoristas ? "Reservado" : row.status} /></td>

      {/* LH + Tipo */}
      <td className="px-3 py-2 align-top">
        {row.reserva ? (
          <span className="block text-[0.62rem] font-bold uppercase tracking-wide text-amber-600 dark:text-amber-400">standby</span>
        ) : (
          <>
            <span className="block font-mono text-xs font-semibold leading-tight text-foreground/80">{row.lh}</span>
            {row.tipo && <span className="block text-[0.62rem] leading-tight text-muted-foreground">{row.tipo}</span>}
          </>
        )}
      </td>

      {/* Cliente */}
      <td className="px-3 py-2 align-top">
        <span className="block truncate text-xs font-medium text-foreground/90" title={row.cliente ?? undefined}>{row.cliente || "—"}</span>
      </td>

      {/* Rota (com código operator-only antes da origem) */}
      <td className="px-3 py-2 align-top">
        <p className="truncate text-xs font-medium leading-tight text-foreground">
          {row.routeCodigo != null && (
            <span className="mr-1 font-mono text-[0.58rem] font-semibold text-muted-foreground/70" title="Código da rota">R{row.routeCodigo}</span>
          )}
          {row.origem || "—"}
        </p>
        <p className="truncate text-[0.62rem] leading-tight text-muted-foreground">{row.destino || "—"}</p>
        {row.routeRegistered === false && (
          <span
            className="mt-0.5 inline-flex items-center gap-1 text-[0.58rem] font-semibold text-orange-600 dark:text-orange-400"
            title="O trajeto origem→destino não tem rota cadastrada no catálogo"
          >
            <AlertTriangle className="h-3 w-3 shrink-0" /> sem rota cadastrada
          </span>
        )}
      </td>

      {/* Agenda: carga + descarga (compacto: C = carregamento, D = descarga) */}
      <td className="px-3 py-2 align-top">
        {row.carregamentoLabel ? (
          <p className="truncate text-xs leading-tight text-foreground" title={`Carregamento: ${row.carregamentoLabel}`}>
            <span className="font-semibold text-muted-foreground/50">C</span> {row.carregamentoLabel}
          </p>
        ) : null}
        {row.descargaLabel ? (
          <p className="truncate text-[0.68rem] leading-tight text-muted-foreground" title={`Descarga: ${row.descargaLabel}`}>
            <span className="font-semibold text-muted-foreground/50">D</span> {row.descargaLabel}
          </p>
        ) : null}
        {!row.carregamentoLabel && !row.descargaLabel && (
          row.reserva && row.standbyAt ? (
            <div className="leading-tight" title={`Em standby desde ${formatStandby(row.standbyAt)}`}>
              <p className="text-[0.58rem] font-semibold uppercase tracking-wide text-amber-600/80 dark:text-amber-400/80">Standby desde</p>
              <p className="text-xs text-amber-700 dark:text-amber-300">{formatStandby(row.standbyAt)}</p>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground/40">—</span>
          )
        )}
      </td>

      {/* Motorista + Placa — editável inline (combobox) */}
      <td className="px-3 py-2 align-top">
        <AllocCell
          row={row}
          enriched={enriched}
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
  onAssignReserva,
  assigningReservaId,
  standbyCountByRoute,
  onPullStandby,
}: {
  rows: SheetMonitorRowType[];
  resolveEnriched: (row: SheetMonitorRowType) => SheetMonitorEnrichedRow | undefined;
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
  onAssignReserva: (input: { reservaId: string; targetLh: string }) => void;
  assigningReservaId: string | null;
  standbyCountByRoute: Map<string, number>;
  onPullStandby: (lh: string) => void;
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

  // Zona de soltura: terços maiores nas bordas (mover na fila = descer/subir) e
  // um miolo menor para trocar. Antes o miolo ocupava 50% e quase todo drop caía
  // em "trocar"; agora a maior parte da linha é "mover na fila".
  const intentFromEvent = (e: React.DragEvent): "swap" | "before" | "after" => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height || 1;
    if (y < h * 0.4) return "before";   // metade de cima → insere ACIMA (move na fila)
    if (y > h * 0.6) return "after";    // metade de baixo → insere ABAIXO (move na fila)
    return "swap";                      // miolo (20%) → troca
  };

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
    // Carga da planilha alvo: corpo = trocar; borda = descer/subir a fila.
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (targetRow.lh === dragging) { setDropTarget(null); return; }
    const intent = intentFromEvent(e);
    setDropTarget((prev) => (prev && prev.key === targetRow.rowKey && prev.intent === intent ? prev : { key: targetRow.rowKey, intent }));
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
      if (targetRow.source === "sistema" || targetRow.reserva) { toast.error("Solte o standby numa carga da planilha."); return; }
      const reservaId = src.slice("reserva:".length);
      const reservaRow = rowsRef.current.find((r) => r.reserva && `reserva:${r.reservaId}` === src);
      if (targetRow.pinned) { toast.error("A carga de destino está fixada. Desafixe antes de puxar o standby."); return; }
      if (!allocEditPolicy(targetRow).editable) { toast.error("A carga de destino está travada (já em atribuição no ASPX)."); return; }
      if (!reservaRow) { toast.error("A lista atualizou durante o arrasto. Tente puxar o standby de novo."); return; }
      if (routeKeyOf(targetRow) !== routeKeyOf(reservaRow)) {
        toast.error("O standby é de outra rota. Puxe para uma carga da mesma rota (origem → destino).");
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

    // ALVO = carga da PLANILHA → reordenação da fila por posição (comportamento atual).
    const srcIdx = list.findIndex((r) => r.lh === src);
    const dstIdx = list.findIndex((r) => r.rowKey === targetRow.rowKey);
    if (srcIdx < 0 || dstIdx < 0) return;
    const items = list.map((r) => ({ lh: r.lh, alloc: { motorista: r.motoristas || "", cavalo: r.cavalo || "", carreta: r.carreta || "" } }));
    const intent = intentFromEvent(e);
    const moves =
      intent === "swap" ? computeSwapMoves(items, srcIdx, dstIdx)
        : intent === "before" ? computeShiftMoves(items, srcIdx, dstIdx)
          : computeShiftMoves(items, srcIdx, dstIdx + 1);
    if (moves.length === 0) return;
    // Bloqueia se qualquer linha afetada (alvo ou intermediárias do "descer fila")
    // for reserva/sistema, fixa, de outra rota ou travada por status (ASPX).
    const affected = moves.map((m) => list.find((x) => x.lh === m.lh)).filter(Boolean) as SheetMonitorRowType[];
    if (affected.some((r) => r.reserva || r.source === "sistema")) {
      toast.error("Linha de reserva ou carga do sistema não entra na reordenação da fila.");
      return;
    }
    if (affected.some((r) => routeKeyOf(r) !== routeKeyOf(srcRow))) {
      toast.error("Só dá pra arrastar dentro da mesma rota (origem → destino). Para mudar entre rotas, edite manualmente.");
      return;
    }
    if (affected.some((r) => r.pinned)) {
      toast.error("Não dá para reordenar: há carga fixada na fila. Desafixe antes de mover.");
      return;
    }
    if (affected.some((r) => !allocEditPolicy(r).editable)) {
      toast.error("Não dá para reordenar: há carga travada (já em atribuição no ASPX).");
      return;
    }
    onReassign(moves);
  }, [onReassign, onAssignReserva]);

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
        <table className="w-full min-w-[1040px] table-fixed text-sm">
          <colgroup>
            <col className="w-[140px]" />
            <col className="w-[96px]" />
            <col className="w-[120px]" />
            <col />
            <col className="w-[150px]" />
            <col className="w-[360px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-border/60 bg-primary/[0.028]">
              {(["Status", "LH", "Cliente", "Rota", "Agenda", "Motorista / Placa"] as const).map((col) => (
                <th key={col} className="px-3 py-2 text-left text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
                  {col}
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
  const [allocForm, setAllocForm] = useState({ motorista: "", cavalo: "", carreta: "", status: "", tipo: "" });
  const [confirmAspx, setConfirmAspx] = useState(false);

  // Pré-preenche com a alocação EFETIVA: override do operador (alloc_*) ?? planilha.
  useEffect(() => {
    if (!row) return;
    setAllocForm({
      motorista: alloc?.alloc_motorista ?? row.motoristas ?? "",
      cavalo: alloc?.alloc_cavalo ?? row.cavalo ?? "",
      carreta: alloc?.alloc_carreta ?? row.carreta ?? "",
      status: alloc?.alloc_status ?? row.status ?? "",
      tipo: alloc?.alloc_tipo ?? (row.tipo && row.tipo !== "SISTEMA" ? row.tipo : "") ?? "",
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

  if (!row) return null;

  // Trava motorista/veículo conforme o status (mesma regra da tabela) E pelo
  // "fixo". O status operacional continua editável (o bloqueio é só de m/v).
  const { editable, aspxWarning } = allocEditPolicy(row);
  const pinned = Boolean(alloc?.alloc_pinned ?? row.pinned);
  const allocEditable = editable && !pinned;

  const doSave = () => {
    saveAllocation.mutate({
      lh: row.lh,
      // Linha travada: preserva o motorista/veículo atual (alloc override; null
      // = continua refletindo a planilha) e grava só o status.
      motorista: allocEditable ? allocForm.motorista : (alloc?.alloc_motorista ?? ""),
      cavalo: allocEditable ? allocForm.cavalo : (alloc?.alloc_cavalo ?? ""),
      carreta: allocEditable ? allocForm.carreta : (alloc?.alloc_carreta ?? ""),
      status: allocForm.status,
      tipo: allocForm.tipo, // tipo é livre (não trava por pinned/status)
    });
  };

  // "Aguardando chegar no cliente": só pergunta se o motorista/veículo realmente
  // mudou (mudança só de status não dispara o pop-up).
  const mvChanged =
    allocForm.motorista !== (alloc?.alloc_motorista ?? row.motoristas ?? "") ||
    allocForm.cavalo !== (alloc?.alloc_cavalo ?? row.cavalo ?? "") ||
    allocForm.carreta !== (alloc?.alloc_carreta ?? row.carreta ?? "");
  const requestSave = () => {
    if (allocEditable && aspxWarning && mvChanged) setConfirmAspx(true);
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
            </div>
            <StatusBadge status={row.status} />
          </DialogHeader>

          {/* Scrollable body */}
          <div className="min-h-0 flex-1 overflow-y-auto">

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
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
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

    <ConfirmDialog
      open={confirmAspx}
      title="Confirmar troca de motorista/veículo"
      description={aspxConfirmDescription(1)}
      onConfirm={() => { setConfirmAspx(false); doSave(); }}
      onCancel={() => setConfirmAspx(false)}
    />
    </>
  );
}

// Seletor de standby — alternativa ao arrastar (funciona mesmo com o standby
// noutra página). Lista os motoristas em standby da MESMA rota da carga.
function StandbyPickerModal({ open, carga, standbys, onPick, onClose }: {
  open: boolean;
  carga: SheetMonitorRowType | null;
  standbys: SheetMonitorRowType[];
  onPick: (reservaId: string) => void;
  onClose: () => void;
}) {
  // Mantém o último conteúdo enquanto o modal anima a saída: ao fechar, carga/lista
  // viram null/[] no mesmo render — se o conteúdo "esvaziar" durante a animação de
  // saída, o Radix Presence trava e o diálogo não desmonta. Congela o que mostrar.
  const lastRef = useRef<{ carga: SheetMonitorRowType | null; standbys: SheetMonitorRowType[] }>({ carga: null, standbys: [] });
  if (open && carga) lastRef.current = { carga, standbys };
  const viewCarga = open ? carga : lastRef.current.carga;
  const viewStandbys = open ? standbys : lastRef.current.standbys;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <UserPlus className="h-4 w-4 text-amber-500" /> Puxar standby para a carga
          </DialogTitle>
          <DialogDescription className="pt-1 text-sm text-muted-foreground">
            {viewCarga ? (
              <>Carga <span className="font-mono font-semibold text-foreground">{viewCarga.lh}</span> — {routeKeyOf(viewCarga)}. Escolha um motorista em standby desta rota:</>
            ) : "—"}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-1.5 overflow-y-auto pr-1">
          {viewStandbys.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Nenhum motorista em standby nesta rota.</p>
          ) : viewStandbys.map((s) => (
            <button
              key={s.reservaId ?? s.rowKey}
              type="button"
              disabled={!s.reservaId}
              onClick={() => { if (s.reservaId) { onPick(s.reservaId); onClose(); } }}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-left transition-colors hover:border-amber-400 hover:bg-amber-50/60 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-amber-500/10"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{s.motoristas || "—"}</p>
                <p className="truncate text-[0.7rem] text-muted-foreground">
                  {s.cavalo || "—"}{s.carreta ? ` · ${s.carreta}` : ""}
                  {s.standbyAt ? ` · standby desde ${formatStandby(s.standbyAt)}` : ""}
                </p>
              </div>
              <UserPlus className="h-4 w-4 shrink-0 text-amber-500" />
            </button>
          ))}
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
  const [routeFilter, setRouteFilter] = useState("todos");
  const [editFilter, setEditFilter] = useState<"todos" | "editaveis" | "bloqueadas">("todos");
  const [dateFromFilter, setDateFromFilter] = useState("");
  const [dateToFilter, setDateToFilter] = useState("");
  const [page, setPage] = useState(0);
  const [selectedRow, setSelectedRow] = useState<SheetMonitorRowType | null>(null);
  const [editingLh, setEditingLh] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(search);

  // Enrich loop state
  const enrichingRef = useRef(false);
  const [enrichProgress, setEnrichProgress] = useState<{ done: number; total: number } | null>(null);

  const { data: monitorData, error: queryError, isFetching, isLoading } = useQuery({
    queryKey: [...SHEET_MONITOR_QUERY_KEY],
    queryFn: fetchSheetMonitor,
    ...SHEET_MONITOR_QUERY_OPTIONS,
  });

  const rawItems = monitorData?.items ?? EMPTY_ROWS;
  const enrichedByLh = monitorData?.enrichedByLh ?? EMPTY_ENRICHED;
  const enrichedByCargoId = monitorData?.enrichedByCargoId ?? EMPTY_ENRICHED;
  const allocByLh = monitorData?.allocByLh ?? EMPTY_ALLOC;
  // Selo resolvido por MOTORISTA/PLACA (não por lh) → troca na fila reflete na hora.
  const seloMaps = useMemo(() => buildSeloMaps(enrichedByLh, enrichedByCargoId), [enrichedByLh, enrichedByCargoId]);
  const resolveEnriched = useCallback((row: SheetMonitorRowType) => resolveRowSelo(row, seloMaps), [seloMaps]);

  // Alocação efetiva: o override do operador (alloc_*) sobrepõe o valor da
  // planilha. Reflete na tabela/contadores o que foi editado no Monitor.
  const items = useMemo(() => {
    if (Object.keys(allocByLh).length === 0) return rawItems;
    return rawItems.map((row) => {
      const a = allocByLh[row.lh];
      if (!a) return row;
      const motoristas = a.alloc_motorista ?? row.motoristas;
      const status = a.alloc_status ?? row.status;
      return {
        ...row,
        motoristas,
        cavalo: a.alloc_cavalo ?? row.cavalo,
        carreta: a.alloc_carreta ?? row.carreta,
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
      const run = () => mutateInlineAlloc(payload);
      // "Aguardando chegar no cliente" → confirma a troca (motorista/veículo no ASPX).
      if (target && allocEditPolicy(target).aspxWarning) setAspxConfirm({ count: 1, run });
      else run();
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

  // ── Puxar um standby (reserva) para uma carga (arrastar reserva → carga) ───────
  const { mutate: mutateAssignReserva, isPending: assigningReserva, variables: assignReservaVars } = useMutation({
    mutationFn: assignReservaToCarga,
    onSuccess: (data) => {
      toast.success(
        data.bumped
          ? "Standby alocado — o motorista anterior voltou para a reserva."
          : "Standby alocado na carga.",
      );
      void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] });
      // O selo Angellira/ASPX da carga é re-enriquecido em background → refetch atrasado.
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: [...SHEET_MONITOR_QUERY_KEY] }), 2000);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Não foi possível puxar o standby para a carga.");
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

  // Rotas do filtro: quando há filtro de DATA, mostra só as rotas que têm carga
  // no intervalo (as "principais" do dia) — não todas. Mesma lógica de data do
  // filteredRows; reserva (standby, sem data) sempre entra.
  const routeOptions = useMemo(() => {
    const fromTs = dateFromFilter ? new Date(dateFromFilter).getTime() : null;
    const toTs = dateToFilter ? new Date(dateToFilter).getTime() : null;
    const inDate = (row: SheetMonitorRowType) => {
      if (fromTs === null && toTs === null) return true;
      if (row.reserva) return true;
      if (!row.data) return false;
      const horario = row.horario || "00:00:00";
      const ts = new Date(`${row.data}T${horario.length === 5 ? `${horario}:00` : horario}`).getTime();
      if (!Number.isFinite(ts)) return false;
      if (fromTs !== null && ts < fromTs) return false;
      if (toTs !== null && ts > toTs) return false;
      return true;
    };
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
  }, [items, dateFromFilter, dateToFilter]);

  // Se a rota selecionada deixar de existir (ex.: filtro de data a removeu),
  // volta para "todos" pra não ficar travado num filtro sem resultado.
  useEffect(() => {
    if (routeFilter !== "todos" && !routeOptions.some((r) => r.key === routeFilter)) setRouteFilter("todos");
  }, [routeOptions, routeFilter]);

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

    if (routeFilter !== "todos")
      result = result.filter((r) => routeKeyOf(r) === routeFilter);

    if (assignmentFilter === "com_motorista") result = result.filter((r) => Boolean(r.motoristas));
    else if (assignmentFilter === "sem_motorista") result = result.filter((r) => !r.motoristas);
    else if (assignmentFilter === "disponiveis") result = result.filter((r) => !r.motoristas && !r.status);

    if (editFilter === "editaveis") result = result.filter((r) => allocEditPolicy(r).editable && !r.pinned);
    else if (editFilter === "bloqueadas") result = result.filter((r) => !allocEditPolicy(r).editable || r.pinned);

    if (dateFromFilter || dateToFilter) {
      const fromTs = dateFromFilter ? new Date(dateFromFilter).getTime() : null;
      const toTs = dateToFilter ? new Date(dateToFilter).getTime() : null;
      result = result.filter((row) => {
        if (row.reserva) return true; // standby (sem data) — sempre visível na fila da rota
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

    // Ordem da fila: grupo de status (Disponível → Reservado → outros → standby)
    // e, dentro de cada grupo, por data + horário DESC (mais recente no topo,
    // igual ao snapshot). Status/motorista são os EFETIVOS (já com overlay alloc).
    const statusGroup = (r: SheetMonitorRowType) => {
      if (r.reserva) return 3; // standby (reserva sem carga) sempre por último
      const s = (r.status || "").trim().toLowerCase();
      if (!s) return r.motoristas ? 1 : 0; // sem status: com motorista=Reservado, sem=Disponível
      if (/dispon/.test(s)) return 0;
      if (/reserv/.test(s)) return 1;
      return 2;
    };
    const dtKey = (r: SheetMonitorRowType) => (r.data ? `${r.data} ${r.horario || ""}` : "");
    return [...result].sort((a, b) => {
      const g = statusGroup(a) - statusGroup(b);
      if (g !== 0) return g;
      // Standby (reserva): mais ANTIGO primeiro (FIFO — quem está esperando há mais tempo).
      if (a.reserva && b.reserva) {
        const sa = a.standbyAt || "";
        const sb = b.standbyAt || "";
        if (sa === sb) return 0;
        return sa < sb ? -1 : 1;
      }
      const ka = dtKey(a);
      const kb = dtKey(b);
      if (!ka && !kb) return 0;
      if (!ka) return 1; // sem data por último dentro do grupo
      if (!kb) return -1;
      if (ka === kb) return 0;
      return ka < kb ? 1 : -1; // data+horário DESC
    });
  }, [items, deferredSearch, statusFilter, tipoFilter, routeFilter, assignmentFilter, editFilter, dateFromFilter, dateToFilter]);

  const hasActiveFilters =
    deferredSearch.trim().length > 0 || statusFilter !== "todos" || tipoFilter !== "todos" ||
    routeFilter !== "todos" || assignmentFilter !== "todos" || editFilter !== "todos" || dateFromFilter.length > 0 || dateToFilter.length > 0;

  useEffect(() => { setPage(0); }, [deferredSearch, statusFilter, tipoFilter, routeFilter, assignmentFilter, editFilter, dateFromFilter, dateToFilter]);

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
      // Limpa o banner "consulta concluída" de uma re-consulta manual anterior —
      // senão ele fica pendurado até desmontar a tela.
      setEnrichProgress(null);
      // Fila operacional usa status da planilha — invalidar para refletir status novo apos sync.
      queryClient.invalidateQueries({ queryKey: ["operator", "public-load-leads"] });
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

              <select value={routeFilter} onChange={(e) => setRouteFilter(e.target.value)}
                title="Filtrar por rota" aria-label="Filtrar por rota"
                className="max-w-[220px] rounded-xl border border-border/80 bg-white/92 px-3 py-2.5 text-sm outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10">
                <option value="todos">Todas as rotas</option>
                {routeOptions.map((r) => (
                  <option key={r.key} value={r.key}>{r.codigo != null ? `R${r.codigo} — ${r.key}` : r.key}</option>
                ))}
              </select>

              <select value={assignmentFilter} onChange={(e) => setAssignmentFilter(e.target.value)}
                className="rounded-xl border border-border/80 bg-white/92 px-3 py-2.5 text-sm outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40">
                <option value="todos">Todos</option>
                <option value="com_motorista">Com motorista</option>
                <option value="sem_motorista">Sem motorista</option>
                <option value="disponiveis">Disponiveis p/ importacao</option>
              </select>

              <select value={editFilter} onChange={(e) => setEditFilter(e.target.value as "todos" | "editaveis" | "bloqueadas")}
                title="Filtrar por edição" aria-label="Filtrar por edição de motorista/veículo"
                className="rounded-xl border border-border/80 bg-white/92 px-3 py-2.5 text-sm outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40">
                <option value="todos">Edição: todas</option>
                <option value="editaveis">Editáveis (motorista/veículo)</option>
                <option value="bloqueadas">Bloqueadas (em atribuição no ASPX)</option>
              </select>

              <input type="datetime-local" value={dateFromFilter} onChange={(e) => setDateFromFilter(e.target.value)}
                className="rounded-xl border border-border/80 bg-white/92 px-3 py-2.5 text-sm outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40"
                title="Carregamento a partir de" aria-label="Carregamento a partir de" />
              <input type="datetime-local" value={dateToFilter} onChange={(e) => setDateToFilter(e.target.value)} min={dateFromFilter || undefined}
                className="rounded-xl border border-border/80 bg-white/92 px-3 py-2.5 text-sm outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40"
                title="Carregamento até" aria-label="Carregamento até" />

              {hasActiveFilters && (
                <button type="button"
                  onClick={() => { setSearch(""); setStatusFilter("todos"); setTipoFilter("todos"); setRouteFilter("todos"); setAssignmentFilter("todos"); setEditFilter("todos"); setDateFromFilter(""); setDateToFilter(""); }}
                  className="inline-flex items-center gap-1 rounded-xl border border-border/80 bg-white px-3 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground dark:bg-muted/40">
                  <X className="h-3.5 w-3.5" />Limpar
                </button>
              )}


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

              <button type="button" onClick={() => handleStartEnrich(true)} disabled={isEnriching}
                title="Re-consulta Angellira/ASPX de todas as linhas e atualiza os selos no banco"
                className="inline-flex items-center gap-1.5 rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2.5 text-xs font-semibold text-sky-700 hover:bg-sky-500/20 disabled:opacity-50 dark:text-sky-300">
                <BadgeCheck className={cn("h-3.5 w-3.5", isEnriching && "animate-pulse")} />
                {isEnriching ? "Consultando..." : "Atualizar consultas"}
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

        {/* ── Tabela + datalists ── */}
        {!noSnapshot && (
          <>
            <MonitorDatalists driverOptions={driverOptions} cavaloOptions={cavaloOptions} carretaOptions={carretaOptions} tipoOptions={tipoOptions} />

            <section className="admin-panel overflow-hidden">
              <SheetMonitorTable
                rows={paginatedRows}
                resolveEnriched={resolveEnriched}
                allocByLh={allocByLh}
                selectedLh={selectedRow?.lh ?? null}
                editingLh={editingLh}
                savingLh={savingLh}
                pinningLh={pinningLh}
                loading={loading}
                reassigning={reassigning}
                onSelect={handleSelectRow}
                onStartEdit={handleStartEdit}
                onCancelEdit={handleCancelEdit}
                onSaveInline={handleSaveInline}
                onTogglePin={handleTogglePin}
                onReassign={handleReassign}
                onAssignReserva={handleAssignReserva}
                assigningReservaId={assigningReservaId}
                standbyCountByRoute={standbyCountByRoute}
                onPullStandby={handlePullStandby}
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

      {/* ── Confirmação ASPX (edição inline / arrastar) ── */}
      <ConfirmDialog
        open={aspxConfirm !== null}
        title="Confirmar troca de motorista/veículo"
        description={aspxConfirm ? aspxConfirmDescription(aspxConfirm.count) : ""}
        onConfirm={() => { aspxConfirm?.run(); setAspxConfirm(null); }}
        onCancel={() => setAspxConfirm(null)}
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

      {/* ── Puxar standby para uma carga (alternativa ao arrastar) ── */}
      <StandbyPickerModal
        open={standbyPickerLh !== null}
        carga={standbyPickerCarga}
        standbys={standbyPickerList}
        onPick={(reservaId) => { if (standbyPickerLh) handleAssignReserva({ reservaId, targetLh: standbyPickerLh }); }}
        onClose={() => setStandbyPickerLh(null)}
      />
    </div>
  );
}
