import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Building2,
  Check,
  CheckCircle2,
  HelpCircle,
  Loader2,
  Truck,
  UserRound,
  XCircle,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { precheckAngellira } from "@/services/readModels";

export type ApproveJob = "angellira" | "spx";

type Props = {
  /** ID do `pending_driver_registrations` — necessário para o precheck */
  cadastroId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  motoristaNome?: string;
  motoristaCpf?: string;
  hasCavalo?: boolean;
  hasCarreta?: boolean;
  /** invocado com o array de jobs ['angellira'] (ou vazio se só criar conta) */
  onConfirm: (jobs: ApproveJob[]) => void;
  isSubmitting?: boolean;
};

/** Status de uma linha do precheck (motorista / cavalo / carreta) */
type RowStatus = "LOADING" | "VIGENTE" | "VENCENDO" | "VENCIDO" | "NAO_CADASTRADO" | "INDISPONIVEL";

type RowInfo = {
  label: string;
  icon: React.ReactNode;
  status: RowStatus;
  validUntil?: string | null;
  daysToExpire?: number | null;
  statusText?: string | null;
  errorMessage?: string | null;
};

const ALERTA_THRESHOLD_DAYS = 30;

/**
 * Modal de aprovação que consulta o Angellira ANTES de oferecer cadastro:
 * - Mostra status por linha (Motorista / Cavalo / Carreta) com cores de vigência
 * - Se TUDO vigente >30d → checkbox Angellira default DESMARCADO + texto
 *   "Dados já vigentes — re-cadastro só atualizaria"
 * - Se alguma linha vence em <30d ou está vencida/não cadastrada → alerta
 *   amarelo/vermelho e checkbox default MARCADO
 * - Forçar re-cadastro com tudo vigente exige 2º opt-in explícito
 *
 * Epic DC-111 / Sprint 1 (refinamento UX 2026-05-29).
 */
