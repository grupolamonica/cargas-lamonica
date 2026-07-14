import * as React from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectFilterProps {
  /** Rótulo do filtro (ex.: "Rotas", "Status"). */
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Placeholder da busca interna. */
  searchPlaceholder?: string;
  emptyText?: string;
  className?: string;
}

/**
 * Filtro multi-seleção genérico (Popover + cmdk + checkbox), no padrão dos
 * selects da tela de Cargas. Marca a contagem selecionada e mantém o popover
 * aberto ao alternar itens. Reutilizável por qualquer tela de operador.
 */
export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  searchPlaceholder = "Buscar...",
  emptyText = "Nenhuma opção.",
  className,
}: MultiSelectFilterProps) {
  const [open, setOpen] = React.useState(false);
  const selectedSet = React.useMemo(() => new Set(selected), [selected]);
  const count = selected.length;

  const toggle = (value: string) => {
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange([...next]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          className={cn(
            "flex min-w-[150px] items-center justify-between gap-2 rounded-2xl border bg-white/92 px-4 py-3 text-sm text-foreground outline-none transition-all duration-200 focus:border-primary/30 focus:ring-4 focus:ring-primary/10",
            count > 0 ? "border-primary/40" : "border-border/80",
            className,
          )}
        >
          <span className="flex items-center gap-2 truncate">
            <span className={cn("truncate", count === 0 && "text-muted-foreground")}>{label}</span>
            {count > 0 && (
              <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground">
                {count}
              </span>
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(340px,92vw)] p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {count > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-xs font-semibold text-muted-foreground transition hover:bg-muted/60"
              >
                <X className="h-3.5 w-3.5" /> Limpar seleção ({count})
              </button>
            )}
            <CommandGroup>
              {options.map((opt) => {
                const isSel = selectedSet.has(opt.value);
                return (
                  <CommandItem key={opt.value} value={opt.label} onSelect={() => toggle(opt.value)}>
                    <span
                      className={cn(
                        "mr-2 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                        isSel ? "border-primary bg-primary text-primary-foreground" : "border-border",
                      )}
                    >
                      {isSel && <Check className="h-3 w-3" />}
                    </span>
                    <span className="truncate">{opt.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default MultiSelectFilter;
