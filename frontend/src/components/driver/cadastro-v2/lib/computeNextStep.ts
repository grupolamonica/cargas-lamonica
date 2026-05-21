/**
 * Smart-skip FSM helpers — decidem qual e o proximo step a renderizar com
 * base nas `pendencias[]` do pre-check, status ownerIsDriver e quantas
 * carretas o motorista declarou.
 *
 * Antes do refactor, os handlers `handleStep*Complete` em
 * DriverRegistrationWizard.tsx avancavam linear (step-a → step-b → step-c
 * → ...) sem consultar pendencias — mesmo quando o cavalo ja estava em dia,
 * o wizard renderizava step-b cobrando upload de CRLV. Centralizar essa
 * logica em uma funcao pura permite cobertura via unit tests e elimina
 * drift entre handlers.
 */

import type { CandidaturaPendency } from "@/api/candidaturaApi";
import type { StepDTrailerInput } from "../steps/StepDCarretas";

export type WizardStepKind =
  | "tela0"
  | "step-a"
  | "step-b"
  | "step-c"
  | "step-d"
  | "step-e"
  | "confirmation";

export interface NextStepArgs {
  currentStep: WizardStepKind;
  pendencias: CandidaturaPendency[];
  ownerIsDriver: boolean;
  trailersToCollect: StepDTrailerInput[];
  /**
   * Indice da carreta atualmente processada. A funcao internamente faz `+1`
   * para decidir se ha proxima carreta a processar.
   */
  currentTrailerIdx: number;
}

/**
 * Decide qual o proximo step a renderizar consultando pendencias[] do
 * pre-check. Skip transparente quando o step nao esta pendente.
 *
 * Regras:
 *  - tela0 → primeiro step pendente (A → B → D) ou confirmation se nada.
 *  - step-a → step-b se B pendente, senao step-d se D pendente, senao confirmation.
 *  - step-b → step-c se owner != driver, senao pula direto pra step-d/confirmation.
 *  - step-c → step-d se D pendente, senao confirmation.
 *  - step-d/e → proxima carreta a processar (currentTrailerIdx+1) ou confirmation.
 */
export function nextPendencyStep(args: NextStepArgs): WizardStepKind {
  const {
    currentStep,
    pendencias,
    ownerIsDriver,
    trailersToCollect,
    currentTrailerIdx,
  } = args;
  const hasA = pendencias.some((p) => p.step === "A");
  const hasB = pendencias.some((p) => p.step === "B");
  const hasD = trailersToCollect.length > 0;

  switch (currentStep) {
    case "tela0":
      if (hasA) return "step-a";
      if (hasB) return "step-b";
      if (hasD) return "step-d";
      return "confirmation";
    case "step-a":
      if (hasB) return "step-b";
      if (hasD) return "step-d";
      return "confirmation";
    case "step-b":
      if (ownerIsDriver) return hasD ? "step-d" : "confirmation";
      return "step-c";
    case "step-c":
      return hasD ? "step-d" : "confirmation";
    case "step-d":
    case "step-e": {
      const nextIdx = currentTrailerIdx + 1;
      return nextIdx < trailersToCollect.length ? "step-d" : "confirmation";
    }
    default:
      return "confirmation";
  }
}

/**
 * Quando `nextPendencyStep` pula um step (ex: step-a → step-d quando B esta
 * vigente), devolve uma mensagem amigavel pro motorista entender o atalho.
 * Retorna `null` quando a transicao foi sequencial natural (ex: step-c →
 * step-d) ou quando o skip ja tem feedback visual proprio (ex: step-b →
 * step-d via ownerIsDriver tem banner "Voce e o proprietario" no Step B).
 */
export function describeSkippedStep(
  from: WizardStepKind,
  to: WizardStepKind,
): string | null {
  if (from === "step-a" && to === "step-d") {
    return "Cavalo já está em dia — pulamos esse passo.";
  }
  if (from === "step-a" && to === "confirmation") {
    return "Cavalo e carretas estão em dia — só faltava você.";
  }
  if (from === "step-b" && to === "confirmation" && /* sem skip C necessario */ false) {
    return null;
  }
  if (from === "step-c" && to === "confirmation") {
    return "Carretas estão em dia — pulamos esse passo.";
  }
  return null;
}
