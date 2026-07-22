import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getAssignableRouteLabel, type AssignableRouteOption } from "@/lib/assignableRoutes";
import { formatVehicleProfileLabel } from "@/lib/vehicleProfiles";
import { normalizeRouteLocation } from "@/lib/routeCatalog";

interface RouteSelectorProps {
  routes: AssignableRouteOption[];
  /** route_key selecionado ("" = sem rota). */
  value: string;
  onChange: (routeKey: string) => void;
  id?: string;
  className?: string;
  placeholder?: string;
}

// Rótulo exibido = trecho da rota + perfil + eixos (mesmo texto da antiga <option>).
function routeDisplayLabel(route: AssignableRouteOption) {
  const base = getAssignableRouteLabel(route);
  const perfil = route.perfil_padrao ? ` — ${formatVehicleProfileLabel(route.perfil_padrao)}` : "";
  const eixos = route.eixos ? ` ${route.eixos} eixos` : "";
  return `${base}${perfil}${eixos}`;
}

const NO_ROUTE_VALUE = "__sem_rota__";

/**
 * DC-302 — seletor da "Rota padrão" da carga: combobox pesquisável (Popover + cmdk)
 * com as rotas ordenadas por ordem alfabética do rótulo. Substitui o <select> nativo,
 * que não permitia buscar e vinha na ordem crua do catálogo. Espelha o padrão do
 * CitySelector (filtro manual, sem acento, shouldFilter=false).
 */
export function RouteSelector({
  routes,
  value,
  onChange,
  id,
  className,
  placeholder = "Selecionar rota do catálogo",
}: RouteSelectorProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");

  const options = React.useMemo(
    () =>
      routes
        .map((route) => ({ route, label: routeDisplayLabel(route) }))
        .sort((a, b) => a.label.localeCompare(b.label, "pt-BR", { sensitivity: "base", numeric: true })),
    [routes],
  );

  const filtered = React.useMemo(() => {
    const term = normalizeRouteLocation(search);
    if (!term) return options;
    return options.filter((option) => normalizeRouteLocation(option.label).includes(term));
  }, [options, search]);

  const selectedLabel = React.useMemo(
    () => options.find((option) => option.route.route_key === value)?.label ?? "",
    [options, value],
  );

  const handleSelect = (routeKey: string) => {
    onChange(routeKey);
    setSearch("");
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Ao fechar (Escape/clique fora) limpa a busca, senão reabre "presa" num filtro.
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          id={id}
          aria-expanded={open}
          className={`w-full justify-between font-normal ${selectedLabel ? "" : "text-muted-foreground"} ${className ?? ""}`}
        >
          <span className="truncate">{selectedLabel || placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        {/* shouldFilter=false: filtramos manualmente (sem acento) igual ao CitySelector. */}
        <Command shouldFilter={false}>
          <CommandInput placeholder="Buscar rota..." value={search} onValueChange={setSearch} />
          <CommandList>
            {/* "Sem rota" só aparece sem busca ativa: evita virar a única opção
                auto-selecionável numa busca sem resultado (Enter limparia a rota). */}
            {!search && (
              <CommandItem value={NO_ROUTE_VALUE} onSelect={() => handleSelect("")}>
                <Check className={`mr-2 h-4 w-4 ${value ? "opacity-0" : "opacity-100"}`} />
                <span className="text-muted-foreground">Sem rota — informar origem/destino</span>
              </CommandItem>
            )}
            {filtered.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Nenhuma rota encontrada.</div>
            ) : (
              filtered.map(({ route, label }) => (
                <CommandItem key={route.id} value={route.route_key} onSelect={() => handleSelect(route.route_key)}>
                  <Check className={`mr-2 h-4 w-4 shrink-0 ${value === route.route_key ? "opacity-100" : "opacity-0"}`} />
                  <span className="truncate">{label}</span>
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default RouteSelector;
