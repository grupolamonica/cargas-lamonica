import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { normalizeRouteLocation } from "@/lib/routeCatalog";
import type { BrazilianCity } from "@/lib/brazilianCities";

interface CitySelectorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  id?: string;
  className?: string;
}

// Cap de itens renderizados — o dataset tem ~5.5k municípios; renderizar todos
// trava o DOM. Filtramos em memória e mostramos no máximo MAX_RESULTS.
const MAX_RESULTS = 60;

/**
 * Autocomplete de cidade alimentado pela lista oficial do IBGE
 * (frontend/src/lib/brazilianCities.ts). Emite a string canônica "Cidade/UF".
 * O dataset é carregado via import() dinâmico só na primeira abertura, para não
 * pesar no bundle inicial. Reaproveita o padrão de BankSelector (Popover + cmdk).
 */
export function CitySelector({
  value,
  onChange,
  placeholder = "Selecione a cidade",
  required,
  id,
  className,
}: CitySelectorProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [cities, setCities] = React.useState<BrazilianCity[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open || cities || loading) {
      return;
    }
    setLoading(true);
    import("@/lib/brazilianCities")
      .then((mod) => setCities(mod.BRAZILIAN_CITIES))
      .catch(() => setCities([]))
      .finally(() => setLoading(false));
  }, [open, cities, loading]);

  const filtered = React.useMemo(() => {
    if (!cities) {
      return [];
    }
    const term = normalizeRouteLocation(search);
    if (!term) {
      return cities.slice(0, MAX_RESULTS);
    }
    const matches: BrazilianCity[] = [];
    for (const city of cities) {
      if (normalizeRouteLocation(`${city.nome} ${city.uf}`).includes(term)) {
        matches.push(city);
        if (matches.length >= MAX_RESULTS) {
          break;
        }
      }
    }
    return matches;
  }, [cities, search]);

  const handleSelect = (city: BrazilianCity) => {
    onChange(`${city.nome}/${city.uf}`);
    setSearch("");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          id={id}
          aria-expanded={open}
          aria-required={required}
          className={`w-full justify-between font-normal ${value ? "" : "text-muted-foreground"} ${className ?? ""}`}
        >
          <span className="truncate">{value || placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        {/* shouldFilter=false: filtramos manualmente (cap + sem acento) para performar com ~5.5k itens */}
        <Command shouldFilter={false}>
          <CommandInput placeholder="Buscar cidade..." value={search} onValueChange={setSearch} />
          <CommandList>
            {loading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Carregando cidades...</div>
            ) : filtered.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">Nenhuma cidade encontrada.</div>
            ) : (
              filtered.map((city) => {
                const label = `${city.nome}/${city.uf}`;
                return (
                  <CommandItem key={`${city.nome}-${city.uf}`} value={label} onSelect={() => handleSelect(city)}>
                    <Check className={`mr-2 h-4 w-4 ${value === label ? "opacity-100" : "opacity-0"}`} />
                    <span>{city.nome}</span>
                    <span className="ml-1 text-muted-foreground">/{city.uf}</span>
                  </CommandItem>
                );
              })
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default CitySelector;
