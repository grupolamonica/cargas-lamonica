import { Ban, BadgeCheck, CheckCircle2, ChevronDown, ChevronUp, Layers, Loader2, MessageCircle, Phone, Route, Truck, User } from "lucide-react";

import ClientLogo from "@/components/ClientLogo";
import { cn } from "@/lib/utils";
import { resolveVinculoStyle } from "@/lib/vinculo";
import { buildDisplayDateTime, formatFullDateTime, formatShortDateTime } from "@/lib/dateDisplay";
import type { OperatorLeadGroup, OperatorLeadPacoteMeta, PublicLeadValidationSummary } from "@/services/loadClaims";

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
 * Aggrega o status dos N leads de um motorista no pacote: APPROVED se ALGUMA
 * parada ja foi reservada (entao o motorista ja venceu o pacote no operador),
 * QUEUED se todas estao na fila ainda, mixed caso contrario.
 */
function aggregateCandidaturaStatus(items: PacoteLeadItem[]) {
  if (items.some((it) => it.lead.status === "APPROVED")) return "APPROVED";
  if (items.every((it) => it.lead.status === "QUEUED")) return "QUEUED";
  return "MIXED";
}

/**
 * Driver name de um motorista no pacote: usa driverName (resolvido pelo
 * backend) do primeiro lead. Como cada candidatura replica para todas as
 * paradas com o mesmo CPF, o nome eh consistente entre items.
 */
function pickDriverName(items: PacoteLeadItem[]) {
  for (const it of items) {
    if (it.lead.driverName?.trim()) return it.lead.driverName.trim();
  }
  return null;
}

/**
 * Vínculo do motorista no pacote: o mesmo CPF replica em todas as paradas, então
 * o vínculo é consistente — pega o primeiro lead que tiver.
 */
