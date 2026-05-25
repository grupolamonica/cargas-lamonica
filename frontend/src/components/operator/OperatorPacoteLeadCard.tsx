import { Ban, BadgeCheck, CheckCircle2, ChevronDown, ChevronUp, Layers, Loader2, MessageCircle, Phone, Route, Truck, User } from "lucide-react";

import ClientLogo from "@/components/ClientLogo";
import { cn } from "@/lib/utils";
import { buildDisplayDateTime, formatShortDateTime } from "@/lib/dateDisplay";
import type { OperatorLeadGroup, OperatorLeadPacoteMeta, PublicLeadValidationSummary } from "@/services/loadClaims";

/**
 * pacoteStatusStyle: mapeia o status do pacote para o mesmo vocabulario visual
 * do card avulsa (ring + shadow + badge). Mantemos o badge "Viagem casada"
 * separadamente para identificar o tipo de carga; o status do pacote ocupa o
 * top-right (igual avulsa) e define a cor do ring/shadow do card.
 */
const PACOTE_STATUS_STYLE: Record<string, { label: string; ring: string; shadow: string; badge: string; pill: string }> = {
  rascunho: {
    label: "Rascunho",
    ring: "outline-slate-400 dark:outline-slate-400",
    shadow: "shadow-[0_0_0_6px_rgba(148,163,184,0.15)]",
    badge: "bg-slate-500 text-white",
    pill: "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-200",
  },
  publicado: {
    label: "Publicado",
    ring: "outline-blue-500 dark:outline-blue-400",
    shadow: "shadow-[0_0_0_6px_rgba(59,130,246,0.15)]",
    badge: "bg-blue-500 text-white",
    pill: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200",
  },
  reservado: {
    label: "Reservado",
    ring: "outline-violet-500 dark:outline-violet-400",
    shadow: "shadow-[0_0_0_6px_rgba(139,92,246,0.18)]",
    badge: "bg-violet-500 text-white",
    pill: "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-200",
  },
  em_andamento: {
    label: "Em andamento",
    ring: "outline-amber-500 dark:outline-amber-400",
    shadow: "shadow-[0_0_0_6px_rgba(245,158,11,0.18)]",
    badge: "bg-amber-500 text-white",
    pill: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200",
  },
  concluido: {
    label: "Concluido",
    ring: "outline-emerald-500 dark:outline-emerald-400",
    shadow: "shadow-[0_0_0_6px_rgba(16,185,129,0.15)]",
    badge: "bg-emerald-500 text-white",
    pill: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200",
  },
  cancelado: {
    label: "Cancelado",
    ring: "outline-red-400 dark:outline-red-400",
    shadow: "shadow-[0_0_0_6px_rgba(248,113,113,0.15)]",
    badge: "bg-red-400 text-white",
    pill: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-200",
  },
};

function resolvePacoteStatusStyle(status: string | null) {
  if (!status) return PACOTE_STATUS_STYLE.publicado;
  return PACOTE_STATUS_STYLE[status] ?? {
    label: status,
    ring: "outline-slate-400 dark:outline-slate-400",
    shadow: "shadow-[0_0_0_6px_rgba(148,163,184,0.15)]",
    badge: "bg-slate-500 text-white",
    pill: "bg-muted text-foreground",
  };
}

function CargaStatusBadge({ status }: { status: string }) {
  const isOpen = status === "OPEN";
  const isReserved = status === "RESERVED";
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-[0.65rem] font-semibold",
        isOpen
          ? "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200"
          : isReserved
            ? "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-200"
            : "bg-muted text-muted-foreground",
      )}
    >
      {isOpen ? "Em aberto" : isReserved ? "Reservada" : status}
    </span>
  );
}

function LeadStatusBadge({ status }: { status: string }) {
  const isApproved = status === "APPROVED";
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2.5 py-0.5 text-[0.65rem] font-semibold",
        isApproved
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200"
          : "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200",
      )}
    >
      {isApproved ? "Reservado" : "Na fila"}
    </span>
  );
}

