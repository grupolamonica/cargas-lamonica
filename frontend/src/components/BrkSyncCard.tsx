import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Clock, KeyRound, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { fetchBrkSyncStatus, updateBrkCookie, type BrkSyncStatus } from "@/services/brkAdmin";

const STATUS_QUERY_KEY = ["operator", "brk-sync-status"] as const;

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
    return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
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

function cookieTone(status: BrkSyncStatus["cookies"]) {
  if (status.expired) return "danger";
  if (status.secondsRemaining < 6 * 3600) return "warn";
  return "ok";
}

export function BrkSyncCard() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [cookiesText, setCookiesText] = useState("");
  const [userAgent, setUserAgent] = useState("");

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: fetchBrkSyncStatus,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const saveMutation = useMutation({
    mutationFn: () => updateBrkCookie({ cookies: cookiesText, userAgent }),
    onSuccess: (result) => {
      if (result.warning) {
        toast.warning(result.warning);
      } else {
        toast.success(`Cookie do BRK atualizado (${result.cookies.count} cookies).`);
      }
      setCookiesText("");
      setUserAgent("");
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Não foi possível atualizar o cookie do BRK.");
    },
  });

  const tone = data?.cookies ? cookieTone(data.cookies) : "ok";
  const toneClasses = {
    ok: "border-emerald-200 bg-emerald-50 text-emerald-800",
    warn: "border-amber-200 bg-amber-50 text-amber-800",
    danger: "border-rose-200 bg-rose-50 text-rose-800",
  }[tone];

  const Icon = data?.cookies?.expired ? AlertTriangle : ShieldCheck;

  return (
    <section className="admin-panel overflow-hidden p-5 lg:p-6">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
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
              Integração BRK
            </p>
            <h3 className="mt-1 text-lg font-semibold tracking-tight text-foreground">
              Brasil Risk — cookie de consulta
            </h3>
            {error ? (
              <p className="mt-1 text-sm text-rose-700">
                Erro ao carregar status: {error instanceof Error ? error.message : String(error)}
              </p>
            ) : isLoading ? (
              <p className="mt-1 text-sm text-muted-foreground">Carregando status...</p>
            ) : data?.cookies ? (
              <div className="mt-2 grid gap-x-6 gap-y-1 text-sm text-muted-foreground sm:grid-cols-2">
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5" />
                  <span>
                    Cookie:{" "}
                    <strong
                      className={cn("font-semibold", {
                        "text-emerald-700": tone === "ok",
                        "text-amber-700": tone === "warn",
                        "text-rose-700": tone === "danger",
                      })}
                    >
                      {data.cookies.count > 0 ? formatRemaining(data.cookies.secondsRemaining) : "não configurado"}
                    </strong>
                    {data.cookies.count > 0 ? (
                      <span className="text-xs"> (expira em {formatAbsolute(data.cookies.expiresAt)})</span>
                    ) : null}
                  </span>
                </div>
                <div>
                  Cookies salvos:{" "}
                  <strong className="font-semibold text-foreground">{data.cookies.count}</strong>
                  <span className="text-xs"> · UA: {data.cookies.hasUserAgent ? "sim" : "não"}</span>
                </div>
                <div>
                  Última consulta BRK:{" "}
                  <strong className="font-semibold text-foreground">
                    {formatAbsolute(data.drivers.lastCheckedAt)}
                  </strong>
                  {formatRelative(data.drivers.lastCheckedAt) ? (
                    <span className="text-xs"> ({formatRelative(data.drivers.lastCheckedAt)})</span>
                  ) : null}
                </div>
                <div>
                  Motoristas com BRK:{" "}
                  <strong className="font-semibold text-foreground">
                    {data.drivers.withBrk.toLocaleString("pt-BR")}
                  </strong>
                </div>
              </div>
            ) : null}
            {data?.cookies && (data.cookies.expired || data.cookies.count === 0) ? (
              <p className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                Cookie do BRK {data.cookies.count === 0 ? "não configurado" : "expirado"}. Faça login no{" "}
                <strong>br2.brasilrisk.com.br</strong>, exporte os cookies (extensão Cookie-Editor) e cole
                em <strong>“Atualizar cookie”</strong>. Inclua o <strong>cf_clearance</strong>.
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
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Atualizar status
          </button>

          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="inline-flex items-center gap-2 rounded-2xl border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary shadow-sm transition hover:bg-primary/20"
          >
            <KeyRound className="h-4 w-4" />
            {showForm ? "Fechar" : "Atualizar cookie"}
          </button>
        </div>
      </div>

      {showForm ? (
        <div className="mt-4 rounded-2xl border border-border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground">
            Cole o export dos cookies do <strong>br2.brasilrisk.com.br</strong> (extensão Cookie-Editor →
            Export, ou o header <em>Cookie</em> do DevTools). Precisa conter o <strong>cf_clearance</strong> e
            o <strong>cokiename</strong>.
          </p>
          <textarea
            value={cookiesText}
            onChange={(e) => setCookiesText(e.target.value)}
            rows={5}
            placeholder='[{"name":"cf_clearance","value":"..."},{"name":"cokiename","value":"..."}]  ou  cf_clearance=...; cokiename=...'
            className="mt-2 w-full rounded-xl border border-border bg-white p-3 font-mono text-xs shadow-inner focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <label className="mt-2 block text-xs font-semibold text-muted-foreground">
            User-Agent do Chrome (o cf_clearance é amarrado ao UA — copie do DevTools)
          </label>
          <input
            type="text"
            value={userAgent}
            onChange={(e) => setUserAgent(e.target.value)}
            placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/... Safari/537.36"
            className="mt-1 w-full rounded-xl border border-border bg-white p-2 font-mono text-xs shadow-inner focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || cookiesText.trim().length === 0}
              className="inline-flex items-center gap-2 rounded-2xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Salvar cookie do BRK
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
