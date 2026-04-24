/**
 * Helper simples de confirmação para ações críticas.
 * Usa window.confirm nativo (1ª iteração pragmática). Pode evoluir para AlertDialog
 * do shadcn sem mudar a assinatura.
 */
export function confirmAction(message: string, detail?: string): boolean {
  const composed = detail ? `${message}\n\n${detail}` : message;
  return typeof window !== "undefined" && window.confirm(composed);
}
