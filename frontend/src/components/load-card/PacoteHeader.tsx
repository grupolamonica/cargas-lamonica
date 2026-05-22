import { Package } from "lucide-react";
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

const STATUS_VARIANT: Record<PacoteHeaderProps["status"], "default" | "secondary" | "destructive" | "outline"> = {
  publicado: "default",
  reservado: "secondary",
  em_andamento: "outline",
};

/**
 * Cabeçalho da renderização "viagem casada" no LoadCard. Exibe ícone de
 * pacote + label "Viagem casada — N paradas" + chip de status + valor total
 * (substitui o valor individual da carga porque o motorista candidata-se ao
 * pacote inteiro). Plan 10-05 (CARGAS-CASADAS-06).
 */
const PacoteHeader = ({ totalCargas, valorTotal, status }: PacoteHeaderProps) => {
  const valorLabel = formatCurrency(valorTotal);
  const statusLabel = STATUS_LABEL[status] ?? status;

  return (
    <div
      className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3"
      data-testid="pacote-header"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Package className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="text-sm font-semibold text-foreground sm:text-base">
          Viagem casada — {totalCargas} paradas
        </span>
        <Badge variant={STATUS_VARIANT[status]} className="shrink-0">
          {statusLabel}
        </Badge>
      </div>
      <span
        className="text-lg font-extrabold tracking-tight text-gradient-primary sm:text-xl"
        aria-label={`Valor total ${valorLabel}`}
      >
        {valorLabel}
      </span>
    </div>
  );
};

export default PacoteHeader;
