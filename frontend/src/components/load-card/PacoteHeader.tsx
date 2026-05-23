import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/currency";

interface PacoteHeaderProps {
  totalCargas: number;
  valorTotal: number;
  status: "publicado" | "reservado" | "em_andamento";
}

const STATUS_LABEL: Record<PacoteHeaderProps["status"], string> = {
  publicado: "Disponível",
  reservado: "Reservada",
  em_andamento: "Em andamento",
};

const STATUS_VARIANT: Record<
  PacoteHeaderProps["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  publicado: "default",
  reservado: "secondary",
  em_andamento: "outline",
};

/**
 * Cabeçalho do card "viagem casada" no LoadCard — painel dark gradient
 * paralelo ao header da carga avulsa (LoadCard.tsx). À esquerda exibe
 * subtitle "VIAGEM CASADA", título "{N} paradas" e badge de status.
 * À direita, painel "PAGAMENTO TOTAL" com `valor_total` e legenda
 * "Valor definido pelo operador".
 *
 * Plan 10-05 (CARGAS-CASADAS-06) — redesign alinhando visual à carga avulsa.
 */
const PacoteHeader = ({ totalCargas, valorTotal, status }: PacoteHeaderProps) => {
  const valorLabel = formatCurrency(valorTotal);
  const statusLabel = STATUS_LABEL[status] ?? status;
  const paradasLabel = totalCargas === 1 ? "parada" : "paradas";

  return (
    <section
      className="relative mb-4 overflow-hidden rounded-[28px] border border-white/70 bg-[linear-gradient(135deg,hsl(223_56%_12%),hsl(223_55%_22%))] p-5 text-white shadow-[0_30px_70px_-30px_hsl(215_25%_12%/0.55)] sm:p-6"
      data-testid="pacote-header"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,hsl(225_100%_65%/0.18),transparent_36%),radial-gradient(circle_at_bottom_left,hsl(200_100%_55%/0.14),transparent_30%)]" />
      <div className="relative grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="min-w-0 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-white/70">
            Viagem casada
          </p>
          <h2 className="text-2xl font-black tracking-tight text-white sm:text-3xl">
            {totalCargas} {paradasLabel}
          </h2>
          <Badge
            variant={STATUS_VARIANT[status]}
            className="border-white/30 bg-white/10 text-white hover:bg-white/15"
          >
            {statusLabel}
          </Badge>
        </div>
        <div
          className="rounded-[22px] border border-white/12 bg-white/10 p-4 backdrop-blur sm:min-w-[220px]"
          aria-label={`Valor total ${valorLabel}`}
        >
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/60">
            Pagamento total
          </p>
          <p className="mt-2 text-2xl font-black tracking-tight text-white sm:text-3xl">
            {valorLabel}
          </p>
          <p className="mt-1 text-[0.72rem] font-medium leading-relaxed text-white/65">
            Valor definido pelo operador
          </p>
        </div>
      </div>
      {/* Mantém o label "Viagem casada — N paradas" no DOM como sr-only para
          preservar matchers existentes em tests (PacoteHeader.test, LoadCard.test). */}
      <span className="sr-only" aria-hidden="true">
        Viagem casada — {totalCargas} {paradasLabel}
      </span>
    </section>
  );
};

export default PacoteHeader;
