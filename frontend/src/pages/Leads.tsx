import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, BadgeCheck, CheckCircle2, ChevronDown, ChevronUp, Clock, Loader2, MessageCircle, Phone, Route, Search, ShieldCheck, Truck, User } from "lucide-react";
import { differenceInDays } from "date-fns";
import { toast } from "sonner";

import DashboardHeader from "@/components/DashboardHeader";
import DriverDetailModal, { type DriverDetailModalData } from "@/components/DriverDetailModal";
import { cn } from "@/lib/utils";
import { buildDisplayDateTime, formatFullDateTime, formatShortDateTime } from "@/lib/dateDisplay";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { approveOperatorLoadLead, cancelOperatorLoadLead, fetchOperatorLoadLeads, revalidateQueuedOperatorLeads, revalidateQueuedOperatorLeadsAspx, type OperatorLeadGroup, type PublicLeadValidationSummary } from "@/services/loadClaims";
import { fetchSheetMonitor, type SheetMonitorRow } from "@/services/readModels";

interface SheetAllocation {
  driverName: string;
  status: string;
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

const Leads = ({ historicoMode = false }: LeadsProps = {}) => {
  const queryClient = useQueryClient();
  const [approvingLeadId, setApprovingLeadId] = useState<string | null>(null);
  const [cancellingLeadId, setCancellingLeadId] = useState<string | null>(null);
  const [revalidating, setRevalidating] = useState(false);
  const [revalidatingAspx, setRevalidatingAspx] = useState(false);
  const [selectedDriver, setSelectedDriver] = useState<DriverDetailModalData | null>(null);
  const [search, setSearch] = useState("");
  const [loadStatusFilter, setLoadStatusFilter] = useState("todos");
  const [leadStatusFilter, setLeadStatusFilter] = useState("todos");
  const [collapsedLoadIds, setCollapsedLoadIds] = useState<string[]>([]);
  const knownLoadIdsRef = useRef<string[]>([]);
  const autoRevalidateFiredRef = useRef<number>(0);
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());

  const { data, error, isLoading, isFetching } = useQuery({
    queryKey: LEADS_QUERY_KEY,
    queryFn: fetchOperatorLoadLeads,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    staleTime: 15_000,
    retry: false,
  });

