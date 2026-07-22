/**
 * Domínio PURO do "Reverter últimas mudanças" do Monitor (DC-283).
 *
 * A partir de um evento de auditoria de alocação (security_audit_logs), extrai as
 * mudanças por CARGA num formato uniforme { lh|cargoId, before, after } — o mesmo
 * consumido pela LEITURA (montar o modal) e pelo REVERT (restaurar o "antes").
 *
 * Só eventos gravados DEPOIS do deploy carregam o estado "antes"
 * (metadata.beforeAlloc / metadata.beforeMoves). Eventos antigos → supported:false
 * (aparecem no modal como "não revertível — sem estado anterior").
 *
 * Não toca banco nem tem dependências externas (testável isolado).
 */

/** Eventos de alocação que o revert conhece. */
export const REVERTIBLE_EVENT_TYPES = [
  "operator.cargo.allocation_updated",
  "operator.cargo.allocation_reassigned",
  "operator.cargo.queue_descended",
  "operator.cargo.cancel_cascade",
];

const str = (v) => (v == null ? null : String(v));
const norm = (v) => (v ?? "").toString().trim();

/** Normaliza um trio motorista/cavalo/carreta (+status opcional) preservando null. */
function pickAlloc(obj, { withStatus = false } = {}) {
  if (!obj || typeof obj !== "object") return null;
  const out = {
    motorista: obj.motorista ?? null,
    cavalo: obj.cavalo ?? null,
    carreta: obj.carreta ?? null,
  };
  if (withStatus) out.status = obj.status ?? null;
  return out;
}

/**
 * Duas alocações são iguais para efeito de "mudou?"/"não mudou desde então?".
 * Compara pelos campos EFETIVOS (null e "" contam como "vazio") — assim uma carga
 * cujo override caiu pra planilha (alloc null) não é vista como diferente de "".
 * `fields` limita a comparação (cascata não mexe em status).
 */
export function sameAlloc(a, b, fields = ["motorista", "cavalo", "carreta"]) {
  if (!a || !b) return false;
  return fields.every((f) => norm(a[f]) === norm(b[f]));
}

/** Alguma diferença entre before e after (nos campos dados)? */
export function allocChanged(before, after, fields = ["motorista", "cavalo", "carreta"]) {
  return !sameAlloc(before, after, fields);
}

/**
 * Igualdade ESTRITA (null ≠ "") entre a alocação BRUTA atual e o "depois" gravado
 * — a guarda do revert ("ninguém mexeu desde então"). Estrito de propósito: o
 * forward gravou alloc_* == after exatamente (inclusive null=cai-pra-planilha vs
 * ""=vazio-explícito), então distinguir os dois flagra corretamente uma edição
 * posterior que trocou null↔"" (mesmo efetivo, estado diferente).
 */
export function allocEqualsStrict(current, after, fields = ["motorista", "cavalo", "carreta"]) {
  if (!current || !after) return false;
  const nz = (v) => (v === undefined ? null : v);
  return fields.every((f) => nz(current[f]) === nz(after[f]));
}

/**
 * Extrai as mudanças por carga de um evento de auditoria.
 *
 * @param {{ eventType: string, metadata: object|null }} event
 * @returns {{
 *   supported: boolean,          // evento conhecido E com estado "antes" gravado
 *   reason: string|null,         // motivo quando !supported
 *   touchesStatus: boolean,      // se o revert deve restaurar alloc_status também
 *   route: string|null,
 *   reserva: boolean,            // a operação criou/mexeu numa reserva (standby)
 *   items: Array<{ lh: string|null, cargoId: string|null,
 *                  before: {motorista,cavalo,carreta,status?},
 *                  after:  {motorista,cavalo,carreta,status?} }>
 * }}
 */
export function extractRevertItemsFromAuditEvent({ eventType, metadata }) {
  const meta = metadata && typeof metadata === "object" ? metadata : {};
  const base = { supported: false, reason: null, touchesStatus: false, route: meta.route ?? null, reserva: meta.reserva === true, items: [] };

  if (!REVERTIBLE_EVENT_TYPES.includes(eventType)) {
    return { ...base, reason: "Tipo de evento não é revertível." };
  }

  if (eventType === "operator.cargo.allocation_updated") {
    const before = pickAlloc(meta.beforeAlloc, { withStatus: true });
    const after = pickAlloc(meta.afterAlloc, { withStatus: true });
    if (!before || !after) {
      return { ...base, reason: "Mudança anterior à atualização do sistema (sem estado para reverter)." };
    }
    return {
      ...base,
      supported: true,
      touchesStatus: true,
      items: [{ lh: str(meta.lh), cargoId: null, before, after }],
    };
  }

  // Cascata (descer fila / cancelamento) e realocação por arrasto: pares
  // moves (depois) × beforeMoves (antes), casados por LH (ou cargoId no reassign).
  const after = Array.isArray(meta.moves) ? meta.moves : null;
  const before = Array.isArray(meta.beforeMoves) ? meta.beforeMoves : null;
  // `moves` do cancel_cascade legado era um NÚMERO (contagem) — não dá pra reverter.
  if (!before || !after || typeof meta.moves === "number") {
    return { ...base, reason: "Mudança anterior à atualização do sistema (sem estado para reverter)." };
  }

  const beforeByKey = new Map();
  for (const b of before) {
    const key = b.lh != null ? `lh:${b.lh}` : b.cargoId != null ? `id:${b.cargoId}` : null;
    if (key) beforeByKey.set(key, b);
  }

  const items = [];
  for (const a of after) {
    const key = a.lh != null ? `lh:${a.lh}` : a.cargoId != null ? `id:${a.cargoId}` : null;
    const b = key ? beforeByKey.get(key) : null;
    if (!b) continue; // sem par "antes" → não reverte esta linha
    items.push({
      lh: str(a.lh ?? b.lh ?? null),
      cargoId: str(a.cargoId ?? b.cargoId ?? null),
      before: pickAlloc(b),
      after: pickAlloc(a),
    });
  }

  if (items.length === 0) {
    return { ...base, reason: "Sem linhas com estado anterior para reverter." };
  }
  return { ...base, supported: true, touchesStatus: false, items };
}
