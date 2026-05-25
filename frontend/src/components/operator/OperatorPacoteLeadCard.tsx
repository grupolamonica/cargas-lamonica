import { Ban, BadgeCheck, CheckCircle2, ChevronDown, ChevronUp, Layers, Loader2, MessageCircle, Phone, Route, Truck, User } from "lucide-react";

import ClientLogo from "@/components/ClientLogo";
import { cn } from "@/lib/utils";
import { buildDisplayDateTime, formatShortDateTime } from "@/lib/dateDisplay";
import type { OperatorLeadGroup, OperatorLeadPacoteMeta, PublicLeadValidationSummary } from "@/services/loadClaims";

const PACOTE_STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  rascunho: { label: "Rascunho", cls: "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-200" },
  publicado: { label: "Publicado", cls: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200" },
  reservado: { label: "Reservado", cls: "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-200" },
  em_andamento: { label: "Em andamento", cls: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200" },
  concluido: { label: "Concluído", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200" },
  cancelado: { label: "Cancelado", cls: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-200" },
};

function PacoteStatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const style = PACOTE_STATUS_STYLE[status] ?? {
    label: status,
    cls: "bg-muted text-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[0.68rem] font-semibold",
        style.cls,
      )}
    >
      {style.label}
    </span>
  );
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
  /** O lead desta carga referente ao mesmo motorista. */
  lead: OperatorLeadGroup["leads"][number];
}