function formatCurrency(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

export interface PacoteLeadItem {
  /** Group da carga (uma parada do pacote). */
  group: OperatorLeadGroup;
  /** O lead desta carga referente a um motorista candidato. */
  lead: OperatorLeadGroup["leads"][number];
}

export interface DriverCandidatura {
  cpf: string;
  phone: string;
  /** Items (parada+lead) deste motorista neste pacote (ordenados por ordem_viagem). */
  items: PacoteLeadItem[];
}

interface Props {
  pacoteMeta: OperatorLeadPacoteMeta;
  /** Todos os items do pacote (flatten — usado para metricas e ordering). */
  items: PacoteLeadItem[];
  /** N motoristas que se candidataram a este mesmo pacote. */
  candidaturas: DriverCandidatura[];
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  approvingLeadId: string | null;
  cancellingLeadId: string | null;
  onApprove: (loadId: string, leadId: string, validation: PublicLeadValidationSummary | null | undefined) => void;
  onCancel: (loadId: string, leadId: string, cpf: string | null) => void;
  /** Permite chamar driver-detail modal (mesmo contrato do componente avulso). */
  onOpenDriverDetail: (lead: OperatorLeadGroup["leads"][number]) => void;
}

/**
 * Card de pacote (viagem casada): espelha visualmente o card avulsa em
 * `Leads.tsx` (status badge top-right, header com ID+chips+title+pills, footer
 * 3-metric grid), mas adaptado para multi-parada + multi-candidato.
 *
 * Estrutura:
 *  - Ring/shadow do card depende do status do PACOTE (publicado/reservado/...)
 *  - Badge top-right "Viagem casada" identifica o tipo (cor segue o status do pacote)
 *  - Header: chips (Pacote ID, LH de cada carga), titulo, status pill + valor + candidato count
 *  - Action row: toggle expand/collapse
 *  - Body (expandido): paradas (uma por carga) + lista de candidaturas (N motoristas)
 *  - Footer: 3-metric grid (paradas, candidatos, reservados)
 */
const OperatorPacoteLeadCard = ({
  pacoteMeta,
  items,
  candidaturas,
  isCollapsed,
  onToggleCollapse,
  approvingLeadId,
  cancellingLeadId,
  onApprove,
  onCancel,
  onOpenDriverDetail,
}: Props) => {
  // Paradas unicas do pacote — dedup por load.id (varias candidaturas geram items repetidos).
  const paradasMap = new Map<string, PacoteLeadItem>();
  items.forEach((it) => {
    if (!paradasMap.has(it.group.load.id)) {
      paradasMap.set(it.group.load.id, it);
    }
  });
  const paradas = Array.from(paradasMap.values());
  const totalParadas = paradas.length;
  const totalCargas = pacoteMeta.totalCargas ?? totalParadas;
  const isComplete = pacoteMeta.totalCargas != null && totalParadas === pacoteMeta.totalCargas;
  const valorTotalLabel = formatCurrency(pacoteMeta.valorTotal);
  const firstClienteLogoUrl = paradas[0]?.group.load.clienteLogoUrl ?? null;
  const firstClienteNome = paradas[0]?.group.load.clienteNome ?? null;
  const pacoteStatusStyle = resolvePacoteStatusStyle(pacoteMeta.status ?? null);

  // Metricas para o footer 3-metric grid (espelha avulsa: candidatos + reservados).
  const approvedCount = candidaturas.reduce(
    (sum, cand) => sum + cand.items.filter((it) => it.lead.status === "APPROVED").length,
    0,
  );

  return (
    <article
      className={cn(
        "admin-panel overflow-hidden relative transition-all outline outline-[3px] -outline-offset-1",
        pacoteStatusStyle.ring,
        pacoteStatusStyle.shadow,
      )}
      data-testid={`pacote-lead-card-${pacoteMeta.id}`}
    >
      {/* Status badge top-right (espelha avulsa) — usa cor do status do pacote. */}
      <span
        className={cn(
          "absolute right-4 top-4 z-10 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.65rem] font-bold uppercase tracking-[0.16em] shadow-sm",
          pacoteStatusStyle.badge,
        )}
      >
        <Layers className="h-3 w-3" />
        Viagem casada
      </span>

      {/* Header (espelha avulsa linhas 906-936). */}
      <div className="border-b border-border/70 px-5 py-5 lg:px-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">
                Pacote {pacoteMeta.id.slice(0, 8)}
              </p>
              {/*
                Decisao UX: os LH de cada parada aparecem na secao "Paradas do pacote".
                O header so identifica o pacote (ID + versao) — manter LH aqui geraria
                duplicacao visual quando o pacote tem 2+ paradas.
              */}
              {pacoteMeta.version != null ? (
                <span className="inline-flex rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[0.6rem] font-mono text-muted-foreground">
                  v{pacoteMeta.version}
                </span>
              ) : null}
            </div>
            <h3 className="mt-2 flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
              {firstClienteLogoUrl ? (
                <ClientLogo logoUrl={firstClienteLogoUrl} name={firstClienteNome ?? ""} className="h-6 w-6" />
              ) : null}
              Viagem casada — {totalParadas}{isComplete ? "" : `/${totalCargas}`} paradas
            </h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {/* Status pill (espelha LoadStatusBadge do avulsa). */}
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.68rem] font-semibold",
                  pacoteStatusStyle.pill,
                )}
              >
                {pacoteStatusStyle.label}
              </span>
              {valorTotalLabel ? (
                <span className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-[0.68rem] font-semibold text-emerald-700 dark:text-emerald-200">
                  Valor total {valorTotalLabel}
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/30 px-2.5 py-0.5 text-[0.68rem] font-semibold text-muted-foreground">
                {candidaturas.length} {candidaturas.length === 1 ? "candidato" : "candidatos"}
              </span>
            </div>
          </div>

          {/* Action row — toggle (espelha "Expandir disputa" do avulsa). */}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onToggleCollapse}
              className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-white px-3 py-1.5 text-xs font-semibold text-foreground transition-colors duration-200 hover:bg-muted dark:bg-muted/40"
              aria-expanded={!isCollapsed}
              aria-controls={`pacote-lead-${pacoteMeta.id}`}
            >
              {isCollapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
              {isCollapsed ? "Expandir paradas" : "Minimizar paradas"}
            </button>
          </div>
        </div>
      </div>

      {!isCollapsed ? (
        <div id={`pacote-lead-${pacoteMeta.id}`}>
          {/* Paradas do pacote. */}
          <div className="border-b border-border/70 px-5 py-4 lg:px-6">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              Paradas do pacote
            </p>
            <div className="mt-3 space-y-2">
              {paradas.map((item, index) => {
                const { group } = item;
                const ordem = group.load.ordemViagem ?? index + 1;
                const coletaLabel =
                  group.load.sheetDataCarregamento ||
                  formatShortDateTime(buildDisplayDateTime(group.load.data, group.load.horario), "A confirmar");
                const descargaLabel = group.load.sheetDataDescarga || null;

                return (
                  <div
                    key={group.load.id}
                    className="rounded-lg border border-border/50 bg-muted/20 p-3"
                    data-testid={`pacote-parada-${ordem}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex h-7 min-w-[2rem] items-center justify-center rounded-full bg-primary px-2 text-xs font-bold text-primary-foreground">
                        #{ordem}
                      </span>
                      {group.load.sheetLh ? (
                        <span className="inline-flex rounded-full border border-primary/15 bg-primary/8 px-2.5 py-0.5 text-[0.68rem] font-bold font-mono text-primary">
                          LH {group.load.sheetLh}
                        </span>
                      ) : null}
                      <CargaStatusBadge status={group.load.status} />
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Route className="h-4 w-4 text-primary" />
                      {group.load.origem} -&gt; {group.load.destino}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/20 px-2.5 py-0.5 font-semibold">
                        <Truck className="h-3 w-3" />
                        Coleta: {coletaLabel}
                      </span>
                      {descargaLabel ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/20 px-2.5 py-0.5 font-semibold">
                          <Route className="h-3 w-3" />
                          Entrega: {descargaLabel}
                        </span>
                      ) : null}
                      {group.load.sheetMotorista ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/20 px-2.5 py-0.5 font-semibold">
                          <User className="h-3 w-3" />
                          {group.load.sheetMotorista}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Candidaturas — N motoristas no mesmo pacote, cada um com seus N leads (1 por parada). */}
          <div className="space-y-3 border-b border-border/70 px-5 py-4 lg:px-6">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              Candidaturas ({candidaturas.length})
            </p>
            {candidaturas.map((cand) => {
              const firstLead = cand.items[0]?.lead;
              const whatsappUrl = firstLead?.whatsappUrl ?? "";
              const validation = firstLead?.validation ?? null;
              return (
                <div
                  key={`${cand.cpf}|${cand.phone}`}
                  className="rounded-xl border border-border/60 bg-card p-3"
                  data-testid={`pacote-candidatura-${cand.cpf}-${cand.phone}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm">
                      <Phone className="h-3.5 w-3.5 text-primary" />
                      <span className="font-semibold text-foreground">{cand.phone || "Sem telefone"}</span>
                      {cand.cpf ? (
                        <span className="font-mono text-[0.65rem] text-muted-foreground">
                          CPF final {cand.cpf.trim().slice(-2)}
                        </span>
                      ) : null}
                    </div>
                    {whatsappUrl ? (
                      <button
                        type="button"
                        onClick={() => window.open(whatsappUrl, "_blank", "noopener,noreferrer")}
                        className="inline-flex items-center gap-1.5 rounded-full bg-[linear-gradient(135deg,#23b26b,#25D366)] px-3 py-1 text-[0.65rem] font-semibold text-white shadow-[0_10px_22px_rgba(37,211,102,0.24)]"
                      >
                        <MessageCircle className="h-3 w-3" />
                        WhatsApp
                      </button>
                    ) : null}
                  </div>

                  <div className="mt-2 space-y-1.5">
                    {cand.items.map((it) => {
                      const { group, lead } = it;
                      const isApproved = lead.status === "APPROVED";
                      const canApprove = group.load.status === "OPEN" && lead.status === "QUEUED";
                      const isApproving = approvingLeadId === lead.id;
                      const isCancelling = cancellingLeadId === lead.id;
                      const ordem = group.load.ordemViagem ?? 0;
                      return (
                        <div
                          key={`${group.load.id}-${lead.id}`}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/20 px-2.5 py-1.5 cursor-pointer"
                          onClick={() => onOpenDriverDetail(lead)}
                        >
                          <div className="flex flex-wrap items-center gap-1.5 text-xs">
                            <span className="inline-flex h-5 items-center justify-center rounded-full bg-primary/20 px-1.5 text-[0.6rem] font-bold text-primary">
                              Parada #{ordem}
                            </span>
                            <LeadStatusBadge status={lead.status} />
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => onApprove(group.load.id, lead.id, validation)}
                              disabled={!canApprove || isApproving}
                              className="inline-flex items-center gap-1.5 rounded-full border border-border/80 px-2.5 py-1 text-[0.65rem] font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {isApproving ? <Loader2 className="h-3 w-3 animate-spin" /> : isApproved ? <BadgeCheck className="h-3 w-3 text-emerald-600" /> : <CheckCircle2 className="h-3 w-3" />}
                              {isApproved ? "Já reservada" : "Reservar parada"}
                            </button>
                            <button
                              type="button"
                              onClick={() => onCancel(group.load.id, lead.id, lead.cpf)}
                              disabled={isCancelling}
                              className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-[0.65rem] font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-400/40 dark:bg-red-500/15 dark:text-red-200"
                            >
                              {isCancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />}
                              Cancelar
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer 3-metric row (espelha avulsa 1118-1133). */}
          <div className="grid gap-3 px-5 py-4 text-sm lg:grid-cols-3 lg:px-6">
            <div className="admin-soft-panel px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Paradas</p>
              <p className="mt-2 text-lg font-semibold text-foreground">{totalParadas}</p>
            </div>
            <div className="admin-soft-panel px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Candidatos</p>
              <p className="mt-2 text-lg font-semibold text-foreground">{candidaturas.length}</p>
            </div>
            <div className="admin-soft-panel px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Reservados</p>
              <p className="mt-2 text-lg font-semibold text-foreground">{approvedCount}</p>
            </div>
          </div>
        </div>
      ) : (
        <div id={`pacote-lead-${pacoteMeta.id}`} className="grid gap-3 px-5 py-4 text-sm lg:grid-cols-3 lg:px-6">
          <div className="admin-soft-panel px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Paradas</p>
            <p className="mt-2 text-lg font-semibold text-foreground">{totalParadas}</p>
          </div>
          <div className="admin-soft-panel px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Candidatos</p>
            <p className="mt-2 text-lg font-semibold text-foreground">{candidaturas.length}</p>
          </div>
          <div className="admin-soft-panel px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">Reservados</p>
            <p className="mt-2 text-lg font-semibold text-foreground">{approvedCount}</p>
          </div>
        </div>
      )}
    </article>
  );
};

export default OperatorPacoteLeadCard;
