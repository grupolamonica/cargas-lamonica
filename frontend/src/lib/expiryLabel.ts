/**
 * Helper para renderizar de forma defensiva o `daysUntilExpiry` que vem do
 * backend (`pre-check.js` e variantes). O backend pode devolver:
 *  - `null` quando não há `validUntil` parseável;
 *  - número negativo (CRLV vencido há N dias);
 *  - zero (vence hoje);
 *  - número positivo (em dia ou vencendo).
 *
 * O frontend não pode renderizar valores crus — o usuário relatou
 * "vence em -2891 dias" no widget do uploader (Bug A — Sintoma 1).
 *
 * Pure function: sem deps externas, sem efeitos.
 */
export type ExpiryTone = "expired" | "expiring" | "valid";

export interface ExpiryLabel {
  tone: ExpiryTone;
  /** Texto longo, em frase. Ex.: "Documento vencido há 3 dia(s)". */
  text: string;
  /** Texto curto/parentético para sufixos inline. Ex.: "(vencido)". */
  short: string;
}

const EXPIRING_THRESHOLD_DAYS = 30;
const STALE_THRESHOLD_DAYS = 30; // vencido há mais de 30 dias → mostra mês/ano em vez de N dias

const MESES_PT_BR = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];

function pluralize(value: number, singular: string, plural?: string): string {
  return value === 1 ? singular : plural ?? `${singular}s`;
}

/**
 * Formata uma data ISO ("YYYY-MM-DD" ou ISO datetime) como "mes/ano" pt-BR.
 * Retorna null se a data não for parseável.
 */
function formatMonthYearPtBr(validUntil: string | null | undefined): string | null {
  if (!validUntil) return null;
  const rawValue = String(validUntil).trim();
  const dateOnlyMatch = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let year: number;
  let monthIdx: number;
  if (dateOnlyMatch) {
    year = Number(dateOnlyMatch[1]);
    monthIdx = Number(dateOnlyMatch[2]) - 1;
  } else {
    const parsed = new Date(rawValue);
    if (Number.isNaN(parsed.getTime())) return null;
    year = parsed.getUTCFullYear();
    monthIdx = parsed.getUTCMonth();
  }
  if (monthIdx < 0 || monthIdx > 11) return null;
  return `${MESES_PT_BR[monthIdx]}/${year}`;
}

/**
 * Formata `daysUntilExpiry` em label seguro com tom semântico.
 *
 * Linguagem motorista (alinhada com backend `pre-check.js`).
 *
 * Edge cases tratados:
 * - `null` / `undefined` / `NaN` / `Infinity` → "Documento sem data de validade" (tone: expiring)
 * - `< -30` com validUntil válido → "Documento venceu em mes/ano" (tone: expired)
 * - `< -30` sem validUntil → "Documento está vencido faz tempo" (tone: expired)
 * - `-30..-1` → "Documento venceu há N dia(s)" (tone: expired)
 * - `=== 0` → "Documento vence hoje" (tone: expired)
 * - `1..30` → "Documento vence em N dia(s)" (tone: expiring)
 * - `> 30` → "Documento vigente (N dia(s))" (tone: valid)
 *
 * @param daysUntilExpiry  Numero de dias relativo a hoje (backend pre-check.js).
 * @param validUntil       Data ISO opcional para formatar mes/ano quando muito vencido.
 */
export function formatExpiryLabel(
  daysUntilExpiry: number | null | undefined,
  validUntil?: string | null,
): ExpiryLabel {
  if (
    daysUntilExpiry == null ||
    Number.isNaN(daysUntilExpiry) ||
    !Number.isFinite(daysUntilExpiry)
  ) {
    return {
      tone: "expiring",
      text: "Documento sem data de validade",
      short: "(sem validade)",
    };
  }

  // Normaliza para inteiro (Math.trunc evita arredondamento de fracionários
  // vindos de calculateDaysUntilExpiry caso o backend mude no futuro).
  const days = Math.trunc(daysUntilExpiry);

  if (days < -STALE_THRESHOLD_DAYS) {
    const monthYear = formatMonthYearPtBr(validUntil);
    return {
      tone: "expired",
      text: monthYear
        ? `Documento venceu em ${monthYear}`
        : "Documento está vencido faz tempo",
      short: monthYear ? `(${monthYear})` : "(vencido)",
    };
  }

  if (days <= -1) {
    const abs = Math.abs(days);
    return {
      tone: "expired",
      text: `Documento venceu há ${abs} ${pluralize(abs, "dia", "dias")}`,
      short: "(vencido)",
    };
  }

  if (days === 0) {
    return {
      tone: "expired",
      text: "Documento vence hoje",
      short: "(vence hoje)",
    };
  }

  if (days <= EXPIRING_THRESHOLD_DAYS) {
    return {
      tone: "expiring",
      text: `Documento vence em ${days} ${pluralize(days, "dia", "dias")}`,
      short: `(vence em ${days} ${pluralize(days, "dia", "dias")})`,
    };
  }

  return {
    tone: "valid",
    text: `Documento vigente (${days} ${pluralize(days, "dia", "dias")})`,
    short: `(${days} ${pluralize(days, "dia", "dias")})`,
  };
}
