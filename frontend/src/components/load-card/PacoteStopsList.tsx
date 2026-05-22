import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchPacote, type PacoteCarga } from "@/services/readModels";

interface PacoteStopsListProps {
  pacoteId: string;
  /** Incrementa quando o operador edita o pacote — força revalidação via queryKey. */
  version: number;
}

interface Stop {
  kind: "coleta" | "entrega";
  /** Posição da carga (1..N) — não posição do stop. */
  cargaIndex: number;
  cidade: string;
}

const buildStops = (cargas: PacoteCarga[]): Stop[] => {
  // Garante ordem por `ordem_viagem` (backend já entrega ordenado mas defesa em profundidade).
  const ordered = [...cargas].sort((a, b) => a.ordem_viagem - b.ordem_viagem);
  const stops: Stop[] = [];
  ordered.forEach((carga, idx) => {
    const cargaIndex = idx + 1;
    stops.push({ kind: "coleta", cargaIndex, cidade: carga.origem });
    stops.push({ kind: "entrega", cargaIndex, cidade: carga.destino });
  });
  return stops;
};

/**
 * Lista vertical "Coleta 1 → Entrega 1 → Coleta 2 → ..." para uma viagem casada.
 * Fetch lazy via useQuery; queryKey inclui version para invalidação automática
 * quando operador edita o pacote (plan 10-06 dispara a propagação).
 *
 * Estados:
 * - loading → 3 Skeletons (placeholders pulsantes)
 * - error → fallback acionável com botão "Tentar novamente"
 * - success → <ol> com role="list" + N x 2 <li> alternando coleta/entrega
 */
const PacoteStopsList = ({ pacoteId, version }: PacoteStopsListProps) => {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["pacote", pacoteId, version],
    queryFn: () => fetchPacote(pacoteId),
    staleTime: 30_000,
    enabled: Boolean(pacoteId),
  });

  if (isLoading) {
    return (
      <div
        className="space-y-2"
        aria-busy="true"
        aria-live="polite"
        data-testid="pacote-stops-loading"
      >
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-6 w-3/4" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-muted-foreground"
        role="alert"
        data-testid="pacote-stops-error"
      >
        Não foi possível carregar as paradas desta viagem.
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="ml-2 font-semibold text-primary underline-offset-2 hover:underline disabled:opacity-50"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  const stops = buildStops(data.cargas);

  return (
    <ol
      role="list"
      aria-label={`Viagem com ${data.cargas.length} paradas`}
      className="space-y-1"
      data-testid="pacote-stops-list"
    >
      {stops.map((stop, i) => {
        const isLast = i === stops.length - 1;
        return (
          <li
            key={`${stop.kind}-${stop.cargaIndex}-${i}`}
            role="listitem"
            className="flex items-start gap-3"
          >
            <div className="flex flex-col items-center pt-1">
              <span
                className={
                  "inline-block h-3 w-3 rounded-full shadow-sm " +
                  (stop.kind === "coleta"
                    ? "bg-emerald-500 ring-2 ring-emerald-200"
                    : "bg-rose-500 ring-2 ring-rose-200")
                }
                aria-hidden="true"
              />
              {!isLast ? (
                <span className="mt-1 block h-6 w-px bg-border" aria-hidden="true" />
              ) : null}
            </div>
            <span className="text-sm leading-snug text-card-foreground">
              <strong className="font-semibold">
                {stop.kind === "coleta" ? "Coleta" : "Entrega"} {stop.cargaIndex}:
              </strong>{" "}
              {stop.cidade}
            </span>
          </li>
        );
      })}
    </ol>
  );
};

export default PacoteStopsList;
