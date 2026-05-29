import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  PlayCircle,
  RefreshCw,
  Truck,
  UserRound,
  XCircle,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import {
  cadastrarAngellira,
  cadastrarSpx,
  listExternalJobs,
  precheckAngellira,
  precheckSpx,
  retryAngelliraStep,
  type AngelliraJobStep,
  type ExternalRegistrationJob,
} from "@/services/readModels";

type Props = {
  cadastroId: string;
};

type AngelliraStepInfo = {
  step: AngelliraJobStep;
  label: string;
  icon: React.ReactNode;
};

const STEPS: AngelliraStepInfo[] = [
  { step: "proprietario_cavalo", label: "Prop. Cavalo", icon: <UserRound className="h-3.5 w-3.5" /> },
  { step: "cavalo", label: "Cavalo", icon: <Truck className="h-3.5 w-3.5" /> },
  { step: "proprietario_carreta", label: "Prop. Carreta", icon: <UserRound className="h-3.5 w-3.5" /> },
  { step: "carreta", label: "Carreta", icon: <Truck className="h-3.5 w-3.5" /> },
  { step: "motorista", label: "Motorista", icon: <UserRound className="h-3.5 w-3.5" /> },
];

const POLL_INTERVAL_MS = 3_000;

/**
 * Painel granular de status do cadastro externo (Angellira + SPX placeholder).
 *
 * Mostra status por etapa, botões Verificar/Cadastrar tudo/Re-tentar etapa,
 * e detalhes de erro estruturados. Polling de 3s quando há job IN_PROGRESS.
 *
 * Epic DC-111 / Sprint 1 / DC-118.
 */
