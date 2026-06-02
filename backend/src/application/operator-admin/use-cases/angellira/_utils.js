/**
 * Helpers internos do pipeline Angellira.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Devolve `value` se for um UUID válido, senão `null`. Útil pra colunas como
 * `created_by` que aceitam NULL mas têm cast pra uuid — passar string vazia
 * dá erro de tipo.
 */
export function stripUuidIfInvalid(value) {
  if (!value) return null;
  return UUID_RE.test(String(value)) ? String(value) : null;
}
