/**
 * Classificacao do tipo de veiculo a partir do campo `tipo` retornado pelo
 * OCR do CRLV (Infosimples). Mapeia strings descritivas brasileiras para a
 * classificacao canonica `cavalo` | `carreta` usada pelo wizard + pre-check.
 *
 * Valores tipicos observados no CRLV:
 *  - "CAVALO MECANICO" / "TRATOR" / "TRUCK" / "CAMINHAO" / "CAMINHAO TRATOR"
 *    -> cavalo (tracao)
 *  - "SEMI-REBOQUE" / "SEMIREBOQUE" / "REBOQUE" / "CARRETA" / "BITREM"
 *    -> carreta (sem motor)
 *
 * Quando o `tipo` esta vazio ou nao bate em nenhum padrao, retorna `null`
 * (caller decide: nao bloquear ou exigir confirmacao manual).
 */

export type VehicleClassification = "cavalo" | "carreta";

const CARRETA_PATTERNS = [
  /SEMI[\s-]?REBOQUE/,
  /\bREBOQUE\b/,
  /\bCARRETA\b/,
  /\bBITREM\b/,
  /\bRODOTREM\b/,
];

const CAVALO_PATTERNS = [
  /\bCAVALO\b/,
  /\bTRATOR\b/,
  /\bTRUCK\b/,
  /\bCAMINHAO\b/,
  /\bCAMINHÃO\b/,
];

/**
 * Classifica uma string descritiva de tipo de veiculo. Case-insensitive,
 * tolera acentos e separadores variados.
 *
 * IMPORTANTE: a ordem das checagens importa. Como "carreta" e mais
 * especifico (e pode aparecer junto com "cavalo" em textos hibridos), checamos
 * carreta primeiro.
 */
export function classifyVehicleType(
  tipoRaw: string | null | undefined,
): VehicleClassification | null {
  if (!tipoRaw) return null;
  const tipo = tipoRaw.trim().toUpperCase();
  if (!tipo) return null;

  for (const pattern of CARRETA_PATTERNS) {
    if (pattern.test(tipo)) return "carreta";
  }
  for (const pattern of CAVALO_PATTERNS) {
    if (pattern.test(tipo)) return "cavalo";
  }
  return null;
}
