import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Clock, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { fetchAspxSyncStatus, triggerAspxSync, type AspxSyncStatus } from "@/services/aspxAdmin";

const STATUS_QUERY_KEY = ["operator", "aspx-sync-status"] as const;
const POLL_AFTER_TRIGGER_MS = 5_000;
const POLL_MAX_ATTEMPTS = 18; // ~90s (5s * 18)

function formatRemaining(seconds: number) {
  if (seconds <= 0) return "expirado";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const mins = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h restantes`;
  if (hours > 0) return `${hours}h ${mins}min restantes`;
  if (mins > 0) return `${mins}min restantes`;
  return `${seconds}s restantes`;
}

function formatAbsolute(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function formatRelative(iso: string | null) {
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

function cookieTone(status: AspxSyncStatus["cookies"]) {
  if (status.expired) return "danger";
  if (status.secondsRemaining < 24 * 3600) return "warn";
  return "ok";
}

export function AspxSyncCard() {
  const queryClient = useQueryClient();
  const [pollingAfterTrigger, setPollingAfterTrigger] = useState(false);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: fetchAspxSyncStatus,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: pollingAfterTrigger ? POLL_AFTER_TRIGGER_MS : false,
  });

  const triggerMutation = useMutation({
    mutationFn: triggerAspxSync,
    onSuccess: () => {
      toast.success("Sync do ASPX disparado. Atualizando em alguns instantes...");
      setPollingAfterTrigger(true);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Não foi possível disparar o sync do ASPX.");
    },
  });

  // Para o polling quando lastSyncAt avancar (sucesso) OU após um teto de tempo
  // GARANTIDO. Bug anterior (render infinito em produção): o contador só
  // incrementava quando `lastSyncAt` mudava (dep do effect), então se o sync
  // disparado nunca avançasse o `lastSyncAt` (workflow não roda / sincroniza
  // outro projeto), o teto nunca era atingido e o polling/refetch rodava pra
  // sempre — spinner infinito. Agora o stop é por timer, independente disso.
  const lastSyncAt = data?.drivers?.lastSyncAt || null;
  const [baselineSyncAt, setBaselineSyncAt] = useState<string | null>(null);

  // Captura o baseline assim que o polling começa.
  useEffect(() => {
    if (pollingAfterTrigger && baselineSyncAt === null) {
      setBaselineSyncAt(lastSyncAt ?? "");
    }
  }, [pollingAfterTrigger, baselineSyncAt, lastSyncAt]);

  // Sucesso: lastSyncAt avançou em relação ao baseline → para o polling.
  useEffect(() => {
    if (!pollingAfterTrigger || baselineSyncAt === null) return;
    if (lastSyncAt && lastSyncAt !== baselineSyncAt) {
      setPollingAfterTrigger(false);
      setBaselineSyncAt(null);
      toast.success(`ASPX atualizado: ${data?.drivers?.total ?? 0} motoristas no portal.`);
      queryClient.invalidateQueries({ queryKey: ["operator", "motoristas-read-model"] });
    }
  }, [lastSyncAt, pollingAfterTrigger, baselineSyncAt, data?.drivers?.total, queryClient]);

  // Teto de tempo garantido (~90s): para o polling mesmo que lastSyncAt nunca mude.
  useEffect(() => {
    if (!pollingAfterTrigger) return;
    const timer = setTimeout(() => {
      setPollingAfterTrigger(false);
      setBaselineSyncAt(null);
      toast.info("Sync ainda em execução. Atualize o status manualmente em alguns minutos.");
    }, POLL_AFTER_TRIGGER_MS * POLL_MAX_ATTEMPTS);
    return () => clearTimeout(timer);
  }, [pollingAfterTrigger]);

  const tone = data ? cookieTone(data.cookies) : "ok";
  const toneClasses = {
    ok: "border-emerald-200 bg-emerald-50 text-emerald-800",
    warn: "border-amber-200 bg-amber-50 text-amber-800",
    danger: "border-rose-200 bg-rose-50 text-rose-800",
  }[tone];

  const Icon = data?.cookies.expired ? AlertTriangle : ShieldCheck;

  return (
    <section className="admin-panel overflow-hidden p-5 lg:p-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex items-start gap-4">
          <div
            className={cn(
              "flex h-12 w-12 items-center justify-center rounded-2xl border",
              toneClasses,
            )}
          >
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-primary/60">
              Integração ASPX
            </p>
            <h3 className="mt-1 text-lg font-semibold tracking-tight text-foreground">
              Sincronização do portal Agency
            </h3>
            {error ? (
              <p className="mt-1 text-sm text-rose-700">
                Erro ao carregar status: {error instanceof Error ? error.message : String(error)}
              </p>
            ) : isLoading ? (
              <p className="mt-1 text-sm text-muted-foreground">Carregando status...</p>
            ) : data ? (
              <div className="mt-2 grid gap-x-6 gap-y-1 text-sm text-muted-foreground sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5" />
                  <span>
                    Cookies:{" "}
                    <strong className={cn("font-semibold", {
                      "text-emerald-700": tone === "ok",
                      "text-amber-700": tone === "warn",
                      "text-rose-700": tone === "danger",
                    })}>
                      {formatRemaining(data.cookies.secondsRemaining)}
                    </strong>{" "}
                    <span className="text-xs">
                      (expira em {formatAbsolute(data.cookies.expiresAt)})
                    </span>
                  </span>
                </div>
                <div>
                  Motoristas na base:{" "}
                  <strong className="font-semibold text-foreground">
                    {data.drivers.total.toLocaleString("pt-BR")}
                  </strong>
                </div>
                <div>
                  Ultimo sync:{" "}
                  <strong className="font-semibold text-foreground">
                    {formatAbsolute(data.drivers.lastSyncAt)}
                  </strong>
                  {formatRelative(data.drivers.lastSyncAt) ? (
                    <span className="text-xs"> ({formatRelative(data.drivers.lastSyncAt)})</span>
                  ) : null}
                </div>
                <div>
                  Cookies renovados em:{" "}
                  <strong className="font-semibold text-foreground">
                    {formatAbsolute(data.cookies.updatedAt)}
                  </strong>
                </div>
              </div>
            ) : null}
            {data?.cookies.expired ? (
              <p className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                Cookies expirados. Rode{" "}
                <code className="rounded bg-white/60 px-1 py-0.5 text-[11px]">
                  ASPX_ALLOW_PLAYWRIGHT_LOGIN=1 python scripts/aspx-sync/asp.py
                </code>{" "}
                em sua maquina local para renovar.
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-2 rounded-2xl border border-border bg-white px-4 py-2 text-sm font-semibold text-foreground shadow-sm transition hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Atualizar status
          </button>

          <button
            type="button"
            onClick={() => triggerMutation.mutate()}
            disabled={
              triggerMutation.isPending ||
              pollingAfterTrigger ||
              Boolean(data?.cookies.expired)
            }
            title={
              data?.cookies.expired
                ? "Cookies expirados: renove localmente antes de sincronizar."
                : "Dispara o GitHub Action que sincroniza aspx_drivers usando os cookies cacheados."
            }
            className="inline-flex items-center gap-2 rounded-2xl border border-primary/60 bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {triggerMutation.isPending || pollingAfterTrigger ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            {pollingAfterTrigger ? "Aguardando conclusão..." : "Sincronizar ASPX agora"}
          </button>
        </div>
      </div>
    </section>
  );
}
