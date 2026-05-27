/**
 * Helper simples de confirmação para ações críticas.
 * Usa window.confirm nativo (1ª iteração pragmática).
 *
 * TODO (UI-02): Migrar todos os call sites para shadcn `<AlertDialog>`
 *  - Bloqueia thread (window.confirm)
 *  - Sem dark mode
 *  - Sem focus-trap consistente
 *  - Mensagens aparecem em logs do browser / acessibility tools
 *
 * Call sites atuais (auditar ao migrar):
 *   - frontend/src/pages/Leads.tsx (handleCancel)
 *   - frontend/src/pages/ManageCargas.tsx
 *   - frontend/src/pages/ManageClientes.tsx
 *   - frontend/src/pages/ManageRoutes.tsx
 *   - frontend/src/pages/Veiculos.tsx
 *
 * Enquanto não migra, esta função MASCARA PII (CPF/RG/PIS/CNH) automaticamente
 * antes de exibir o diálogo nativo — defense in depth contra leak de dados
 * sensíveis em logs de acessibilidade, screenshots, capturas de tela, etc.
 */

const PII_PATTERNS: Array<{ regex: RegExp; mask: string }> = [
  // CPF formatado (000.000.000-00) ou cru (00000000000)
  { regex: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, mask: "***.***.***-**" },
  // RG (formato comum: 00.000.000-0)
  { regex: /\b\d{2}\.\d{3}\.\d{3}-?[\dxX]\b/g, mask: "**.***.***-*" },
  // CNH (11 dígitos)
  { regex: /\bcnh[:\s]*\d{11}\b/gi, mask: "CNH ***********" },
  // PIS/PASEP (11 dígitos formatados ou crus)
  { regex: /\b\d{3}\.\d{5}\.\d{2}-?\d\b/g, mask: "***.*****.**-*" },
  // Fallback genérico: sequência crua de 11 dígitos (CPF/PIS sem formatação).
  // Aplicado por último para não conflitar com casos formatados acima.
  { regex: /\b\d{11}\b/g, mask: "***********" },
];

export function maskPII(msg: string): string {
  let out = msg;
  for (const { regex, mask } of PII_PATTERNS) {
    out = out.replace(regex, mask);
  }
  return out;
}

export function confirmAction(message: string, detail?: string): boolean {
  const composed = detail ? `${message}\n\n${detail}` : message;
  const sanitized = maskPII(composed);
  return typeof window !== "undefined" && window.confirm(sanitized);
}