export default function ExternalRegistrationPanel({ cadastroId }: Props) {
  const queryClient = useQueryClient();
  const [expandedError, setExpandedError] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);

  const queryKey = useMemo(() => ["external-jobs", cadastroId] as const, [cadastroId]);

  const { data, isLoading, refetch } = useQuery({
    queryKey,
    queryFn: () => listExternalJobs(cadastroId),
    refetchInterval: (query) => {
      const jobs = (query.state.data as { jobs?: ExternalRegistrationJob[] })?.jobs ?? [];
      const anyInProgress = jobs.some((j) => j.status === "IN_PROGRESS");
      return anyInProgress ? POLL_INTERVAL_MS : false;
    },
  });

  const jobs = data?.jobs ?? [];
  const angelliraJobs = jobs.filter((j) => j.target === "angellira");
  const spxJobs = jobs.filter((j) => j.target === "spx");

  // Determina o status agregado da Angellira (cinza/amarelo/verde/vermelho)
  const overallStatus = useMemo(() => {
    if (!angelliraJobs.length) return "NONE" as const;
    if (angelliraJobs.some((j) => j.status === "IN_PROGRESS")) return "IN_PROGRESS" as const;
    if (angelliraJobs.some((j) => j.status === "ERROR")) return "ERROR" as const;
    if (angelliraJobs.every((j) => j.status === "OK")) return "OK" as const;
    return "PENDING" as const;
  }, [angelliraJobs]);

  // Status agregado SPX (1 step só: spx_motorista)
  const spxStatus = useMemo(() => {
    if (!spxJobs.length) return "NONE" as const;
    const j = spxJobs[spxJobs.length - 1]; // mais recente
    if (j.status === "IN_PROGRESS") return "IN_PROGRESS" as const;
    if (j.status === "ERROR") return "ERROR" as const;
    if (j.status === "OK") return "OK" as const;
    return "PENDING" as const;
  }, [spxJobs]);

  const cadastrarMutation = useMutation({
    mutationFn: () => cadastrarAngellira(cadastroId),
    onSuccess: (result) => {
      if (result.ok) {
        toast.success("Cadastro Angellira concluído com sucesso.");
      } else {
        toast.warning("Cadastro Angellira concluído com erros. Veja o painel.");
      }
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error & { details?: unknown }) => {
      toast.error(err.message || "Falha ao disparar cadastro Angellira.");
    },
  });

  const retryMutation = useMutation({
    mutationFn: (step: AngelliraJobStep) => retryAngelliraStep(cadastroId, step),
    onSuccess: () => {
      toast.success("Etapa re-tentada. Atualizando status...");
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast.error(err.message || "Falha ao re-tentar etapa."),
  });

  const precheckMutation = useMutation({
    mutationFn: () => precheckAngellira(cadastroId),
    onSuccess: (result) => {
      const motorista = (result.motorista as { status?: string; valid_until?: string } | undefined);
      const vigente = motorista?.valid_until || (motorista?.status === "FOUND" ? "encontrado" : null);
      setVerifyResult(
        vigente
          ? `Motorista: ${motorista?.status || "FOUND"} (vigência ${motorista?.valid_until || "—"})`
          : "Motorista não encontrado no Angellira (pré-cadastro).",
      );
      toast.success("Verificação concluída.");
    },
    onError: (err: Error) => toast.error(err.message || "Falha na verificação."),
  });

  // SPX mutations
  const [spxVerifyResult, setSpxVerifyResult] = useState<string | null>(null);
  const cadastrarSpxMutation = useMutation({
    mutationFn: () => cadastrarSpx(cadastroId),
    onSuccess: (r) => {
      if (r.ok) toast.success("Cadastro SPX concluído.");
      else toast.warning("Cadastro SPX concluído com erros. Veja o painel.");
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast.error(err.message || "Falha cadastrar SPX."),
  });
  const precheckSpxMutation = useMutation({
    mutationFn: () => precheckSpx(cadastroId),
    onSuccess: (r) => {
      const msg = {
        NOT_FOUND: "Motorista não cadastrado no SPX.",
        IS_MATCHED_NOSSA: "Já cadastrado na nossa agência.",
        IS_MATCHED_OUTRA: "Existe em outra agência — pode importar.",
        REQUEST_PENDENTE: "Request pendente no SPX.",
        BLOQUEADO: "Motorista bloqueado no SPX.",
        UNAVAILABLE: "SPX indisponível.",
      }[r.status] || "Status desconhecido";
      setSpxVerifyResult(msg);
      toast.success("Verificação SPX concluída.");
    },
    onError: (err: Error) => toast.error(err.message || "Falha verificar SPX."),
  });

  return (
    <section className="admin-panel mt-4 p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-foreground">
          <Zap className="h-4 w-4 text-amber-500" />
          Cadastro externo
        </h3>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isLoading}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-50"
          title="Atualizar"
        >
          <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
        </button>
      </div>

      {/* Linha Angellira */}
      <div className="mt-3 rounded-xl border border-border bg-background p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <StatusBadge status={overallStatus} />
            <span className="font-semibold text-foreground">Angellira</span>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={precheckMutation.isPending}
              onClick={() => precheckMutation.mutate()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60"
            >
              {precheckMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
              Verificar
            </button>
            <button
              type="button"
              disabled={cadastrarMutation.isPending || overallStatus === "IN_PROGRESS"}
              onClick={() => cadastrarMutation.mutate()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {cadastrarMutation.isPending || overallStatus === "IN_PROGRESS" ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <PlayCircle className="h-3 w-3" />
              )}
              {overallStatus === "OK" ? "Re-cadastrar tudo" : "Cadastrar tudo"}
            </button>
          </div>
        </div>

        {verifyResult ? (
          <p className="mt-2 rounded-md border border-emerald-200 bg-emerald-50/60 px-2 py-1 text-xs text-emerald-800">
            {verifyResult}
          </p>
        ) : null}

        {/* Sub-etapas */}
        <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {STEPS.map((s) => {
            const job = angelliraJobs.find((j) => j.step === s.step);
            return (
              <StepRow
                key={s.step}
                info={s}
                job={job}
                expanded={expandedError === s.step}
                onToggle={() => setExpandedError(expandedError === s.step ? null : s.step)}
                onRetry={() => retryMutation.mutate(s.step)}
                isRetrying={retryMutation.isPending && retryMutation.variables === s.step}
              />
            );
          })}
        </div>
      </div>

      {/* Linha SPX/Shopee — funcional (DC-111 / extensão SPX) */}
      <div className="mt-3 rounded-xl border border-border bg-background p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <StatusBadge status={spxStatus} />
            <span className="font-semibold text-foreground">SPX / Shopee</span>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={precheckSpxMutation.isPending}
              onClick={() => precheckSpxMutation.mutate()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60"
            >
              {precheckSpxMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
              Verificar
            </button>
            <button
              type="button"
              disabled={cadastrarSpxMutation.isPending || spxStatus === "IN_PROGRESS"}
              onClick={() => cadastrarSpxMutation.mutate()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-600 disabled:opacity-60"
            >
              {cadastrarSpxMutation.isPending || spxStatus === "IN_PROGRESS"
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <PlayCircle className="h-3 w-3" />}
              {spxStatus === "OK" ? "Re-cadastrar" : "Cadastrar"}
            </button>
          </div>
        </div>
        {spxVerifyResult ? (
          <p className="mt-2 rounded-md border border-orange-200 bg-orange-50/60 px-2 py-1 text-xs text-orange-800">
            {spxVerifyResult}
          </p>
        ) : null}
        {/* Job mais recente — se ERROR, mostra detalhes inline */}
        {spxJobs.length ? (
          <div className="mt-2 grid gap-1.5">
            <SpxJobRow job={spxJobs[spxJobs.length - 1]} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SpxJobRow({ job }: { job: ExternalRegistrationJob }) {
  const status = job.status;
  const error = job.error as { code?: string; message?: string; acao?: string } | null | undefined;
  return (
    <div className={cn(
      "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs",
      status === "OK" && "border-emerald-200 bg-emerald-50/40",
      status === "ERROR" && "border-rose-200 bg-rose-50/40",
      status === "IN_PROGRESS" && "border-amber-200 bg-amber-50/40",
      (status === "PENDING") && "border-border bg-background",
    )}>
      <StatusDot status={status} />
      <div className="flex-1 min-w-0">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <UserRound className="h-3.5 w-3.5" /> SPX • {job.step}
        </p>
        {job.external_id ? (
          <p className="mt-0.5 text-[10px] text-muted-foreground">ID: {job.external_id}</p>
        ) : null}
        {error && status === "ERROR" ? (
          <div className="mt-1 rounded-md border border-rose-200 bg-white p-2 text-[11px] text-rose-900">
            <p className="font-medium">{error.code || "Erro"}</p>
            <p>{error.message || "Erro desconhecido."}</p>
            {error.acao ? <p className="mt-1 italic text-rose-700">→ {error.acao}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StepRow({
  info,
  job,
  expanded,
  onToggle,
  onRetry,
  isRetrying,
}: {
  info: AngelliraStepInfo;
  job: ExternalRegistrationJob | undefined;
  expanded: boolean;
  onToggle: () => void;
  onRetry: () => void;
  isRetrying: boolean;
}) {
  const status = (job?.status || "NONE") as ExternalRegistrationJob["status"] | "NONE";
  const error = job?.error as { code?: string; message?: string; acao?: string } | null | undefined;
  const externalId = job?.external_id;

  return (
    <div className={cn(
      "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs",
      status === "OK" && "border-emerald-200 bg-emerald-50/40",
      status === "ERROR" && "border-rose-200 bg-rose-50/40",
      status === "IN_PROGRESS" && "border-amber-200 bg-amber-50/40",
      (status === "PENDING" || status === "NONE") && "border-border bg-background",
    )}>
      <StatusDot status={status} />
      <div className="flex-1 min-w-0">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          {info.icon}
          {info.label}
        </p>
        {externalId ? (
          <p className="mt-0.5 text-[10px] text-muted-foreground">ID: {externalId}</p>
        ) : null}
        {error && status === "ERROR" ? (
          <>
            <button
              type="button"
              onClick={onToggle}
              className="mt-1 flex items-center gap-1 text-[10px] font-medium text-rose-700 hover:underline"
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {error.code || "Erro"}
            </button>
            {expanded ? (
              <div className="mt-1 rounded-md border border-rose-200 bg-white p-2 text-[11px] text-rose-900">
                <p>{error.message || "Erro desconhecido."}</p>
                {error.acao ? (
                  <p className="mt-1 italic text-rose-700">→ {error.acao}</p>
                ) : null}
                <button
                  type="button"
                  onClick={onRetry}
                  disabled={isRetrying}
                  className="mt-2 inline-flex items-center gap-1 rounded-md bg-rose-600 px-2 py-1 text-[10px] font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
                >
                  {isRetrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  Re-tentar
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: "OK" | "ERROR" | "IN_PROGRESS" | "PENDING" | "NONE" }) {
  const cfg = {
    OK: { color: "border-emerald-300 bg-emerald-100 text-emerald-800", icon: <CheckCircle2 className="h-3 w-3" />, label: "OK" },
    ERROR: { color: "border-rose-300 bg-rose-100 text-rose-800", icon: <XCircle className="h-3 w-3" />, label: "ERRO" },
    IN_PROGRESS: { color: "border-amber-300 bg-amber-100 text-amber-800", icon: <Loader2 className="h-3 w-3 animate-spin" />, label: "EM PROGRESSO" },
    PENDING: { color: "border-slate-300 bg-slate-100 text-slate-700", icon: <AlertCircle className="h-3 w-3" />, label: "PENDENTE" },
    NONE: { color: "border-border bg-muted text-muted-foreground", icon: <AlertCircle className="h-3 w-3" />, label: "NÃO INICIADO" },
  }[status];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase", cfg.color)}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function StatusDot({ status }: { status: ExternalRegistrationJob["status"] | "NONE" }) {
  const map = {
    OK: "bg-emerald-500",
    ERROR: "bg-rose-500",
    IN_PROGRESS: "bg-amber-500 animate-pulse",
    PENDING: "bg-slate-400",
    NONE: "bg-slate-300",
  };
  return <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", map[status])} />;
}
