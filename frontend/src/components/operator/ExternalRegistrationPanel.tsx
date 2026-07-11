import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowDownToLine,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  KeyRound,
  Loader2,
  PlayCircle,
  RefreshCw,
  RotateCcw,
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
import { refreshAspxSession } from "@/services/aspxAdmin";

type Props = {
  cadastroId: string;
};

type AngelliraStepInfo = {
  step: AngelliraJobStep;
  label: string;
  icon: React.ReactNode;
};

const STEPS: AngelliraStepInfo[] = [
  { step: "proprietario_cavalo",  label: "Proprietário do cavalo", icon: <UserRound className="h-3.5 w-3.5" /> },
  { step: "cavalo",               label: "Cavalo",                 icon: <Truck className="h-3.5 w-3.5" /> },
  { step: "proprietario_carreta", label: "Proprietário da carreta",icon: <UserRound className="h-3.5 w-3.5" /> },
  { step: "carreta",              label: "Carreta",                icon: <Truck className="h-3.5 w-3.5" /> },
  { step: "motorista",            label: "Motorista",              icon: <UserRound className="h-3.5 w-3.5" /> },
];

const POLL_INTERVAL_MS = 3_000;

// ── Mapeamento de códigos de erro → mensagem amigável para operador ──────────

const ANGELLIRA_ERROR_LABELS: Record<string, { label: string; hint: string }> = {
  BOT_UNAVAILABLE:           { label: "API Angellira indisponível",       hint: "O servidor do Angellira está lento ou fora do ar. Tente novamente em alguns minutos." },
  BOT_DOWNSTREAM_FAIL:       { label: "Falha no Angellira",               hint: "O Angellira retornou um erro interno. Veja o detalhe e tente novamente." },
  OWNER_NAO_INFORMADO:       { label: "Proprietário não informado",        hint: "O CPF/CNPJ do proprietário não foi enviado. Re-faça o cadastro completo." },
  OWNER_NAO_CADASTRADO:      { label: "Proprietário não encontrado",       hint: "O proprietário precisa ser cadastrado antes do veículo. Re-tente desde o início." },
  OWNER_GENERICO_BLOQUEADO:  { label: "Proprietário genérico bloqueado",   hint: "O Angellira não aceita proprietários placeholder. Informe o CPF/CNPJ real." },
  OWNER_CAVALO_AUSENTE:      { label: "Dono do cavalo ausente",            hint: "O campo 'proprietário do cavalo' não foi preenchido no cadastro." },
  OWNER_CARRETA_AUSENTE:     { label: "Dono da carreta ausente",           hint: "O proprietário da carreta não foi encontrado. Revise o cadastro." },
  VEICULO_MODELO_NENHUM_ENCONTRADO: { label: "Modelo do veículo não encontrado", hint: "O modelo do CRLV não existe no catálogo do Angellira. Cadastre o veículo manualmente no portal e re-tente." },
  VEICULO_RENAVAM_DUPLICADO: { label: "RENAVAM duplicado no Angellira",    hint: "O RENAVAM deste veículo já está cadastrado em outro registro. Corrija no portal Angellira e re-tente." },
  OWNER_LOOKUP_FALHOU:       { label: "Erro ao buscar proprietário",       hint: "Falha de comunicação ao consultar o Angellira. Tente novamente." },
  BOT_BAD_REQUEST:           { label: "Dados inválidos",                   hint: "Os dados do cadastro são inválidos para o Angellira. Revise as informações." },
  BOT_INDISPONIVEL:          { label: "Bot Angellira offline",             hint: "O container angelira-bot não está rodando ou as credenciais estão ausentes." },
  PIPELINE_UNEXPECTED:       { label: "Erro inesperado no pipeline",       hint: "Ocorreu um erro interno. Verifique os logs do servidor e contate o suporte." },
};

const SPX_ERROR_LABELS: Record<string, { label: string; hint: string }> = {
  SPX_VEICULO_MUITO_ANTIGO:  { label: "Veículo acima de 20 anos",          hint: "A Shopee/SPX só aceita veículos com até 20 anos de fabricação. O cadastro fica em rascunho mas não é submetido — é necessário um veículo dentro do limite de idade." },
  SPX_UNKNOWN_ERROR:         { label: "Falha ao importar para o SPX",      hint: "Ocorreu um erro ao processar o motorista no SPX/Shopee. Verifique o detalhe abaixo." },
  SPX_DRIVER_BLOQUEADO:      { label: "Motorista bloqueado no SPX",        hint: "O motorista está bloqueado no portal Shopee Express. Contate o SPX para desbloquear." },
  SPX_BOT_INDISPONIVEL:      { label: "Bot SPX offline",                   hint: "O container spx-bot não está acessível ou as credenciais expiraram. Renove os cookies no Supabase." },
  SPX_PIPELINE_UNEXPECTED:   { label: "Erro inesperado no SPX",            hint: "Erro interno no pipeline SPX. Verifique os logs e tente novamente." },
};

