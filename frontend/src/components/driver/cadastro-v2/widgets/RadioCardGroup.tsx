import { useRef, type ReactNode } from "react";

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

export interface RadioCardOption {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
}

export interface RadioCardGroupProps {
  value: string;
  onValueChange: (value: string) => void;
  options: RadioCardOption[];
  name: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * Wrapper do shadcn RadioGroup com os itens renderizados como card-tiles.
 * - Grid 1-col mobile / 2-col em sm+
 * - Cada item: card clickable (label envelopa o RadioGroupItem)
 * - Touch target minimo 44px (min-h-[68px] para acomodar texto + descricao)
 * - Estado selecionado: border-primary + bg-primary/5
 */
export function RadioCardGroup({
  value,
  onValueChange,
  options,
  name,
  ariaLabel,
  className,
}: RadioCardGroupProps) {
  return (
    <RadioGroup
      value={value}
      onValueChange={onValueChange}
      name={name}
      aria-label={ariaLabel}
      className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2", className)}
    >
      {options.map((option) => (
        <RadioCard
          key={option.value}
          option={option}
          selected={value === option.value}
          name={name}
          onSelect={onValueChange}
        />
      ))}
    </RadioGroup>
  );
}

interface RadioCardProps {
  option: RadioCardOption;
  selected: boolean;
  name: string;
  onSelect: (value: string) => void;
}

/**
 * Card individual do RadioCardGroup.
 *
 * A11y (A-01 P1 fix): o controle real é o RadioGroupItem (`<button role="radio">`).
 * O `<label htmlFor>` envolve APENAS o texto descritivo — ainda associado via
 * `htmlFor` para que screen readers anunciem o label junto com o role/state.
 * O wrapper `<div onClick>` delega o clique do card inteiro para o radio
 * (via `inputRef.current?.click()`), preservando o touch target grande sem
 * quebrar a11y de SR (NVDA/VoiceOver lê "Radio button, <label>, selected").
 */
function RadioCard({ option, selected, name, onSelect }: RadioCardProps) {
  const inputRef = useRef<HTMLButtonElement | null>(null);
  const itemId = `${name}-${option.value}`;
  const labelId = `${itemId}-label`;

  const handleCardClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // Se o clique chegou direto no botão do radio ou no label htmlFor, deixa
    // o comportamento nativo agir (evita disparar onValueChange duas vezes).
    if (target.closest('[role="radio"]') || target.closest("label")) return;
    // Delega via DOM: dispara o click no button, Radix trata foco + state.
    if (inputRef.current) {
      inputRef.current.click();
    } else {
      onSelect(option.value);
    }
  };

  return (
    <div
      onClick={handleCardClick}
      className={cn(
        "admin-card-surface relative flex min-h-[68px] cursor-pointer items-start gap-3 rounded-2xl border-2 p-3.5 transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "border-border hover:border-primary/40",
      )}
    >
      <RadioGroupItem
        ref={inputRef}
        id={itemId}
        value={option.value}
        aria-labelledby={labelId}
        className="mt-0.5 shrink-0"
      />
      <label htmlFor={itemId} id={labelId} className="min-w-0 flex-1 cursor-pointer">
        <span className="flex items-center gap-2">
          {option.icon ? (
            <span className="text-primary" aria-hidden="true">
              {option.icon}
            </span>
          ) : null}
          <span className="text-sm font-semibold leading-5 text-foreground">
            {option.label}
          </span>
        </span>
        {option.description ? (
          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
            {option.description}
          </span>
        ) : null}
      </label>
    </div>
  );
}
