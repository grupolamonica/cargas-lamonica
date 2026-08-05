// Edição SIMULTÂNEA: a carga foi alterada por outra pessoa depois que a tela do
// operador carregou os dados?
//
// POR QUE EXISTE (incidente 2026-08-05): não há controle de concorrência nenhum nos
// caminhos de alocação — último que salva ganha, em silêncio. Duas operadoras
// trabalhando a mesma fila entraram em ping-pong na carga LT0Q8502CP7W1:
//   08:57 daniele  ELEONALDO → Joao
//   09:13 sinara   Joao → ELEONALDO   (desfaz a colega sem saber)
//   09:14 daniele  ELEONALDO → Joao   (desfaz de volta)
// Cada uma via "minha alteração foi revertida", porque o Monitor não avisa que a
// linha mudou por baixo (poll de 2 min, `refetchOnWindowFocus` desligado).
//
// AVISA, NÃO BLOQUEIA (decisão do usuário): sobrescrever pode ser exatamente o que o
// operador quer — ele é quem sabe. O sistema só para de deixar a sobrescrita
// acontecer às cegas.
//
// COMO: concorrência otimista com `alloc_updated_at`. A tela manda o carimbo que ela
// viu (`expectedAllocUpdatedAt`); se o do banco for diferente, alguém gravou no meio.
// Campo AUSENTE = sem baseline (editor inline, aba antiga, chamada de automação) →
// checagem PULADA, comportamento anterior preservado.
//
// ARMADILHA EVITADA: a atualização otimista do front gravava
// `alloc_updated_at: new Date().toISOString()` (timestamp do CLIENTE) no cache. Se a
// tela mandasse esse valor como baseline, o 2º save do mesmo modal SEMPRE divergiria
// do banco e todo mundo veria o aviso sem ninguém ter mexido. Por isso a resposta do
// save devolve o `allocUpdatedAt` REAL e o front usa esse — ver `updateMonitorAllocation`.
//
// Gate `CONCURRENT_EDIT_WARN=off` desliga sem rollback. Default LIGADO.

import { resolveOperatorDirectory } from "./audit-logs-read-model.js";

/** "off" desliga o aviso. Qualquer outro valor (inclusive ausente) = ligado. */
export function concurrentEditWarnEnabled() {
  return String(process.env.CONCURRENT_EDIT_WARN ?? "").trim().toLowerCase() !== "off";
}

/**
 * Milissegundos de um carimbo que pode chegar como Date (pg), string ISO (front) ou
 * null/vazio ("nunca alterado"). `null` para ausente — comparar `null === null` é o
 * caso legítimo de "os dois lados concordam que ninguém mexeu".
 */
export function carimboMs(v) {
  if (v == null || v === "") return null;
  const t = v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * A linha mudou desde o que a tela viu?
 *
 * @param {{ atualUpdatedAt: any, esperadoUpdatedAt: any }} args
 * @returns {boolean} true quando há divergência REAL de carimbo
 */
export function alocacaoDesatualizada({ atualUpdatedAt, esperadoUpdatedAt }) {
  const atual = carimboMs(atualUpdatedAt);
  const esperado = carimboMs(esperadoUpdatedAt);
  // Tolerância de 1s: `timestamptz` do Postgres tem precisão de microssegundos e o
  // ISO do JavaScript trunca em milissegundos — sem isso o round-trip do próprio
  // carimbo poderia divergir por arredondamento.
  if (atual == null && esperado == null) return false;
  if (atual == null || esperado == null) return true;
  return Math.abs(atual - esperado) > 1000;
}

/**
 * Descreve, em português do operador, quem alterou e o que está lá agora.
 * Best-effort: sem diretório de operadores, cai em "Outra pessoa".
 *
 * @returns {Promise<{ mensagem: string, alteradoPor: string, alteradoEm: string|null, atual: object }>}
 */
export async function descreverAlteracaoConcorrente({ row }) {
  let quem = "Outra pessoa";
  try {
    if (row?.alloc_updated_by) {
      const dir = await resolveOperatorDirectory();
      const info = dir?.get?.(row.alloc_updated_by);
      quem = info?.displayName || info?.email || quem;
    }
  } catch {
    // Diretório indisponível não impede o aviso — só perde o nome.
  }

  const quando = row?.alloc_updated_at ? new Date(row.alloc_updated_at) : null;
  // Hora de parede em São Paulo (o operador pensa no fuso dele, não em UTC).
  const hora = quando
    ? quando.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })
    : null;

  const atual = {
    motorista: row?.alloc_motorista ?? row?.sheet_motorista ?? null,
    cavalo: row?.alloc_cavalo ?? row?.sheet_cavalo ?? null,
    carreta: row?.alloc_carreta ?? row?.sheet_carreta ?? null,
    status: row?.alloc_status ?? row?.sheet_status ?? null,
  };

  const partes = [];
  if (atual.motorista) partes.push(`motorista ${atual.motorista}`);
  if (atual.cavalo) partes.push(`cavalo ${atual.cavalo}`);
  if (atual.status) partes.push(`status ${atual.status}`);
  const agora = partes.length ? ` Agora está: ${partes.join(", ")}.` : " A carga está sem motorista agora.";

  return {
    mensagem: `${quem} alterou esta carga${hora ? ` às ${hora}` : ""} enquanto você editava.${agora}`,
    alteradoPor: quem,
    alteradoEm: quando ? quando.toISOString() : null,
    atual,
  };
}
