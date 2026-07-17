/**
 * schedule-nlp — parser de preferência de DATA/HORÁRIO em português coloquial,
 * do jeito que motorista de caminhão responde no WhatsApp.
 *
 * Entrada: texto livre ("pode ser amanhã de manhã", "só quinta que vem",
 * "o quanto antes", "dia 20 de tarde", "22/07 às 8h", "tanto faz"…).
 * Saída: intenção estruturada que o matcher usa para achar a carga mais próxima.
 *
 * Puro (sem I/O). Recebe `todayIso` (YYYY-MM-DD no fuso de São Paulo) para ser
 * determinístico e testável. Toda a matemática de data é feita em cima da string
 * ISO (meio-dia UTC) para não sofrer drift de fuso.
 *
 * @typedef {Object} SchedulePreference
 * @property {'asap'|'any'|'date'|'range'|'period_only'|'unknown'} kind
 * @property {string|null} dateIso      data alvo resolvida (YYYY-MM-DD)
 * @property {string|null} dateFrom     início do intervalo (kind='range')
 * @property {string|null} dateTo       fim do intervalo (kind='range')
 * @property {'madrugada'|'manha'|'tarde'|'noite'|null} period
 * @property {string|null} timeIso      horário específico (HH:MM)
 * @property {boolean} flexible         motorista topa qualquer coisa (asap/any)
 * @property {string} raw               texto original
 * @property {string} normalized        texto normalizado (debug)
 */

// ─── Helpers de data (ISO, fuso-safe) ─────────────────────────────────────────

/** Remove acentos + baixa caixa + colapsa espaços. */
export function normalizeText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Expande abreviações/gírias de caminhoneiro para a forma canônica ANTES do
 * casamento. NÃO mexe em "pra" (usado como "pra ontem"/"pra ja" no ASAP).
 */
export function expandAbbreviations(t) {
  return ` ${t} `
    // qualquer: qquer, qlqr, qlqer, qualqer, qualq, qq, qqr
    .replace(/\b(qq|qqr|qquer|qlqr|qlqer|qualqer|qualq)\b/g, "qualquer")
    // que: oq / o q → o que; q isolado → que
    .replace(/\boq\b/g, "o que")
    .replace(/\bo q\b/g, "o que")
    .replace(/\bq\b/g, "que")
    // outras comuns
    .replace(/\bvc\b/g, "voce")
    .replace(/\b(tbm|tb)\b/g, "tambem")
    .replace(/\bdps\b/g, "depois")
    .replace(/\b(qdo|qnd|qndo)\b/g, "quando")
    .replace(/\bmanhazinha\b/g, "manha")
    .replace(/\btardezinha\b/g, "tarde")
    .replace(/\bmadruga\b/g, "madrugada")
    .replace(/\s+/g, " ")
    .trim();
}