function pickVinculo(items: PacoteLeadItem[]) {
  for (const it of items) {
    if (it.lead.vinculo?.trim()) return it.lead.vinculo.trim();
  }
  return null;
}

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
  /**
   * Aprova um motorista para o pacote inteiro (todas as paradas com leads
   * QUEUED daquele driver). Reaproveita createPacoteClaim do iter #3 via
   * sequenciamento de approveOperatorLoadLead por lead.
   */
  onApprovePacote?: (candidatura: DriverCandidatura) => void;
  /** Cancela todas as candidaturas (uma por parada) de um motorista no pacote. */
  onCancelPacote?: (candidatura: DriverCandidatura) => void;
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
  onApprovePacote,
  onCancelPacote,
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

  // Trajeto consolidado: cidade1 -> cidade2 -> cidade3 (uma vez cada).
  const trajeto = (() => {
    const cidades: string[] = [];
    paradas.forEach((p, i) => {
      const o = p.group.load.origem;
      const d = p.group.load.destino;
      if (i === 0) cidades.push(o, d);
      else if (cidades[cidades.length - 1] !== o) cidades.push(o, d);
      else cidades.push(d);
    });
    return cidades.join(" -> ");
  })();
  const firstParadaPerfil = paradas[0]?.group.load.perfil ?? "";

  return (
    <article
      className={cn(
        // iter #9: overflow-visible permite badge top-right respirar.
        "admin-panel relative transition-all outline outline-[3px] -outline-offset-1",
        pacoteStatusStyle.ring,
        pacoteStatusStyle.shadow,
      )}
      data-testid={`pacote-lead-card-${pacoteMeta.id}`}
    >
      {/* Status badge top-right (espelha avulsa) — usa cor do status do pacote. */}
      <span
        className={cn(
          "absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-[0.14em] shadow-sm",
          pacoteStatusStyle.badge,
        )}
      >
        <Layers className="h-3 w-3" />
        Viagem casada
      </span>

      {/* Header consolidado iter #9 — 3 linhas espelhando o avulsa: chips
          identificadores + valor + candidato count na linha 1, "Viagem casada
          — N paradas" + status + perfil na linha 2, trajeto na linha 3. */}
      <div className="border-b border-border/70 px-5 py-3 lg:px-6">
        <div className="flex flex-wrap items-center gap-2 pr-32">
          <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-primary/60">
            Pacote {pacoteMeta.id.slice(0, 8)}
          </p>
          {pacoteMeta.version != null ? (
            <span className="inline-flex rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[0.6rem] font-mono text-muted-foreground">
              v{pacoteMeta.version}
            </span>
          ) : null}
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.6rem] font-semibold",
              pacoteStatusStyle.pill,
            )}
          >
            {pacoteStatusStyle.label}
          </span>
          {firstParadaPerfil ? (
            <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[0.6rem] font-semibold text-muted-foreground">
              {firstParadaPerfil}
            </span>
          ) : null}
          {valorTotalLabel ? (
            <span className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[0.6rem] font-semibold text-emerald-700 dark:text-emerald-200">
              {valorTotalLabel}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[0.6rem] font-semibold text-muted-foreground">
            {candidaturas.length} {candidaturas.length === 1 ? "candidato" : "candidatos"}
          </span>
        </div>

        <h3 className="mt-1.5 flex items-center gap-2 text-base font-semibold tracking-tight text-foreground">
          {firstClienteLogoUrl ? (
            <ClientLogo logoUrl={firstClienteLogoUrl} name={firstClienteNome ?? ""} className="h-5 w-5 shrink-0" />
          ) : null}
          <span className="truncate">
            Viagem casada — {totalParadas}{isComplete ? "" : `/${totalCargas}`} paradas
          </span>
        </h3>

        {/* Linha 3: trajeto + toggle */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex max-w-2xl items-center gap-1.5 rounded-full border border-border/70 bg-muted/20 px-2.5 py-1 text-[0.65rem] font-semibold text-muted-foreground" title={trajeto}>
            <Route className="h-3 w-3" />
            <span className="truncate">{trajeto}</span>
          </span>
          <div className="ml-auto">
            <button
              type="button"
              onClick={onToggleCollapse}
              className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-white px-2.5 py-1 text-[0.65rem] font-semibold text-foreground transition-colors duration-200 hover:bg-muted dark:bg-muted/40"
              aria-expanded={!isCollapsed}
              aria-controls={`pacote-lead-${pacoteMeta.id}`}
            >
              {isCollapsed ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
              {isCollapsed ? "Expandir pacote" : "Minimizar pacote"}
            </button>
          </div>
        </div>
      </div>

      {!isCollapsed ? (
        <div id={`pacote-lead-${pacoteMeta.id}`}>
          {/* Paradas em lista compacta 1-linha cada (iter #9 — antes era card grande). */}
          <div className="border-b border-border/70 px-5 py-3 lg:px-6">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Paradas
            </p>
            <ul className="mt-2 space-y-1">
              {paradas.map((item, index) => {
                const { group } = item;
                const ordem = group.load.ordemViagem ?? index + 1;
                const coletaLabel =
                  group.load.sheetDataCarregamento ||
                  formatShortDateTime(buildDisplayDateTime(group.load.data, group.load.horario), "A confirmar");
                return (
                  <li
                    key={group.load.id}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border/40 bg-muted/15 px-2.5 py-1.5 text-xs"
                    data-testid={`pacote-parada-${ordem}`}
                  >
                    <span className="inline-flex h-5 min-w-[1.5rem] items-center justify-center rounded-full bg-primary px-1.5 text-[0.6rem] font-bold text-primary-foreground">
                      #{ordem}
                    </span>
                    {group.load.sheetLh ? (
                      <span className="inline-flex rounded-full border border-primary/15 bg-primary/8 px-2 py-0.5 text-[0.6rem] font-bold font-mono text-primary">
                        LH {group.load.sheetLh}
                      </span>
                    ) : null}
                    <CargaStatusBadge status={group.load.status} />
                    <span className="font-semibold text-foreground truncate max-w-xs">
                      {group.load.origem} -&gt; {group.load.destino}
                    </span>
                    <span className="ml-auto inline-flex items-center gap-1 text-[0.65rem] text-muted-foreground">
                      <Truck className="h-3 w-3" />
                      <span className="truncate max-w-[12rem]">{coletaLabel}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Candidaturas em TABELA igual avulsa: 1 row por motorista (cpf|phone),
              colunas Fila / Entrada / Motorista / Status / Acoes. Acoes operam
              no PACOTE inteiro (reservar todos / cancelar todos os leads do
              driver). Iter #9 — substituiu o card-por-candidatura + lista nested
              de paradas que duplicava informacao. */}
          <div className="border-b border-border/70 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-primary/[0.045]">
                <tr className="border-b border-border/70">
                  <th className="px-4 py-3 text-left text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Fila</th>
                  <th className="px-4 py-3 text-left text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Entrada</th>
                  <th className="px-4 py-3 text-left text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Motorista</th>
                  <th className="px-4 py-3 text-left text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-right text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Acoes</th>
                </tr>
              </thead>
              <tbody>
                {candidaturas.map((cand, idx) => {
                  const firstLead = cand.items[0]?.lead;
                  const validation = firstLead?.validation ?? null;
                  const whatsappUrl = firstLead?.whatsappUrl ?? "";
                  const driverName = pickDriverName(cand.items);
                  const vinculoStyle = resolveVinculoStyle(pickVinculo(cand.items));
                  const aggregateStatus = aggregateCandidaturaStatus(cand.items);
                  const cpfMask = maskCpfSuffix(cand.cpf);
                  const phoneFormatted = formatPhoneDisplay(cand.phone);
                  const subLabel = driverName
                    ? [cpfMask ? `CPF ${cpfMask}` : null, phoneFormatted].filter(Boolean).join(" · ")
                    : cpfMask
                      ? `CPF ${cpfMask} · sem cadastro`
                      : "sem cadastro";
                  // Acoes em batch: aprova / cancela TODAS as paradas QUEUED do motorista.
                  const hasQueuedItems = cand.items.some((it) => it.lead.status === "QUEUED");
                  const isApprovingAny = cand.items.some((it) => approvingLeadId === it.lead.id);
                  const isCancellingAny = cand.items.some((it) => cancellingLeadId === it.lead.id);
                  const queuedAt =
                    cand.items[0]?.lead.queuedAt || cand.items[0]?.lead.preRegisteredAt || null;
                  return (
                    <tr
                      key={`${cand.cpf}|${cand.phone}`}
                      className="border-b border-border/70 last:border-0 transition-colors duration-200 hover:bg-primary/[0.03] cursor-pointer"
                      data-testid={`pacote-candidatura-${cand.cpf}-${cand.phone}`}
                      onClick={() => firstLead && onOpenDriverDetail(firstLead)}
                    >
                      <td className="px-4 py-3 font-semibold text-foreground">#{idx + 1}</td>
                      <td className="px-4 py-3 text-foreground text-xs">{formatFullDateTime(queuedAt)}</td>
                      <td className="px-4 py-3 text-foreground">
                        <div className="flex items-start gap-2 font-medium">
                          {driverName ? (
                            <User className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                          ) : (
                            <Phone className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                          )}
                          <div className="min-w-0 leading-tight">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate">{driverName ?? phoneFormatted}</span>
                              {vinculoStyle ? (
                                <span
                                  className={cn(
                                    "shrink-0 rounded-full px-1.5 py-0.5 text-[0.55rem] font-bold uppercase tracking-wide",
                                    vinculoStyle.className,
                                  )}
                                  title={`Vínculo: ${vinculoStyle.label}`}
                                >
                                  {vinculoStyle.label}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-0.5 truncate text-[0.65rem] font-normal text-muted-foreground">
                              {subLabel}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex rounded-full px-2.5 py-0.5 text-[0.65rem] font-semibold",
                            aggregateStatus === "APPROVED"
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200"
                              : aggregateStatus === "QUEUED"
                                ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200"
                                : "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-200",
                          )}
                        >
                          {aggregateStatus === "APPROVED"
                            ? "Reservado"
                            : aggregateStatus === "QUEUED"
                              ? "Na fila"
                              : "Parcial"}
                        </span>
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex flex-wrap justify-end gap-1.5">
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
                          {onApprovePacote ? (
                            <button
                              type="button"
                              onClick={() => onApprovePacote(cand)}
                              disabled={!hasQueuedItems || isApprovingAny}
                              title="Reserva o pacote inteiro para este motorista (todas as paradas QUEUED de uma vez)"
                              className="inline-flex items-center gap-1.5 rounded-full border border-border/80 px-2.5 py-1 text-[0.65rem] font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {isApprovingAny ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : aggregateStatus === "APPROVED" ? (
                                <BadgeCheck className="h-3 w-3 text-emerald-600" />
                              ) : (
                                <CheckCircle2 className="h-3 w-3" />
                              )}
                              {aggregateStatus === "APPROVED" ? "Reservado" : "Reservar pacote"}
                            </button>
                          ) : (
                            // Fallback: aprova a primeira parada QUEUED se nao tem onApprovePacote.
                            <button
                              type="button"
                              onClick={() => {
                                const next = cand.items.find((it) => it.lead.status === "QUEUED");
                                if (next) onApprove(next.group.load.id, next.lead.id, validation);
                              }}
                              disabled={!hasQueuedItems || isApprovingAny}
                              className="inline-flex items-center gap-1.5 rounded-full border border-border/80 px-2.5 py-1 text-[0.65rem] font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {isApprovingAny ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                              Reservar parada
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              if (onCancelPacote) onCancelPacote(cand);
                              else cand.items.forEach((it) => onCancel(it.group.load.id, it.lead.id, it.lead.cpf));
                            }}
                            disabled={isCancellingAny}
                            className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-[0.65rem] font-semibold text-red-700 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-400/40 dark:bg-red-500/15 dark:text-red-200 dark:hover:bg-red-500/25"
                          >
                            {isCancellingAny ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />}
                            Cancelar
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Footer 3-metric row (espelha avulsa 1118-1133). */}
          <div className="grid gap-3 px-5 py-3 text-sm lg:grid-cols-3 lg:px-6">
            <div className="admin-soft-panel px-4 py-3">
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Paradas</p>
              <p className="mt-2 text-base font-semibold text-foreground">{totalParadas}</p>
            </div>
            <div className="admin-soft-panel px-4 py-3">
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Candidatos</p>
              <p className="mt-2 text-base font-semibold text-foreground">{candidaturas.length}</p>
            </div>
            <div className="admin-soft-panel px-4 py-3">
              <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Reservados</p>
              <p className="mt-2 text-base font-semibold text-foreground">{approvedCount}</p>
            </div>
          </div>
        </div>
      ) : (
        <div id={`pacote-lead-${pacoteMeta.id}`} className="grid gap-3 px-5 py-3 text-sm lg:grid-cols-3 lg:px-6">
          <div className="admin-soft-panel px-4 py-3">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Paradas</p>
            <p className="mt-2 text-base font-semibold text-foreground">{totalParadas}</p>
          </div>
          <div className="admin-soft-panel px-4 py-3">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Candidatos</p>
            <p className="mt-2 text-base font-semibold text-foreground">{candidaturas.length}</p>
          </div>
          <div className="admin-soft-panel px-4 py-3">
            <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Reservados</p>
            <p className="mt-2 text-base font-semibold text-foreground">{approvedCount}</p>
          </div>
        </div>
      )}
    </article>
  );
};

export default OperatorPacoteLeadCard;
