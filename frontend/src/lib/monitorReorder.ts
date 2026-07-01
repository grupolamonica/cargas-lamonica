// Lógica pura da reatribuição da fila de motoristas/veículos do Monitor.
// As VIAGENS (linhas) são fixas — só a alocação (motorista+placa) se move entre
// elas. Separada da UI para ser testável.
//
// O modo é auto-identificável pelo ponto de soltura no arrastar:
// - soltar no CORPO da linha  → "trocar" (swap)        → computeSwapMoves
// - soltar na BORDA da linha  → "descer/subir a fila"  → computeShiftMoves

export type MonitorAlloc = { motorista: string; cavalo: string; carreta: string };
export type MonitorMove = { lh: string } & MonitorAlloc;

export function sameMonitorAlloc(a: MonitorAlloc, b: MonitorAlloc): boolean {
  return a.motorista === b.motorista && a.cavalo === b.cavalo && a.carreta === b.carreta;
}

function diffMoves(
  items: Array<{ lh: string; alloc: MonitorAlloc }>,
  original: MonitorAlloc[],
  next: MonitorAlloc[],
): MonitorMove[] {
  const moves: MonitorMove[] = [];
  for (let i = 0; i < items.length; i++) {
    if (!sameMonitorAlloc(original[i], next[i])) {
      moves.push({ lh: items[i].lh, ...next[i] });
    }
  }
  return moves;
}

/** Troca a alocação entre duas posições. Só as linhas que mudam voltam em moves. */
export function computeSwapMoves(
  items: Array<{ lh: string; alloc: MonitorAlloc }>,
  idxA: number,
  idxB: number,
): MonitorMove[] {
  if (idxA < 0 || idxB < 0 || idxA >= items.length || idxB >= items.length || idxA === idxB) {
    return [];
  }
  const original = items.map((it) => it.alloc);
  const next = original.slice();
  const tmp = next[idxA];
  next[idxA] = next[idxB];
  next[idxB] = tmp;
  return diffMoves(items, original, next);
}

/**
 * Move a alocação de srcIdx para ser inserida ANTES da posição insertBeforeIdx
 * (0..len; len = inserir no fim), deslocando as demais — reordenação clássica
 * de lista. insertBeforeIdx em coordenadas do array ORIGINAL.
 */
export function computeShiftMoves(
  items: Array<{ lh: string; alloc: MonitorAlloc }>,
  srcIdx: number,
  insertBeforeIdx: number,
): MonitorMove[] {
  if (srcIdx < 0 || srcIdx >= items.length || insertBeforeIdx < 0 || insertBeforeIdx > items.length) {
    return [];
  }
  const original = items.map((it) => it.alloc);
  const next = original.slice();
  const [moved] = next.splice(srcIdx, 1);
  // Após remover a origem, alvos à direita deslocam um índice à esquerda.
  const insertAt = srcIdx < insertBeforeIdx ? insertBeforeIdx - 1 : insertBeforeIdx;
  next.splice(insertAt, 0, moved);
  return diffMoves(items, original, next);
}