// Códigos mapeados têm hint curado; para NÃO-mapeados não inventa hint genérico
// — a mensagem pt-BR do backend (sempre presente) é a fonte da verdade e já é
// renderizada abaixo, evitando "Consulte os logs" quando há causa específica.
function getAngelliraErrorInfo(code?: string): { label: string; hint: string | null } | null {
  if (!code) return null;
  return ANGELLIRA_ERROR_LABELS[code] ?? { label: code, hint: null };
}

function getSpxErrorInfo(code?: string): { label: string; hint: string | null } | null {
  if (!code) return null;
  return SPX_ERROR_LABELS[code] ?? { label: code, hint: null };
}

/**
 * Painel de cadastro externo (Angellira + SPX/Shopee).
 * Mostra status por etapa, botões contextuais e mensagens amigáveis para o operador.
 */
export default function ExternalRegistrationPanel({ cadastroId }: Props) {
  const queryClient = useQueryClient();
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<{ text: string; type: "ok" | "warn" | "info" } | null>(null);
  const [spxVerifyResult, setSpxVerifyResult] = useState<{ text: string; type: "ok" | "warn" | "info" | "error" } | null>(null);

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

  const overallStatus = useMemo(() => {
    if (!angelliraJobs.length) return "NONE" as const;
    if (angelliraJobs.some((j) => j.status === "IN_PROGRESS")) return "IN_PROGRESS" as const;
    if (angelliraJobs.some((j) => j.status === "ERROR")) return "ERROR" as const;
    if (angelliraJobs.every((j) => j.status === "OK")) return "OK" as const;
    return "PENDING" as const;
  }, [angelliraJobs]);

  // FIX 2026-06-25: usar SÓ o job do MOTORISTA SPX (step "spx_motorista"). O passo da
  // unificada (step "unificada_pdf") TAMBÉM tem target "spx" e, sendo o ÚLTIMO da lista
  // quando o dossiê dá OK mas o cadastro do motorista FALHA (ex.: retcode 271606027 —
  // veículo > 20 anos, caso FLAVIO), tanto o status/badge quanto o card "Motorista SPX"
  // pegavam o dossiê OK e pintavam "Cadastrado com sucesso", MASCARANDO a falha real.
  const spxMotoristaJob = useMemo(() => {
    const m = spxJobs.filter((j) => j.step === "spx_motorista");
    return m.length ? m[m.length - 1] : null;
  }, [spxJobs]);

  const spxStatus = useMemo(() => {
    if (!spxMotoristaJob) return "NONE" as const;
    const s = spxMotoristaJob.status;
    if (s === "IN_PROGRESS") return "IN_PROGRESS" as const;
    if (s === "ERROR") return "ERROR" as const;
    if (s === "OK") return "OK" as const;
    return "PENDING" as const;
  }, [spxMotoristaJob]);

  // Detecta se SPX tem motorista em outra agência (IS_MATCHED_OUTRA) para mudar label do botão
  const spxMatchedOutra = spxVerifyResult?.text.includes("outra agência");
  const spxMainBtnLabel = spxStatus === "OK"
    ? "Re-cadastrar"
    : spxMatchedOutra
      ? "Importar para nossa agência"
      : "Cadastrar no SPX";

  // ── Mutations Angellira ────────────────────────────────────────────────────

  const cadastrarMutation = useMutation({
    mutationFn: () => cadastrarAngellira(cadastroId),
    onSuccess: (result) => {
      if (result.ok) toast.success("Cadastro Angellira concluído com sucesso.");
      else toast.warning("Cadastro Angellira concluído com erros. Verifique as etapas abaixo.");
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast.error(err.message || "Falha ao disparar cadastro Angellira."),
  });

  const retryMutation = useMutation({
    mutationFn: (step: AngelliraJobStep) => retryAngelliraStep(cadastroId, step),
    onSuccess: (_data, step) => {
      const label = STEPS.find((s) => s.step === step)?.label ?? step;
      toast.success(`Etapa "${label}" re-tentada.`);
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast.error(err.message || "Falha ao re-tentar etapa."),
  });

  const precheckMutation = useMutation({
    mutationFn: () => precheckAngellira(cadastroId),
    onSuccess: (result) => {
      const motorista = result.motorista as { status?: string; valid_until?: string } | undefined;
      if (!motorista || motorista.status === "NOT_FOUND") {
        setVerifyResult({ text: "Motorista não encontrado no Angellira — ainda não cadastrado.", type: "warn" });
      } else if (motorista.valid_until) {
        setVerifyResult({ text: `✓ Motorista encontrado — vigência até ${motorista.valid_until}`, type: "ok" });
      } else {
        setVerifyResult({ text: "✓ Motorista encontrado no Angellira (vigência não informada)", type: "ok" });
      }
    },
    onError: (err: Error) => toast.error(err.message || "Falha na verificação."),
  });

  // ── Mutations SPX ──────────────────────────────────────────────────────────

  const cadastrarSpxMutation = useMutation({
    mutationFn: () => cadastrarSpx(cadastroId),
    onSuccess: (r) => {
      if (r.ok) toast.success("Motorista cadastrado/importado no SPX com sucesso.");
      else toast.warning("SPX concluído com erros. Verifique o painel.");
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast.error(err.message || "Falha ao cadastrar no SPX."),
  });

  const precheckSpxMutation = useMutation({
    mutationFn: () => precheckSpx(cadastroId),
    onSuccess: (r) => {
      const config: Record<string, { text: string; type: "ok" | "warn" | "info" | "error" }> = {
        NOT_FOUND:        { text: "Motorista não cadastrado no SPX — clique em 'Cadastrar no SPX'.", type: "info" },
        IS_MATCHED_NOSSA: { text: "✓ Motorista já cadastrado na nossa agência SPX.", type: "ok" },
        IS_MATCHED_OUTRA: { text: "Motorista existe em outra agência SPX — use 'Importar' para trazer para a Lamônica.", type: "warn" },
        REQUEST_PENDENTE: { text: "Já existe uma solicitação pendente no SPX — aguarde a aprovação.", type: "info" },
        BLOQUEADO:        { text: "⚠ Motorista bloqueado no SPX. Contate a Shopee Express para desbloquear.", type: "error" },
        UNAVAILABLE:      { text: "SPX indisponível — tente novamente mais tarde.", type: "warn" },
      };
      setSpxVerifyResult(config[r.status] ?? { text: `Status desconhecido: ${r.status}`, type: "warn" });
    },
    onError: (err: Error) => toast.error(err.message || "Falha ao verificar SPX."),
  });

  // B2 (DC-222 AC5): renovar a sessão SPX na hora, sem sair da tela do cadastro.
  const refreshSpxSessionMutation = useMutation({
    mutationFn: () => refreshAspxSession(),
    onSuccess: (r) => {
      if (r.alive) {
        toast.success("Sessão SPX renovada. Clique em 'Cadastrar no SPX' para tentar novamente.");
      } else {
        toast.error(
          r.detail
            ? `Não foi possível renovar a sessão SPX: ${r.detail}`
            : "Sessão SPX expirada e não foi possível renová-la automaticamente — refaça o login no portal SPX.",
        );
      }
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast.error(err.message || "Falha ao renovar a sessão SPX."),
  });

  const isAngelliraRunning = cadastrarMutation.isPending || overallStatus === "IN_PROGRESS";
  const isSpxRunning = cadastrarSpxMutation.isPending || spxStatus === "IN_PROGRESS";
  // Detecta sessão SPX expirada em QUALQUER etapa (proprietário/cavalo/carreta/motorista/unificada).
  const spxSessionExpired = useMemo(
    () =>
      spxJobs.some(
        (j) =>
          j.status === "ERROR" &&
          (j.error as { code?: string } | null | undefined)?.code === "SPX_SESSAO_EXPIRADA",
      ),
    [spxJobs],
  );

  return (
    <section className="admin-panel mt-4 p-5">
      {/* Cabeçalho */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-bold uppercase tracking-wide text-foreground">
          <Zap className="h-4 w-4 shrink-0 text-amber-500" />
          <span className="truncate">Cadastro externo</span>
        </h3>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isLoading}
          className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-50"
          title="Atualizar status"
        >
          <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
        </button>
      </div>

      {/* ── Angellira ────────────────────────────────────────────────────── */}
      <div className="mt-3 rounded-xl border border-border bg-background p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <StatusBadge status={overallStatus} />
            <span className="shrink-0 font-semibold text-foreground">Angellira</span>
            {overallStatus === "IN_PROGRESS" && (
              <span className="text-[10px] text-amber-700 animate-pulse">Processando…</span>
            )}
          </div>
          <div className="flex shrink-0 gap-1.5">
            {/* Verificar — consulta o Angellira sem escrever nada */}
            <button
              type="button"
              disabled={precheckMutation.isPending}
              onClick={() => precheckMutation.mutate()}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60"
              title="Consulta se o motorista já existe no Angellira (somente leitura)"
            >
              {precheckMutation.isPending
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <CheckCircle2 className="h-3 w-3" />}
              Verificar
            </button>
            {/* Cadastrar / Re-cadastrar */}
            <button
              type="button"
              disabled={isAngelliraRunning}
              onClick={() => cadastrarMutation.mutate()}
              className={cn(
                "inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-60",
                overallStatus === "OK"
                  ? "bg-slate-600 hover:bg-slate-700"
                  : "bg-emerald-600 hover:bg-emerald-700",
              )}
              title={overallStatus === "OK" ? "Re-enviar todas as etapas para o Angellira (sobrescreve registros existentes)" : "Iniciar cadastro de todas as etapas no Angellira"}
            >
              {isAngelliraRunning
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : overallStatus === "OK"
                  ? <RotateCcw className="h-3 w-3" />
                  : <PlayCircle className="h-3 w-3" />}
              {overallStatus === "OK" ? "Re-cadastrar" : "Cadastrar tudo"}
            </button>
          </div>
        </div>

        {/* Resultado da verificação */}
        {verifyResult ? (
          <VerifyResultBanner type={verifyResult.type} text={verifyResult.text} />
        ) : null}

        {/* Etapas */}
        <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {STEPS.map((s) => {
            const job = angelliraJobs.find((j) => j.step === s.step);
            return (
              <StepRow
                key={s.step}
                info={s}
                job={job}
                expanded={expandedStep === s.step}
                onToggle={() => setExpandedStep(expandedStep === s.step ? null : s.step)}
                onRetry={() => retryMutation.mutate(s.step)}
                isRetrying={retryMutation.isPending && retryMutation.variables === s.step}
              />
            );
          })}
        </div>
      </div>

      {/* ── SPX / Shopee ──────────────────────────────────────────────────── */}
      <div className="mt-3 rounded-xl border border-border bg-background p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <StatusBadge status={spxStatus} />
            <span className="shrink-0 font-semibold text-foreground">SPX / Shopee</span>
            {spxStatus === "IN_PROGRESS" && (
              <span className="text-[10px] text-amber-700 animate-pulse">Processando…</span>
            )}
          </div>
          <div className="flex shrink-0 gap-1.5">
            {/* Verificar SPX */}
            <button
              type="button"
              disabled={precheckSpxMutation.isPending}
              onClick={() => precheckSpxMutation.mutate()}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60"
              title="Consulta o status do motorista no portal SPX (somente leitura)"
            >
              {precheckSpxMutation.isPending
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <CheckCircle2 className="h-3 w-3" />}
              Verificar
            </button>
            {/* Cadastrar / Importar / Re-cadastrar */}
            <button
              type="button"
              disabled={isSpxRunning}
              onClick={() => cadastrarSpxMutation.mutate()}
              className={cn(
                "inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-60",
                spxStatus === "OK"
                  ? "bg-slate-600 hover:bg-slate-700"
                  : spxMatchedOutra
                    ? "bg-sky-600 hover:bg-sky-700"
                    : "bg-orange-500 hover:bg-orange-600",
              )}
              title={
                spxStatus === "OK"
                  ? "Re-enviar motorista para o SPX"
                  : spxMatchedOutra
                    ? "Importar o motorista da outra agência para a Lamônica"
                    : "Cadastrar motorista no SPX/Shopee Express"
              }
            >
              {isSpxRunning
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : spxStatus === "OK"
                  ? <RotateCcw className="h-3 w-3" />
                  : spxMatchedOutra
                    ? <ArrowDownToLine className="h-3 w-3" />
                    : <PlayCircle className="h-3 w-3" />}
              {spxMainBtnLabel}
            </button>
          </div>
        </div>

        {/* Resultado da verificação SPX */}
        {spxVerifyResult ? (
          <VerifyResultBanner type={spxVerifyResult.type} text={spxVerifyResult.text} />
        ) : null}

        {/* Job do MOTORISTA SPX (NÃO o unificada_pdf, que tb tem target "spx" e
            mascarava a falha como "Cadastrado com sucesso"). */}
        {spxMotoristaJob ? (
          <div className="mt-2 grid gap-1.5">
            <SpxJobRow job={spxMotoristaJob} />
          </div>
        ) : null}

        {/* B2 (DC-222 AC5): sessão SPX expirada — renovar na hora, sem sair da tela */}
        {spxSessionExpired ? (
          <div className="mt-2 flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2.5 text-xs text-amber-900 sm:flex-row sm:items-center sm:justify-between">
            <span className="flex items-start gap-1.5">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Sessão do SPX expirada — por isso o cadastro falhou. Renove a sessão e tente novamente.
            </span>
            <button
              type="button"
              disabled={refreshSpxSessionMutation.isPending}
              onClick={() => refreshSpxSessionMutation.mutate()}
              className="inline-flex shrink-0 items-center gap-1 self-start whitespace-nowrap rounded-lg bg-amber-600 px-2.5 py-1.5 font-semibold text-white hover:bg-amber-700 disabled:opacity-60 sm:self-auto"
            >
              {refreshSpxSessionMutation.isPending
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <KeyRound className="h-3 w-3" />}
              Renovar sessão SPX
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ── Sub-componentes ────────────────────────────────────────────────────────

function VerifyResultBanner({ type, text }: { type: "ok" | "warn" | "info" | "error"; text: string }) {
  const cfg = {
    ok:    "border-emerald-200 bg-emerald-50/60 text-emerald-800",
    warn:  "border-amber-200 bg-amber-50/60 text-amber-800",
    info:  "border-blue-200 bg-blue-50/60 text-blue-800",
    error: "border-rose-200 bg-rose-50/60 text-rose-800",
  }[type];
  const Icon = type === "ok" ? CheckCircle2 : type === "error" ? XCircle : Info;
  return (
    <p className={cn("mt-2 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs", cfg)}>
      <Icon className="mt-0.5 h-3 w-3 shrink-0" />
      {text}
    </p>
  );
}

function SpxJobRow({ job }: { job: ExternalRegistrationJob }) {
  const status = job.status;
  const error = job.error as
    | { code?: string; message?: string; acao?: string; retcode?: number | null; httpStatus?: number | null }
    | null
    | undefined;
  const errInfo = getSpxErrorInfo(error?.code);
  return (
    <div className={cn(
      "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs",
      status === "OK"          && "border-emerald-200 bg-emerald-50/40",
      status === "ERROR"       && "border-rose-200 bg-rose-50/40",
      status === "IN_PROGRESS" && "border-amber-200 bg-amber-50/40",
      status === "PENDING"     && "border-border bg-background",
    )}>
      <StatusDot status={status} />
      <div className="flex-1 min-w-0">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <UserRound className="h-3.5 w-3.5" />
          Motorista SPX
        </p>
        {job.external_id ? (
          <p className="mt-0.5 text-[10px] text-muted-foreground">ID: {job.external_id}</p>
        ) : null}
        {job.attempts && job.attempts > 1 ? (
          <p className="text-[10px] text-muted-foreground">{job.attempts} tentativa(s)</p>
        ) : null}
        {error && status === "ERROR" ? (
          <div className="mt-1 rounded-md border border-rose-200 bg-white p-2 text-[11px] text-rose-900 space-y-0.5">
            <p className="font-semibold">{errInfo?.label || error.code || "Erro"}</p>
            {errInfo?.hint ? (
              <p className="text-rose-700">{errInfo.hint}</p>
            ) : null}
            {/* Sempre mostra a mensagem técnica para facilitar diagnóstico */}
            {error.message && error.message !== errInfo?.hint ? (
              <p className="font-mono text-[10px] text-rose-600 break-all">{error.message}</p>
            ) : null}
            {error.acao ? (
              <p className="italic text-rose-700">→ {error.acao}</p>
            ) : null}
            {typeof error.retcode === "number" || typeof error.httpStatus === "number" ? (
              <p className="text-[10px] text-rose-400">código do robô: {error.retcode ?? error.httpStatus}</p>
            ) : null}
          </div>
        ) : null}
        {status === "OK" ? (
          <p className="mt-0.5 text-[10px] text-emerald-700 font-medium">Cadastrado com sucesso</p>
        ) : null}
      </div>
    </div>
  );
}

function StepRow({
  info, job, expanded, onToggle, onRetry, isRetrying,
}: {
  info: AngelliraStepInfo;
  job: ExternalRegistrationJob | undefined;
  expanded: boolean;
  onToggle: () => void;
  onRetry: () => void;
  isRetrying: boolean;
}) {
  const status = (job?.status || "NONE") as ExternalRegistrationJob["status"] | "NONE";
  const error = job?.error as
    | { code?: string; message?: string; acao?: string; retcode?: number | null; httpStatus?: number | null }
    | null
    | undefined;
  const errInfo = getAngelliraErrorInfo(error?.code);
  const externalId = job?.external_id;

  return (
    <div className={cn(
      "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-xs",
      status === "OK"          && "border-emerald-200 bg-emerald-50/40",
      status === "ERROR"       && "border-rose-200 bg-rose-50/40",
      status === "IN_PROGRESS" && "border-amber-200 bg-amber-50/40",
      (status === "PENDING" || status === "NONE") && "border-border bg-background",
    )}>
      <StatusDot status={status} />
      <div className="flex-1 min-w-0">
        {/* Linha 1: label + botão re-tentar visível quando ERROR */}
        <div className="flex items-center justify-between gap-1">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            {info.icon}
            {info.label}
          </p>
          {status === "ERROR" ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={isRetrying}
              className="shrink-0 inline-flex items-center gap-1 rounded-md border border-rose-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-60"
              title="Re-tentar esta etapa"
            >
              {isRetrying ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <RefreshCw className="h-2.5 w-2.5" />}
              Re-tentar
            </button>
          ) : null}
        </div>

        {externalId ? (
          <p className="mt-0.5 text-[10px] text-muted-foreground">ID Angellira: {externalId}</p>
        ) : null}
        {job?.attempts && job.attempts > 1 ? (
          <p className="text-[10px] text-muted-foreground">{job.attempts} tentativa(s)</p>
        ) : null}

        {/* Erro expansível */}
        {error && status === "ERROR" ? (
          <>
            <button
              type="button"
              onClick={onToggle}
              className="mt-1 flex items-center gap-1 text-[10px] font-medium text-rose-700 hover:underline"
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {errInfo?.label || error.code || "Erro"}
            </button>
            {expanded ? (
              <div className="mt-1 rounded-md border border-rose-200 bg-white p-2 text-[11px] text-rose-900 space-y-1">
                {errInfo?.hint ? (
                  <p className="text-rose-700">{errInfo.hint}</p>
                ) : null}
                {error.message && error.message !== errInfo?.hint ? (
                  <p className="font-mono text-[10px] text-rose-600 break-all">{error.message}</p>
                ) : (
                  !errInfo?.hint && <p>Erro desconhecido.</p>
                )}
                {error.acao ? <p className="italic text-rose-700">→ {error.acao}</p> : null}
                {typeof error.retcode === "number" || typeof error.httpStatus === "number" ? (
                  <p className="text-[10px] text-rose-400">código do robô: {error.retcode ?? error.httpStatus}</p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        {status === "OK" ? (
          <p className="mt-0.5 text-[10px] text-emerald-700 font-medium">Concluído ✓</p>
        ) : null}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: "OK" | "ERROR" | "IN_PROGRESS" | "PENDING" | "NONE" }) {
  const cfg = {
    OK:          { color: "border-emerald-300 bg-emerald-100 text-emerald-800", icon: <CheckCircle2 className="h-3 w-3" />, label: "OK" },
    ERROR:       { color: "border-rose-300 bg-rose-100 text-rose-800",         icon: <XCircle className="h-3 w-3" />,       label: "COM ERRO" },
    IN_PROGRESS: { color: "border-amber-300 bg-amber-100 text-amber-800",      icon: <Loader2 className="h-3 w-3 animate-spin" />, label: "PROCESSANDO" },
    PENDING:     { color: "border-slate-300 bg-slate-100 text-slate-700",      icon: <AlertCircle className="h-3 w-3" />,   label: "PENDENTE" },
    NONE:        { color: "border-border bg-muted text-muted-foreground",      icon: <AlertCircle className="h-3 w-3" />,   label: "NÃO INICIADO" },
  }[status];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase", cfg.color)}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function StatusDot({ status }: { status: ExternalRegistrationJob["status"] | "NONE" }) {
  const map: Record<string, string> = {
    OK:          "bg-emerald-500",
    ERROR:       "bg-rose-500",
    IN_PROGRESS: "bg-amber-500 animate-pulse",
    PENDING:     "bg-slate-400",
    NONE:        "bg-slate-300",
  };
  return <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", map[status])} />;
}
