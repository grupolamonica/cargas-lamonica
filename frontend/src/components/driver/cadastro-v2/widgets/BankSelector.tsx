import * as React from "react";
import { ChevronsUpDown, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BRAZILIAN_BANKS, type BrazilianBank } from "@/lib/brazilianBanks";

interface BankSelectorProps {
  value?: BrazilianBank | null;
  onChange: (bank: BrazilianBank) => void;
  required?: boolean;
  error?: string;
}

export function BankSelector({ value, onChange, required, error }: BankSelectorProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-required={required}
            aria-invalid={!!error}
            className="h-12 w-full justify-between"
          >
            {value ? `${value.compe} - ${value.nome}` : "Selecione o banco"}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command
            filter={(value, search) => {
              // value e a concatenacao "compe nome", search e o input do usuario.
              // Match contra codigo OU nome (case-insensitive).
              return value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
            }}
          >
            <CommandInput placeholder="Pesquisar por nome ou código..." />
            <CommandList>
              <CommandEmpty>
                <div className="py-4 text-center">
                  <p className="text-sm font-semibold text-foreground">Banco não encontrado</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Tente pesquisar pelo código (3 dígitos) ou nome completo.
                  </p>
                </div>
              </CommandEmpty>
              {BRAZILIAN_BANKS.map((bank) => (
                <CommandItem
                  key={bank.compe}
                  value={`${bank.compe} ${bank.nome}`}
                  onSelect={() => {
                    onChange(bank);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={`mr-2 h-4 w-4 ${
                      value?.compe === bank.compe ? "opacity-100" : "opacity-0"
                    }`}
                  />
                  <span className="font-mono mr-2 text-muted-foreground">{bank.compe}</span>
                  <span>{bank.nome}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {error && <p className="text-xs text-destructive mt-1">{error}</p>}
    </div>
  );
}
