// Componentes de filtro reutilizáveis (Rotas, Links, Fila) — espelham a barra de
// filtros do Monitor de Produção: multi-seleção de rota com busca + faixas de
// data de carregamento/descarga. Lógica pura em `@/lib/listFilters`.
import { useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  dateFilterWithMidnight,
  normalizeFilterText,
  type CargoDateFilterState,
  type RouteFacetOption,
} from "@/lib/listFilters";

/**
 * Filtro multi-seleção (dropdown com checkboxes). Vazio = "todos". Semântica OR
 * entre os selecionados. Idêntico ao MultiSelectFilter do Monitor.
 */
export function FacetMultiSelect({
  label,
  options,
  selected,
  onChange,
  widthClass,
  searchable = false,
}: {
  label: string;
  options: RouteFacetOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  widthClass?: string;
  /** Mostra um campo de busca no topo (útil quando há muitas opções, ex.: rotas). */
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const count = selected.length;
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  // Ao fechar, limpa a busca — a próxima abertura começa com a lista completa.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const normalizedQuery = searchable ? normalizeFilterText(query.trim()) : "";
  const visibleOptions = normalizedQuery
    ? options.filter((o) => normalizeFilterText(o.label).includes(normalizedQuery))
    : options;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          className={cn(
            "inline-flex h-12 items-center justify-between gap-1.5 rounded-2xl border bg-white/92 px-4 text-sm outline-none transition-colors focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40",
            count > 0 ? "border-primary/40 text-foreground" : "border-border/80 text-muted-foreground",
            widthClass,
          )}
        >
          <span className="truncate">
            {label}
            {count > 0 && (
              <span className="ml-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[0.68rem] font-bold text-primary">{count}</span>
            )}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[22rem] max-w-[92vw] p-1.5">
        {searchable && (
          <div className="relative mb-1.5">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Buscar ${label.toLowerCase()}…`}
              className="w-full rounded-md border border-border/70 bg-background py-1.5 pl-7 pr-2 text-sm outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/10"
            />
          </div>
        )}
        <div className="max-h-64 overflow-y-auto">
          {options.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Nenhuma opção</p>
          ) : visibleOptions.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Nenhum resultado para “{query.trim()}”.</p>
          ) : (
            visibleOptions.map((o) => {
              const active = selected.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(o.value)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                      active ? "border-primary bg-primary text-primary-foreground" : "border-input",
                    )}
                  >
                    {active && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-normal break-words leading-snug" title={o.label}>
                    {o.label}
                  </span>
                </button>
              );
            })
          )}
        </div>
        {count > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="mt-1 flex w-full items-center gap-1 border-t border-border/40 px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-3 w-3" /> Limpar
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

type DateField = keyof CargoDateFilterState;

const DATE_INPUT_CLASS =
  "rounded-2xl border border-border/80 bg-white/92 px-3 text-sm outline-none focus:border-primary/30 focus:ring-4 focus:ring-primary/10 dark:bg-muted/40";

/**
 * Duas faixas de data independentes: carregamento e descarga. Cada faixa tem
 * "de" e "até" (datetime-local). Espelha o Monitor (horário padrão 00:00 ao
 * escolher a data). Altura h-12 p/ alinhar com os demais controles das telas.
 */
export function CargoDateRangeFilters({
  value,
  onChange,
  className,
}: {
  value: CargoDateFilterState;
  onChange: (field: DateField, next: string) => void;
  className?: string;
}) {
  const handle = (field: DateField) => (event: React.ChangeEvent<HTMLInputElement>) =>
    onChange(field, dateFilterWithMidnight(value[field], event.target.value));

  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <div className="flex items-center gap-1">
        <span className="text-[0.6rem] font-semibold uppercase text-muted-foreground/70">Carreg.</span>
        <input
          type="datetime-local"
          value={value.carFrom}
          onChange={handle("carFrom")}
          className={cn("h-12", DATE_INPUT_CLASS)}
          title="Carregamento a partir de (horário padrão 00:00 — edite se quiser)"
          aria-label="Carregamento a partir de"
        />
        <input
          type="datetime-local"
          value={value.carTo}
          onChange={handle("carTo")}
          min={value.carFrom || undefined}
          className={cn("h-12", DATE_INPUT_CLASS)}
          title="Carregamento até (horário padrão 00:00 — edite se quiser)"
          aria-label="Carregamento até"
        />
      </div>
      <div className="flex items-center gap-1">
        <span className="text-[0.6rem] font-semibold uppercase text-muted-foreground/70">Descarga</span>
        <input
          type="datetime-local"
          value={value.desFrom}
          onChange={handle("desFrom")}
          className={cn("h-12", DATE_INPUT_CLASS)}
          title="Descarga a partir de (00:00 padrão)"
          aria-label="Descarga a partir de"
        />
        <input
          type="datetime-local"
          value={value.desTo}
          onChange={handle("desTo")}
          min={value.desFrom || undefined}
          className={cn("h-12", DATE_INPUT_CLASS)}
          title="Descarga até (00:00 padrão)"
          aria-label="Descarga até"
        />
      </div>
    </div>
  );
}