export default function ApproveCadastroModal({
  cadastroId,
  open,
  onOpenChange,
  motoristaNome,
  motoristaCpf,
  hasCavalo,
  hasCarreta,
  onConfirm,
  isSubmitting,
}: Props) {
  // 3 linhas: motorista (sempre), cavalo se houver placa, carreta se houver
  const [rows, setRows] = useState<{ motorista: RowInfo; cavalo?: RowInfo; carreta?: RowInfo }>(() => ({
    motorista: { label: "Motorista", icon: <UserRound className="h-4 w-4" />, status: "LOADING" },
    ...(hasCavalo ? { cavalo: { label: "Cavalo", icon: <Truck className="h-4 w-4" />, status: "LOADING" } } : {}),
    ...(hasCarreta ? { carreta: { label: "Carreta", icon: <Truck className="h-4 w-4" />, status: "LOADING" } } : {}),
  }));
  const [precheckDone, setPrecheckDone] = useState(false);
  const [angelliraChecked, setAngelliraChecked] = useState(false);
  /** 2º opt-in: forçar re-cadastro mesmo com tudo vigente */
  const [forceUpdate, setForceUpdate] = useState(false);

  // Roda precheck assim que o modal abre
  useEffect(() => {
    if (!open || !cadastroId) return;
    let cancelled = false;
    setPrecheckDone(false);
    setForceUpdate(false);
    setRows({
      motorista: { label: "Motorista", icon: <UserRound className="h-4 w-4" />, status: "LOADING" },
      ...(hasCavalo ? { cavalo: { label: "Cavalo", icon: <Truck className="h-4 w-4" />, status: "LOADING" } } : {}),
      ...(hasCarreta ? { carreta: { label: "Carreta", icon: <Truck className="h-4 w-4" />, status: "LOADING" } } : {}),
    });

    precheckAngellira(cadastroId)
      .then((res) => {
        if (cancelled) return;
        const newRows: typeof rows = {
          motorista: rowFromPrecheck(res.motorista, "Motorista", <UserRound className="h-4 w-4" />),
        };
        if (hasCavalo) {
          newRows.cavalo = rowFromPrecheck(res.cavalo, "Cavalo", <Truck className="h-4 w-4" />);
        }
        if (hasCarreta) {
          newRows.carreta = rowFromPrecheck(res.carreta, "Carreta", <Truck className="h-4 w-4" />);
        }
        setRows(newRows);
        setPrecheckDone(true);
        // Default do checkbox: marcado SE algum item exige ação
        const needsAction = Object.values(newRows).some((r) =>
          r && ["VENCENDO", "VENCIDO", "NAO_CADASTRADO"].includes(r.status),
        );
        setAngelliraChecked(needsAction);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        // Falha no precheck → modo permissivo: deixa operador decidir
        const fallback = (label: string, icon: React.ReactNode): RowInfo => ({
          label, icon, status: "INDISPONIVEL", errorMessage: err.message,
        });
        setRows({
          motorista: fallback("Motorista", <UserRound className="h-4 w-4" />),
          ...(hasCavalo ? { cavalo: fallback("Cavalo", <Truck className="h-4 w-4" />) } : {}),
          ...(hasCarreta ? { carreta: fallback("Carreta", <Truck className="h-4 w-4" />) } : {}),
        });
        setPrecheckDone(true);
        setAngelliraChecked(true); // sem info, default = cadastrar
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cadastroId, hasCavalo, hasCarreta]);

  // Análise agregada do precheck
  const todosVigentes = useMemo(
    () => precheckDone && Object.values(rows).every((r) => r && r.status === "VIGENTE"),
    [precheckDone, rows],
  );
  const algumVencendo = useMemo(
    () => Object.values(rows).some((r) => r && r.status === "VENCENDO"),
    [rows],
  );
  const algumVencidoOuFaltando = useMemo(
    () => Object.values(rows).some((r) => r && ["VENCIDO", "NAO_CADASTRADO"].includes(r.status)),
    [rows],
  );

  // Quando tudo vigente, o checkbox Angellira só pode ser marcado se o operador
  // primeiro confirmar "Forçar atualização" (2º opt-in).
  const angelliraDisabled = todosVigentes && !forceUpdate;
  const effectiveChecked = todosVigentes ? forceUpdate && angelliraChecked : angelliraChecked;

  const handleConfirm = () => {
    const jobs: ApproveJob[] = [];
    if (effectiveChecked) jobs.push("angellira");
    onConfirm(jobs);
  };

  const nomeFmt = motoristaNome?.toUpperCase() || "—";
  const cpfFmt = motoristaCpf?.replace(/\D/g, "") || "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Check className="h-5 w-5 text-emerald-600" />
            Aprovar cadastro
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <p className="flex items-center gap-2 font-semibold text-foreground">
              <UserRound className="h-4 w-4 text-muted-foreground" />
              {nomeFmt}
            </p>
            {cpfFmt ? <p className="mt-1 text-xs text-muted-foreground">CPF {cpfFmt}</p> : null}
          </div>

          {/* PRECHECK status por linha */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Status atual no Angellira
            </p>
            <div className="space-y-1.5">
              {Object.values(rows).map((row, idx) =>
                row ? <PrecheckRow key={idx} row={row} /> : null,
              )}
            </div>
          </div>

          {/* Alerta agregado conforme o resultado */}
          {precheckDone ? (
            <AlertBlock
              todosVigentes={todosVigentes}
              algumVencendo={algumVencendo}
              algumVencidoOuFaltando={algumVencidoOuFaltando}
            />
          ) : null}

          {/* Checkbox Angellira — comportamento adaptativo */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Após aprovar, também:
            </p>
            <div className="space-y-2">
              <label
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 transition-colors",
                  angelliraDisabled
                    ? "cursor-not-allowed border-border bg-muted/30 opacity-70"
                    : "cursor-pointer hover:border-emerald-200",
                  effectiveChecked && "border-emerald-300 bg-emerald-50/60",
                  !effectiveChecked && !angelliraDisabled && "border-border bg-background",
                )}
              >
                <input
                  type="checkbox"
                  checked={effectiveChecked}
                  disabled={angelliraDisabled}
                  onChange={(e) => setAngelliraChecked(e.target.checked)}
                  className="mt-0.5 h-4 w-4 cursor-pointer accent-emerald-600 disabled:cursor-not-allowed"
                />
                <div className="flex-1 text-sm">
                  <p className="flex items-center gap-2 font-semibold text-foreground">
                    <Building2 className="h-4 w-4 text-emerald-700" />
                    {todosVigentes ? "Re-cadastrar/atualizar no Angellira" : "Cadastrar no Angellira"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {todosVigentes
                      ? "Tudo já está vigente. Atualização força PATCH em todos os registros."
                      : "Proprietário + cavalo + carreta + motorista. ~30-60s."}
                  </p>
                </div>
              </label>

              {/* 2º opt-in quando tudo vigente */}
              {todosVigentes ? (
                <label className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={forceUpdate}
                    onChange={(e) => {
                      setForceUpdate(e.target.checked);
                      if (!e.target.checked) setAngelliraChecked(false);
                    }}
                    className="mt-0.5 h-4 w-4 cursor-pointer accent-amber-600"
                  />
                  <div className="flex-1 text-sm">
                    <p className="flex items-center gap-2 font-semibold text-amber-900">
                      <AlertTriangle className="h-4 w-4" />
                      Forçar atualização mesmo assim
                    </p>
                    <p className="mt-0.5 text-xs text-amber-800">
                      Marque se quiser sobrescrever os dados existentes (raro — use só
                      se houver erro nos cadastros atuais).
                    </p>
                  </div>
                </label>
              ) : null}

              {/* SPX placeholder */}
              <label
                className="flex cursor-not-allowed items-start gap-3 rounded-lg border border-border bg-muted/30 p-3 opacity-60"
                title="Disponível no Sprint 2"
              >
                <input type="checkbox" disabled className="mt-0.5 h-4 w-4" />
                <div className="flex-1 text-sm">
                  <p className="flex items-center gap-2 font-semibold text-muted-foreground">
                    <Truck className="h-4 w-4" />
                    Cadastrar no SPX/Shopee
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">Em breve (Sprint 2 — DC-111).</p>
                </div>
              </label>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
            className="inline-flex items-center justify-center rounded-xl border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-60 transition-colors"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={isSubmitting || !precheckDone}
            onClick={handleConfirm}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-60 transition-colors"
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {effectiveChecked ? "Aprovar e cadastrar" : "Aprovar somente"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function PrecheckRow({ row }: { row: RowInfo }) {
  const config = STATUS_CONFIG[row.status];
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm",
        config.bg,
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("flex h-6 w-6 items-center justify-center rounded-full", config.iconBg)}>
          {config.icon}
        </span>
        <span className="font-medium text-foreground">{row.label}</span>
      </div>
      <div className="flex flex-col items-end text-right">
        <span className={cn("text-xs font-semibold", config.text)}>{config.label}</span>
        {row.validUntil ? (
          <span className="text-[10px] text-muted-foreground">
            Vigência: {formatDate(row.validUntil)}
            {typeof row.daysToExpire === "number"
              ? ` (${row.daysToExpire > 0 ? `${row.daysToExpire}d` : "vencida"})`
              : ""}
          </span>
        ) : null}
        {row.errorMessage ? (
          <span className="text-[10px] text-rose-700" title={row.errorMessage}>
            falha consulta
          </span>
        ) : null}
      </div>
    </div>
  );
}

function AlertBlock({
  todosVigentes,
  algumVencendo,
  algumVencidoOuFaltando,
}: {
  todosVigentes: boolean;
  algumVencendo: boolean;
  algumVencidoOuFaltando: boolean;
}) {
  if (todosVigentes) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 text-xs text-emerald-900">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          <strong>Todos os dados já estão cadastrados e vigentes no Angellira.</strong> Não
          é necessário re-cadastrar. O motorista pode ser aprovado sem disparo automático.
        </p>
      </div>
    );
  }
  if (algumVencidoOuFaltando) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50/70 p-3 text-xs text-rose-900">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          <strong>Cadastro necessário.</strong> Há registros vencidos ou faltantes no
          Angellira. Recomendado marcar a opção abaixo para regularizar.
        </p>
      </div>
    );
  }
  if (algumVencendo) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          <strong>Atenção: vigência prestes a expirar (&lt; {ALERTA_THRESHOLD_DAYS} dias).</strong>{" "}
          Considere disparar a atualização agora para evitar problemas operacionais.
        </p>
      </div>
    );
  }
  return null;
}

