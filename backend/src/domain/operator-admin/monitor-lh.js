// backend/src/domain/operator-admin/monitor-lh.js
//
// Resolução do LH de uma linha do Monitor contra um índice AO VIVO (agenda/status),
// keyed por código de viagem.
//
// POR QUE não é um `map.get(lh)` simples: o LH da Nestlé pode ser MULTI-CÓDIGO. A
// planilha e o lançamento gravam os códigos do grupo numa célula só, separados por
// vírgula ("B101474063, B101473490" — visto em produção), enquanto os índices são
// construídos a partir das tabelas do Galileu, que têm UMA linha por código. Sem
// quebrar a célula, essas linhas nunca casavam e ficavam sem overlay — em 04/08/2026,
// 6 das 12 cargas Nestlé com agenda defasada eram justamente multi-código.
//
// Os LHs da Shopee (trip_number "LT…") nunca têm vírgula, então a regra é inerte
// para eles: o caminho comum continua sendo um `get` direto.

/**
 * Entrada do índice para o LH de uma linha do Monitor. Tenta o LH inteiro e, só se
 * ele for multi-código, cada parte (a primeira que casar vale — é a mesma viagem).
 *
 * @param {Map<string, any>|null|undefined} index
 * @param {string|null|undefined} lh
 * @returns {any|null} valor do índice, ou null sem match
 */
export function lookupByMonitorLh(index, lh) {
  if (!index || index.size === 0) return null;
  const raw = String(lh ?? "").trim();
  if (!raw) return null;
  const direto = index.get(raw);
  if (direto !== undefined) return direto;
  if (!raw.includes(",")) return null;
  for (const parte of raw.split(",")) {
    const hit = index.get(parte.trim());
    if (hit !== undefined) return hit;
  }
  return null;
}
