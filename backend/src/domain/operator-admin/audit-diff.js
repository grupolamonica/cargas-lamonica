/**
 * DC-184 — registrar valor ANTERIOR e NOVO em cada alteração.
 *
 * Gera o "change set" comparando o estado antes/depois de uma edição, para
 * gravar em {metadata.changes} do log de auditoria. A tela de Auditoria
 * renderiza esse array como "antes → depois" por campo.
 *
 * Convenção de metadata:
 *   metadata.changes = [{ field, label, before, after }, ...]
 *   (somente campos que de fato mudaram; array ausente/vazio = nada mudou)
 */

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/** null / undefined / "" (após trim) → "" (vazio); demais tipos → string. */
function toComparableString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value.trim() : String(value);
}

/**
 * Igualdade "de negócio":
 *  - null / undefined / "" são equivalentes (vazio);
 *  - números iguais que diferem só na formatação decimal ("1000" vs "1000.00")
 *    contam como iguais — MAS só quando há ponto decimal em algum lado, para
 *    NÃO mascarar mudança em identificador puramente inteiro (ex.: LH "007" → "7").
 */
function valuesEqual(a, b) {
  const sa = toComparableString(a);
  const sb = toComparableString(b);
  if (sa === sb) return true;
  if (sa === "" || sb === "") return false;
  if (NUMERIC_RE.test(sa) && NUMERIC_RE.test(sb) && (sa.includes(".") || sb.includes("."))) {
    return Number(sa) === Number(sb);
  }
  return false;
}

/** Valor "limpo" para exibição: mantém tipos JSON-serializáveis; "" e undefined → null. */
function displayValue(value) {
  if (value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * @param {Record<string, unknown>} before  estado anterior (por campo lógico)
 * @param {Record<string, unknown>} after   estado novo (por campo lógico)
 * @param {Array<{ key: string, label: string }>} fields campos a comparar (ordem preservada)
 * @returns {Array<{ field: string, label: string, before: unknown, after: unknown }>}
 */
export function buildAuditChanges(before, after, fields) {
  if (!Array.isArray(fields)) return [];
  const prev = before && typeof before === "object" ? before : {};
  const next = after && typeof after === "object" ? after : {};

  const changes = [];
  for (const { key, label } of fields) {
    if (valuesEqual(prev[key], next[key])) continue;
    changes.push({
      field: key,
      label: label || key,
      before: displayValue(prev[key]),
      after: displayValue(next[key]),
    });
  }
  return changes;
}
