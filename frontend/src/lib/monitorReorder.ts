// Lógica pura da reordenação da "fila" de motoristas/veículos do Monitor (F3).
// Separada da UI para ser testável: dado a fila de alocações numa ordem estável
// + origem/destino + modo, calcula quais linhas mudam de alocação.

export type MonitorAlloc = { motorista: string; cavalo: string; carreta: string };

export function sameMonitorAlloc(a: MonitorAlloc, b: MonitorAlloc): boolean {
  return a.motorista === b.motorista && a.cavalo === b.cavalo && a.carreta === b.carreta;
}

/**
 * Calcula as movimentações para reordenar a fila.
 *
 * @param items alocações efetivas na ORDEM da fila (cada uma com o lh da carga).
 * @param srcIdx posição arrastada; @param dstIdx posição de destino.
 * @param mode "swap" troca só as duas posições; "shift" remove a origem e insere
 *        no destino (descer/subir a fila), deslocando as demais.
 * @returns só as posições cuja alocação mudou — `{ lh, motorista, cavalo, carreta }`
 *          com os valores que aquela carga passa a ter ("" = vazio explícito).
 */
export function computeReassignMoves(
  items: Array<{ lh: string; alloc: MonitorAlloc }>,
  srcIdx: number,
  dstIdx: number,
  mode: "swap" | "shift",
): Array<{ lh: string } & MonitorAlloc> {
  if (
    srcIdx < 0 || dstIdx < 0 ||
    srcIdx >= items.length || dstIdx >= items.length ||
    srcIdx === dstIdx
  ) {
    return [];
  }

  const original = items.map((it) => it.alloc);
  const next = original.slice();

  if (mode === "swap") {
    const tmp = next[srcIdx];
    next[srcIdx] = next[dstIdx];
    next[dstIdx] = tmp;
  } else {
    const [moved] = next.splice(srcIdx, 1);
    next.splice(dstIdx, 0, moved);
  }

  const moves: Array<{ lh: string } & MonitorAlloc> = [];
  for (let i = 0; i < items.length; i++) {
    if (!sameMonitorAlloc(original[i], next[i])) {
      moves.push({ lh: items[i].lh, ...next[i] });
    }
  }
  return moves;
}
