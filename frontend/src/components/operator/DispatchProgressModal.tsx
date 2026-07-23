import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
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
import { listExternalJobs, type ExternalRegistrationJob } from "@/services/readModels";

import type { ApproveJob } from "./ApproveCadastroModal";

type JobStatus = ExternalRegistrationJob["status"];
type RowStatus = JobStatus | "NONE";

type Props = {
  /** ID do `pending_driver_registrations`. */
  cadastroId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  motoristaNome?: string;
  /** Alvos que foram disparados — define quais blocos/etapas exibir. */
  dispatchedJobs: ApproveJob[];
  hasCavalo?: boolean;
  hasCarreta?: boolean;
  /**
   * `true` enquanto o POST /aprovar ainda está no ar. Mesmo terminal nas jobs,
   * mantemos o polling vivo até a request HTTP voltar (evita encerrar cedo se
   * o backend ainda está commitando o último passo).
   */
  dispatchPending: boolean;
};

const POLL_INTERVAL_MS = 2_500;

/** Etapas Angellira na ordem real de execução do pipeline (DC-116). */
type StepDef = { step: string; label: string; icon: React.ReactNode };

const ANGELLIRA_STEP_LABELS: Record<string, { label: string; icon: React.ReactNode }> = {
  proprietario_cavalo: { label: "Proprietário do cavalo", icon: <UserRound className="h-4 w-4" /> },
  proprietario_carreta: { label: "Proprietário da carreta", icon: <UserRound className="h-4 w-4" /> },
  motorista: { label: "Motorista", icon: <UserRound className="h-4 w-4" /> },
  cavalo: { label: "Cavalo", icon: <Truck className="h-4 w-4" /> },
  carreta: { label: "Carreta", icon: <Truck className="h-4 w-4" /> },
};

/**
 * Modal de PROGRESSO em tempo real do disparo Angellira + SPX.
 *
 * Abre logo após "Aprovar e cadastrar". O backend roda o pipeline de forma
 * SÍNCRONA dentro do POST /aprovar, mas cada etapa faz commit imediato em
 * `external_registration_jobs` (conexão em autocommit, sem transação) — então
 * um polling concorrente de GET /external-jobs reflete o avanço ao vivo.
 *
 * Polling via TanStack Query (refetchInterval ~2.5s). Para de pollar quando
 * TODAS as etapas esperadas estão terminais (OK/ERROR) E o POST /aprovar já
 * voltou (`dispatchPending=false`).
 *
 * Epic DC-111 / Sprint 1 / DC-118 (progress UI).
 */
