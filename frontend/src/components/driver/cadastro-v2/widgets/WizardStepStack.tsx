import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { WizardStepStatus } from "./WizardStepCard";

export interface WizardStepStackStep {
  /** Identificador estável da sub-etapa (ex.: "a1", "crlv"). */
  id: string;
  /** Marca se a sub-etapa foi concluída (lifted state — pai controla). */
  isCompleted: boolean;
  /**
   * Render-prop: o pai monta o <WizardStepCard> e injeta status + onActivate
   * derivados pelo Stack. Mantemos render-prop (vs. children) porque o pai
   * precisa receber esses valores para passá-los ao WizardStepCard.
   */
  render: (props: { status: WizardStepStatus; onActivate: () => void }) => ReactNode;
}

export interface WizardStepStackProps {
  steps: WizardStepStackStep[];
  /**
   * Quando true (default), scrolla suavemente para a próxima sub-etapa quando
   * auto-avança após uma conclusão. Pode ser desabilitado para testes ou
   * quando o caller já controla scroll.
   */
  autoScrollOnAdvance?: boolean;
  className?: string;
}

/**
 * Stepper-accordion controller. Mantém um único `activeId` por vez. Regras:
 *
 *  1. Inicialização: primeiro step não-completed; se todos completados, o último.
 *  2. Auto-avanço: quando o step ativo passa de `isCompleted=false` para `true`,
 *     procura o próximo step com `isCompleted=false` e ativa.
 *  3. Re-ativação manual: clicar num completed re-abre aquele step (todos os
 *     outros completed permanecem `completed`, e o ex-active se torna
 *     `completed` ou `pending` conforme seu `isCompleted` atual).
 *  4. Pending: steps que vêm depois do `activeId` e não estão completos.
 *  5. Hidratação: se vier com vários `isCompleted=true` do draft, o stack
 *     pula direto para o primeiro pending — preservando o trabalho já feito.
 */
function WizardStepStackImpl({
  steps,
  autoScrollOnAdvance = true,
  className,
}: WizardStepStackProps) {
  const stepIds = useMemo(() => steps.map((s) => s.id), [steps]);
  const completedMap = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const s of steps) map[s.id] = s.isCompleted;
    return map;
  }, [steps]);

  const firstPendingId = useMemo(() => {
    for (const s of steps) {
      if (!s.isCompleted) return s.id;
    }
    return steps.length > 0 ? steps[steps.length - 1].id : null;
  }, [steps]);

  const [activeId, setActiveId] = useState<string | null>(firstPendingId);

  // Re-sincroniza activeId quando a lista de steps muda (ex.: hidratação tardia)
  // mas só se o activeId atual deixou de existir.
  useEffect(() => {
    if (!activeId || !stepIds.includes(activeId)) {
      setActiveId(firstPendingId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIds.join("|")]);

  // Detector de transição false→true do step ativo: refletido via ref para
  // não disparar reruns quando outros steps mudam.
  const prevCompletedRef = useRef<Record<string, boolean>>(completedMap);
  const stackRef = useRef<HTMLDivElement>(null);

  // 2026-05-26 — Debounce do auto-advance pra evitar pular o step enquanto
  // o motorista ainda está digitando. Cenário real: telefone "7129498367"
  // (10 dígitos, DDD 71) já é válido em isValidBrazilianPhone (landline),
  // mas o motorista pode estar a meio caminho de digitar 11 dígitos do
  // celular (com o 9 do meio). Sem debounce, transição false→true no 10º
  // dígito fazia pular antes do 11º.
  //
  // Estratégia: timer 1500ms ao transicionar para completed. QUALQUER input
  // event no DOM reseta o timer. Se pausar 1500ms sem digitar, avança.
  // Refs usados imperativamente porque completedMap muda ref a cada parent
  // render — não dá pra montar listeners dentro do effect (cleanup runa).
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const advanceFnRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const prev = prevCompletedRef.current;
    prevCompletedRef.current = completedMap;
    if (!activeId) return;
    const wasCompleted = Boolean(prev[activeId]);
    const isNowCompleted = Boolean(completedMap[activeId]);

    if (!isNowCompleted) {
      if (advanceTimerRef.current) {
        clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
      advanceFnRef.current = null;
      return;
    }

    if (!wasCompleted && isNowCompleted) {
      const currentIdx = stepIds.indexOf(activeId);
      let nextPending: string | null = null;
      for (let i = currentIdx + 1; i < stepIds.length; i++) {
        if (!completedMap[stepIds[i]]) {
          nextPending = stepIds[i];
          break;
        }
      }
      if (!nextPending) return;
      const fireAdvance = () => {
        advanceTimerRef.current = null;
        advanceFnRef.current = null;
        setActiveId(nextPending);
        if (autoScrollOnAdvance && typeof window !== "undefined") {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const node = stackRef.current?.querySelector<HTMLElement>(
                `[data-stack-step-id="${nextPending}"]`,
              );
              if (node) {
                node.scrollIntoView({ behavior: "smooth", block: "start" });
                const firstFocusable = node.querySelector<HTMLElement>(
                  "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])",
                );
                firstFocusable?.focus({ preventScroll: true });
              }
            });
          });
        }
      };
      advanceFnRef.current = fireAdvance;
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = setTimeout(fireAdvance, 1500);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedMap, activeId]);

  // Listener global de input — vive enquanto o stack existe. Reseta o timer
  // qualquer vez que o motorista digita, mas só se houver advance pendente.
  useEffect(() => {
    const onInput = () => {
      if (advanceTimerRef.current && advanceFnRef.current) {
        clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = setTimeout(advanceFnRef.current, 1500);
      }
    };
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onInput, true);
    return () => {
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("change", onInput, true);
      if (advanceTimerRef.current) {
        clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
    };
  }, []);

  const activateStep = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  return (
    <div ref={stackRef} className={className ?? "space-y-4"}>
      {steps.map((step) => {
        let status: WizardStepStatus;
        if (step.id === activeId) {
          status = "active";
        } else if (step.isCompleted) {
          status = "completed";
        } else {
          status = "pending";
        }
        return (
          <div key={step.id} data-stack-step-id={step.id}>
            {step.render({
              status,
              onActivate: () => activateStep(step.id),
            })}
          </div>
        );
      })}
    </div>
  );
}

export const WizardStepStack = memo(WizardStepStackImpl);
