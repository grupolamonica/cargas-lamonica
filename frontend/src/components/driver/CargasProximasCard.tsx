import { Link } from "react-router-dom";
import { MapPin, LocateOff, Loader2, WifiOff } from "lucide-react";

import ClientLogo from "@/components/ClientLogo";
import { formatVehicleProfileLabel } from "@/lib/vehicleProfiles";

export interface CargaProximaItem {
  id: string;
  dateLabel: string;
  originCity: string;
  destCity: string;
  perfil: string;
  distLabel: string;
  logoUrl?: string;
  logoAlt?: string;
}

interface CargasProximasCardProps {
  items: CargaProximaItem[];
  buildHref: (id: string) => string;
  title?: string;
  loading?: boolean;
  denied?: boolean;
  unavailable?: boolean;
}

export default function CargasProximasCard({
  items,
  buildHref,
  title = "Cargas próximas",
  loading = false,
  denied = false,
  unavailable = false,
}: CargasProximasCardProps) {
  const renderBody = () => {
    if (loading) {
      return (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center">
          <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
          <p className="text-sm text-gray-500">Buscando cargas próximas…</p>
        </div>
      );
    }

    if (denied) {
      return (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center">
          <LocateOff className="h-5 w-5 text-gray-400" />
          <p className="text-sm font-medium text-gray-600">Localização bloqueada</p>
          <p className="text-xs leading-relaxed text-gray-400">
            Permita o acesso à localização nas configurações do navegador para ver cargas próximas a você.
          </p>
        </div>
      );
    }

    if (unavailable) {
      return (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center">
          <WifiOff className="h-5 w-5 text-gray-400" />
          <p className="text-sm font-medium text-gray-600">Localização indisponível</p>
          <p className="text-xs leading-relaxed text-gray-400">
            Não foi possível obter sua localização agora. Verifique o GPS e recarregue a página.
          </p>
        </div>
      );
    }

    if (items.length === 0) {
      return (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center">
          <MapPin className="h-5 w-5 text-gray-400" />
          <p className="text-sm font-medium text-gray-600">Nenhuma carga na sua região</p>
          <p className="text-xs leading-relaxed text-gray-400">
            Não há cargas com origem próxima a você agora. Consulte a lista completa abaixo.
          </p>
        </div>
      );
    }

    return items.map((item) => (
      <Link
        key={`preview-${item.id}`}
        to={buildHref(item.id)}
        className="relative block rounded-xl bg-gray-50 p-4 shadow-md transition-all duration-300 hover:-translate-y-1 hover:shadow-xl"
      >
        {item.logoUrl ? (
          <ClientLogo
            name={item.logoAlt ?? ""}
            logoUrl={item.logoUrl}
            noBg
            className="absolute right-2 top-3 h-6 w-[44px] rounded-none border-0 shadow-none bg-transparent"
            imageClassName="p-0"
          />
        ) : null}
        <p className="text-sm text-gray-500">{item.dateLabel}</p>
        <p className="mt-0.5 truncate font-medium text-gray-800">
          {item.originCity} → {item.destCity}
        </p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {item.perfil ? (
              <span className="shrink-0 rounded bg-gray-200 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-gray-700">
                {formatVehicleProfileLabel(item.perfil)}
              </span>
            ) : null}
            {item.distLabel ? (
              <span className="truncate rounded bg-gray-200 px-2 py-1 text-xs text-gray-700">
                {item.distLabel}
              </span>
            ) : null}
          </div>
          <span className="shrink-0 text-sm font-semibold text-[hsl(224,94%,37%)]">
            Ver detalhes
          </span>
        </div>
      </Link>
    ));
  };

  return (
    <div className="space-y-3 rounded-2xl bg-white p-4 shadow-xl">
      <h3 className="font-semibold text-gray-700">{title}</h3>
      {renderBody()}
    </div>
  );
}
