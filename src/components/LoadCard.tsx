import { Navigation, Truck, ArrowRight, Clock3 } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { getCargaPath } from "@/data/cargas";
import { formatEstimatedTime } from "@/lib/estimated-time";

interface LoadCardProps {
  id: string;
  dateTime: string;
  dataCarregamento: string;
  dataDescarga: string;
  origemCidade: string;
  origemEstado: string;
  destinoCidade: string;
  destinoEstado: string;
  tipoVeiculo: string;
  distancia: string;
  pagamento: string;
  index?: number;
}

const LoadCard = ({
  id,
  dateTime,
  dataCarregamento,
  dataDescarga,
  origemCidade,
  origemEstado,
  destinoCidade,
  destinoEstado,
  tipoVeiculo,
  distancia,
  pagamento,
  index = 0,
}: LoadCardProps) => {
  const tempoEstimado = formatEstimatedTime(dataCarregamento, dataDescarga);
  const cargaPath = getCargaPath(id);

  return (
    <div
      className="group relative bg-card rounded-2xl sm:rounded-3xl border border-border/50 p-4 sm:p-6 transition-all duration-500 ease-out premium-shadow hover:premium-shadow-hover hover:-translate-y-1 opacity-0 animate-fade-in-up"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      {/* Subtle gradient overlay on hover */}
      <div className="absolute inset-0 rounded-2xl sm:rounded-3xl bg-gradient-to-br from-primary/[0.02] to-accent/[0.02] opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />

      {/* Header */}
      <div className="relative flex items-center justify-between mb-4 sm:mb-5">
        <span className="inline-flex items-center gap-1.5 sm:gap-2 rounded-lg sm:rounded-xl bg-badge px-2.5 sm:px-3.5 py-1 sm:py-1.5 text-[11px] sm:text-xs font-bold text-badge-text tracking-wide">
          <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse-glow" />
          {dateTime}
        </span>
        <span className="text-[10px] sm:text-[11px] text-muted-foreground/70 font-mono font-medium tracking-wider bg-muted/50 px-2 sm:px-3 py-1 rounded-lg">
          #{id}
        </span>
      </div>

      {/* Route */}
      <div className="relative flex gap-3 sm:gap-5 mb-4 sm:mb-5">
        {/* Timeline */}
        <div className="flex flex-col items-center pt-1.5 pb-0.5">
          <div className="h-3.5 w-3.5 sm:h-4 sm:w-4 rounded-full border-[2.5px] border-primary bg-card shadow-sm ring-4 ring-primary/10" />
          <div className="w-[2px] flex-1 my-1 sm:my-1.5 bg-gradient-to-b from-primary/40 via-primary/20 to-accent/40 rounded-full" />
          <div className="h-3.5 w-3.5 sm:h-4 sm:w-4 rounded-full bg-accent shadow-sm ring-4 ring-accent/10" />
        </div>

        {/* Locations */}
        <div className="flex-1 space-y-3 sm:space-y-4">
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-bold">Origem</p>
            <p className="text-sm sm:text-base font-extrabold text-card-foreground tracking-tight">{origemCidade}, <span className="text-primary font-extrabold">{origemEstado}</span></p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-bold">Destino</p>
            <p className="text-sm sm:text-base font-extrabold text-card-foreground tracking-tight">{destinoCidade}, <span className="text-accent font-extrabold">{destinoEstado}</span></p>
          </div>
        </div>
      </div>

      {/* Info blocks */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-4 sm:mb-5">
        <div className="flex-1 rounded-xl sm:rounded-2xl bg-muted/40 border border-border/30 p-2.5 sm:p-3.5 transition-colors duration-200 group-hover:bg-muted/60">
          <div className="flex items-center gap-1.5 sm:gap-2 mb-1 sm:mb-1.5">
            <div className="flex items-center justify-center h-5 w-5 sm:h-6 sm:w-6 rounded-md sm:rounded-lg bg-primary/10">
              <Truck className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-primary" />
            </div>
            <span className="text-[9px] sm:text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-bold">Veículo</span>
          </div>
          <p className="text-xs sm:text-sm font-extrabold text-card-foreground">{tipoVeiculo}</p>
        </div>
        <div className="flex-1 rounded-xl sm:rounded-2xl bg-muted/40 border border-border/30 p-2.5 sm:p-3.5 transition-colors duration-200 group-hover:bg-muted/60">
          <div className="flex items-center gap-1.5 sm:gap-2 mb-1 sm:mb-1.5">
            <div className="flex items-center justify-center h-5 w-5 sm:h-6 sm:w-6 rounded-md sm:rounded-lg bg-primary/10">
              <Navigation className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-primary" />
            </div>
            <span className="text-[9px] sm:text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-bold">Distância</span>
          </div>
          <p className="text-xs sm:text-sm font-extrabold text-card-foreground">{distancia}</p>
        </div>
        <div className="flex-1 rounded-xl sm:rounded-2xl bg-muted/40 border border-border/30 p-2.5 sm:p-3.5 transition-colors duration-200 group-hover:bg-muted/60">
          <div className="flex items-center gap-1.5 sm:gap-2 mb-1 sm:mb-1.5">
            <div className="flex items-center justify-center h-5 w-5 sm:h-6 sm:w-6 rounded-md sm:rounded-lg bg-primary/10">
              <Clock3 className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-primary" />
            </div>
            <span className="text-[9px] sm:text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-bold">Tempo</span>
          </div>
          <p className="text-xs sm:text-sm font-extrabold text-card-foreground">{tempoEstimado}</p>
        </div>
      </div>

      {/* Footer */}
      <div className="relative border-t border-border/40 pt-4 sm:pt-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-0">
        <div>
          <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground font-bold mb-1">Pagamento</p>
          <p className="text-xl sm:text-2xl font-extrabold tracking-tight text-gradient-primary">{pagamento}</p>
        </div>
        <Button
          asChild
          variant="cta"
          size="lg"
          className="rounded-xl sm:rounded-2xl px-5 sm:px-7 w-full sm:w-auto group/btn"
        >
          <Link to={cargaPath}>
            <span>Abrir carga</span>
            <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover/btn:translate-x-1" />
          </Link>
        </Button>
      </div>
    </div>
  );
};

export default LoadCard;