/** Soma `n` dias a um ISO (YYYY-MM-DD), retornando ISO. */
export function addDaysIso(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Dia da semana de um ISO: 0=domingo … 6=sábado. */
export function weekdayOfIso(iso) {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

// ─── Dicionários ──────────────────────────────────────────────────────────────

// weekday alvo (0=dom..6=sab) → sinônimos
const WEEKDAYS = [
  { dow: 0, words: ["domingo", "dom"] },
  { dow: 1, words: ["segunda-feira", "segunda feira", "segunda", "seg"] },
  { dow: 2, words: ["terca-feira", "terca feira", "terca", "ter"] },
  { dow: 3, words: ["quarta-feira", "quarta feira", "quarta", "qua"] },
  { dow: 4, words: ["quinta-feira", "quinta feira", "quinta", "qui"] },
  { dow: 5, words: ["sexta-feira", "sexta feira", "sexta", "sex"] },
  { dow: 6, words: ["sabado", "sab"] },
];

const MONTHS = {
  janeiro: 1, jan: 1,
  fevereiro: 2, fev: 2,
  marco: 3, mar: 3,
  abril: 4, abr: 4,
  maio: 5, mai: 5,
  junho: 6, jun: 6,
  julho: 7, jul: 7,
  agosto: 8, ago: 8,
  setembro: 9, set: 9,
  outubro: 10, out: 10,
  novembro: 11, nov: 11,
  dezembro: 12, dez: 12,
};

// ─── Detecção de PERÍODO ──────────────────────────────────────────────────────

function detectPeriod(t) {
  // madrugada primeiro (mais específico que "de manhã cedo")
  if (/\bmadrugad/.test(t) || /\bde madruga/.test(t)) return "madrugada";
  if (/\bmanha\b|\bmanhazinha\b|\bpela manha\b|\bde manha\b|\bcedinho\b|\bamanhecer\b/.test(t)) return "manha";
  if (/\btarde\b|\bde tarde\b|\ba tarde\b|\bfim da tarde\b|\bfinal da tarde\b/.test(t)) return "tarde";
  if (/\bnoite\b|\bde noite\b|\ba noite\b|\banoitecer\b|\bfim do dia\b|\bfinal do dia\b/.test(t)) return "noite";
  // "cedo" sozinho = de manhã
  if (/\bcedo\b/.test(t)) return "manha";
  return null;
}

// ─── Detecção de HORÁRIO específico ───────────────────────────────────────────

function pad2(n) {
  return String(n).padStart(2, "0");
}

function detectTime(t) {
  // meia noite / meio dia
  if (/\bmeia[- ]?noite\b/.test(t)) return "00:00";
  if (/\bmeio[- ]?dia\b/.test(t)) return "12:00";

  // "8 da manha", "2 da tarde", "8 da noite", "6 da madrugada"
  let m = t.match(/\b(\d{1,2})(?:h|:00|hrs|horas?)?\s*(?:da|de|pela)\s*(manha|tarde|noite|madrugada)\b/);
  if (m) {
    let h = Number(m[1]);
    const per = m[2];
    if (per === "tarde" && h < 12) h += 12;
    else if (per === "noite" && h < 12) h += 12;
    else if (per === "madrugada" && h === 12) h = 0;
    else if (per === "manha" && h === 12) h = 0;
    if (h >= 0 && h <= 23) return `${pad2(h)}:00`;
  }

  // "08:30", "8:30", "14h30", "8h30"
  m = t.match(/\b(\d{1,2})[:h](\d{2})\b/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return `${pad2(h)}:${pad2(min)}`;
  }

  // "8h", "14h", "8 horas", "14hrs", "as 8", "às 14"
  m = t.match(/\b(?:as\s*)?(\d{1,2})\s*(?:h|hrs|hr|horas?)\b/);
  if (m) {
    const h = Number(m[1]);
    if (h >= 0 && h <= 23) return `${pad2(h)}:00`;
  }
  // "as 8" / "às 14" sem sufixo
  m = t.match(/\bas\s+(\d{1,2})\b/);
  if (m) {
    const h = Number(m[1]);
    if (h >= 0 && h <= 23) return `${pad2(h)}:00`;
  }
  return null;
}

// ─── Detecção de DATA explícita ───────────────────────────────────────────────

function clampMonthDay(year, month, day) {
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  // valida
  const d = new Date(`${iso}T12:00:00Z`);
  if (d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month && d.getUTCDate() === day) return iso;
  return null;
}

/** Resolve dd/mm[/aaaa] considerando o ano corrente (rola pro ano seguinte se já passou). */
function detectExplicitDate(t, todayIso) {
  const [ty, tm, td] = todayIso.split("-").map(Number);

  // dd/mm/aaaa ou dd-mm-aaaa
  let m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    return clampMonthDay(year, Number(m[2]), Number(m[1]));
  }

  // dd/mm (sem ano) → ano corrente, ou próximo se já passou
  m = t.match(/\b(\d{1,2})[\/](\d{1,2})\b/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    let iso = clampMonthDay(ty, month, day);
    if (iso && iso < todayIso) iso = clampMonthDay(ty + 1, month, day);
    return iso;
  }

  // "15 de julho", "20 de agosto de 2026", "dia 15 de julho"
  m = t.match(/\b(\d{1,2})\s+de\s+([a-z]+)(?:\s+de\s+(\d{4}))?\b/);
  if (m && MONTHS[m[2]]) {
    const day = Number(m[1]);
    const month = MONTHS[m[2]];
    const year = m[3] ? Number(m[3]) : ty;
    let iso = clampMonthDay(year, month, day);
    if (iso && !m[3] && iso < todayIso) iso = clampMonthDay(year + 1, month, day);
    return iso;
  }

  // "dia 20" (só o dia) → esse mês se >= hoje, senão mês que vem
  m = t.match(/\bdia\s+(\d{1,2})\b/);
  if (m) {
    const day = Number(m[1]);
    let iso = clampMonthDay(ty, tm, day);
    if (!iso || iso < todayIso) {
      const nm = tm === 12 ? 1 : tm + 1;
      const ny = tm === 12 ? ty + 1 : ty;
      iso = clampMonthDay(ny, nm, day);
    }
    return iso;
  }

  return null;
}

// ─── Detecção de DIA relativo / semana ────────────────────────────────────────

function nextWeekday(todayIso, targetDow, { forceNext = false } = {}) {
  const todayDow = weekdayOfIso(todayIso);
  let delta = (targetDow - todayDow + 7) % 7;
  if (delta === 0) delta = forceNext ? 7 : 0; // hoje é o dia
  if (forceNext && delta < 7 && delta === 0) delta = 7;
  return addDaysIso(todayIso, delta);
}

// ─── Parser principal ─────────────────────────────────────────────────────────

/**
 * @param {string} text
 * @param {{ todayIso: string }} ctx  data de hoje (YYYY-MM-DD, fuso SP)
 * @returns {SchedulePreference}
 */
export function parseSchedulePreference(text, { todayIso } = {}) {
  const raw = String(text || "");
  const t = expandAbbreviations(normalizeText(raw));
  const today = todayIso || new Date().toISOString().slice(0, 10);

  const base = {
    kind: "unknown",
    dateIso: null,
    dateFrom: null,
    dateTo: null,
    period: detectPeriod(t),
    timeIso: detectTime(t),
    flexible: false,
    raw,
    normalized: t,
  };

  if (!t) return base;

  // ── ASAP: urgência ──────────────────────────────────────────────────────────
  if (
    /\bo quanto antes\b|\bmais rapido\b|\bmais breve\b|\bo mais cedo\b|\burgente\b|\bpra ontem\b|\bpra ja\b|\bpde imediato\b|\bimediato\b|\bagora\b|\bhoje mesmo se der\b|\bassim que possivel\b|\bo mais rapido possivel\b|\bo mais rapido que der\b|\bja\b(?! que)|\basap\b/.test(
      t,
    )
  ) {
    return { ...base, kind: "asap", flexible: true };
  }

  // ── ANY: tanto faz / qualquer ────────────────────────────────────────────────
  if (
    /\btanto faz\b|\bqualquer dia\b|\bqualquer data\b|\bqualquer hora(rio)?\b|\bqualquer uma?\b|\bquando (voce |vc )?(tiver|puder|der|houver|quiser)\b|\bo que (tiver|aparecer|vier|for|surgir|voce tem|tem)\b|\baparecer eu pego\b|\bo que aparecer\b|\bme manda o que\b|\bpode ser qualquer\b|\bpode marcar\b|\bpode ser a que tiver\b|\bnao tenho preferencia\b|\bpode escolher\b|\bvoce escolhe\b|\bvoce que sabe\b|\bqualquer coisa\b|\bme encaixa\b/.test(
      t,
    )
  ) {
    return { ...base, kind: "any", flexible: true };
  }

  // ── Fim de semana ────────────────────────────────────────────────────────────
  if (/\bfim de semana\b|\bfinal de semana\b|\bfds\b|\bfinde\b/.test(t)) {
    // próximo sábado até domingo
    const sat = nextWeekday(today, 6, { forceNext: weekdayOfIso(today) === 0 });
    const sun = addDaysIso(sat, 1);
    return { ...base, kind: "range", dateFrom: sat, dateTo: sun };
  }

  // ── Semana que vem / próxima semana ──────────────────────────────────────────
  if (/\b(semana que vem|proxima semana|semana proxima|na proxima semana|semana seguinte)\b/.test(t)) {
    // segunda a domingo da semana seguinte
    const nextMon = nextWeekday(today, 1, { forceNext: true });
    return { ...base, kind: "range", dateFrom: nextMon, dateTo: addDaysIso(nextMon, 6) };
  }

  // ── Essa semana / ainda essa semana ──────────────────────────────────────────
  if (/\b(essa semana|esta semana|nessa semana|ainda essa semana|dessa semana|semana atual)\b/.test(t)) {
    const dow = weekdayOfIso(today);
    const sundayDelta = (7 - dow) % 7; // até domingo
    return { ...base, kind: "range", dateFrom: today, dateTo: addDaysIso(today, sundayDelta) };
  }

  // ── Mês que vem ──────────────────────────────────────────────────────────────
  if (/\b(mes que vem|proximo mes|mes proximo)\b/.test(t)) {
    const [y, mo] = today.split("-").map(Number);
    const ny = mo === 12 ? y + 1 : y;
    const nm = mo === 12 ? 1 : mo + 1;
    const from = `${ny}-${pad2(nm)}-01`;
    const to = addDaysIso(mo === 12 ? `${ny}-01-01` : `${y}-${pad2(mo + 1)}-01`, 27);
    return { ...base, kind: "range", dateFrom: from, dateTo: to };
  }

  // ── Data explícita (dd/mm, dia N, N de mês) ──────────────────────────────────
  const explicit = detectExplicitDate(t, today);
  if (explicit) {
    return { ...base, kind: "date", dateIso: explicit };
  }

  // ── Depois de amanhã ─────────────────────────────────────────────────────────
  if (/\bdepois de amanha\b|\bdepois d amanha\b/.test(t)) {
    return { ...base, kind: "date", dateIso: addDaysIso(today, 2) };
  }

  // ── Amanhã ───────────────────────────────────────────────────────────────────
  if (/\bamanha\b|\bamanha cedo\b|\bde amanha\b/.test(t)) {
    return { ...base, kind: "date", dateIso: addDaysIso(today, 1) };
  }

  // ── Hoje ─────────────────────────────────────────────────────────────────────
  if (/\bhoje\b|\bhj\b|\bainda hoje\b|\bhoje mesmo\b/.test(t)) {
    return { ...base, kind: "date", dateIso: today };
  }

  // ── Dia da semana ("quinta", "segunda que vem", "na sexta") ──────────────────
  for (const wd of WEEKDAYS) {
    for (const w of wd.words) {
      const re = new RegExp(`\\b${w.replace(/[-]/g, "[- ]")}\\b`);
      if (re.test(t)) {
        const forceNext = /\bque vem\b|\bproxim[ao]\b|\bque ve\b/.test(t);
        return { ...base, kind: "date", dateIso: nextWeekday(today, wd.dow, { forceNext }) };
      }
    }
  }

  // ── "em N dias" / "daqui a N dias" ───────────────────────────────────────────
  let m = t.match(/\b(?:em|daqui a|daqui)\s+(\d{1,2})\s+dias?\b/);
  if (m) {
    return { ...base, kind: "date", dateIso: addDaysIso(today, Number(m[1])) };
  }

  // ── Só período/horário, sem dia → trata como ASAP com preferência de período ──
  if (base.period || base.timeIso) {
    return { ...base, kind: "period_only", flexible: true };
  }

  return base; // unknown
}
