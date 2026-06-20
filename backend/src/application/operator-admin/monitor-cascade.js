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
