import { CalendarClock, Clock3, MapPinned, Package, Truck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  buildLoadingDateTime,
  buildOperationalDateLabel,
  formatEstimatedTime,
} from "@/lib/estimatedTime";
import { fixBrokenPortugueseText } from "@/lib/fixBrokenEncoding";
import { DetailMetric, formatRouteMetric } from "@/pages/DriverCargoDetails";
import type { PacoteCarga } from "@/services/readModels";

interface CargaParadaCardProps {
  carga: PacoteCarga;
  isCurrent: boolean;
  index: number;
}

/**
 * Sub-card de uma parada (carga) dentro de uma viagem casada — renderizado
 * por DriverCargoDetails quando `isPacote=true`.
 *
 * iter #2 (2026-05-23): espelha EXATAMENTE o JSX do bloco "Coleta, entrega
 * e percurso" do AVULSA (DriverCargoDetails.tsx:866-881):
 *  - Card admin-panel
 *  - CardHeader "INFORMACOES DA CARGA" + CardTitle "Coleta, entrega e percurso"
 *  - 5 DetailMetrics: Carregamento, Descarga, Tempo estimado, Tipo veiculo,
 *    Percurso recomendado
 *  - Sub-header adicional com "Carga {N}: origem -> destino" + badge
 *    "Voce esta aqui" quando isCurrent=true (delta vs avulsa para acomodar
 *    multi-carga)
 *
 * D9 (iter #2): TEMPO + PERCURSO voltam por carga so no details page
 * (D5 permanece para o LoadCard listing).
 *
 * PacoteCarga nao expoe sheet_data_carregamento/sheet_data_descarga; usamos
 * apenas `data` + `horario` para buildOperationalDateLabel.
 */
const CargaParadaCard = ({ carga, isCurrent, index }: CargaParadaCardProps) => {
  const loadingDate = buildLoadingDateTime(null, carga.data, carga.horario);
  const loadingLabel = buildOperationalDateLabel(null, carga.data, carga.horario);
  const unloadingLabel = buildOperationalDateLabel(null);
  const estimatedTime = formatEstimatedTime(loadingDate, null);
  const veiculoLabel = carga.perfil || "A confirmar";
  const percursoLabel = formatRouteMetric(carga.distancia_km, "km");

  return (
    <Card
      className="admin-panel overflow-hidden"
      data-testid={isCurrent ? "carga-parada-current" : "carga-parada-other"}
    >
      <CardHeader>
        <CardDescription className="text-xs font-semibold uppercase tracking-[0.24em] text-primary/60">
          Informações da carga
        </CardDescription>
        <CardTitle className="text-2xl tracking-tight text-foreground">
          Coleta, entrega e percurso
        </CardTitle>
        {/* Sub-header com "Carga {N}: origem -> destino" + badge "Voce esta aqui". */}
        <div className="mt-2 flex items-start justify-between gap-3">
          <p className="min-w-0 text-sm text-muted-foreground">
            <strong className="font-semibold text-foreground">Carga {index}:</strong>{" "}
            <span className="break-words">{fixBrokenPortugueseText(carga.origem)}</span>
            {" "}{"→"}{" "}
            <span className="break-words">{fixBrokenPortugueseText(carga.destino)}</span>
          </p>
          {isCurrent ? (
            <Badge className="shrink-0 border-accent/40 bg-accent/15 px-3 py-1 text-accent">
              Você está aqui
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <DetailMetric icon={CalendarClock} label="Carregamento" value={loadingLabel} />
        <DetailMetric icon={Clock3} label="Descarga" value={unloadingLabel} />
        <DetailMetric icon={Package} label="Tempo estimado" value={estimatedTime} />
        <DetailMetric icon={Truck} label="Tipo de veículo" value={veiculoLabel} />
        <DetailMetric icon={MapPinned} label="Percurso recomendado" value={percursoLabel} />
      </CardContent>
    </Card>
  );
};

export default CargaParadaCard;
