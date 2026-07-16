// Lógica PURA da cascata de cancelamento da fila do Monitor (Interpretação A).
//
// Quando uma carga é cancelada, o motorista/veículo dela "desce a fila": assume a
// PRÓXIMA carga da rota, empurrando cada motorista seguinte para a carga de baixo
// (ripple). O último que fica sem carga vira RESERVA (standby na rota).
//
// Regras:
// - Escopo = UMA rota (a lista `loads` já vem só com as cargas da rota, em ordem
//   cronológica = a "fila"). data+horário definem a ordem; o caller garante isso.
// - A carga cancelada fica MORTA (sem motorista) — seu motorista vira o "carry".
// - Cargas FIXAS (pinned) são intocáveis: a cascata pula (o motorista fica) e o
//   carry continua para a próxima carga livre.
// - Cargas TRAVADAS (locked) — com status operacional (CARREGADO, DESCARGA, etc.)
//   ou canceladas — também são puladas: não se mexe em motorista que já está no
//   ASPX/em operação (mesma regra da trava de edição). Só Disponível/Reservado
//   (status vazio) entram no remanejamento.
// - O ripple PARA na primeira carga VAZIA (sem motorista) que receber o carry —
//   o motorista achou lugar e ninguém sobra (sem reserva).
// - Sobrou carry no fim → vira RESERVA.
//
// Idempotente: se a carga cancelada já não tem motorista (ex.: cascata já rodou),
// não há o que mover → { moves: [], reserva: null }.

/** @typedef {{ motorista?: string|null, cavalo?: string|null, carreta?: string|null }} Alloc */
/** @typedef {Alloc & { lh: string, pinned?: boolean, cancelled?: boolean, locked?: boolean }} CascadeLoad */

const EMPTY = { motorista: "", cavalo: "", carreta: "" };

const norm = (v) => (v ?? "").toString();
const hasDriver = (a) => norm(a && a.motorista).trim() !== "";
const allocOf = (a) => ({ motorista: norm(a && a.motorista), cavalo: norm(a && a.cavalo), carreta: norm(a && a.carreta) });
const sameAlloc = (a, b) => a.motorista === b.motorista && a.cavalo === b.cavalo && a.carreta === b.carreta;
// Uma carga participa do remanejamento se NÃO é fixa, cancelada nem travada por
// status operacional. Fixa/travada = fica no lugar; a cascata anda ao redor dela.
const isMovable = (l) => !(l.pinned || l.cancelled || l.locked);

/**
 * Descer a fila "a partir de onde soltei" (arrasto manual do Monitor, F3).
 *
 * O motorista de `sourceLh` é solto na carga `targetLh`: ele ASSUME a carga de
 * destino e, a partir dela, cada motorista seguinte desce uma carga (ripple para
 * baixo = índices crescentes na ordem exibida). A carga de ORIGEM fica vaga; essa
 * vaga é uma "carga em branco" que o ripple pode absorver. Cargas FIXAS/travadas
 * são PULADAS (o carry passa por cima). O ripple para na primeira carga em branco
 * (inclusive a vaga da origem, no caso de subir); se sobrar motorista no fim da
 * fila, vira RESERVA.
 *
 * Funciona nos dois sentidos:
 * - soltar ABAIXO da origem (descer): a vaga da origem fica acima do ripple; se a
 *   fila estiver cheia, o último motorista sobra → reserva.
 * - soltar ACIMA da origem (subir/promover): o ripple desce até a vaga da origem e
 *   a preenche → rotação, ninguém sobra (sem reserva).
 *
 * @param {CascadeLoad[]} loads  Cargas da rota na ordem EXIBIDA (topo→base).
 * @param {string} sourceLh      LH da carga de origem (motorista que se move).
 * @param {string} targetLh      LH da carga onde foi solto (âncora da descida).
 * @returns {{ moves: Array<{lh:string, motorista:string, cavalo:string, carreta:string}>, reserva: {motorista:string, cavalo:string, carreta:string} | null }}
 */
export function computeDescendFromDrop(loads, sourceLh, targetLh) {
  const srcIdx = loads.findIndex((l) => l.lh === sourceLh);
  const tgtIdx = loads.findIndex((l) => l.lh === targetLh);
  if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return { moves: [], reserva: null };
  // A origem precisa poder se mover e ter motorista, senão não há o que descer.
  if (!isMovable(loads[srcIdx]) || !hasDriver(loads[srcIdx])) return { moves: [], reserva: null };

  const original = loads.map(allocOf);
  const next = original.map((a) => ({ ...a }));

  let carry = { ...original[srcIdx] }; // o motorista que está sendo solto
  next[srcIdx] = { ...EMPTY };         // a carga de origem fica vaga

  let reserva = null;
  let placed = false;
  for (let i = tgtIdx; i < loads.length; i++) {
    if (!isMovable(loads[i])) continue;            // fixa/travada: pula, o carry segue
    const prev = next[i];
    next[i] = { ...carry };
    placed = true;
    if (!hasDriver(prev)) { carry = null; break; } // carga em branco (ou a vaga da origem) absorve
    carry = prev;
  }
  // Não achou NENHUMA carga movível do destino pra baixo → não movimenta (nem
  // esvazia a origem): evita "sumir" com o motorista sem ter onde colocar.
  if (!placed) return { moves: [], reserva: null };
  if (carry && hasDriver(carry)) reserva = { ...carry };

  const moves = [];
  for (let i = 0; i < loads.length; i++) {
    if (!sameAlloc(original[i], next[i])) {
      moves.push({ lh: loads[i].lh, ...next[i] });
    }
  }
  return { moves, reserva };
}

/**
 * Calcula a redistribuição da fila ao cancelar a carga `cancelledLh`.
 *
 * @param {CascadeLoad[]} loads  Cargas da rota em ordem cronológica (a fila).
 * @param {string} cancelledLh   LH da carga cancelada (gatilho).
 * @returns {{ moves: Array<{lh:string, motorista:string, cavalo:string, carreta:string}>, reserva: {motorista:string, cavalo:string, carreta:string} | null }}
 */
export function computeCancelCascade(loads, cancelledLh) {
  const idx = loads.findIndex((l) => l.lh === cancelledLh);
  if (idx < 0) return { moves: [], reserva: null };

  // Carga FIXA é intocável — nem a cascata move o motorista dela.
  if (loads[idx].pinned) return { moves: [], reserva: null };

  const original = loads.map(allocOf);
  // Nada para mover se a carga cancelada já está sem motorista (idempotência).
  if (!hasDriver(loads[idx])) return { moves: [], reserva: null };

  const next = original.map((a) => ({ ...a }));
  let carry = { ...original[idx] }; // motorista/veículo da carga cancelada
  next[idx] = { ...EMPTY };         // carga cancelada fica morta (sem motorista)

  let reserva = null;
  for (let i = idx + 1; i < loads.length; i++) {
    // Carga fixa, travada (status operacional) ou cancelada não recebe motorista
    // — pula, o carry segue adiante até a próxima carga livre (Disponível/Reservado).
    if (loads[i].pinned || loads[i].cancelled || loads[i].locked) continue;
    const prev = next[i];
    next[i] = { ...carry };
    if (!hasDriver(prev)) { carry = null; break; } // achou carga vazia → ripple absorvido
    carry = prev;
  }
  if (carry && hasDriver(carry)) reserva = { ...carry };

  const moves = [];
  for (let i = 0; i < loads.length; i++) {
    if (!sameAlloc(original[i], next[i])) {
      moves.push({ lh: loads[i].lh, ...next[i] });
    }
  }
  return { moves, reserva };
}
