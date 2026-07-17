import { useDeferredValue, useMemo } from "react";
import { Navigation, PackageX } from "lucide-react";
import { Button } from "@/components/ui/button";
import LoadCard from "@/components/LoadCard";
import type {
  DriverClaimPanelMode,
  PreSubmitInterceptor,
} from "@/components/driver/DriverClaimPanel";
import type { PreCheckResponse } from "@/api/candidaturaApi";
import { formatCurrency, buildTotalPayment } from "@/lib/currency";
import { buildOperationalDateLabel, buildRouteEstimatedDurationLabel } from "@/lib/estimatedTime";
import { buildLoadingDateTime } from "@/lib/estimatedTime";
import { isToday, format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { type Cargo, splitLocation, toTitleCase, toDisplayCityName, normalizeDisplayCity } from "@/hooks/useDriverLoads";

const formatRouteMetric = (value: number) =>
  value.toLocaleString("pt-BR", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });

const formatRouteDistanceLabel = (distanceKm: number) => `${formatRouteMetric(distanceKm)} km`;

const buildDriverPaymentDetailsLabel = (valor: number | null, bonus: number | null) => {
  const hasValor = typeof valor === "number" && Number.isFinite(valor);
  const hasBonus = typeof bonus === "number" && Number.isFinite(bonus) && bonus > 0;
  if (hasValor && hasBonus) {
    return `${formatCurrency(valor)} da carga + ${formatCurrency(bonus)} de bônus por concluir a entrega seguindo as normas pedidas`;
  }
  if (hasBonus) {
    return `${formatCurrency(bonus)} de bônus por concluir a entrega seguindo as normas pedidas`;
  }
  return null;
};

const buildDateLabel = (cargo: Cargo) => {
  const loadingDate = buildLoadingDateTime(cargo.carregamentoLabel, cargo.data, cargo.horario);
  if (!loadingDate) return "Coleta a confirmar";
  const baseDate = isToday(loadingDate) ? "hoje" : format(loadingDate, "dd/MM", { locale: ptBR });
  return `Coleta ${baseDate} às ${format(loadingDate, "HH:mm")}`;
};

interface DriverLoadsListProps {
  cargas: Cargo[];
  loading: boolean;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  onInterestDialogOpenChange: (open: boolean) => void;
  /**
   * Wiring opcional cadastro v2 (Phase 8 — fix entry-point "Candidatar-se").
   * Encaminhado para cada LoadCard / DriverClaimPanel renderizado, espelhando
   * o comportamento de DriverCargoDetails.
   *
   * `buildDriverClaimPreSubmit` é uma factory: recebe o loadId do card e devolve
   * o interceptor já com o loadId capturado no closure. Isso permite que o consumer
   * (DriverPortal) saiba qual carga disparou o pre-check sem mudar a assinatura
   * do interceptor compartilhada com DriverCargoDetails.
   */
  driverClaimMode?: DriverClaimPanelMode;
  buildDriverClaimPreSubmit?: (loadId: string) => PreSubmitInterceptor;
  onDriverClaimCompleteRegistration?: (params: {
    preCheckResponse: PreCheckResponse;
    cpf: string;
    horsePlate: string;
    trailerPlates: string[];
    loadId: string;
  }) => void;
}

