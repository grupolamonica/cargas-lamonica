/**
 * Lógica pura de recorrência de cargas — compartilhada entre o job de
 * auto-avanço (application/operator-admin) e o clone-on-reserve
 * (application/load-claims), garantindo UMA definição de "próxima ocorrência
 * visível". Sem dependências externas (camada de domínio).
 */

/**
 * Soma `n` dias a uma data ISO (YYYY-MM-DD) em espaço UTC (evita saltos de DST).
 * @param {string} iso
 * @param {number} n
 * @returns {string} nova data ISO (YYYY-MM-DD)
 */
export function addDaysIso(iso, n) {
  const [year, month, day] = String(iso).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * Normaliza um valor de coluna `date` (Date do driver pg ou string) para
 * YYYY-MM-DD. Usa getters UTC — consistente com o filtro de visibilidade do
 * portal (que usa toISOString) e estável no Postgres real e no motor in-memory.
 * @param {Date|string} value
 * @returns {string}
 */
export function toIsoDate(value) {
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/**
 * A partir de `dataIso`, retorna a primeira data (em passos de `intervalDays`)
 * que fica VISÍVEL pelo mesmo critério do portal do motorista
 * (buildDriverLoadFilters): `data > hoje` OU `data = hoje E horario >= agora`.
 * Função pura.
 *
 * @param {string} dataIso      data de partida (YYYY-MM-DD)
 * @param {string} horario      horário da carga (HH:MM[:SS])
 * @param {number} intervalDays intervalo de recorrência em dias (>=1)
 * @param {Date}   [now]        instante de referência
 * @returns {string} data ISO visível (YYYY-MM-DD); igual à entrada se já visível
 */
export function computeNextRecurrenceDate(dataIso, horario, intervalDays, now = new Date()) {
  const interval = Number.isInteger(intervalDays) && intervalDays > 0 ? intervalDays : 1;
  const todayIso = now.toISOString().slice(0, 10);
  const nowTime = now.toTimeString().slice(0, 8); // HH:MM:SS local — espelha buildDriverLoadFilters
  const time = String(horario || "00:00:00").slice(0, 8);

  const isVisible = (d) => d > todayIso || (d === todayIso && time >= nowTime);

  let candidate = String(dataIso).slice(0, 10);
  // Guard: teto defensivo (~11 anos em passos diários) — nunca deve ser atingido.
  for (let guard = 0; !isVisible(candidate) && guard < 4000; guard += 1) {
    candidate = addDaysIso(candidate, interval);
  }
  return candidate;
}
