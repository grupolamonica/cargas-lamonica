import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Ban, BadgeCheck, CheckCircle2, ChevronDown, ChevronUp, Clock, Download, Loader2, MessageCircle, Phone, Route, Search, ShieldCheck, Truck, User, UserPlus } from "lucide-react";
import { differenceInDays } from "date-fns";
import { toast } from "sonner";

import ClientLogo from "@/components/ClientLogo";
import DashboardHeader from "@/components/DashboardHeader";
import DriverDetailModal, { type DriverDetailModalData } from "@/components/DriverDetailModal";
import OperatorPacoteLeadCard, { type DriverCandidatura, type PacoteLeadItem } from "@/components/operator/OperatorPacoteLeadCard";
import { cn } from "@/lib/utils";
import { confirmAction } from "@/lib/confirm";
import { useOperatorPermissions } from "@/hooks/useOperatorPermissions";
import { buildDisplayDateTime, formatFullDateTime, formatShortDateTime } from "@/lib/dateDisplay";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { ApiError, approveOperatorLoadLead, cancelOperatorLoadLead, createDirectAllocation, fetchOperatorLoadLeads, revalidateQueuedOperatorLeads, revalidateQueuedOperatorLeadsAspx, type DirectAllocationPayload, type OperatorLeadGroup, type OperatorLeadPacoteMeta, type PublicLeadValidationSummary } from "@/services/loadClaims";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { VEHICLE_PROFILE_OPTIONS } from "@/lib/vehicleProfiles";
import { fetchOperatorClientes, fetchSheetMonitor, type SheetMonitorRow } from "@/services/readModels";

interface SheetAllocation {
  driverName: string;
  status: string;
}

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Em aberto", RESERVED: "Reservado", BOOKED: "Concluída",
  EXPIRED: "Expirado", CANCELLED: "Cancelado", COMPLETED: "Concluída",
  DESCARREGADO: "Descarregado", CANCELADO: "Cancelado",
  "CTE ENVIADO": "CTE Enviado", DESCARREGANDO: "Descarregando",
  "AGUARDANDO CARREGAMENTO": "Aguard. Carregamento",
  "AGUARDANDO CHEGAR NO CLIENTE": "Aguard. Chegada",
  "AGUARDANDO DESCARGA": "Aguard. Descarga",
  "NO SHOW": "No Show",
};

function resolveStatusStyle(status: string) {
  const n = (status || "").toLowerCase().trim();
  const label = STATUS_LABELS[status] ?? STATUS_LABELS[(status || "").toUpperCase()] ?? status ?? "—";
  if (!n || n === "open")                    return { dot: "bg-blue-500",    bg: "bg-blue-50 text-blue-800 dark:bg-blue-500/15 dark:text-blue-200",       ring: "outline-blue-500 dark:outline-blue-400",     shadow: "shadow-[0_0_0_6px_rgba(59,130,246,0.15)]",    badge: "bg-blue-500 text-white",    label };
  if (/^reserved$|^reservado$/.test(n))      return { dot: "bg-violet-500",  bg: "bg-violet-50 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200", ring: "outline-violet-500 dark:outline-violet-400", shadow: "shadow-[0_0_0_6px_rgba(139,92,246,0.18)]",   badge: "bg-violet-500 text-white",  label };
  if (/descarregad|conclu|finaliz|entregue|booked/.test(n)) return { dot: "bg-teal-500", bg: "bg-teal-50 text-teal-800 dark:bg-teal-500/15 dark:text-teal-200", ring: "outline-teal-500 dark:outline-teal-400",     shadow: "shadow-[0_0_0_6px_rgba(20,184,166,0.15)]",  badge: "bg-teal-500 text-white",    label };
  if (/descarregando/.test(n))               return { dot: "bg-cyan-500",    bg: "bg-cyan-50 text-cyan-800 dark:bg-cyan-500/15 dark:text-cyan-200",         ring: "outline-cyan-500 dark:outline-cyan-400",     shadow: "shadow-[0_0_0_6px_rgba(6,182,212,0.15)]",    badge: "bg-cyan-500 text-white",    label };
  if (/cte/.test(n))                         return { dot: "bg-sky-500",     bg: "bg-sky-50 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200",             ring: "outline-sky-500 dark:outline-sky-400",       shadow: "shadow-[0_0_0_6px_rgba(14,165,233,0.15)]",   badge: "bg-sky-500 text-white",     label };
  if (/cancel/.test(n))                      return { dot: "bg-red-400",     bg: "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-200",             ring: "outline-red-400 dark:outline-red-400",       shadow: "shadow-[0_0_0_6px_rgba(248,113,113,0.15)]",  badge: "bg-red-400 text-white",     label };
  if (/no[\s_]?show/.test(n))                return { dot: "bg-rose-500",    bg: "bg-rose-50 text-rose-800 dark:bg-rose-500/15 dark:text-rose-200",         ring: "outline-rose-500 dark:outline-rose-400",     shadow: "shadow-[0_0_0_6px_rgba(244,63,94,0.15)]",    badge: "bg-rose-500 text-white",    label };
  if (/aguardando.{0,6}chegar/.test(n))      return { dot: "bg-amber-500",   bg: "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",     ring: "outline-amber-500 dark:outline-amber-400",   shadow: "shadow-[0_0_0_6px_rgba(245,158,11,0.15)]",   badge: "bg-amber-500 text-white",   label };
  if (/aguardando.{0,6}carr/.test(n))        return { dot: "bg-orange-500",  bg: "bg-orange-50 text-orange-800 dark:bg-orange-500/15 dark:text-orange-200", ring: "outline-orange-500 dark:outline-orange-400", shadow: "shadow-[0_0_0_6px_rgba(249,115,22,0.15)]",   badge: "bg-orange-500 text-white",  label };
  if (/aguardando/.test(n))                  return { dot: "bg-amber-400",   bg: "bg-amber-50 text-amber-700 dark:bg-amber-400/15 dark:text-amber-200",     ring: "outline-amber-400 dark:outline-amber-300",   shadow: "shadow-[0_0_0_6px_rgba(251,191,36,0.15)]",   badge: "bg-amber-400 text-white",   label };
  if (/carregando|em.tr[aâ]/.test(n))        return { dot: "bg-indigo-500",  bg: "bg-indigo-50 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-200", ring: "outline-indigo-500 dark:outline-indigo-400", shadow: "shadow-[0_0_0_6px_rgba(99,102,241,0.15)]",   badge: "bg-indigo-500 text-white",  label };
  if (/expired/.test(n))                     return { dot: "bg-slate-400",   bg: "bg-slate-100 text-slate-600 dark:bg-slate-500/20 dark:text-slate-300",    ring: "outline-slate-400 dark:outline-slate-400",   shadow: "shadow-[0_0_0_6px_rgba(148,163,184,0.12)]",  badge: "bg-slate-400 text-white",   label };
  return                                            { dot: "bg-emerald-500",  bg: "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200", ring: "outline-emerald-500 dark:outline-emerald-400", shadow: "shadow-[0_0_0_6px_rgba(16,185,129,0.18)]", badge: "bg-emerald-500 text-white",  label };
}

function LoadStatusBadge({ status }: { status: string }) {
  const s = resolveStatusStyle(status);
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.68rem] font-semibold", s.bg)}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

interface LeadsProps {
  historicoMode?: boolean;
}

const LEADS_QUERY_KEY = ["operator", "public-load-leads"];
const EMPTY_GROUPS: OperatorLeadGroup[] = [];
// Status terminais — cargas nesses estados so aparecem em "Historico fila".
const TERMINAL_LOAD_STATUSES = ["EXPIRED", "CANCELLED", "COMPLETED", "FAILED", "BOOKED"] as const;

