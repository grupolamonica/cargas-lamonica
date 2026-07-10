import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Clock, Loader2, PlayCircle, Power, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import {
  getAutoApproveAngellira,
  runAutoApproveAngellira,
  setAutoApproveAngellira,
} from "@/services/readModels";

const QUERY_KEY = ["operator", "auto-approve-angellira"] as const;

function formatRelative(iso?: string | null) {
  if (!iso) return null;
  try {
    const diffMs = Date.now() - new Date(iso).getTime();
    if (diffMs < 0) return null;
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 1) return "agora";
    if (mins < 60) return `${mins}min atrás`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h atrás`;
    const days = Math.floor(hours / 24);
    return `${days}d atrás`;
  } catch {
    return null;
  }
}

/**
 * Card da aba "Pendentes": liga/desliga a aprovação automática por vigência no
 * Angellira e permite rodar uma leva sob demanda. A aprovação é leve (só muda o
 * status p/ 'aprovado', reversível). Consulta o Angellira do motorista por CPF.
 */
export function AutoApproveAngelliraCard() {
  const queryClient = useQueryClient();
  const [confirmRun, setConfirmRun] = useState(false);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getAutoApproveAngellira,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    // Enquanto uma leva roda, atualiza sozinho a cada 5s pra mostrar o progresso.
    refetchInterval: (query) => (query.state.data?.running ? 5_000 : false),
  });

  const toggleMutation = useMutation({
    mutationFn: (next: boolean) => setAutoApproveAngellira(next),
    onSuccess: (res) => {
      toast.success(res.enabled ? "Aprovação automática LIGADA." : "Aprovação automática desligada.");
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err: Error) => toast.error(err.message || "Não foi possível alterar a configuração."),
  });

  const runMutation = useMutation({
    mutationFn: () => runAutoApproveAngellira(),
    onSuccess: () => {
      setConfirmRun(false);
      toast.success("Consulta iniciada — aprovando os vigentes em segundo plano.");
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setTimeout(() => void refetch(), 1_000);
    },
    onError: (err: Error) => {
      setConfirmRun(false);
      toast.error(err.message || "Não foi possível iniciar a execução.");
    },
  });

  const enabled = Boolean(data?.enabled);
  const running = Boolean(data?.running);
  const lastRun = data?.lastRun ?? null;
  const pendingCount = data?.pendingCount ?? 0;

  const toneClasses = enabled
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : "border-slate-200 bg-slate-50 text-slate-600";

  return (
    <section className="admin-panel overflow-hidden p-5 lg:p-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex items-start gap-4">
          <div className={cn("flex h-12 w-12 items-center justify-center rounded-2xl border", toneClasses)}>
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-primary/60">
              Aprovação automática
            </p>
            <h3 className="mt-1 text-lg font-semibold tracking-tight text-foreground">
              Angellira — aprovar pendentes vigentes
            </h3>

            {error ? (
              <p className="mt-1 text-sm text-rose-700">
                Erro ao carregar: {error instanceof Error ? error.message : String(error)}
              </p>
            ) : isLoading ? (
              <p className="mt-1 text-sm text-muted-foreground">Carregando status...</p>
            ) : (
              <div className="mt-2 grid gap-x-6 gap-y-1 text-sm text-muted-foreground sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <Power className="h-3.5 w-3.5" />
                  <span>
                    Modo automático:{" "}
                    <strong className={cn("font-semibold", enabled ? "text-emerald-700" : "text-slate-600")}>
                      {enabled ? "LIGADO" : "desligado"}
                    </strong>
                  </span>
                </div>
                <div>
                  Fila:{" "}
                  <strong className="font-semibold text-foreground">{pendingCount.toLocaleString("pt-BR")}</strong>{" "}
                  pendente(s) com CPF
                </div>
                <div className="sm:col-span-2 flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5" />
                  {running ? (
                    <span className="text-primary">Consultando o Angellira… pode levar alguns minutos.</span>
                  ) : lastRun?.at ? (
                    <span>
                      Última execução:{" "}
                      <strong className="font-semibold text-foreground">
                        aprovou {lastRun.approved ?? 0}
                      </strong>{" "}
                      de {lastRun.scanned ?? 0} consultado(s)
                      {formatRelative(lastRun.at) ? <span className="text-xs"> · {formatRelative(lastRun.at)}</span> : null}
                    </span>
                  ) : (
                    <span>Nenhuma execução ainda.</span>
                  )}
                </div>
              </div>
            )}

            <p className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Aprova (só muda o status para <strong>aprovado</strong>) os cadastros pendentes cujo{" "}
              <strong>motorista está vigente no Angellira</strong> (Conforme + validade futura). Leve e reversível
              — não cria login nem perfil.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-2 rounded-2xl border border-border bg-white px-4 py-2 text-sm font-semibold text-foreground shadow-sm transition hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Atualizar
          </button>

          <button
            type="button"
            onClick={() => toggleMutation.mutate(!enabled)}
            disabled={toggleMutation.isPending}
            className={cn(
              "inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-60",
              enabled
                ? "border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                : "border-primary/30 bg-primary/10 text-primary hover:bg-primary/20",
            )}
          >
            {toggleMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
            {enabled ? "Desligar automático" : "Ligar automático"}
          </button>

          <button
            type="button"
            onClick={() => setConfirmRun((v) => !v)}
            disabled={running || runMutation.isPending}
            className="inline-flex items-center gap-2 rounded-2xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {running || runMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PlayCircle className="h-4 w-4" />
            )}
            Rodar agora
          </button>
        </div>
      </div>

      {confirmRun ? (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            Isso vai <strong>consultar o Angellira</strong> dos pendentes e <strong>aprovar</strong> (só status) os
            motoristas vigentes. Roda em segundo plano e pode levar alguns minutos. Continuar?
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmRun(false)}
              className="inline-flex items-center rounded-2xl border border-border bg-white px-4 py-2 text-sm font-semibold text-foreground shadow-sm transition hover:bg-muted/60"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => runMutation.mutate()}
              disabled={runMutation.isPending}
              className="inline-flex items-center gap-2 rounded-2xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {runMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
              Confirmar e rodar
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
