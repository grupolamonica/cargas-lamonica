/**
 * Domain constants para pacote de cargas (cargas_casadas).
 *
 * LOCKED em CONTEXT.md (Phase 10):
 *  - D-04: status lowercase em portugues (DISTINCT de cargas.status uppercase EN)
 *  - D-04: limite=3 cargas por pacote (regra de negocio, nao schema)
 *  - D-04: transicoes de estado controladas (cascade unidirecional)
 *
 * Sem deps externas — modulo puro.
 */

export const PACOTE_STATUS = Object.freeze({
  RASCUNHO: "rascunho",
  PUBLICADO: "publicado",
  RESERVADO: "reservado",
  EM_ANDAMENTO: "em_andamento",
  CONCLUIDO: "concluido",
  CANCELADO: "cancelado",
});

export const PACOTE_STATUS_VALUES = Object.freeze(Object.values(PACOTE_STATUS));

/** D-04 LOCKED: limite=3 cargas por pacote. */
export const MAX_CARGAS_POR_PACOTE = 3;

/**
 * Transicoes validas: status -> array de proximos status permitidos.
 *
 * - rascunho -> publicado (via publishPacote) | cancelado
 * - publicado -> reservado (claim atomico, plan 10-03) | rascunho (despublicar, edicao) | cancelado
 * - reservado -> em_andamento (motorista confirma) | publicado (motorista desiste) | cancelado
 * - em_andamento -> concluido (entrega) | cancelado (operador)
 * - concluido / cancelado -> terminal (sem transicoes)
 */
export const PACOTE_STATUS_TRANSITIONS = Object.freeze({
  rascunho: Object.freeze(["publicado", "cancelado"]),
  publicado: Object.freeze(["reservado", "rascunho", "cancelado"]),
  reservado: Object.freeze(["em_andamento", "publicado", "cancelado"]),
  em_andamento: Object.freeze(["concluido", "cancelado"]),
  concluido: Object.freeze([]),
  cancelado: Object.freeze([]),
});

export function canTransitionPacoteStatus(from, to) {
  const allowed = PACOTE_STATUS_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Status terminais (sem proximas transicoes).
 */
export const PACOTE_STATUS_TERMINAL = Object.freeze([
  PACOTE_STATUS.CONCLUIDO,
  PACOTE_STATUS.CANCELADO,
]);

/**
 * Status editaveis: operador pode add/remove/reorder cargas + alterar valor_total.
 * D-04: edicao em 'publicado' incrementa version (D-06).
 */
export const PACOTE_STATUS_EDITAVEIS = Object.freeze([
  PACOTE_STATUS.RASCUNHO,
  PACOTE_STATUS.PUBLICADO,
]);