interface VigenciaItem {
  label: string;
  daysLeft: number; // negativo = já vencido
}

function buildVigenciaItems(validation: PublicLeadValidationSummary): VigenciaItem[] {
  const items: VigenciaItem[] = [];
  const today = new Date();

  // Motorista
  const driverUntil = validation.driver.angelira.validUntil;
  if (driverUntil) {
    items.push({
      label: "Motorista",
      daysLeft: differenceInDays(new Date(driverUntil), today),
    });
  }

  // Placas
  for (const plate of validation.plates) {
    if (plate.validUntil) {
      items.push({
        label: plate.label,
        daysLeft: differenceInDays(new Date(plate.validUntil), today),
      });
    }
  }

  return items;
}

function buildRouteLabel(group: OperatorLeadGroup) {
  return `${group.load.origem} -> ${group.load.destino}`;
}

function buildTrailerPlateLabel(lead: OperatorLeadGroup["leads"][number]) {
  return [lead.trailerPlate, lead.trailerPlate2].filter((value) => value && value.trim()).join(" | ") || "Sem carreta";
}

function maskCpfSuffix(cpf: string | null | undefined) {
  const digits = (cpf ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return `*${digits.slice(-2)}`;
}

function formatPhoneDisplay(phone: string | null | undefined) {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return phone ?? "";
}

/**
 * Sublabel mostrado abaixo do nome (ou abaixo do telefone, quando nao ha
 * nome): "CPF *XX  ·  (DD) NNNNN-NNNN" ou "(sem cadastro)" quando so phone.
 */
function buildDriverSubLabel(lead: OperatorLeadGroup["leads"][number]) {
  const cpfMask = maskCpfSuffix(lead.cpf);
  const phoneFormatted = formatPhoneDisplay(lead.phone);
  if (lead.driverName && lead.driverName.trim()) {
    // Quando temos o nome, sublabel mostra CPF + phone.
    return [cpfMask ? `CPF ${cpfMask}` : null, phoneFormatted].filter(Boolean).join(" · ");
  }
  // Sem nome: ja exibimos o phone como label principal; sublabel sinaliza falta de cadastro.
  return cpfMask ? `CPF ${cpfMask} · sem cadastro` : "sem cadastro";
}

/**
 * Escapa um valor para célula CSV. Usa `;` como separador (padrão do Excel
 * pt-BR) — envolve em aspas quando contém `;`, aspas ou quebra de linha.
 */
function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename: string, headers: string[], rows: string[][]) {
  const lines = [headers, ...rows].map((cols) => cols.map(csvCell).join(";"));
  // BOM (U+FEFF) para o Excel reconhecer UTF-8 e não corromper acentos.
  const blob = new Blob([`\uFEFF${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

const Leads = ({ historicoMode = false }: LeadsProps = {}) => {
  const queryClient = useQueryClient();
  const permissions = useOperatorPermissions();
  const [approvingLeadId, setApprovingLeadId] = useState<string | null>(null);
  const [cancellingLeadId, setCancellingLeadId] = useState<string | null>(null);
  const [revalidating, setRevalidating] = useState(false);
  const [revalidatingAspx, setRevalidatingAspx] = useState(false);
  const [selectedDriver, setSelectedDriver] = useState<DriverDetailModalData | null>(null);
  const [search, setSearch] = useState("");
  const [loadStatusFilter, setLoadStatusFilter] = useState("todos");
  const [leadStatusFilter, setLeadStatusFilter] = useState("todos");
  const [clienteFilter, setClienteFilter] = useState("");
  const [collapsedLoadIds, setCollapsedLoadIds] = useState<string[]>([]);
  const [directAllocLoadId, setDirectAllocLoadId] = useState<string | null>(null);
  const [directAllocLoading, setDirectAllocLoading] = useState(false);
  const [directAllocForm, setDirectAllocForm] = useState<DirectAllocationPayload & { trailerPlate: string }>({
    cpf: "", phone: "", horsePlate: "", vehicleType: "CARRETA", trailerPlate: "",
  });
  const [page, setPage] = useState(1);
  const knownLoadIdsRef = useRef<string[]>([]);
  const autoRevalidateFiredRef = useRef<number>(0);
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());

  const { data, error, isLoading, isFetching } = useQuery({
    queryKey: LEADS_QUERY_KEY,
    queryFn: fetchOperatorLoadLeads,
    // Backoff: 30s quando ainda não temos dados; 60s estável uma vez que a
    // primeira página renderizou. Reduz ~50% do tráfego de polling no fluxo
    // estável de operador sem perder responsividade no carregamento inicial.
    refetchInterval: (query) => (query.state.data ? 60_000 : 30_000),
    refetchIntervalInBackground: false,
    // refetchOnWindowFocus desligado: o polling (60s) + realtime debounced já
    // mantêm a fila fresca. Com focus-refetch ligado, alternar abas dispara
    // refetch da query pesada (238 leads × 6 JOINs) desnecessariamente — somava
    // ao egress do pooler (incidente 70GB).
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    staleTime: 15_000,
    // Retry transient errors (5xx) with exponential backoff. 4xx errors
    // (auth, validation) sao terminais e nao devem ser retentados.
    retry: (failureCount, err) => {
      if (failureCount >= 2) return false;
      const status = (err as ApiError)?.status;
      return status === undefined || status >= 500;
    },
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
  });

  // Detecta erro transient (503 schema-drift) para banner amarelo
  // nao-bloqueante — dados antigos continuam visiveis enquanto retenta.
  const isTransientError = (error as ApiError | null | undefined)?.status === 503;

  // Snapshot da planilha para detectar aloca\u00e7\u00e3o externa (motorista preenchido no Google Sheets)
  const { data: sheetData } = useQuery({
    queryKey: ["operator", "sheet-monitor"],
    queryFn: () => fetchSheetMonitor({ refresh: false }),
    staleTime: 30_000,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const { data: clientesData } = useQuery({
    queryKey: ["operator", "clientes-selector"],
    queryFn: () => fetchOperatorClientes({ pageSize: "200" }),
    staleTime: 5 * 60_000,
  });
  const clienteOptions = clientesData?.items ?? [];

  const sheetAllocationByLh = useMemo(() => {
    const map = new Map<string, SheetAllocation>();
    const rows: SheetMonitorRow[] = sheetData?.items ?? [];
    for (const row of rows) {
      // Include rows with motorista OR with status — needed for Histórico where
      // sheet_lh is preserved and status column carries the operator's closure label.
      const hasMotorista = Boolean(row.motoristas?.trim());
      const hasStatus = Boolean(row.status?.trim());
      if (row.lh && (hasMotorista || hasStatus)) {
        map.set(row.lh.trim(), {
          driverName: row.motoristas?.trim() ?? "",
          status: row.status?.trim() ?? "",
        });
      }
    }
    return map;
  }, [sheetData]);

  useEffect(() => {
    // Debounce da invalidação: o canal `cargas` é ruidoso — o sheet sync faz
    // UPDATE em massa (centenas de linhas por ciclo), e cada linha emite um
    // evento postgres_changes. Sem debounce, cada evento disparava um refetch
    // imediato da query pesada (listOperatorPublicLoadLeads: 238 leads × 6
    // JOINs), gerando centenas de mil chamadas ao pooler (incidente 70GB de
    // egress). O debounce colapsa uma rajada de N eventos numa única
    // invalidação ~3s depois do último evento.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const invalidateLeadQueueDebounced = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void queryClient.invalidateQueries({ queryKey: LEADS_QUERY_KEY });
      }, 3_000);
    };

    const realtimeChannel = supabase
      .channel("operator-public-load-leads")
      .on("postgres_changes", { event: "*", schema: "public", table: "load_public_leads" }, () => {
        invalidateLeadQueueDebounced();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "cargas" }, () => {
        invalidateLeadQueueDebounced();
      })
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      void supabase.removeChannel(realtimeChannel);
    };
  }, [queryClient]);

  const groups = data?.groups ?? EMPTY_GROUPS;
  const filteredGroups = useMemo(() => {
    return groups
      .map((group) => {
        const isTerminal = TERMINAL_LOAD_STATUSES.includes(group.load.status);
        // Fila ativa oculta cargas terminais; Hist\u00f3rico mostra s\u00f3 elas (por padr\u00e3o).
        if (!historicoMode && isTerminal) {
          return null;
        }
        if (historicoMode && !isTerminal && loadStatusFilter === "todos") {
          return null;
        }

        const sheetAllocForFilter = group.load.sheetLh ? sheetAllocationByLh.get(group.load.sheetLh) : undefined;
        const effectiveStatusForFilter = sheetAllocForFilter?.status || group.load.sheetStatus || group.load.status;
        const matchesLoadStatus = loadStatusFilter === "todos" || effectiveStatusForFilter === loadStatusFilter;

        if (!matchesLoadStatus) {
          return null;
        }

        const loadText = [
          group.load.id,
          group.load.origem,
          group.load.destino,
          group.load.perfil,
          group.load.status,
        ]
          .join(" ")
          .toLowerCase();

        const loadMatchesSearch = !deferredSearch || loadText.includes(deferredSearch);

        const leads = group.leads.filter((lead) => {
          const matchesLeadStatus = leadStatusFilter === "todos" || lead.status === leadStatusFilter;

          if (!matchesLeadStatus) {
            return false;
          }

          if (!deferredSearch || loadMatchesSearch) {
            return true;
          }

          const leadText = [
            lead.id,
            lead.status,
            lead.phone,
            lead.cpf,
            lead.horsePlate,
            lead.trailerPlate,
            lead.trailerPlate2,
            lead.vehicleType,
            lead.validation?.overallStatus,
            ...(lead.validation?.warnings || []),
          ]
            .filter((v) => v != null)
            .join(" ")
            .toLowerCase();

          return leadText.includes(deferredSearch);
        });

        // Hide groups with no drivers at all.
        if (group.leads.length === 0) {
          return null;
        }

        // Hide when all leads were filtered out by active search/status filter.
        if (!leads.length) {
          return null;
        }

        return {
          ...group,
          leads,
          queueCount: leads.filter((lead) => lead.status === "QUEUED").length,
          totalLeads: leads.length,
        };
      })
      .filter((group): group is OperatorLeadGroup => Boolean(group));
  }, [groups, deferredSearch, loadStatusFilter, leadStatusFilter, historicoMode, sheetAllocationByLh]);

  const filteredByCliente = useMemo(() =>
    clienteFilter
      ? filteredGroups.filter((g) => g.load.clienteId === clienteFilter)
      : filteredGroups,
  [filteredGroups, clienteFilter]);

  /**
   * Pacote grouping: cargas que pertencem ao mesmo `pacoteMeta.id` sao
   * apresentadas como uma viagem casada unica em um card destacado, com TODAS
   * as candidaturas (N motoristas) agrupadas dentro do mesmo card. Antes o
   * agrupamento era por (pacote + driver) — gerando 1 card por motorista — e o
   * operador via duplicacao visual.
   *
   * Cargas avulsas (viagemId == null) seguem rendering original.
   */
  type RenderItem =
    | { kind: "carga"; group: OperatorLeadGroup }
    | {
        kind: "pacote";
        pacoteMeta: OperatorLeadPacoteMeta;
        /** Todas as paradas do pacote (cargas + lead correspondente), achatadas para compat com testes. */
        items: PacoteLeadItem[];
        /** Candidaturas agrupadas por motorista (cpf|phone). */
        candidaturas: DriverCandidatura[];
      };

  const renderItems = useMemo<RenderItem[]>(() => {
    const items: RenderItem[] = [];
    // Map<viagemId, RenderItem(pacote)> — 1 card por pacote, independente de quantos drivers.
    const pacoteIndex = new Map<string, Extract<RenderItem, { kind: "pacote" }>>();
    // Map auxiliar: viagemId -> Map<driverKey, DriverCandidatura> para deduplicar candidatos.
    const pacoteDriversIndex = new Map<string, Map<string, DriverCandidatura>>();

    filteredByCliente.forEach((group) => {
      const pacoteMeta = group.load.pacoteMeta ?? null;
      // group sem viagem_id ou sem leads = render avulso (mantem comportamento).
      if (!pacoteMeta || !group.load.viagemId || group.leads.length === 0) {
        items.push({ kind: "carga", group });
        return;
      }

      const indexKey = pacoteMeta.id;
      let bucket = pacoteIndex.get(indexKey);
      let driversMap = pacoteDriversIndex.get(indexKey);
      if (!bucket) {
        driversMap = new Map<string, DriverCandidatura>();
        bucket = {
          kind: "pacote",
          pacoteMeta,
          items: [],
          candidaturas: [],
        };
        pacoteIndex.set(indexKey, bucket);
        pacoteDriversIndex.set(indexKey, driversMap);
        items.push(bucket);
      }
      // driversMap eh garantido nao-nulo a partir daqui
      const drivers = driversMap as Map<string, DriverCandidatura>;

      // Leads sem identidade (defensivo) caem em um candidatura "anonima" agregada.
      const remainingLeads: typeof group.leads = [];

      group.leads.forEach((lead) => {
        const cpf = lead.cpf?.trim() ?? "";
        const phone = lead.phone?.trim() ?? "";
        if (!cpf && !phone) {
          remainingLeads.push(lead);
          return;
        }

        const driverKey = `${cpf}|${phone}`;
        let cand = drivers.get(driverKey);
        if (!cand) {
          cand = { cpf, phone, items: [] };
          drivers.set(driverKey, cand);
        }
        cand.items.push({ group, lead });
        bucket!.items.push({ group, lead });
      });

      if (remainingLeads.length > 0) {
        items.push({
          kind: "carga",
          group: { ...group, leads: remainingLeads },
        });
      }
    });

    // Ordena cada pacote por ordem_viagem ASC (multi-parada) e materializa candidaturas[].
    pacoteIndex.forEach((bucket, key) => {
      bucket.items.sort((a, b) => {
        const ordemA = a.group.load.ordemViagem ?? Number.MAX_SAFE_INTEGER;
        const ordemB = b.group.load.ordemViagem ?? Number.MAX_SAFE_INTEGER;
        return ordemA - ordemB;
      });
      const drivers = pacoteDriversIndex.get(key);
      if (drivers) {
        bucket.candidaturas = Array.from(drivers.values()).map((cand) => ({
          ...cand,
          items: cand.items.slice().sort((a, b) => {
            const ordemA = a.group.load.ordemViagem ?? Number.MAX_SAFE_INTEGER;
            const ordemB = b.group.load.ordemViagem ?? Number.MAX_SAFE_INTEGER;
            return ordemA - ordemB;
          }),
        }));
      }
    });

    return items;
  }, [filteredByCliente]);

  const PAGE_SIZE = 10;
  const totalPages = Math.ceil(renderItems.length / PAGE_SIZE);
  const paginatedItems = renderItems.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const hasActiveFilters =
    deferredSearch.length > 0 || loadStatusFilter !== "todos" || leadStatusFilter !== "todos" || clienteFilter !== "";
  const visibleLoadIds = useMemo(() => filteredByCliente.map((group) => group.load.id), [filteredByCliente]);
  const allVisibleGroupsCollapsed =
    visibleLoadIds.length > 0 && visibleLoadIds.every((loadId) => collapsedLoadIds.includes(loadId));

  // Reset known IDs and page when search/filter changes.
  useEffect(() => {
    knownLoadIdsRef.current = [];
    setPage(1);
  }, [historicoMode, loadStatusFilter, leadStatusFilter, deferredSearch, clienteFilter]);

  useEffect(() => {
    const unseenLoadIds = groups
      .map((group) => group.load.id)
      .filter((loadId) => !knownLoadIdsRef.current.includes(loadId));

    if (unseenLoadIds.length === 0) {
      return;
    }

    knownLoadIdsRef.current = [...knownLoadIdsRef.current, ...unseenLoadIds];
    setCollapsedLoadIds((current) => Array.from(new Set([...current, ...unseenLoadIds])));
  }, [groups]);

  // Fire-and-forget validation runs inside the submission request and can timeout/trip the
  // circuit breaker. Auto-retry after 15s so the operator doesn't have to click manually.
  useEffect(() => {
    if (historicoMode) return;

    const now = Date.now();
    const THREE_MIN_MS = 3 * 60 * 1000;
    const COOLDOWN_MS = 70 * 1000;

    const hasRecentStaleLeads = groups.some((group) =>
      group.leads.some((lead) => {
        if (lead.status !== "QUEUED") return false;
        if (lead.validation && lead.validation.overallStatus !== "UNAVAILABLE") return false;
        const submittedAt = lead.queuedAt ?? lead.preRegisteredAt;
        if (!submittedAt) return false;
        return now - new Date(submittedAt).getTime() <= THREE_MIN_MS;
      }),
    );

    if (!hasRecentStaleLeads) return;
    if (now - autoRevalidateFiredRef.current < COOLDOWN_MS) return;

    const timerId = window.setTimeout(async () => {
      autoRevalidateFiredRef.current = Date.now();
      try {
        setRevalidating(true);
        await revalidateQueuedOperatorLeads("fila");
        await queryClient.invalidateQueries({ queryKey: LEADS_QUERY_KEY });
      } catch {
        // silent — operator can use the Verificar no Angellira button
      } finally {
        setRevalidating(false);
      }
    }, 15_000);

    return () => window.clearTimeout(timerId);
  }, [groups, historicoMode, queryClient]);

  const summary = useMemo(() => {
    return filteredGroups.reduce(
      (accumulator, group) => {
        accumulator.loads += 1;
        accumulator.queued += group.leads.some((lead) => lead.status === "QUEUED") ? 1 : 0;
        accumulator.approved += group.leads.filter((lead) => lead.status === "APPROVED").length;
        return accumulator;
      },
      {
        loads: 0,
        queued: 0,
        approved: 0,
      },
    );
  }, [filteredGroups]);

  const handleApprove = async (loadId: string, leadId: string, validation?: PublicLeadValidationSummary | null) => {
    const ovs = validation?.overallStatus;
    const WARN_STATUSES = ["INVALID", "NOT_FOUND", "PLATE_MISMATCH", "INCOMPLETE"];

    if (ovs && WARN_STATUSES.includes(ovs)) {
      const reasons = (validation?.warnings || []).filter(Boolean).slice(0, 3);
      const reasonsText = reasons.length ? `\n\n• ${reasons.join("\n• ")}` : "";
      const prompt = `Este motorista tem pendências cadastrais.${reasonsText}\n\nConfirma a reserva mesmo assim?`;
      if (!window.confirm(prompt)) return;
    } else if (ovs === "UNAVAILABLE") {
      if (!window.confirm("Validação ainda não foi concluída para este motorista. Prosseguir mesmo assim?")) return;
    } else if (ovs === "EXPIRING" || ovs === "PARTIAL") {
      if (!window.confirm("Este motorista tem alertas de vigência próximos de vencer. Confirma a reserva?")) return;
    }

    try {
      setApprovingLeadId(leadId);
      await approveOperatorLoadLead(loadId, leadId);
      toast.success("Carga reservada para este motorista.");
      await queryClient.invalidateQueries({
        queryKey: LEADS_QUERY_KEY,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível reservar a carga agora.");
    } finally {
      setApprovingLeadId(null);
    }
  };

  const handleDirectAlloc = async () => {
    if (!directAllocLoadId) return;
    try {
      setDirectAllocLoading(true);
      await createDirectAllocation(directAllocLoadId, {
        cpf: directAllocForm.cpf,
        phone: directAllocForm.phone,
        horsePlate: directAllocForm.horsePlate,
        vehicleType: directAllocForm.vehicleType,
        trailerPlate: directAllocForm.trailerPlate || undefined,
      });
      toast.success("Motorista alocado diretamente. Carga reservada.");
      setDirectAllocLoadId(null);
      setDirectAllocForm({ cpf: "", phone: "", horsePlate: "", vehicleType: "CARRETA", trailerPlate: "" });
      await queryClient.invalidateQueries({ queryKey: LEADS_QUERY_KEY });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível realizar a alocação.");
    } finally {
      setDirectAllocLoading(false);
    }
  };

  const handleCancel = async (loadId: string, leadId: string, cpf: string | null) => {
    // UI-02: mensagem genérica para não vazar CPF em logs/screenshots/AT.
    // Para distinguir candidaturas no diálogo, exibimos apenas o sufixo do CPF (defense in depth).
    const cpfSuffix = cpf?.trim() ? cpf.trim().slice(-2).padStart(2, "*") : null;
    const tail = cpfSuffix ? ` (final ${cpfSuffix})` : "";
    const confirmed = confirmAction(
      `Tem certeza que deseja cancelar a candidatura${tail}? O motorista verá que a candidatura foi cancelada.`,
    );

    if (!confirmed) {
      return;
    }

    try {
      setCancellingLeadId(leadId);
      await cancelOperatorLoadLead(loadId, leadId);
      toast.success("Candidatura cancelada. O motorista será notificado.");
      await queryClient.invalidateQueries({
        queryKey: LEADS_QUERY_KEY,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível cancelar a candidatura agora.");
    } finally {
      setCancellingLeadId(null);
    }
  };

  const revalidateScope = historicoMode ? "historico" : "fila";
  const handleRevalidateQueued = async () => {
    try {
      setRevalidating(true);
      const response = await revalidateQueuedOperatorLeads(revalidateScope);
      if (response.total === 0) {
        toast.info("Nenhuma candidatura em fila para revalidar.");
      } else {
        const truncatedSuffix = response.truncated ? ` (limite de ${response.limit})` : "";
        toast.success(
          `Angellira consultado para ${response.revalidated}/${response.total} candidaturas${truncatedSuffix}.` +
            (response.failed > 0 ? ` ${response.failed} falharam.` : ""),
        );
      }
      await queryClient.invalidateQueries({ queryKey: LEADS_QUERY_KEY });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível revalidar no Angellira agora.");
    } finally {
      setRevalidating(false);
    }
  };

  const handleRevalidateQueuedAspx = async () => {
    try {
      setRevalidatingAspx(true);
      const response = await revalidateQueuedOperatorLeadsAspx(revalidateScope);
      if (response.total === 0) {
        toast.info("Nenhuma candidatura em fila para consultar.");
      } else {
        const truncatedSuffix = response.truncated ? ` (limite de ${response.limit})` : "";
        toast.success(
          `ASPX consultado para ${response.revalidated}/${response.total} candidaturas. ${response.foundInAspx} encontrados${truncatedSuffix}.` +
            (response.failed > 0 ? ` ${response.failed} falharam.` : ""),
        );
      }
      await queryClient.invalidateQueries({ queryKey: LEADS_QUERY_KEY });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível consultar o ASPX agora.");
    } finally {
      setRevalidatingAspx(false);
    }
  };

  const toggleLoadVisibility = (loadId: string) => {
    setCollapsedLoadIds((current) =>
      current.includes(loadId) ? current.filter((currentId) => currentId !== loadId) : [...current, loadId],
    );
  };

  const handleToggleAllLoads = () => {
    setCollapsedLoadIds((current) => {
      if (visibleLoadIds.length === 0) {
        return current;
      }

      if (visibleLoadIds.every((loadId) => current.includes(loadId))) {
        return current.filter((loadId) => !visibleLoadIds.includes(loadId));
      }

      return Array.from(new Set([...current, ...visibleLoadIds]));
    });
  };

  // Exporta o histórico filtrado (todas as páginas, respeitando filtros ativos)
  // para CSV — uma linha por candidatura. Usado no "Histórico fila".
  const handleExport = () => {
    const headers = [
      "Carga", "LH", "Cliente", "Origem", "Destino", "Status carga",
      "Coleta", "Entrega", "Perfil",
      "Motorista", "CPF", "Telefone", "Cavalo", "Carreta", "Tipo veículo",
      "Status lead", "Validação",
    ];
    const rows: string[][] = [];
    for (const group of filteredByCliente) {
      const sheetAllocation = group.load.sheetLh ? sheetAllocationByLh.get(group.load.sheetLh) : undefined;
      const effectiveStatus = sheetAllocation?.status || group.load.sheetStatus || group.load.status;
      const statusLabel =
        STATUS_LABELS[effectiveStatus] ?? STATUS_LABELS[(effectiveStatus || "").toUpperCase()] ?? effectiveStatus ?? "";
      const coleta =
        group.load.sheetDataCarregamento ||
        formatShortDateTime(buildDisplayDateTime(group.load.data, group.load.horario), "");
      const entrega = group.load.sheetDataDescarga || "";
      for (const lead of group.leads) {
        rows.push([
          group.load.id,
          group.load.sheetLh ?? "",
          group.load.clienteNome ?? "",
          group.load.origem,
          group.load.destino,
          statusLabel,
          coleta,
          entrega,
          group.load.perfil,
          lead.driverName ?? sheetAllocation?.driverName ?? "",
          lead.cpf ?? "",
          formatPhoneDisplay(lead.phone),
          lead.horsePlate ?? "",
          buildTrailerPlateLabel(lead),
          lead.vehicleType ?? "",
          STATUS_LABELS[lead.status] ?? lead.status ?? "",
          lead.validation?.overallStatus ?? "",
        ]);
      }
    }

    if (rows.length === 0) {
      toast.info("Nada para exportar com os filtros atuais.");
      return;
    }

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    downloadCsv(`historico-fila-${stamp}.csv`, headers, rows);
    toast.success(`${rows.length} registro${rows.length === 1 ? "" : "s"} exportado${rows.length === 1 ? "" : "s"}.`);
  };

  return (
    <div>
      <DashboardHeader title={historicoMode ? "Hist\u00f3rico fila" : "Fila"} />

      <main className="space-y-5 p-6 lg:p-8">
        <section className="admin-panel p-5 lg:p-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-primary/60">Fila operacional</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
                {summary.queued} carga{summary.queued === 1 ? "" : "s"} aguardando decisão
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                Aqui entram os motoristas que enviaram a candidatura pelo sistema. O WhatsApp fica somente como ação operacional da equipe.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="admin-soft-panel flex items-center gap-3 px-4 py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Route className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Cargas</p>
                  <p className="text-sm font-semibold text-foreground">{summary.loads}</p>
                </div>
              </div>

              <div className="admin-soft-panel flex items-center gap-3 px-4 py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent/12 text-accent">
                  <MessageCircle className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Na fila</p>
                  <p className="text-sm font-semibold text-foreground">{summary.queued}</p>
                </div>
              </div>

              <div className="admin-soft-panel flex items-center gap-3 px-4 py-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/12 text-emerald-700">
                  <ShieldCheck className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Reservadas</p>
                  <p className="text-sm font-semibold text-foreground">{summary.approved}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_200px_200px_200px_auto_auto_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Pesquisar por carga, origem, destino, telefone, CPF ou placa..."
                className="h-12 rounded-2xl border-border/80 bg-white/92 pl-11 pr-4"
              />
            </div>

            <select
              value={loadStatusFilter}
              onChange={(event) => setLoadStatusFilter(event.target.value)}
              className="h-12 rounded-2xl border border-border/80 bg-white/92 px-4 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40"
            >
              <option value="todos">Todas as cargas</option>
              {historicoMode ? (
                <>
                  <option value="DESCARREGADO">Descarregado</option>
                  <option value="CTE ENVIADO">CTE Enviado</option>
                  <option value="DESCARREGANDO">Descarregando</option>
                  <option value="AGUARDANDO DESCARGA">Aguard. Descarga</option>
                  <option value="AGUARDANDO CHEGAR NO CLIENTE">Aguard. Chegada</option>
                  <option value="AGUARDANDO CARREGAMENTO">Aguard. Carregamento</option>
                  <option value="CANCELADO">Cancelado</option>
                  <option value="NO SHOW">No Show</option>
                  <option value="EXPIRED">Expirado (sem status)</option>
                </>
              ) : (
                <>
                  <option value="OPEN">Em aberto</option>
                  <option value="RESERVED">Reservado</option>
                  <option value="AGUARDANDO CARREGAMENTO">Aguard. Carregamento</option>
                  <option value="AGUARDANDO CHEGAR NO CLIENTE">Aguard. Chegada</option>
                  <option value="DESCARREGANDO">Descarregando</option>
                </>
              )}
            </select>

            <select
              value={leadStatusFilter}
              onChange={(event) => setLeadStatusFilter(event.target.value)}
              className="h-12 rounded-2xl border border-border/80 bg-white/92 px-4 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40"
            >
              <option value="todos">Todos os leads</option>
              <option value="QUEUED">Na fila</option>
              <option value="APPROVED">Reservados</option>
            </select>

            <select
              value={clienteFilter}
              onChange={(event) => setClienteFilter(event.target.value)}
              className="h-12 rounded-2xl border border-border/80 bg-white/92 px-4 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40"
            >
              <option value="">Todos os clientes</option>
              {clienteOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.nome}</option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => {
                setSearch("");
                setLoadStatusFilter("todos");
                setLeadStatusFilter("todos");
                setClienteFilter("");
              }}
              disabled={!hasActiveFilters}
              className="inline-flex items-center justify-center rounded-2xl border border-border/80 bg-white/92 px-4 text-sm font-semibold text-foreground transition-colors duration-200 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 dark:bg-muted/40"
            >
              Limpar filtros
            </button>

            <button
              type="button"
              onClick={() => void handleRevalidateQueued()}
              disabled={revalidating}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-[0_10px_22px_-14px_rgba(2,36,131,0.55)] transition-colors duration-200 hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              title="Consulta Angellira para todas as candidaturas em fila ainda não reservadas"
            >
              {revalidating ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />}
              <span className="whitespace-nowrap">Verificar no Angellira</span>
            </button>

            <button
              type="button"
              onClick={() => void handleRevalidateQueuedAspx()}
              disabled={revalidatingAspx}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl border border-sky-400/40 bg-sky-500/10 px-4 text-sm font-semibold text-sky-700 transition-colors duration-200 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-sky-500/15 dark:text-sky-200"
              title="Consulta ASPX para todas as candidaturas em fila (mais rápido que Angellira)"
            >
              {revalidatingAspx ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              <span className="whitespace-nowrap">Verificar no ASPX</span>
            </button>
          </div>

          {filteredGroups.length > 0 ? (
            <div className="mt-4 flex flex-wrap justify-end gap-3">
              {historicoMode ? (
                <button
                  type="button"
                  onClick={handleExport}
                  className="inline-flex items-center gap-2 rounded-2xl border border-emerald-400/50 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-700 transition-colors duration-200 hover:bg-emerald-500/20 dark:bg-emerald-500/15 dark:text-emerald-200"
                  title="Exporta o histórico filtrado para CSV (abre no Excel)"
                >
                  <Download className="h-4 w-4" />
                  Exportar CSV
                </button>
              ) : null}
              <button
                type="button"
                onClick={handleToggleAllLoads}
                className="inline-flex items-center gap-2 rounded-2xl border border-border/80 bg-white/92 px-4 py-2 text-sm font-semibold text-foreground transition-colors duration-200 hover:bg-muted dark:bg-muted/40"
              >
                {allVisibleGroupsCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                {allVisibleGroupsCollapsed ? "Expandir todas as cargas" : "Minimizar todas as cargas"}
              </button>
            </div>
          ) : null}
        </section>

        {/* Banner gracioso para 503 transient: mostra alerta, mantem polling rodando
            e preserva os dados anteriores ja renderizados (nao bloqueia a UI). */}
        {isTransientError && groups.length > 0 ? (
          <section className="admin-panel flex items-center gap-3 border-l-4 border-amber-500 bg-amber-50/70 px-5 py-3 text-sm text-amber-900 dark:border-amber-400 dark:bg-amber-500/15 dark:text-amber-100">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-300" />
            <div className="flex-1">
              <p className="font-semibold">Sincronizacao temporariamente indisponivel</p>
              <p className="mt-0.5 text-xs leading-relaxed text-amber-900/85 dark:text-amber-100/80">
                Reconectando automaticamente. Os dados exibidos podem estar desatualizados em alguns instantes.
              </p>
            </div>
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin text-amber-600 dark:text-amber-300" /> : null}
          </section>
        ) : null}

        {isLoading ? (
          <section className="admin-panel flex min-h-[260px] items-center justify-center">
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Carregando a fila de leads...
            </div>
          </section>
        ) : error && !isTransientError ? (
          <section className="admin-panel flex min-h-[260px] flex-col items-center justify-center gap-4 p-10 text-center">
            <ShieldCheck className="h-14 w-14 text-amber-600/70" />
            <div className="space-y-1">
              <p className="text-lg font-bold text-foreground">Não foi possível carregar a fila</p>
              <p className="text-sm text-muted-foreground">
                {error instanceof Error ? error.message : "Verifique a sessao do operador e tente novamente."}
              </p>
            </div>
          </section>
        ) : groups.length === 0 ? (
          <section className="admin-panel flex min-h-[260px] flex-col items-center justify-center gap-4 p-10 text-center">
            <MessageCircle className="h-14 w-14 text-muted-foreground/35" />
            <div className="space-y-1">
              <p className="text-lg font-bold text-foreground">Nenhum lead na fila</p>
              <p className="text-sm text-muted-foreground">Quando um motorista enviar a candidatura pela tela de cargas, ele aparece aqui automaticamente.</p>
            </div>
          </section>
        ) : filteredGroups.length === 0 ? (
          <section className="admin-panel flex min-h-[260px] flex-col items-center justify-center gap-4 p-10 text-center">
            <MessageCircle className="h-14 w-14 text-muted-foreground/35" />
            <div className="space-y-1">
              <p className="text-lg font-bold text-foreground">Nenhum lead encontrado</p>
              <p className="text-sm text-muted-foreground">Ajuste os filtros para encontrar a fila que você precisa analisar.</p>
            </div>
          </section>
        ) : (
          <>
            {isFetching ? (
              <div className="flex justify-end px-1">
                <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-white px-3 py-1.5 text-xs font-semibold text-muted-foreground dark:bg-muted/40">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Atualizando
                </span>
              </div>
            ) : null}
          <section className="space-y-4">
            {paginatedItems.map((renderItem) => {
              if (renderItem.kind === "pacote") {
                const pacoteCollapseKey = `pacote:${renderItem.pacoteMeta.id}`;
                const isCollapsed = collapsedLoadIds.includes(pacoteCollapseKey);
                return (
                  <OperatorPacoteLeadCard
                    key={pacoteCollapseKey}
                    pacoteMeta={renderItem.pacoteMeta}
                    items={renderItem.items}
                    candidaturas={renderItem.candidaturas}
                    isCollapsed={isCollapsed}
                    onToggleCollapse={() => toggleLoadVisibility(pacoteCollapseKey)}
                    approvingLeadId={approvingLeadId}
                    cancellingLeadId={cancellingLeadId}
                    onApprove={(loadId, leadId, val) => void handleApprove(loadId, leadId, val)}
                    onCancel={(loadId, leadId, cpf) => void handleCancel(loadId, leadId, cpf)}
                    onApprovePacote={(cand) => {
                      // Iter #9: reserva o pacote inteiro para um motorista.
                      // Sequencia handleApprove por lead QUEUED — aproveita o
                      // atomic-claim do iter #3 que ja garante a transicao
                      // PACOTE.publicado -> reservado quando a primeira parada
                      // eh aprovada e replica via cascade nas demais.
                      void (async () => {
                        const queuedItems = cand.items.filter((it) => it.lead.status === "QUEUED");
                        for (const it of queuedItems) {
                          await handleApprove(it.group.load.id, it.lead.id, it.lead.validation);
                        }
                      })();
                    }}
                    onCancelPacote={(cand) => {
                      // Cancela todas as candidaturas (1 por parada) deste motorista.
                      const cpfSuffix = cand.cpf?.trim() ? cand.cpf.trim().slice(-2).padStart(2, "*") : null;
                      const tail = cpfSuffix ? ` (final ${cpfSuffix})` : "";
                      if (
                        !confirmAction(
                          `Cancelar a candidatura${tail} em todas as paradas do pacote? O motorista sera notificado.`,
                        )
                      ) {
                        return;
                      }
                      void (async () => {
                        for (const it of cand.items) {
                          // Pula leads ja em estado terminal.
                          if (it.lead.status === "QUEUED" || it.lead.status === "APPROVED") {
                            await cancelOperatorLoadLead(it.group.load.id, it.lead.id).catch(() => undefined);
                          }
                        }
                        toast.success("Candidaturas do pacote canceladas.");
                        await queryClient.invalidateQueries({ queryKey: LEADS_QUERY_KEY });
                      })();
                    }}
                    onOpenDriverDetail={(lead) =>
                      setSelectedDriver({
                        name: lead.validation?.driver.angelira.displayName || null,
                        cpf: lead.cpf || null,
                        phone: lead.phone || null,
                        vehicleType: lead.vehicleType || null,
                        plates: {
                          horsePlate: lead.horsePlate || null,
                          trailerPlate: lead.trailerPlate || null,
                          trailerPlate2: lead.trailerPlate2 || null,
                        },
                        validation: lead.validation || null,
                        angelliraDetails: null,
                      })
                    }
                  />
                );
              }
              const group = renderItem.group;
              const routeLabel = buildRouteLabel(group);
              const isCargaCollapsed = collapsedLoadIds.includes(group.load.id);
              const sheetAllocation = group.load.sheetLh ? sheetAllocationByLh.get(group.load.sheetLh) : undefined;
              const effectiveStatus = sheetAllocation?.status || group.load.sheetStatus || group.load.status;
              const statusStyle = resolveStatusStyle(effectiveStatus);

              const isReserved =
                group.load.status === "RESERVED" ||
                group.load.status === "BOOKED" ||
                Boolean(sheetAllocation) ||
                Boolean(group.load.sheetMotorista);

              // Vigência: busca o lead APPROVED e computa itens próximos de vencer (≤ 30 dias)
              const approvedLead = group.leads.find((l) => l.status === "APPROVED");
              const vigenciaItems =
                isReserved && approvedLead?.validation
                  ? buildVigenciaItems(approvedLead.validation).filter((item) => item.daysLeft <= 30)
                  : [];
              const hasVigenciaAlert = vigenciaItems.length > 0;

              // Próxima do horário: carregamento programado dentro das próximas 6h (ou já passou em até 1h).
              // Só pinta de amarelo quando ainda não está reservada — evita conflito visual com o ring verde.
              const loadDateTime = buildDisplayDateTime(group.load.data, group.load.horario);
              let isNearDeadline = false;
              if (!isReserved && loadDateTime) {
                const diffMs = loadDateTime.getTime() - Date.now();
                isNearDeadline = diffMs >= -60 * 60 * 1000 && diffMs <= 6 * 60 * 60 * 1000;
              }

              const coletaLabel =
                group.load.sheetDataCarregamento ||
                formatShortDateTime(buildDisplayDateTime(group.load.data, group.load.horario), "A confirmar");
              const entregaLabel = group.load.sheetDataDescarga || null;

              return (
                <article
                  key={group.load.id}
                  className={cn(
                    // iter #9 — overflow-visible: deixa badge top-right respirar sem
                    // ser cortado quando o card encolhe.
                    "admin-panel relative transition-all",
                    isNearDeadline
                      ? "outline outline-[3px] -outline-offset-1 outline-amber-500 shadow-[0_0_0_6px_rgba(245,158,11,0.22)] dark:outline-amber-400"
                      : `outline outline-[3px] -outline-offset-1 ${statusStyle.ring} ${statusStyle.shadow}`,
                  )}
                >
                  <span
                    className={cn(
                      "absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-[0.14em] shadow-sm",
                      isNearDeadline
                        ? "bg-amber-500 text-white dark:bg-amber-400 dark:text-amber-950 animate-pulse"
                        : statusStyle.badge,
                    )}
                  >
                    {isNearDeadline ? (
                      <><Loader2 className="h-3 w-3" /> Carregamento em breve</>
                    ) : (
                      <><ShieldCheck className="h-3 w-3" />{statusStyle.label}</>
                    )}
                  </span>
                  {/*
                    Header redesign iter #9: 3 linhas compactas (~85px no desktop).
                    Linha 1: chips de identificacao + perfil + queue count.
                    Linha 2: rota com logo do cliente.
                    Linha 3: coleta / entrega / sheet info + acoes (flex-wrap).
                    Badge "Carregamento em breve" / status do load fica top-right.
                  */}
                  <div className="border-b border-border/70 px-5 py-3 lg:px-6">
                    {/* Linha 1: chips identificadores + status pill + queue counter */}
                    <div className="flex flex-wrap items-center gap-2 pr-32">
                      <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-primary/60">
                        Carga {group.load.id}
                      </p>
                      {group.load.sheetLh ? (
                        <span className="inline-flex rounded-full border border-primary/15 bg-primary/8 px-2 py-0.5 text-[0.6rem] font-bold font-mono text-primary">
                          LH {group.load.sheetLh}
                        </span>
                      ) : null}
                      <LoadStatusBadge status={effectiveStatus} />
                      <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[0.6rem] font-semibold text-muted-foreground">
                        {group.load.perfil}
                      </span>
                      <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[0.6rem] font-semibold text-muted-foreground">
                        {group.queueCount} na fila
                      </span>
                    </div>

                    {/* Linha 2: rota com logo do cliente */}
                    <h3 className="mt-1.5 flex items-center gap-2 text-base font-semibold tracking-tight text-foreground">
                      <span className="truncate">{routeLabel}</span>
                      {group.load.clienteLogoUrl ? (
                        <ClientLogo
                          logoUrl={group.load.clienteLogoUrl}
                          name={group.load.clienteNome ?? ""}
                          className="h-5 w-5 shrink-0"
                        />
                      ) : null}
                    </h3>

                    {/* Linha 3: datetimes + acoes em flex-wrap (mobile-friendly) */}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex max-w-xs items-center gap-1.5 rounded-full border border-border/70 bg-muted/20 px-2.5 py-1 text-[0.65rem] font-semibold text-muted-foreground" title="Carregamento">
                        <Truck className="h-3 w-3" />
                        <span className="truncate">Coleta: {coletaLabel}</span>
                      </span>
                      {entregaLabel ? (
                        <span className="inline-flex max-w-xs items-center gap-1.5 rounded-full border border-border/70 bg-muted/20 px-2.5 py-1 text-[0.65rem] font-semibold text-muted-foreground" title="Descarga">
                          <Route className="h-3 w-3" />
                          <span className="truncate">Entrega: {entregaLabel}</span>
                        </span>
                      ) : null}
                      {group.load.sheetMotorista ? (
                        <span className="inline-flex max-w-xs items-center gap-1.5 rounded-full border border-border/70 bg-muted/20 px-2.5 py-1 text-[0.65rem] font-semibold text-muted-foreground" title="Motorista (planilha)">
                          <User className="h-3 w-3" />
                          <span className="truncate">{group.load.sheetMotorista}</span>
                        </span>
                      ) : null}
                      {hasVigenciaAlert && (
                        <span
                          className="inline-flex flex-wrap items-center gap-1"
                          title={vigenciaItems.map((i) => `${i.label}: ${i.daysLeft < 0 ? "VENCIDO" : `${i.daysLeft}d`}`).join(" | ")}
                        >
                          {vigenciaItems.map((item) => {
                            const expired = item.daysLeft < 0;
                            const urgent = item.daysLeft >= 0 && item.daysLeft <= 7;
                            return (
                              <span
                                key={item.label}
                                className={cn(
                                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6rem] font-bold",
                                  expired
                                    ? "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300"
                                    : urgent
                                      ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
                                      : "bg-yellow-50 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-300",
                                )}
                              >
                                <Clock className="h-3 w-3" />
                                {item.label}: {item.daysLeft < 0 ? "Vencido" : `${item.daysLeft}d`}
                              </span>
                            );
                          })}
                        </span>
                      )}
                      {group.load.sheetCavalo ? (
                        <span className="inline-flex max-w-xs items-center gap-1.5 rounded-full border border-border/70 bg-muted/20 px-2.5 py-1 text-[0.65rem] font-semibold text-muted-foreground" title="Veículo (planilha)">
                          <Truck className="h-3 w-3" />
                          <span className="truncate">{[group.load.sheetCavalo, group.load.sheetCarreta].filter(Boolean).join(" · ")}</span>
                        </span>
                      ) : null}
                      {group.load.sheetStatus ? (
                        // iter #9 UI-04: contrast no dark mode (bg-slate-700 escuro)
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/20 px-2.5 py-1 text-[0.65rem] font-semibold text-muted-foreground dark:bg-slate-700/40 dark:text-slate-100" title="Status (planilha)">
                          {group.load.sheetStatus}
                        </span>
                      ) : null}
                      <div className="ml-auto flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => toggleLoadVisibility(group.load.id)}
                          className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-white px-2.5 py-1 text-[0.65rem] font-semibold text-foreground transition-colors duration-200 hover:bg-muted dark:bg-muted/40"
                          aria-expanded={!isCargaCollapsed}
                          aria-controls={`lead-group-${group.load.id}`}
                        >
                          {isCargaCollapsed ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
                          {isCargaCollapsed ? "Expandir disputa" : "Minimizar disputa"}
                        </button>
                        {group.load.status === "OPEN" && !historicoMode && permissions.canAllocateLeads ? (
                          <button
                            type="button"
                            onClick={() => {
                              setDirectAllocLoadId(group.load.id);
                              setDirectAllocForm({ cpf: "", phone: "", horsePlate: "", vehicleType: "CARRETA", trailerPlate: "" });
                            }}
                            className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[0.65rem] font-semibold text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-400/40 dark:bg-blue-500/15 dark:text-blue-200 dark:hover:bg-blue-500/25"
                          >
                            <UserPlus className="h-3 w-3" />
                            Alocar motorista
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {!isCargaCollapsed ? (
                    <div id={`lead-group-${group.load.id}`} className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-primary/[0.045]">
                          <tr className="border-b border-border/70">
                            <th className="px-4 py-4 text-left text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Fila</th>
                            <th className="px-4 py-4 text-left text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Entrada</th>
                            <th className="px-4 py-4 text-left text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Motorista</th>
                            <th className="px-4 py-4 text-left text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Status</th>
                            <th className="px-4 py-4 text-right text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Ações</th>
                          </tr>
                        </thead>

                        <tbody>
                          {group.leads.map((lead, index) => {
                            const isApprovedLead = lead.status === "APPROVED";
                            const canApprove = group.load.status === "OPEN" && lead.status === "QUEUED";

                            return (
                              <tr
                                key={lead.id}
                                className="admin-table-row border-b border-border/70 last:border-0 transition-colors duration-200 hover:bg-primary/[0.03] cursor-pointer"
                                style={{ animationDelay: `${index * 40}ms` }}
                                onClick={() => setSelectedDriver({
                                  name: lead.validation?.driver.angelira.displayName || null,
                                  cpf: lead.cpf || null,
                                  phone: lead.phone || null,
                                  vehicleType: lead.vehicleType || null,
                                  plates: {
                                    horsePlate: lead.horsePlate || null,
                                    trailerPlate: lead.trailerPlate || null,
                                    trailerPlate2: lead.trailerPlate2 || null,
                                  },
                                  validation: lead.validation || null,
                                  angelliraDetails: null,
                                })}
                              >
                                <td className="px-4 py-4 font-semibold text-foreground">
                                  {lead.queuePosition ? `#${lead.queuePosition}` : "Reservado"}
                                </td>
                                <td className="px-4 py-4 text-foreground">
                                  {formatFullDateTime(lead.queuedAt || lead.preRegisteredAt)}
                                </td>
                                <td className="px-4 py-4 text-foreground">
                                  <div className="flex items-start gap-2 font-medium">
                                    {lead.driverName ? (
                                      <User className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                                    ) : (
                                      <Phone className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                                    )}
                                    <div className="min-w-0 leading-tight">
                                      <div className="truncate">
                                        {lead.driverName?.trim() || formatPhoneDisplay(lead.phone)}
                                      </div>
                                      <div className="mt-0.5 truncate text-[0.65rem] font-normal text-muted-foreground">
                                        {buildDriverSubLabel(lead)}
                                      </div>
                                    </div>
                                  </div>
                                </td>
                                <td className="px-4 py-4">
                                  <span
                                    className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${
                                      isApprovedLead ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-200" : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200"
                                    }`}
                                  >
                                    {isApprovedLead ? "Reservado" : "Na fila"}
                                  </span>
                                </td>
                                <td className="px-4 py-4" onClick={(e) => e.stopPropagation()}>
                                  <div className="flex flex-wrap justify-end gap-2">
                                    <button
                                      type="button"
                                      onClick={() => window.open(lead.whatsappUrl, "_blank", "noopener,noreferrer")}
                                      className="inline-flex items-center gap-2 rounded-full bg-[linear-gradient(135deg,#23b26b,#25D366)] px-4 py-2 text-xs font-semibold text-white shadow-[0_10px_22px_rgba(37,211,102,0.24)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_14px_28px_rgba(37,211,102,0.3)]"
                                    >
                                      <MessageCircle className="h-4 w-4" />
                                      Chamar no WhatsApp
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => void handleApprove(group.load.id, lead.id, lead.validation)}
                                      disabled={!canApprove || approvingLeadId === lead.id}
                                      className="inline-flex items-center gap-2 rounded-full border border-border/80 px-4 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                      {approvingLeadId === lead.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                                      {isApprovedLead ? "Já reservado" : "Reservar para este motorista"}
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => void handleCancel(group.load.id, lead.id, lead.cpf)}
                                      disabled={cancellingLeadId === lead.id}
                                      title={`Cancelar candidatura${lead.cpf ? ` (final ${lead.cpf.trim().slice(-2)})` : ""}`}
                                      className="inline-flex items-center gap-2 rounded-full border border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-400/40 dark:bg-red-500/15 dark:text-red-200 dark:hover:bg-red-500/25"
                                    >
                                      {cancellingLeadId === lead.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
                                      Cancelar candidatura
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div id={`lead-group-${group.load.id}`} className="grid gap-3 px-5 py-4 text-sm lg:grid-cols-3 lg:px-6">
                      <div className="admin-soft-panel px-4 py-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Candidatos nesta carga</p>
                        <p className="mt-2 text-lg font-semibold text-foreground">{group.totalLeads}</p>
                      </div>
                      <div className="admin-soft-panel px-4 py-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Na fila</p>
                        <p className="mt-2 text-lg font-semibold text-foreground">{group.queueCount}</p>
                      </div>
                      <div className="admin-soft-panel px-4 py-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Reservados</p>
                        <p className="mt-2 text-lg font-semibold text-foreground">
                          {group.leads.filter((lead) => lead.status === "APPROVED").length}
                        </p>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </section>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="inline-flex h-9 w-9 items-center justify-center rounded-2xl border border-border/80 bg-white/92 text-sm font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 dark:bg-muted/40"
              >
                <ChevronDown className="h-4 w-4 -rotate-90" />
              </button>
              <span className="text-sm font-semibold text-muted-foreground">
                {page} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="inline-flex h-9 w-9 items-center justify-center rounded-2xl border border-border/80 bg-white/92 text-sm font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 dark:bg-muted/40"
              >
                <ChevronDown className="h-4 w-4 rotate-90" />
              </button>
              <span className="ml-2 text-xs text-muted-foreground">
                {filteredGroups.length} cargas no total
              </span>
            </div>
          )}
          </>
        )}
      </main>

      <DriverDetailModal
        open={selectedDriver !== null}
        onOpenChange={(open) => { if (!open) setSelectedDriver(null); }}
        data={selectedDriver}
      />

      <Dialog open={directAllocLoadId !== null} onOpenChange={(open) => { if (!open) setDirectAllocLoadId(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Alocar motorista diretamente</DialogTitle>
          </DialogHeader>
          <div className="mt-2 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted-foreground">CPF *</label>
              <Input
                placeholder="00000000000"
                value={directAllocForm.cpf}
                onChange={(e) => setDirectAllocForm((f) => ({ ...f, cpf: e.target.value }))}
                maxLength={14}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted-foreground">Telefone *</label>
              <Input
                placeholder="11999999999"
                value={directAllocForm.phone}
                onChange={(e) => setDirectAllocForm((f) => ({ ...f, phone: e.target.value }))}
                maxLength={15}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted-foreground">Placa cavalo *</label>
              <Input
                placeholder="ABC1234"
                value={directAllocForm.horsePlate}
                onChange={(e) => setDirectAllocForm((f) => ({ ...f, horsePlate: e.target.value.toUpperCase() }))}
                maxLength={8}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted-foreground">Tipo de veículo *</label>
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={directAllocForm.vehicleType}
                onChange={(e) => setDirectAllocForm((f) => ({ ...f, vehicleType: e.target.value }))}
              >
                {VEHICLE_PROFILE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted-foreground">Placa carreta (opcional)</label>
              <Input
                placeholder="DEF5678"
                value={directAllocForm.trailerPlate}
                onChange={(e) => setDirectAllocForm((f) => ({ ...f, trailerPlate: e.target.value.toUpperCase() }))}
                maxLength={8}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDirectAllocLoadId(null)}
                className="inline-flex items-center rounded-full border border-border/80 px-4 py-2 text-xs font-semibold text-foreground hover:bg-muted"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void handleDirectAlloc()}
                disabled={directAllocLoading}
                className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {directAllocLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Confirmar alocação
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Leads;
