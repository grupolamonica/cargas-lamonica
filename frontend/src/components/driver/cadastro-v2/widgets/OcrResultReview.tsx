import { useState } from "react";
import { CheckCircle2, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface OcrResultField {
  label: string;
  value: string;
}

export interface OcrResultReviewProps {
  fields: OcrResultField[];
  onCorrectManually?: () => void;
}

/**
 * Resumo dos campos lidos via OCR. Por default fica colapsado em uma linha
 * "Dados lidos — toque para ver" (touch-friendly, ~48px) para reduzir
 * densidade visual em motoristas com baixa literacia digital. Ao expandir,
 * mostra o grid 2 colunas com os cards (label uppercase + valor semibold).
 *
 * Botão "Corrigir manualmente" fica sempre visível (linha separada) para que
 * o motorista nao precise expandir para acessar o fallback.
 *
 * Padrão visual: admin-card-surface + eyebrow (uppercase 11px) + value
 * (sm semibold). Inspirado em DriverClaimPanel.tsx linhas 624-633.
 */
export function OcrResultReview({ fields, onCorrectManually }: OcrResultReviewProps) {
  const [expanded, setExpanded] = useState(false);

  if (fields.length === 0) {
    return null;
  }

  const fieldCount = fields.length;

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-label={
          expanded
            ? `Esconder os ${fieldCount} dados extraídos automaticamente`
            : `Ver os ${fieldCount} dados extraídos automaticamente`
        }
        className={cn(
          "inline-flex w-full min-h-[48px] items-center justify-between gap-2",
          "rounded-2xl border bg-emerald-50/60 px-4 py-2.5",
          "text-sm font-semibold text-foreground transition-colors",
          "hover:bg-emerald-50 focus-visible:outline-none focus-visible:ring-2",
          "focus-visible:ring-ring focus-visible:ring-offset-2",
        )}
      >
        <span className="flex items-center gap-2">
          <CheckCircle2
            className="h-5 w-5 shrink-0 text-emerald-700"
            aria-hidden="true"
          />
          <span>
            {expanded ? "Esconder dados lidos" : "Dados lidos — toque para ver"}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-200",
            expanded ? "rotate-180" : "rotate-0",
          )}
          aria-hidden="true"
        />
      </button>

      {expanded ? (
        <div className="grid grid-cols-2 gap-3">
          {fields.map((field) => (
            <div
              key={`${field.label}-${field.value}`}
              className="admin-card-surface rounded-2xl border p-3 shadow-[0_14px_26px_-22px_hsl(223_56%_12%/0.18)]"
            >
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {field.label}
              </p>
              <p className="mt-2 text-sm font-semibold text-foreground break-words">
                {field.value}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {onCorrectManually ? (
        <div>
          <Button variant="outline" size="sm" type="button" onClick={onCorrectManually}>
            Corrigir manualmente
          </Button>
        </div>
      ) : null}
    </div>
  );
}