export function DriverLoadsList({
  cargas,
  loading,
  hasActiveFilters,
  onClearFilters,
  onInterestDialogOpenChange,
  driverClaimMode,
  buildDriverClaimPreSubmit,
  onDriverClaimCompleteRegistration,
}: DriverLoadsListProps) {
  const deferredCargas = useDeferredValue(cargas);

  const cargoCards = useMemo(() => {
    return deferredCargas.map((cargo, index) => {
      const [routeOrigin, routeDestination] = cargo.routeLabel
        ? cargo.routeLabel.split(" X ").map((s) => s.trim())
        : [null, null];
      const originRaw = routeOrigin ? null : splitLocation(cargo.origem);
      const destinationRaw = routeDestination ? null : splitLocation(cargo.destino);
      const origin = routeOrigin
        ? { city: toDisplayCityName(routeOrigin), uf: "" }
        : { city: toTitleCase(normalizeDisplayCity(originRaw!.city)), uf: originRaw!.uf };
      const destination = routeDestination
        ? { city: toDisplayCityName(routeDestination), uf: "" }
        : { city: toTitleCase(normalizeDisplayCity(destinationRaw!.city)), uf: destinationRaw!.uf };
      const loadingScheduleLabel = buildOperationalDateLabel(cargo.carregamentoLabel, cargo.data, cargo.horario);
      const descargaScheduleLabel = cargo.descargaLabel ? buildOperationalDateLabel(cargo.descargaLabel) : null;
      const totalPaymentValue = buildTotalPayment(cargo.valor, cargo.bonus);
      const paymentLabel = totalPaymentValue !== null ? formatCurrency(totalPaymentValue) : "A combinar";
      const paymentDetailsLabel = buildDriverPaymentDetailsLabel(cargo.valor, cargo.bonus);
      const routeDistanceLabel =
        typeof cargo.distancia_km === "number" && Number.isFinite(cargo.distancia_km)
          ? formatRouteDistanceLabel(cargo.distancia_km)
          : "A confirmar";
      const routeDurationLabel = buildRouteEstimatedDurationLabel({
        routeEstimatedHours: cargo.tempo_estimado_horas,
        fallbackDurationHours: cargo.duracao_horas,
      });
      return (
        <LoadCard
          key={cargo.id}
          id={cargo.id.slice(0, 8).toUpperCase()}
          loadId={cargo.id}
          dateTime={buildDateLabel(cargo)}
          clienteId={cargo.clienteId}
          clienteNome={cargo.clienteNome}
          clienteDescricao={cargo.clienteDescricao}
          clienteLogoUrlCard={cargo.clienteLogoUrlCard ?? null}
          carregamentoLabel={loadingScheduleLabel}
          descargaLabel={descargaScheduleLabel}
          origemCidade={origin.city}
          origemEstado={origin.uf}
          destinoCidade={destination.city}
          destinoEstado={destination.uf}
          tipoVeiculo={cargo.perfil}
          eixos={cargo.eixos}
          secondaryLabel="Percurso recomendado"
          SecondaryIcon={Navigation}
          secondaryValue={routeDistanceLabel}
          secondarySupportText={routeDurationLabel}
          pagamento={paymentLabel}
          paymentDetails={paymentDetailsLabel}
          valorCarga={cargo.valor}
          bonusValor={cargo.bonus}
          routeDistanceLabel={routeDistanceLabel}
          routeDurationLabel={routeDurationLabel}
          detailsHref={`/motorista/cargas/${cargo.id}`}
          index={index}
          onInterestDialogOpenChange={onInterestDialogOpenChange}
          pacoteMeta={cargo.pacote_meta ?? null}
          driverClaimMode={driverClaimMode}
          onDriverClaimPreSubmit={
            buildDriverClaimPreSubmit ? buildDriverClaimPreSubmit(cargo.id) : undefined
          }
          onDriverClaimCompleteRegistration={
            onDriverClaimCompleteRegistration
              ? (params) =>
                  onDriverClaimCompleteRegistration({ ...params, loadId: cargo.id })
              : undefined
          }
        />
      );
    });
  }, [
    deferredCargas,
    onInterestDialogOpenChange,
    driverClaimMode,
    buildDriverClaimPreSubmit,
    onDriverClaimCompleteRegistration,
  ]);

  if (loading) {
    return (
      <div className="flex min-h-[220px] flex-col items-center justify-center gap-4 rounded-3xl border border-border/50 bg-card px-6 py-12 text-center premium-shadow">
        <div className="h-10 w-10 rounded-full border-2 border-primary/20 border-t-primary animate-spin" />
        <p className="text-sm font-medium text-muted-foreground">Carregando cargas...</p>
      </div>
    );
  }

  if (deferredCargas.length === 0) {
    return (
      <div className="flex min-h-[220px] flex-col items-center justify-center gap-4 rounded-3xl border border-border/50 bg-card px-6 py-12 text-center premium-shadow animate-slide-up">
        <PackageX className="h-14 w-14 text-muted-foreground/35" />
        <div>
          <p className="text-lg font-bold text-foreground">Nenhuma carga encontrada</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Não encontrou uma carga? Toque em limpar filtros para ver tudo de novo ou confira se ela ainda está disponível.
          </p>
        </div>
        {hasActiveFilters ? (
          <Button type="button" variant="outline" onClick={onClearFilters} className="rounded-2xl px-5 font-semibold">
            Limpar filtros
          </Button>
        ) : (
          <p className="text-sm font-medium text-muted-foreground">
            As cargas são atualizadas periodicamente sem precisar carregar a lista inteira no navegador.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5 xl:grid xl:grid-cols-2 xl:gap-4 xl:space-y-0">
      {cargoCards}
    </div>
  );
}