  // Snapshot da planilha para detectar aloca\u00e7\u00e3o externa (motorista preenchido no Google Sheets)
  const { data: sheetData } = useQuery({
    queryKey: ["operator", "sheet-monitor"],
    queryFn: () => fetchSheetMonitor({ refresh: false }),
    staleTime: 30_000,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

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
    const invalidateLeadQueue = () =>
      queryClient.invalidateQueries({
        queryKey: LEADS_QUERY_KEY,
      });

    const realtimeChannel = supabase
      .channel("operator-public-load-leads")
      .on("postgres_changes", { event: "*", schema: "public", table: "load_public_leads" }, () => {
        void invalidateLeadQueue();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "cargas" }, () => {
        void invalidateLeadQueue();
      })
      .subscribe();

    return () => {
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

        const matchesLoadStatus = loadStatusFilter === "todos" || group.load.status === loadStatusFilter;

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
  }, [groups, deferredSearch, loadStatusFilter, leadStatusFilter, historicoMode]);
  const hasActiveFilters =
    deferredSearch.length > 0 || loadStatusFilter !== "todos" || leadStatusFilter !== "todos";
  const visibleLoadIds = useMemo(() => filteredGroups.map((group) => group.load.id), [filteredGroups]);
  const allVisibleGroupsCollapsed =
    visibleLoadIds.length > 0 && visibleLoadIds.every((loadId) => collapsedLoadIds.includes(loadId));

  // Reset known IDs when search/filter changes so stale IDs from previous result sets
  // don't accumulate forever as the user navigates different filters.
  useEffect(() => {
    knownLoadIdsRef.current = [];
  }, [historicoMode, loadStatusFilter, deferredSearch]);

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

  const handleApprove = async (loadId: string, leadId: string) => {
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

  const handleCancel = async (loadId: string, leadId: string, cpf: string | null) => {
    const cpfLabel = cpf?.trim() ? ` do CPF ${cpf}` : "";
    const confirmed = window.confirm(
      `Tem certeza que deseja cancelar a candidatura${cpfLabel}? O motorista verá que a candidatura foi cancelada.`,
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
          `ASPx consultado para ${response.revalidated}/${response.total} candidaturas. ${response.foundInAspx} encontrados${truncatedSuffix}.` +
            (response.failed > 0 ? ` ${response.failed} falharam.` : ""),
        );
      }
      await queryClient.invalidateQueries({ queryKey: LEADS_QUERY_KEY });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível consultar o ASPx agora.");
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

          <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_220px_220px_auto_auto_auto]">
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
              <option value="OPEN">Cargas abertas</option>
              <option value="RESERVED">Cargas reservadas</option>
              <option value="BOOKED">Cargas fechadas</option>
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

            <button
              type="button"
              onClick={() => {
                setSearch("");
                setLoadStatusFilter("todos");
                setLeadStatusFilter("todos");
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
              title="Consulta ASPx para todas as candidaturas em fila (mais rápido que Angellira)"
            >
              {revalidatingAspx ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              <span className="whitespace-nowrap">Verificar no ASPx</span>
            </button>
          </div>

          {filteredGroups.length > 0 ? (
            <div className="mt-4 flex justify-end">
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

        {isLoading ? (
          <section className="admin-panel flex min-h-[260px] items-center justify-center">
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Carregando a fila de leads...
            </div>
          </section>
        ) : error ? (
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
            {filteredGroups.map((group) => {
              const routeLabel = buildRouteLabel(group);
              const isCollapsed = collapsedLoadIds.includes(group.load.id);
              const sheetAllocation = group.load.sheetLh ? sheetAllocationByLh.get(group.load.sheetLh) : undefined;

              // Reservada: status RESERVED/BOOKED no banco, motorista na planilha ao vivo,
              // OU sheet_motorista persistido (sheet_lh pode ter sido removido após a viagem).
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

              return (
                <article
                  key={group.load.id}
                  className={cn(
                    "admin-panel overflow-hidden relative transition-all",
                    // Usamos `outline` em vez de `ring`: o .admin-panel j\u00e1 tem
                    // box-shadow pr\u00f3prio e o ring do Tailwind colidia (via
                    // --tw-shadow), ficando invis\u00edvel. `outline` n\u00e3o conflita
                    // com box-shadow, n\u00e3o afeta layout e \u00e9 bem mais vis\u00edvel.
                    isReserved &&
                      "outline outline-[3px] -outline-offset-1 outline-emerald-500 shadow-[0_0_0_6px_rgba(16,185,129,0.18)] dark:outline-emerald-400",
                    isNearDeadline &&
                      "outline outline-[3px] -outline-offset-1 outline-amber-500 shadow-[0_0_0_6px_rgba(245,158,11,0.22)] dark:outline-amber-400",
                  )}
                >
                  {(isReserved || isNearDeadline) && (
                    <span
                      className={cn(
                        "absolute right-4 top-4 z-10 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.65rem] font-bold uppercase tracking-[0.16em] shadow-sm",
                        isReserved
                          ? "bg-emerald-500 text-white dark:bg-emerald-400 dark:text-emerald-950"
                          : "bg-amber-500 text-white dark:bg-amber-400 dark:text-amber-950 animate-pulse",
                      )}
                    >
                      {isReserved ? (
                        <>
                          <ShieldCheck className="h-3 w-3" />
                          {TERMINAL_LOAD_STATUSES.includes(group.load.status) && Boolean(group.load.sheetMotorista)
                            ? "Realizada"
                            : "Reservada"}
                        </>
                      ) : (
                        <>
                          <Loader2 className="h-3 w-3" /> Carregamento em breve
                        </>
                      )}
                    </span>
                  )}
                  <div className="border-b border-border/70 px-5 py-5 lg:px-6">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">Carga {group.load.id}</p>
                          {group.load.sheetLh ? (
                            <span className="inline-flex rounded-full border border-primary/15 bg-primary/8 px-2.5 py-0.5 text-[0.68rem] font-bold font-mono text-primary">
                              LH {group.load.sheetLh}
                            </span>
                          ) : null}
                        </div>
                        <h3 className="mt-2 text-xl font-semibold tracking-tight text-foreground">{routeLabel}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Perfil {group.load.perfil} | Status{" "}
                          {sheetAllocation?.status || group.load.sheetStatus || group.load.status}{" "}
                          | {group.queueCount} na fila
                        </p>
                        {(sheetAllocation || group.load.sheetStatus || group.load.sheetMotorista) ? (
                          <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-emerald-300/60 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-200">
                            <Truck className="h-3.5 w-3.5" />
                            {sheetAllocation ? (
                              historicoMode ? (
                                <>
                                  Planilha
                                  {sheetAllocation.driverName ? `: ${sheetAllocation.driverName}` : ""}
                                  {sheetAllocation.status ? ` · ${sheetAllocation.status}` : ""}
                                </>
                              ) : (
                                <>
                                  Reservado externamente: {sheetAllocation.driverName}
                                  {sheetAllocation.status ? ` · ${sheetAllocation.status}` : ""}
                                </>
                              )
                            ) : (
                              <>
                                Planilha
                                {group.load.sheetMotorista ? `: ${group.load.sheetMotorista}` : ""}
                                {group.load.sheetStatus ? ` · ${group.load.sheetStatus}` : ""}
                              </>
                            )}
                          </div>
                        ) : null}
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => toggleLoadVisibility(group.load.id)}
                          className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-white px-3 py-1.5 text-xs font-semibold text-foreground transition-colors duration-200 hover:bg-muted dark:bg-muted/40"
                          aria-expanded={!isCollapsed}
                          aria-controls={`lead-group-${group.load.id}`}
                        >
                          {isCollapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
                          {isCollapsed ? "Expandir disputa" : "Minimizar disputa"}
                        </button>
                        <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/20 px-3 py-1.5 text-xs font-semibold text-muted-foreground" title="Carregamento">
                          <Truck className="h-3.5 w-3.5" />
                          Coleta: {group.load.sheetDataCarregamento || formatShortDateTime(buildDisplayDateTime(group.load.data, group.load.horario), "A confirmar")}
                        </span>
                        {group.load.sheetDataDescarga ? (
                          <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/20 px-3 py-1.5 text-xs font-semibold text-muted-foreground" title="Descarga">
                            <Route className="h-3.5 w-3.5" />
                            Entrega: {group.load.sheetDataDescarga}
                          </span>
                        ) : null}
                        {group.load.sheetMotorista ? (
                          <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/20 px-3 py-1.5 text-xs font-semibold text-muted-foreground" title="Motorista (planilha)">
                            <User className="h-3.5 w-3.5" />
                            {group.load.sheetMotorista}
                          </span>
                        ) : null}
                        {hasVigenciaAlert && (
                          <span
                            className="inline-flex items-center gap-1.5"
                            title={vigenciaItems.map((i) => `${i.label}: ${i.daysLeft < 0 ? "VENCIDO" : `${i.daysLeft}d`}`).join(" | ")}
                          >
                            {vigenciaItems.map((item) => {
                              const expired = item.daysLeft < 0;
                              const urgent = item.daysLeft >= 0 && item.daysLeft <= 7;
                              return (
                                <span
                                  key={item.label}
                                  className={cn(
                                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.65rem] font-bold",
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
                          <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/20 px-3 py-1.5 text-xs font-semibold text-muted-foreground" title="Veículo (planilha)">
                            <Truck className="h-3.5 w-3.5" />
                            {[group.load.sheetCavalo, group.load.sheetCarreta].filter(Boolean).join(" · ")}
                          </span>
                        ) : null}
                        {group.load.sheetStatus ? (
                          <span className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-muted/20 px-3 py-1.5 text-xs font-semibold text-muted-foreground" title="Status (planilha)">
                            {group.load.sheetStatus}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {!isCollapsed ? (
                    <div id={`lead-group-${group.load.id}`} className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-primary/[0.045]">
                          <tr className="border-b border-border/70">
                            <th className="px-4 py-4 text-left text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Fila</th>
                            <th className="px-4 py-4 text-left text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Entrada</th>
                            <th className="px-4 py-4 text-left text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Telefone</th>
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
                                  <div className="flex items-center gap-2 font-medium">
                                    <Phone className="h-4 w-4 text-primary" />
                                    {lead.phone}
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
                                      onClick={() => void handleApprove(group.load.id, lead.id)}
                                      disabled={!canApprove || approvingLeadId === lead.id}
                                      className="inline-flex items-center gap-2 rounded-full border border-border/80 px-4 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                      {approvingLeadId === lead.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                                      {isApprovedLead ? "Ja reservado" : "Reservar para este motorista"}
                                    </button>

                                    <button
                                      type="button"
                                      onClick={() => void handleCancel(group.load.id, lead.id, lead.cpf)}
                                      disabled={cancellingLeadId === lead.id}
                                      title={`Cancelar candidatura${lead.cpf ? ` do CPF ${lead.cpf}` : ""}`}
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
                        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Leads nesta disputa</p>
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
          </>
        )}
      </main>

      <DriverDetailModal
        open={selectedDriver !== null}
        onOpenChange={(open) => { if (!open) setSelectedDriver(null); }}
        data={selectedDriver}
      />
    </div>
  );
};

export default Leads;