export default function DispatchProgressModal({
  cadastroId,
  open,
  onOpenChange,
  motoristaNome,
  dispatchedJobs,
  hasCavalo,
  hasCarreta,
  dispatchPending,
}: Props) {
  const wantsAngellira = dispatchedJobs.includes("angellira");
  const wantsSpx = dispatchedJobs.includes("spx");

  // Etapas Angellira esperadas (mesma derivação do backend determineStepsFromDados):
  // proprietários → motorista → veículos.
  const expectedAngelliraSteps = useMemo<StepDef[]>(() => {
    if (!wantsAngellira) return [];
    const steps: string[] = [];
    if (hasCavalo) steps.push("proprietario_cavalo");
    if (hasCarreta) steps.push("proprietario_carreta");
    steps.push("motorista");
    if (hasCavalo) steps.push("cavalo");
    if (hasCarreta) steps.push("carreta");
    return steps.map((s) => ({ step: s, ...ANGELLIRA_STEP_LABELS[s] }));
  }, [wantsAngellira, hasCavalo, hasCarreta]);

  const queryKey = useMemo(() => ["external-jobs", cadastroId] as const, [cadastroId]);

  const { data } = useQuery({
    queryKey,
    queryFn: () => listExternalJobs(cadastroId as string),
    enabled: open && Boolean(cadastroId),
    refetchInterval: (query) => {
      const jobs = (query.state.data as { jobs?: ExternalRegistrationJob[] } | undefined)?.jobs ?? [];
      // Continua pollando enquanto o POST /aprovar não voltou — o backend pode
      // ainda estar entre etapas e nenhum job aparece ainda.
      if (dispatchPending) return POLL_INTERVAL_MS;
      // Sem POST no ar: para se não há nada IN_PROGRESS/PENDING.
      const anyLive = jobs.some((j) => j.status === "IN_PROGRESS" || j.status === "PENDING");
      return anyLive ? POLL_INTERVAL_MS : false;
    },
    refetchIntervalInBackground: true,
  });

  const allJobs = useMemo(() => data?.jobs ?? [], [data?.jobs]);

  // Para cada etapa Angellira esperada, pega o job mais recente daquela etapa.
  const angelliraRows = useMemo(
    () =>
      expectedAngelliraSteps.map((def) => ({
        def,
        job: latestJobFor(allJobs, "angellira", def.step),
      })),
    [expectedAngelliraSteps, allJobs],
  );

  const spxJob = useMemo(
    () => (wantsSpx ? latestJobFor(allJobs, "spx", "spx_motorista") : null),
    [wantsSpx, allJobs],
  );

  // Status agregado por alvo.
  const angelliraStatus = aggregateStatus(
    angelliraRows.map((r) => (r.job?.status ?? "PENDING") as RowStatus),
    expectedAngelliraSteps.length,
  );
  const spxStatus: RowStatus = wantsSpx ? (spxJob?.status ?? "PENDING") : "NONE";

  // Resumo final: terminal quando o POST voltou e nada está mais rodando.
  const isRunning =
    dispatchPending ||
    angelliraStatus === "IN_PROGRESS" ||
    angelliraStatus === "PENDING" ||
    spxStatus === "IN_PROGRESS" ||
    spxStatus === "PENDING";

  const summary = useMemo(() => {
    if (isRunning) return null;
    const targets: RowStatus[] = [];
    if (wantsAngellira) targets.push(angelliraStatus);
    if (wantsSpx) targets.push(spxStatus);
    if (!targets.length) return null;
    if (targets.every((s) => s === "OK")) return "OK" as const;
    if (targets.every((s) => s === "ERROR")) return "ERROR" as const;
    return "PARTIAL" as const;
  }, [isRunning, wantsAngellira, wantsSpx, angelliraStatus, spxStatus]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isRunning ? (
              <Loader2 className="h-5 w-5 animate-spin text-emerald-600" />
            ) : summary === "OK" ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            ) : summary === "ERROR" ? (
              <XCircle className="h-5 w-5 text-rose-600" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-amber-600" />
            )}
            {isRunning ? "Cadastrando nos sistemas externos…" : "Cadastro externo concluído"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <p className="text-sm text-muted-foreground">
            {motoristaNome ? <span className="font-semibold text-foreground">{motoristaNome.toUpperCase()}</span> : "Motorista"}
            {isRunning
              ? " — pode acompanhar aqui. Isso leva ~30 a 180s; não é necessário sair da tela."
              : " — veja abaixo o resultado de cada etapa."}
          </p>

          {/* Bloco Angellira */}
          {wantsAngellira ? (
            <TargetBlock
              title="Angellira"
              accent="emerald"
              status={angelliraStatus}
            >
              <div className="grid gap-1.5">
                {angelliraRows.map(({ def, job }) => (
                  <StepRow key={def.step} def={def} job={job} running={isRunning} />
                ))}
              </div>
            </TargetBlock>
          ) : null}

          {/* Bloco SPX */}
          {wantsSpx ? (
            <TargetBlock title="SPX / Shopee" accent="orange" status={spxStatus}>
              <div className="grid gap-1.5">
                <StepRow
                  def={{ step: "spx_motorista", label: "Importação do motorista", icon: <UserRound className="h-4 w-4" /> }}
                  job={spxJob ?? undefined}
                  running={isRunning}
                />
              </div>
            </TargetBlock>
          ) : null}

          {/* Resumo final */}
          {summary ? <SummaryBanner summary={summary} /> : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className={cn(
              "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors",
              isRunning
                ? "border border-border bg-background text-foreground hover:bg-muted"
                : "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700",
            )}
          >
            {isRunning ? "Fechar (continua em segundo plano)" : "Concluir"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Subcomponentes
// ──────────────────────────────────────────────────────────────────────────

function TargetBlock({
  title,
  accent,
  status,
  children,
}: {
  title: string;
  accent: "emerald" | "orange";
  status: RowStatus;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={cn("font-semibold", accent === "emerald" ? "text-emerald-700" : "text-orange-700")}>
          {title}
        </span>
        <StatusBadge status={status} />
      </div>
      {children}
    </div>
  );
}

function StepRow({
  def,
  job,
  running,
}: {
  def: StepDef;
  job: ExternalRegistrationJob | undefined;
  running: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Sem job ainda: se o disparo está rodando, mostra "aguardando" (fila);
  // caso contrário "não iniciado".
  const status: RowStatus = job?.status ?? (running ? "PENDING" : "NONE");
  const error = job?.error as { code?: string; message?: string; acao?: string; etapa?: string } | null | undefined;
  const attempts = job?.attempts ?? 0;

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs",
        status === "OK" && "border-emerald-200 bg-emerald-50/50",
        status === "ERROR" && "border-rose-200 bg-rose-50/50",
        status === "IN_PROGRESS" && "border-amber-200 bg-amber-50/50",
        (status === "PENDING" || status === "NONE") && "border-border bg-background",
      )}
    >
      <StatusDot status={status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            {def.icon}
            {def.label}
          </p>
          <span className="shrink-0 text-[10px] font-semibold uppercase text-muted-foreground">
            {STATUS_TEXT[status]}
          </span>
        </div>
        {job?.external_id ? (
          <p className="mt-0.5 text-[10px] text-muted-foreground">ID: {job.external_id}</p>
        ) : null}
        {attempts > 1 ? (
          <p className="mt-0.5 text-[10px] text-muted-foreground">Tentativas: {attempts}</p>
        ) : null}
        {error && status === "ERROR" ? (
          <>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 flex items-center gap-1 text-[10px] font-medium text-rose-700 hover:underline"
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {error.code || "Erro"}
            </button>
            {expanded ? (
              <div className="mt-1 rounded-md border border-rose-200 bg-white p-2 text-[11px] text-rose-900">
                <p>{error.message || "Erro desconhecido."}</p>
                {error.acao ? <p className="mt-1 italic text-rose-700">→ {error.acao}</p> : null}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function SummaryBanner({ summary }: { summary: "OK" | "PARTIAL" | "ERROR" }) {
  if (summary === "OK") {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 text-xs text-emerald-900">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          <strong>Tudo certo.</strong> Todas as etapas foram cadastradas com sucesso nos sistemas externos.
        </p>
      </div>
    );
  }
  if (summary === "ERROR") {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50/70 p-3 text-xs text-rose-900">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          <strong>Falhou.</strong> Nenhuma etapa foi concluída, então o cadastro NÃO foi aprovado e continua
          na fila. Veja o erro de cada etapa acima e clique em <strong>Aprovar</strong> novamente para
          re-tentar (as etapas que já deram certo são puladas).
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-xs text-amber-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        <strong>Parcial.</strong> Algumas etapas falharam, então o cadastro NÃO foi aprovado e continua na
        fila. Confira acima quais e clique em <strong>Aprovar</strong> novamente para re-tentar (o que já
        deu certo não é refeito).
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: RowStatus }) {
  const cfg = STATUS_BADGE[status];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase", cfg.color)}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function StatusDot({ status }: { status: RowStatus }) {
  const map: Record<RowStatus, string> = {
    OK: "bg-emerald-500",
    ERROR: "bg-rose-500",
    IN_PROGRESS: "bg-amber-500 animate-pulse",
    PENDING: "bg-slate-400 animate-pulse",
    NONE: "bg-slate-300",
  };
  return <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", map[status])} />;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/** Job mais recente (por created_at) de um target+step. */
function latestJobFor(
  jobs: ExternalRegistrationJob[],
  target: ExternalRegistrationJob["target"],
  step: string,
): ExternalRegistrationJob | undefined {
  const matches = jobs.filter((j) => j.target === target && j.step === step);
  if (!matches.length) return undefined;
  return matches.reduce((latest, j) => {
    const a = new Date(latest.created_at ?? 0).getTime();
    const b = new Date(j.created_at ?? 0).getTime();
    return b >= a ? j : latest;
  });
}

/**
 * Agrega o status de N etapas em um status único para o alvo.
 * - Falta alguma etapa esperada (job ainda não criado) → PENDING (na fila).
 * - Qualquer IN_PROGRESS → IN_PROGRESS.
 * - Todas terminais e ao menos uma ERROR → ERROR (representa "tem falha").
 * - Todas OK → OK.
 */
function aggregateStatus(statuses: RowStatus[], expectedCount: number): RowStatus {
  if (expectedCount === 0) return "NONE";
  if (statuses.length < expectedCount) return "PENDING";
  if (statuses.some((s) => s === "IN_PROGRESS")) return "IN_PROGRESS";
  if (statuses.some((s) => s === "PENDING")) return "PENDING";
  if (statuses.some((s) => s === "ERROR")) return "ERROR";
  if (statuses.every((s) => s === "OK")) return "OK";
  return "IN_PROGRESS";
}

const STATUS_TEXT: Record<RowStatus, string> = {
  OK: "ok",
  ERROR: "erro",
  IN_PROGRESS: "em progresso",
  PENDING: "pendente",
  NONE: "não iniciado",
};

const STATUS_BADGE: Record<RowStatus, { color: string; icon: React.ReactNode; label: string }> = {
  OK: { color: "border-emerald-300 bg-emerald-100 text-emerald-800", icon: <CheckCircle2 className="h-3 w-3" />, label: "OK" },
  ERROR: { color: "border-rose-300 bg-rose-100 text-rose-800", icon: <XCircle className="h-3 w-3" />, label: "Erro" },
  IN_PROGRESS: { color: "border-amber-300 bg-amber-100 text-amber-800", icon: <Loader2 className="h-3 w-3 animate-spin" />, label: "Em progresso" },
  PENDING: { color: "border-slate-300 bg-slate-100 text-slate-700", icon: <Clock className="h-3 w-3" />, label: "Pendente" },
  NONE: { color: "border-border bg-muted text-muted-foreground", icon: <Clock className="h-3 w-3" />, label: "Não iniciado" },
};