const STATUS_CONFIG: Record<RowStatus, {
  label: string;
  icon: React.ReactNode;
  iconBg: string;
  bg: string;
  text: string;
}> = {
  LOADING: {
    label: "consultando...",
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" />,
    iconBg: "bg-slate-100",
    bg: "border-border bg-muted/30",
    text: "text-muted-foreground",
  },
  VIGENTE: {
    label: "CADASTRADO E VIGENTE",
    icon: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />,
    iconBg: "bg-emerald-100",
    bg: "border-emerald-200 bg-emerald-50/40",
    text: "text-emerald-800",
  },
  VENCENDO: {
    label: "VENCE EM <30 DIAS",
    icon: <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />,
    iconBg: "bg-amber-100",
    bg: "border-amber-200 bg-amber-50/40",
    text: "text-amber-800",
  },
  VENCIDO: {
    label: "VIGÊNCIA VENCIDA",
    icon: <XCircle className="h-3.5 w-3.5 text-rose-600" />,
    iconBg: "bg-rose-100",
    bg: "border-rose-200 bg-rose-50/40",
    text: "text-rose-800",
  },
  NAO_CADASTRADO: {
    label: "NÃO CADASTRADO",
    icon: <AlertCircle className="h-3.5 w-3.5 text-slate-600" />,
    iconBg: "bg-slate-100",
    bg: "border-slate-200 bg-slate-50/40",
    text: "text-slate-700",
  },
  INDISPONIVEL: {
    label: "CONSULTA INDISPONÍVEL",
    icon: <HelpCircle className="h-3.5 w-3.5 text-slate-600" />,
    iconBg: "bg-slate-100",
    bg: "border-slate-200 bg-slate-50/40",
    text: "text-slate-700",
  },
};

