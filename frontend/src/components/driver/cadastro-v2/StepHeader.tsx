import { useEffect, useRef } from "react";

import { Progress } from "@/components/ui/progress";

export interface StepHeaderProps {
  eyebrow: string;
  title: string;
  description?: string;
  currentStep: number;
  totalSteps: number;
}

/**
 * Cabeçalho padrão das telas do wizard v2.
 *
 * - Eyebrow micro-label (uppercase, primary tint)
 * - Título acessível (foco programático ao montar/atualizar)
 * - Descrição opcional
 * - Barra de progresso + texto "Etapa N de Total"
 */
export function StepHeader({
  eyebrow,
  title,
  description,
  currentStep,
  totalSteps,
}: StepHeaderProps) {
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, [title, currentStep]);

  const safeTotal = totalSteps > 0 ? totalSteps : 1;
  const safeCurrent = Math.min(Math.max(currentStep, 1), safeTotal);
  const percent = Math.round((safeCurrent / safeTotal) * 100);

  return (
    <header className="space-y-2 lg:space-y-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary lg:text-sm">
        {eyebrow}
      </p>
      <h2
        ref={titleRef}
        tabIndex={-1}
        className="text-xl font-semibold leading-7 text-foreground outline-none sm:text-2xl sm:leading-8 lg:text-3xl lg:leading-9"
      >
        {title}
      </h2>
      {description ? (
        <p className="text-sm leading-relaxed text-foreground/80 sm:text-base lg:text-lg">
          {description}
        </p>
      ) : null}
      <div className="pt-1">
        <Progress
          value={percent}
          aria-label={`Progresso do cadastro: etapa ${safeCurrent} de ${safeTotal}`}
        />
      </div>
    </header>
  );
}
