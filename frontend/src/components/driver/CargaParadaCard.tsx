import { ArrowRight, Clock3, Truck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DetailMetric } from "@/pages/DriverCargoDetails";
import { fixBrokenPortugueseText } from "@/lib/fixBrokenEncoding";
import type { PacoteCarga } from "@/services/readModels";

interface CargaParadaCardProps {
  carga: PacoteCarga;
  isCurrent: boolean;
}

/**
 * Sub-card de uma parada (carga) dentro de uma viagem casada — renderizado
 * por DriverCargoDetails quando `isPacote=true`. Plan revisao 2026-05-23.
 *
 * Anatomia:
 *  - Header: "Carga {N} — origem -> destino" (N = ordem_viagem) + badge
 *    "Voce esta aqui" quando isCurrent=true (i.e. carga.id === cargo.id atual)
 *  - Body: DetailMetric grid 2-col com Carregamento, Descarga, Tipo veiculo.
 *    D5: NAO mostrar Tempo estimado nem Percurso recomendado.
 *
 * Sem botao "Ver detalhes" — apenas dados; o motorista navega via grid
 * (todas as cargas estao acessiveis a partir da carga atual ja aberta).
 */
const CargaParadaCard = ({ carga, isCurrent }: CargaParadaCardProps) => {
  const carregamentoLabel = formatScheduleLabel(carga.data, carga.horario);
  const descargaLabel = "A confirmar";
  const veiculoLabel = carga.perfil || "A confirmar";

  return (
    <Card
      className="admin-panel overflow-hidden"
      data-testid={isCurrent ? "carga-parada-current" : "carga-parada-other"}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardDescription className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">
              Carga {carga.ordem_viagem}
            </CardDescription>
            <CardTitle className="mt-1 flex flex-wrap items-center gap-2 text-lg tracking-tight text-foreground sm:text-xl">
              <span className="break-words">{fixBrokenPortugueseText(carga.origem)}</span>
              <ArrowRight className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="break-words">{fixBrokenPortugueseText(carga.destino)}</span>
            </CardTitle>
          </div>
          {isCurrent ? (
            <Badge className="shrink-0 border-accent/40 bg-accent/15 px-3 py-1 text-accent">
              Você está aqui
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <DetailMetric icon={Clock3} label="Carregamento" value={carregamentoLabel} />
        <DetailMetric icon={Clock3} label="Descarga" value={descargaLabel} />
        <DetailMetric icon={Truck} label="Tipo de veículo" value={veiculoLabel} />
      </CardContent>
    </Card>
  );
};

function formatScheduleLabel(data: string | null, horario: string | null): string {
  if (!data) return "A confirmar";
  const horarioPart = horario ? ` às ${horario}` : "";
  return `${data}${horarioPart}`;
}

export default CargaParadaCard;