/**
 * Converte a resposta do `/angellira/precheck` (motorista|cavalo|carreta) em RowInfo.
 *
 * Backend retorna `lookupAngelliraDriverByCpf` / `lookupAngelliraPlate` shape:
 *   { status: 'FOUND'|'NOT_FOUND'|'UNAVAILABLE', found, validUntil, lastSeenAt,
 *     statusText, ... }
 */
function rowFromPrecheck(precheck: unknown, label: string, icon: React.ReactNode): RowInfo {
  const p = (precheck || {}) as {
    status?: string;
    found?: boolean;
    validUntil?: string | null;
    statusText?: string | null;
    error?: string;
    reason?: string;
  };

  // Erro / indisponível
  if (p.status === "UNAVAILABLE" || p.error) {
    return { label, icon, status: "INDISPONIVEL", errorMessage: p.error || "API indisponível" };
  }

  // Não encontrado
  if (p.status === "NOT_FOUND" || p.found === false) {
    return { label, icon, status: "NAO_CADASTRADO" };
  }

  // Encontrado — classifica por vigência
  if (p.status === "FOUND" || p.found === true) {
    const validUntil = p.validUntil || null;
    const days = computeDaysToExpire(validUntil);
    let status: RowStatus = "VIGENTE";
    if (days !== null && days < 0) status = "VENCIDO";
    else if (days !== null && days < ALERTA_THRESHOLD_DAYS) status = "VENCENDO";
    return {
      label, icon, status, validUntil,
      daysToExpire: days,
      statusText: p.statusText,
    };
  }

  return { label, icon, status: "INDISPONIVEL" };
}

function computeDaysToExpire(validUntil: string | null | undefined): number | null {
  if (!validUntil) return null;
  const target = new Date(validUntil);
  if (Number.isNaN(target.getTime())) return null;
  const diff = target.getTime() - Date.now();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("pt-BR");
  } catch {
    return iso;
  }
}
