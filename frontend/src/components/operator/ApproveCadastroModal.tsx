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
import { precheckAngellira, precheckSpx, type SpxPrecheckResult } from "@/services/readModels";

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
  /** invocado com o array de jobs ['angellira'] (ou vazio) + a conformidade do precheck (DC-198) */
  onConfirm: (jobs: ApproveJob[], conformidade: { angellira: boolean; spx: boolean }) => void;
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
  // 3 linhas Angellira + 1 linha SPX (motorista)
  const [rows, setRows] = useState<{
    motorista: RowInfo;
    cavalo?: RowInfo;
    carreta?: RowInfo;
    spx: RowInfo;
  }>(() => ({
    motorista: { label: "Angellira • Motorista", icon: <UserRound className="h-4 w-4" />, status: "LOADING" },
    ...(hasCavalo ? { cavalo: { label: "Angellira • Cavalo", icon: <Truck className="h-4 w-4" />, status: "LOADING" } } : {}),
    ...(hasCarreta ? { carreta: { label: "Angellira • Carreta", icon: <Truck className="h-4 w-4" />, status: "LOADING" } } : {}),
    spx: { label: "SPX/Shopee • Motorista", icon: <UserRound className="h-4 w-4" />, status: "LOADING" },
  }));
  const [precheckDone, setPrecheckDone] = useState(false);
  const [angelliraChecked, setAngelliraChecked] = useState(false);
  const [spxChecked, setSpxChecked] = useState(false);
  /** 2º opt-in geral: forçar re-cadastro mesmo com tudo vigente */
  const [forceUpdate, setForceUpdate] = useState(false);

  // Roda precheck (Angellira + SPX em paralelo) assim que o modal abre.
  // RENDER INCREMENTAL (perf 2026-05-29): cada sistema atualiza suas linhas
  // assim que responde — não espera o mais lento. SPX (~1s) aparece antes do
  // Angellira (~6s cold), dando feedback imediato ao operador.
  useEffect(() => {
    if (!open || !cadastroId) return;
    let cancelled = false;
    setPrecheckDone(false);
    setForceUpdate(false);
    setRows({
      motorista: { label: "Angellira • Motorista", icon: <UserRound className="h-4 w-4" />, status: "LOADING" },
      ...(hasCavalo ? { cavalo: { label: "Angellira • Cavalo", icon: <Truck className="h-4 w-4" />, status: "LOADING" } } : {}),
      ...(hasCarreta ? { carreta: { label: "Angellira • Carreta", icon: <Truck className="h-4 w-4" />, status: "LOADING" } } : {}),
      spx: { label: "SPX/Shopee • Motorista", icon: <UserRound className="h-4 w-4" />, status: "LOADING" },
    });

    const angP = precheckAngellira(cadastroId);
    const spxP = precheckSpx(cadastroId).catch((err: Error) => ({
      ok: false, status: "UNAVAILABLE" as const, message: err.message,
    }));

    // ── Render incremental: Angellira ──────────────────────────────────
    angP.then((res) => {
      if (cancelled) return;
      setRows((prev) => ({
        ...prev,
        motorista: rowFromPrecheck(res.motorista, "Angellira • Motorista", <UserRound className="h-4 w-4" />),
        ...(hasCavalo ? { cavalo: rowFromPrecheck(res.cavalo, "Angellira • Cavalo", <Truck className="h-4 w-4" />) } : {}),
        ...(hasCarreta ? { carreta: rowFromPrecheck(res.carreta, "Angellira • Carreta", <Truck className="h-4 w-4" />) } : {}),
      }));
    }).catch((err: Error) => {
      if (cancelled) return;
      const fail = (lbl: string, ic: React.ReactNode): RowInfo => ({
        label: lbl, icon: ic, status: "INDISPONIVEL", errorMessage: err.message,
      });
      setRows((prev) => ({
        ...prev,
        motorista: fail("Angellira • Motorista", <UserRound className="h-4 w-4" />),
        ...(hasCavalo ? { cavalo: fail("Angellira • Cavalo", <Truck className="h-4 w-4" />) } : {}),
        ...(hasCarreta ? { carreta: fail("Angellira • Carreta", <Truck className="h-4 w-4" />) } : {}),
      }));
    });

    // ── Render incremental: SPX ────────────────────────────────────────
    spxP.then((res) => {
      if (cancelled) return;
      setRows((prev) => ({
        ...prev,
        spx: rowFromSpxPrecheck(res, "SPX/Shopee • Motorista", <UserRound className="h-4 w-4" />),
      }));
    });

    // ── Quando AMBOS terminam: libera botão + calcula defaults dos checkboxes ──
    Promise.allSettled([angP, spxP]).then(([angR, spxR]) => {
      if (cancelled) return;
      setPrecheckDone(true);

      // Recalcula linhas finais pra decidir defaults (mesma lógica do render)
      const angRows: RowInfo[] = [];
      if (angR.status === "fulfilled") {
        const res = angR.value;
        angRows.push(rowFromPrecheck(res.motorista, "m", null));
        if (hasCavalo) angRows.push(rowFromPrecheck(res.cavalo, "c", null));
        if (hasCarreta) angRows.push(rowFromPrecheck(res.carreta, "ct", null));
      } else {
        angRows.push({ label: "m", icon: null, status: "INDISPONIVEL" });
      }
      const angellNeedsAction = angRows.some((r) =>
        ["VENCENDO", "VENCIDO", "NAO_CADASTRADO", "INDISPONIVEL"].includes(r.status),
      );
      setAngelliraChecked(angellNeedsAction);

      const spxRow = spxR.status === "fulfilled"
        ? rowFromSpxPrecheck(spxR.value, "s", null)
        : { status: "INDISPONIVEL" as RowStatus };
      const spxNeedsAction = ["VENCENDO", "VENCIDO", "NAO_CADASTRADO"].includes(spxRow.status);
      setSpxChecked(spxNeedsAction);
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cadastroId, hasCavalo, hasCarreta]);

  // Análise agregada do precheck (Angellira separado de SPX)
  const angellRows = useMemo(
    () => [rows.motorista, rows.cavalo, rows.carreta].filter(Boolean) as RowInfo[],
    [rows.motorista, rows.cavalo, rows.carreta],
  );
  const angellTodosVigentes = useMemo(
    () => precheckDone && angellRows.length > 0 && angellRows.every((r) => r.status === "VIGENTE"),
    [precheckDone, angellRows],
  );
  const spxVigenteOuJaNossa = useMemo(
    () => precheckDone && rows.spx.status === "VIGENTE",
    [precheckDone, rows.spx],
  );
  const algumVencendo = useMemo(
    () => Object.values(rows).some((r) => r && r.status === "VENCENDO"),
    [rows],
  );
  const algumVencidoOuFaltando = useMemo(
    () => Object.values(rows).some((r) => r && ["VENCIDO", "NAO_CADASTRADO"].includes(r.status)),
    [rows],
  );
  const todosVigentes = useMemo(
    () => angellTodosVigentes && spxVigenteOuJaNossa,
    [angellTodosVigentes, spxVigenteOuJaNossa],
  );

  // Disable checkbox quando o sistema correspondente está tudo vigente,
  // exceto se operador marcou "Forçar atualização" (2º opt-in).
  const angelliraDisabled = angellTodosVigentes && !forceUpdate;
  const spxDisabled = spxVigenteOuJaNossa && !forceUpdate;
  const effectiveAngellira = angellTodosVigentes ? forceUpdate && angelliraChecked : angelliraChecked;
  const effectiveSpx = spxVigenteOuJaNossa ? forceUpdate && spxChecked : spxChecked;

  const handleConfirm = () => {
    const jobs: ApproveJob[] = [];
    if (effectiveAngellira) jobs.push("angellira");
    if (effectiveSpx) jobs.push("spx");
    // DC-198 — conformidade do precheck (Angellira todos vigentes + SPX vigente/na
    // nossa agência) para o gatilho de WhatsApp "cadastro aprovado".
    onConfirm(jobs, { angellira: angellTodosVigentes, spx: spxVigenteOuJaNossa });
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
                  effectiveAngellira && "border-emerald-300 bg-emerald-50/60",
                  !effectiveAngellira && !angelliraDisabled && "border-border bg-background",
                )}
              >
                <input
                  type="checkbox"
                  checked={effectiveAngellira}
                  disabled={angelliraDisabled}
                  onChange={(e) => setAngelliraChecked(e.target.checked)}
                  className="mt-0.5 h-4 w-4 cursor-pointer accent-emerald-600 disabled:cursor-not-allowed"
                />
                <div className="flex-1 text-sm">
                  <p className="flex items-center gap-2 font-semibold text-foreground">
                    <Building2 className="h-4 w-4 text-emerald-700" />
                    {angellTodosVigentes ? "Re-cadastrar/atualizar no Angellira" : "Cadastrar no Angellira"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {angellTodosVigentes
                      ? "Já vigente. Atualização força PATCH em todos os registros."
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

              {/* Checkbox SPX/Shopee */}
              <label
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3 transition-colors",
                  spxDisabled
                    ? "cursor-not-allowed border-border bg-muted/30 opacity-70"
                    : "cursor-pointer hover:border-orange-200",
                  effectiveSpx && "border-orange-300 bg-orange-50/60",
                  !effectiveSpx && !spxDisabled && "border-border bg-background",
                )}
              >
                <input
                  type="checkbox"
                  checked={effectiveSpx}
                  disabled={spxDisabled}
                  onChange={(e) => setSpxChecked(e.target.checked)}
                  className="mt-0.5 h-4 w-4 cursor-pointer accent-orange-500 disabled:cursor-not-allowed"
                />
                <div className="flex-1 text-sm">
                  <p className="flex items-center gap-2 font-semibold text-foreground">
                    <Truck className="h-4 w-4 text-orange-600" />
                    {spxVigenteOuJaNossa ? "Re-cadastrar no SPX/Shopee" : "Cadastrar no SPX/Shopee"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {spxVigenteOuJaNossa
                      ? "Motorista já cadastrado. Re-cadastrar criaria nova request."
                      : rows.spx.status === "INDISPONIVEL"
                        ? "SPX indisponível — cookies podem precisar de renovação."
                        : "Cria driver_request na agência LAMONICA (~30-60s)."}
                  </p>
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
            {effectiveAngellira || effectiveSpx ? "Aprovar e cadastrar" : "Aprovar somente"}
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
  // Quando há statusText custom (ex: "CADASTRADO EM OUTRA AGÊNCIA"), prioriza
  // sobre o label genérico do STATUS_CONFIG ("VENCE EM <30 DIAS").
  const badgeText = row.statusText || config.label;
  // errorMessage só vira "falha consulta" se for status INDISPONIVEL ou se
  // não temos statusText custom (preserva contexto rico em IS_MATCHED_OUTRA etc).
  const showErrorChip = row.errorMessage && (row.status === "INDISPONIVEL" || !row.statusText);
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
      <div className="flex flex-col items-end text-right max-w-[60%]">
        <span className={cn("text-xs font-semibold uppercase", config.text)} title={row.errorMessage ?? undefined}>
          {badgeText}
        </span>
        {row.validUntil ? (
          <span className="text-[10px] text-muted-foreground">
            Vigência: {formatDate(row.validUntil)}
            {typeof row.daysToExpire === "number"
              ? ` (${row.daysToExpire > 0 ? `${row.daysToExpire}d` : "vencida"})`
              : ""}
          </span>
        ) : null}
        {showErrorChip ? (
          <span className="text-[10px] text-rose-700" title={row.errorMessage ?? undefined}>
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

/**
 * Converte resposta do POST /spx/precheck em RowInfo.
 *
 * Mapping de SpxPrecheckStatus → RowStatus visual:
 *   IS_MATCHED_NOSSA / REQUEST_PENDENTE → VIGENTE (verde, sem ação)
 *   IS_MATCHED_OUTRA                   → VENCENDO (amarelo, requer importar)
 *   NOT_FOUND                          → NAO_CADASTRADO (cinza, requer cadastro)
 *   BLOQUEADO                          → VENCIDO (vermelho)
 *   UNAVAILABLE                        → INDISPONIVEL
 */
function rowFromSpxPrecheck(precheck: SpxPrecheckResult, label: string, icon: React.ReactNode): RowInfo {
  if (precheck.status === "IS_MATCHED_NOSSA") {
    return {
      label, icon, status: "VIGENTE",
      statusText: "Cadastrado na nossa agência",
      validUntil: null,
    };
  }
  if (precheck.status === "REQUEST_PENDENTE") {
    return {
      label, icon, status: "VENCENDO",
      statusText: "Request pendente no SPX — aguarde ou complete o rascunho",
      errorMessage: precheck.message,
      validUntil: null,
    };
  }
  if (precheck.status === "INATIVO") {
    return {
      label, icon, status: "VENCENDO",
      statusText: "Cadastrado mas INATIVO — precisa ativar antes",
      errorMessage: precheck.message,
      validUntil: null,
    };
  }
  if (precheck.status === "IS_MATCHED_OUTRA") {
    return {
      label, icon, status: "VENCENDO",
      statusText: "⚠ CADASTRADO EM OUTRA AGÊNCIA — importar pra LAMONICA",
      errorMessage: precheck.message,
      validUntil: null,
    };
  }
  if (precheck.status === "BLOQUEADO") {
    return {
      label, icon, status: "VENCIDO",
      statusText: "Motorista BLOQUEADO no SPX",
      errorMessage: precheck.message,
      validUntil: null,
    };
  }
  if (precheck.status === "UNAVAILABLE") {
    return {
      label, icon, status: "INDISPONIVEL",
      errorMessage: precheck.message || "SPX indisponível",
    };
  }
  return { label, icon, status: "NAO_CADASTRADO" };
}
