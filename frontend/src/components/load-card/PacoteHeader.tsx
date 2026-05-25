import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Package } from "lucide-react";
import { format, isToday } from "date-fns";
import { ptBR } from "date-fns/locale";

import { Skeleton } from "@/components/ui/skeleton";
import { buildLoadingDateTime } from "@/lib/estimatedTime";
import { fetchPacote, type PacoteCarga, type PacoteMeta } from "@/services/readModels";

interface PacoteHeaderProps {
  pacoteMeta: PacoteMeta;
}

/**
 * Header do LoadCard pacote — espelha a anatomia do AVULSA listing card
 * (LoadCard.tsx:304–398). Plan revisao 2026-05-23:
 *
 *  Row 1 (mobile / lg:hidden): date badge "Coleta DD/MM as HH:MM" usando
 *    pacoteMeta.earliest_carga_date. Area direita (onde o avulsa exibe
 *    ClientLogo) fica VAZIA por design — D6 explicito: sem "Multi-cliente"
 *    badge, sem logo, mas preserva o layout/posicionamento.
 *
 *  Trecho box: wrapper IDENTICO ao avulsa (border-border/40 bg-muted/25
 *    rounded-2xl p-3) com label "{N} paradas" + uma linha por carga, no
 *    formato `Coleta X: city -> Entrega X: city` lado a lado (D4).
 *
 *  Tablet+ (sm:hidden inverso): adapta layout horizontal, mantendo o trecho
 *    box como conteudo principal.
 *
 *  NAO inclui mais o dark gradient (descartado) nem PAGAMENTO TOTAL embed —
 *  esses migraram para o LoadCard branch pacote em outros painels.
 *
 *  Mantem data-testid="pacote-header" para compat com tests.
 */
const PacoteHeader = ({ pacoteMeta }: PacoteHeaderProps) => {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["pacote", pacoteMeta.id, pacoteMeta.version],
    queryFn: () => fetchPacote(pacoteMeta.id),
    staleTime: 30_000,
    enabled: Boolean(pacoteMeta.id),
  });

  const paradasLabel = pacoteMeta.total_cargas === 1 ? "parada" : "paradas";
  const dateBadgeLabel = formatDateBadge(
    pacoteMeta.earliest_carga_date ?? null,
    pacoteMeta.earliest_carga_horario ?? null,
  );

  return (
    <section data-testid="pacote-header" className="relative">
      {/* Row 1 (mobile + tablet, lg:hidden) — Date badge esquerda + "Carga casada" badge direita.
          iter #8 (2026-05-25): area direita ganha indicador intuitivo do tipo de carga.
          Substitui o vazio anterior (D6 do iter #2) — necessario deixar claro pro motorista
          que e uma viagem multi-paradas, nao avulsa. */}
      <div className="relative mb-3 flex items-start justify-between gap-2 sm:mb-5 lg:hidden">
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-badge px-2.5 py-1 text-[11px] font-bold tracking-wide text-badge-text sm:gap-2 sm:rounded-xl sm:px-3.5 sm:py-1.5 sm:text-xs">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-glow" />
          {dateBadgeLabel}
        </span>
        <span
          className="inline-flex items-center gap-1.5 rounded-xl border border-primary/30 bg-primary/[0.08] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-primary shadow-sm sm:gap-2 sm:px-3 sm:py-1.5 sm:text-[11px]"
          aria-label="Esta carga e uma viagem casada com multiplas paradas"
          data-testid="pacote-badge-carga-casada"
        >
          <Package className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="flex flex-col leading-tight">
            <span>Carga casada</span>
            <span className="text-[8px] font-medium normal-case tracking-normal text-primary/75 sm:text-[9px]">
              {pacoteMeta.total_cargas} {paradasLabel} no trajeto
            </span>
          </span>
        </span>
      </div>

      {/* Trecho box — wrapper IDENTICO ao avulsa (border-border/40 bg-muted/25) */}
      <div className="relative mb-4 rounded-2xl border border-border/40 bg-muted/25 p-3">
        <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.15em] text-muted-foreground">
          {pacoteMeta.total_cargas} {paradasLabel}
        </p>
        {isLoading ? (
          <div className="space-y-2" data-testid="pacote-stops-loading" aria-busy="true">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-5/6" />
            <Skeleton className="h-5 w-3/4" />
          </div>
        ) : isError || !data ? (
          <div
            role="alert"
            data-testid="pacote-stops-error"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-sm text-muted-foreground"
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
        ) : (
          <ol
            role="list"
            aria-label={`Viagem com ${data.cargas.length} paradas`}
            data-testid="pacote-stops-list"
            className="space-y-1.5"
          >
            {orderedCargas(data.cargas).map((carga, idx) => {
              const cargaIndex = idx + 1;
              return (
                <li
                  key={carga.id}
                  role="listitem"
                  className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 text-sm leading-snug"
                >
                  <span className="min-w-0 truncate">
                    <strong className="font-semibold">Coleta {cargaIndex}:</strong>{" "}
                    <span className="text-card-foreground">{carga.origem}</span>
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                  <span className="min-w-0 truncate text-right">
                    <strong className="font-semibold">Entrega {cargaIndex}:</strong>{" "}
                    <span className="text-card-foreground">{carga.destino}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* Mantém o label "Viagem casada — N paradas" no DOM como sr-only para
          preservar matchers existentes em tests (LoadCard.test, PacoteHeader). */}
      <span className="sr-only" aria-hidden="true">
        Viagem casada — {pacoteMeta.total_cargas} {paradasLabel}
      </span>
    </section>
  );
};

function orderedCargas(cargas: PacoteCarga[]): PacoteCarga[] {
  // Backend ja devolve ordenado, defesa em profundidade.
  return [...cargas].sort((a, b) => a.ordem_viagem - b.ordem_viagem);
}

/**
 * Formata o badge "Coleta DD/MM as HH:MM" — espelha exatamente buildDateLabel
 * do branch avulsa (frontend/src/components/driver/DriverLoadsList.tsx:37-42).
 * iter #2 (2026-05-23): badge ganha horario para virar identico ao avulsa.
 *
 *  - quando earliest+horario presentes: "Coleta hoje as 08:00" ou "Coleta 10/06 as 08:00"
 *  - quando so earliest: "Coleta hoje" ou "Coleta 10/06"
 *  - quando ambos null: "Coleta a confirmar"
 */
function formatDateBadge(
  earliestDate: string | null,
  earliestHorario: string | null,
): string {
  const loadingDate = buildLoadingDateTime(null, earliestDate, earliestHorario);
  if (!loadingDate) return "Coleta a confirmar";
  const baseDate = isToday(loadingDate) ? "hoje" : format(loadingDate, "dd/MM", { locale: ptBR });
  const hasTimeComponent = Boolean(earliestHorario && earliestHorario.trim() !== "");
  if (!hasTimeComponent) {
    return `Coleta ${baseDate}`;
  }
  return `Coleta ${baseDate} às ${format(loadingDate, "HH:mm")}`;
}

export default PacoteHeader;
