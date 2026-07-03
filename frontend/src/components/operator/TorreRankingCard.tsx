import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, MapPin, Trophy } from "lucide-react";
import { fetchTorreDriverInfo } from "@/services/readModels";
import { cn } from "@/lib/utils";

/**
 * Ranking do motorista na Torre de Controle, exibido no painel de revisão de
 * cadastro do operador (fonte: GET /api/operator/cadastros/:id/torre, que
 * consulta a Torre por CPF). Read-only — complementa os prechecks
 * Angellira/SPX com posição no ranking, vínculo e sinais operacionais.
 */
export default function TorreRankingCard({ cadastroId }: { cadastroId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["operator", "cadastro-torre", cadastroId],
    queryFn: () => fetchTorreDriverInfo(cadastroId),
    staleTime: 60_000,
    retry: 1,
  });

  return (
    <div className="mt-4 rounded-xl border border-border bg-muted/20 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Trophy className="h-3.5 w-3.5" />
        Torre de Controle — Ranking
      </p>

      {isLoading ? (
        <div className="h-10 animate-pulse rounded-lg bg-muted/60" />
      ) : isError ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
          Torre indisponível no momento.
        </p>
      ) : !data?.found || !data.torre ? (
        <p className="text-xs text-muted-foreground">Sem registro na Torre para este CPF.</p>
      ) : (
        <div className="space-y-2">
          {data.torre.ranking.encontrado ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-sm font-bold text-primary">
                #{data.torre.ranking.posicao ?? "—"}
              </span>
              {data.torre.ranking.pontuacao != null && (
                <span className="text-xs text-muted-foreground">
                  {data.torre.ranking.pontuacao.toLocaleString("pt-BR")} pts
                </span>
              )}
              {data.torre.ranking.vinculo && (
                <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs font-semibold text-foreground">
                  {data.torre.ranking.vinculo}
                </span>
              )}
              {data.torre.ranking.status && (
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs font-semibold",
                    data.torre.ranking.status === "ATIVO" ? "admin-tint-success" : "admin-tint-warning",
                  )}
                >
                  {data.torre.ranking.status}
                </span>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Motorista fora do ranking atual.</p>
          )}

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {data.torre.conformidade.operationalScore != null && (
              <span>
                Score operacional: <strong className="text-foreground">{data.torre.conformidade.operationalScore}</strong>
              </span>
            )}
            <span>
              Viagens: <strong className="text-foreground">{data.torre.viagens.total}</strong>
            </span>
            <span className={cn(data.torre.ocorrencias.total > 0 && "text-amber-600")}>
              Ocorrências: <strong>{data.torre.ocorrencias.total}</strong>
            </span>
            {data.torre.conformidade.operationalBlocked === true && (
              <span className="font-semibold text-rose-600">BLOQUEADO operacionalmente</span>
            )}
          </div>

          {data.torre.ultimaPosicao?.at && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3 w-3" />
              Última posição: {[data.torre.ultimaPosicao.cidade, data.torre.ultimaPosicao.uf]
                .filter(Boolean)
                .join("/") || data.torre.ultimaPosicao.veiculo || "—"}{" "}
              em {new Date(data.torre.ultimaPosicao.at).toLocaleDateString("pt-BR")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
