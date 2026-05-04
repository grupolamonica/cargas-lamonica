import { Link } from "react-router-dom";

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
  emptyLabel?: string;
}

export default function CargasProximasCard({
  items,
  buildHref,
  title = "Cargas próximas",
  emptyLabel = "Sem cargas no momento.",
}: CargasProximasCardProps) {
  return (
    <div className="space-y-4 rounded-2xl bg-white p-4 shadow-xl transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl">
      <h3 className="font-semibold text-gray-700">{title}</h3>
      {items.map((item) => (
        <Link
          key={`preview-${item.id}`}
          to={buildHref(item.id)}
          className="relative block rounded-xl bg-gray-50 p-4 shadow-md transition-all duration-300 hover:-translate-y-1 hover:shadow-xl"
        >
          {item.logoUrl ? (
            <img
              src={item.logoUrl}
              alt={item.logoAlt ?? ""}
              className="absolute -right-2 top-2 h-8 w-auto object-contain"
            />
          ) : null}
          <p className="text-sm text-gray-500">{item.dateLabel}</p>
          <p className="mt-0.5 truncate font-medium text-gray-800">
            {item.originCity} → {item.destCity}
          </p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {item.perfil ? (
                <span className="rounded bg-gray-200 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-gray-700">
                  {item.perfil}
                </span>
              ) : null}
              {item.distLabel ? (
                <span className="rounded bg-gray-200 px-2 py-1 text-xs text-gray-700">
                  {item.distLabel}
                </span>
              ) : null}
            </div>
            <span className="text-sm font-semibold text-[hsl(224,94%,37%)]">
              Ver detalhes
            </span>
          </div>
        </Link>
      ))}
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-500">
          {emptyLabel}
        </p>
      ) : null}
    </div>
  );
}
