import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * ProgressiveStepHeader — toggle global "Ver todos os campos" para steps que
 * usam `ProgressiveSection` em várias áreas.
 *
 * Quando o motorista clica, o step pai inverte `showAll` e propaga para todas
 * as `ProgressiveSection` filhas via prop `forceExpanded`. Quando colapsa
 * (`showAll` vira false), o ProgressiveSection mantém o estado aberto (decisão
 * de UX: não fechar à força após o usuário ter visto/editado o conteúdo).
 * Para uma experiência "fechar tudo de novo", basta recarregar o step.
 *
 * Renderiza como linha discreta logo após o `StepHeader`. Touch-friendly (44px).
 */
export interface ProgressiveStepHeaderProps {
  showAll: boolean;
  onToggle: () => void;
  /** Total de seções progressive no step (informativo). */
  hiddenSections?: number;
  className?: string;
}

export function ProgressiveStepHeader({
  showAll,
  onToggle,
  hiddenSections,
  className,
}: ProgressiveStepHeaderProps) {
  // Não renderiza quando não há seções escondidas e o toggle está fechado —
  // evita ruido visual sem propósito.
  if (
    !showAll &&
    (typeof hiddenSections !== "number" || hiddenSections <= 0)
  ) {
    return null;
  }

  const label = showAll ? "Esconder" : "Ver";
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2",
        className,
      )}
    >
      <p className="text-sm text-foreground/80">Outros dados (opcional)</p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onToggle}
        className="min-h-[40px] gap-1.5 text-sm"
        aria-pressed={showAll}
      >
        {showAll ? (
          <EyeOff className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Eye className="h-4 w-4" aria-hidden="true" />
        )}
        {label}
      </Button>
    </div>
  );
}