interface Props {
  pacoteMeta: OperatorLeadPacoteMeta;
  /** Carga + lead daquele motorista para cada parada (ordenado por ordem_viagem ASC). */
  items: PacoteLeadItem[];
  /** Identifica o motorista (CPF/phone do primeiro lead). */
  driverCpf: string;
  driverPhone: string;
  /** WhatsApp URL — usa o do primeiro lead (igual em todos). */
  whatsappUrl: string;
  /** Validation summary — igual para todos os leads. */
  validation: PublicLeadValidationSummary | null | undefined;
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
 * Card agrupado que representa uma candidatura única a um pacote (cargas
 * casadas). O motorista mandou UMA candidatura — o backend replicou em N
 * cargas; aqui apresentamos as N paradas como uma viagem casada.
 *
 * Cada parada mostra:
 *  - Ordem + LH + rota + horários de coleta/entrega
 *  - Status da carga e do lead individual
 *  - Botão "Reservar para este motorista" e "Cancelar candidatura" por parada
 *
 * Decisão UX: aprovação/cancelamento permanece por carga (atomic claim do
 * pacote roda em fluxo separado). UI só agrupa visualmente para o operador
 * conseguir avaliar a viagem inteira.
 */
const OperatorPacoteLeadCard = ({
  pacoteMeta,
  items,
  driverCpf,
  driverPhone,
  whatsappUrl,
  validation,
  isCollapsed,
  onToggleCollapse,
  approvingLeadId,
  cancellingLeadId,
  onApprove,
  onCancel,
  onOpenDriverDetail,
}: Props) => {
  const totalParadas = items.length;
  const totalCargas = pacoteMeta.totalCargas ?? totalParadas;
  const isComplete = pacoteMeta.totalCargas != null && totalParadas === pacoteMeta.totalCargas;
  const valorTotalLabel = formatCurrency(pacoteMeta.valorTotal);
  const firstClienteLogoUrl = items[0]?.group.load.clienteLogoUrl ?? null;
  const firstClienteNome = items[0]?.group.load.clienteNome ?? null;

  // Sufixo do CPF para diálogo de cancelamento (defense in depth — não vaza CPF cheio).
  const cpfDigits = driverCpf?.trim() ?? "";

  return (
    <article
      className="admin-panel overflow-hidden relative transition-all outline outline-[3px] -outline-offset-1 outline-violet-500 shadow-[0_0_0_6px_rgba(139,92,246,0.18)] dark:outline-violet-400"
      data-testid={`pacote-lead-card-${pacoteMeta.id}`}
    >
      <span className="absolute right-4 top-4 z-10 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.65rem] font-bold uppercase tracking-[0.16em] shadow-sm bg-violet-500 text-white">
        <Layers className="h-3 w-3" />
        Viagem casada
      </span>

      <div className="border-b border-border/70 px-5 py-5 lg:px-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">
                Pacote {pacoteMeta.id.slice(0, 8)}
              </p>
              <span className="inline-flex rounded-full border border-violet-500/15 bg-violet-500/8 px-2.5 py-0.5 text-[0.68rem] font-bold text-violet-700 dark:text-violet-200">
                {totalParadas}{isComplete ? "" : `/${totalCargas}`} paradas
              </span>
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
              Candidatura única — {totalParadas} {totalParadas === 1 ? "parada" : "paradas"}
            </h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <PacoteStatusBadge status={pacoteMeta.status ?? null} />
              {valorTotalLabel ? (
                <span className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-[0.68rem] font-semibold text-emerald-700 dark:text-emerald-200">
                  Valor total {valorTotalLabel}
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/30 px-2.5 py-0.5 text-[0.68rem] font-semibold text-muted-foreground">
                <Phone className="h-3 w-3" />
                {driverPhone}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onToggleCollapse}
              className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-white px-3 py-1.5 text-xs font-semibold text-foreground transition-colors duration-200 hover:bg-muted dark:bg-muted/40"
              aria-expanded={!isCollapsed}
              aria-controls={`pacote-lead-${pacoteMeta.id}-${cpfDigits}`}
            >
              {isCollapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
              {isCollapsed ? "Expandir paradas" : "Minimizar paradas"}
            </button>
            <button
              type="button"
              onClick={() => window.open(whatsappUrl, "_blank", "noopener,noreferrer")}
              className="inline-flex items-center gap-2 rounded-full bg-[linear-gradient(135deg,#23b26b,#25D366)] px-4 py-1.5 text-xs font-semibold text-white shadow-[0_10px_22px_rgba(37,211,102,0.24)] transition-all duration-200 hover:-translate-y-0.5"
            >
              <MessageCircle className="h-4 w-4" />
              Chamar no WhatsApp
            </button>
          </div>
        </div>
      </div>

      {!isCollapsed ? (
        <div id={`pacote-lead-${pacoteMeta.id}-${cpfDigits}`} className="divide-y divide-border/70">
          {items.map((item, index) => {
            const { group, lead } = item;
            const isApproved = lead.status === "APPROVED";
            const canApprove = group.load.status === "OPEN" && lead.status === "QUEUED";
            const isApproving = approvingLeadId === lead.id;
            const isCancelling = cancellingLeadId === lead.id;
            const ordem = group.load.ordemViagem ?? index + 1;
            const coletaLabel =
              group.load.sheetDataCarregamento ||
              formatShortDateTime(buildDisplayDateTime(group.load.data, group.load.horario), "A confirmar");
            const descargaLabel = group.load.sheetDataDescarga || null;

            return (
              <div
                key={`${group.load.id}-${lead.id}`}
                className="px-5 py-4 lg:px-6 cursor-pointer hover:bg-primary/[0.03] transition-colors"
                onClick={() => onOpenDriverDetail(lead)}
                data-testid={`pacote-parada-${ordem}`}
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-1 flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex h-7 min-w-[2rem] items-center justify-center rounded-full bg-violet-500 px-2 text-xs font-bold text-white">
                        #{ordem}
                      </span>
                      {group.load.sheetLh ? (
                        <span className="inline-flex rounded-full border border-primary/15 bg-primary/8 px-2.5 py-0.5 text-[0.68rem] font-bold font-mono text-primary">
                          LH {group.load.sheetLh}
                        </span>
                      ) : null}
                      <CargaStatusBadge status={group.load.status} />
                      <LeadStatusBadge status={lead.status} />
                    </div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Route className="h-4 w-4 text-violet-500" />
                      {group.load.origem} -&gt; {group.load.destino}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
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

                  <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => onApprove(group.load.id, lead.id, validation)}
                      disabled={!canApprove || isApproving}
                      className="inline-flex items-center gap-2 rounded-full border border-border/80 px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isApproving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : isApproved ? <BadgeCheck className="h-3.5 w-3.5 text-emerald-600" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      {isApproved ? "Já reservada" : "Reservar parada"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onCancel(group.load.id, lead.id, lead.cpf)}
                      disabled={isCancelling}
                      className="inline-flex items-center gap-2 rounded-full border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-400/40 dark:bg-red-500/15 dark:text-red-200"
                    >
                      {isCancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                      Cancelar
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div id={`pacote-lead-${pacoteMeta.id}-${cpfDigits}`} className="px-5 py-4 lg:px-6 text-sm text-muted-foreground">
          {totalParadas} parada{totalParadas === 1 ? "" : "s"} agrupada{totalParadas === 1 ? "" : "s"} nesta candidatura.
        </div>
      )}
    </article>
  );
};

export default OperatorPacoteLeadCard;
