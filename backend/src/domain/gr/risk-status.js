// backend/src/domain/gr/risk-status.js
//
// Núcleo PURO do Gerenciamento de Risco (GR): classifica vigências, consolida o
// veredito do conjunto (Angellira + BRK + SPX) por entidade e deriva a lista de
// alertas (motorista/veículo). Sem I/O — recebe dados já normalizados e é 100%
// testável. Base: análise DC-223 / card DC-234.
//
// O semáforo de vigência espelha o já usado nos read-models de motorista/veículo
// (EXPIRED / EXPIRING_SOON ≤30d / OK) — ver buildAngelliraVigency em
// application/operator-admin/read-models.js. Mantido aqui como fonte única da
// camada de GR; unificar com aqueles builders fica como follow-up.

const DAY_MS = 86_400_000;

export const EXPIRY_WARN_DAYS = 30;

/** Veredito consolidado do conjunto por entidade. */
export const VERDICT = Object.freeze({
  OK: "OK",
  ATENCAO: "ATENCAO",
  CRITICO: "CRITICO",
  SEM_DADO: "SEM_DADO",
});

/** Alertas só existem em severidade crítica ou de atenção (OK/sem-dado não alertam). */
export const SEVERITY = Object.freeze({ CRIT: "crit", WARN: "warn" });
export const ALERT_TYPE = Object.freeze({ EXPIRY: "EXPIRY", STATE: "STATE" });
export const SOURCE = Object.freeze({ ANGELLIRA: "ANGELLIRA", BRK: "BRK", SPX: "SPX" });

// Severidade por fonte (uso interno na consolidação).
const SRC = Object.freeze({ OK: "ok", ATENCAO: "atencao", CRITICO: "critico", SEM_DADO: "sem_dado" });

function norm(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function toUtcMidnight(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Classifica uma data de validade em nível de alerta + dias restantes.
 * Espelha os builders dos read-models: <0 → EXPIRED, ≤warnDays → EXPIRING_SOON, senão OK.
 * @param {string|Date|null} validUntil 'YYYY-MM-DD' | Date | null
 * @param {{ nowMs?: number, warnDays?: number }} [opts]
 * @returns {{ daysUntilExpiry: number|null, alertLevel: 'EXPIRED'|'EXPIRING_SOON'|'OK'|null }}
 */
export function classifyExpiry(validUntil, { nowMs = Date.now(), warnDays = EXPIRY_WARN_DAYS } = {}) {
  const expMid = toUtcMidnight(validUntil);
  if (expMid == null) return { daysUntilExpiry: null, alertLevel: null };
  const nowMid = toUtcMidnight(new Date(nowMs));
  const daysUntilExpiry = Math.round((expMid - nowMid) / DAY_MS);
  let alertLevel;
  if (daysUntilExpiry < 0) alertLevel = "EXPIRED";
  else if (daysUntilExpiry <= warnDays) alertLevel = "EXPIRING_SOON";
  else alertLevel = "OK";
  return { daysUntilExpiry, alertLevel };
}

const ANGELLIRA_BAD = new Set([
  "not_found", "nao_encontrado", "nao encontrado", "nao_conforme", "nao conforme", "reprovado", "invalid", "vencido",
]);

function classifyAngellira(a) {
  if (!a) return SRC.SEM_DADO;
  if (a.alertLevel === "EXPIRED") return SRC.CRITICO;
  if (a.alertLevel === "EXPIRING_SOON") return SRC.ATENCAO;
  if (a.alertLevel === "OK") return SRC.OK;
  const s = norm(a.status);
  if (!s) return SRC.SEM_DADO;
  if (ANGELLIRA_BAD.has(s)) return SRC.CRITICO;
  if (s === "found" || s === "conforme" || s === "vigente") return SRC.OK;
  return SRC.SEM_DADO;
}

function classifyBrk(b) {
  if (!b) return SRC.SEM_DADO;
  if (b.conjuntoApto === false) return SRC.CRITICO;
  if (b.alertLevel === "EXPIRED") return SRC.CRITICO;
  if (b.alertLevel === "EXPIRING_SOON") return SRC.ATENCAO;
  if (b.alertLevel === "OK") return SRC.OK;
  if (b.conjuntoApto === true) return SRC.OK;
  const s = norm(b.status);
  if (!s || s === "erro") return SRC.SEM_DADO;
  if (s === "vigente" || s === "apto") return SRC.OK;
  if (s === "reprovado" || s === "vencido" || s === "nao_apto") return SRC.CRITICO;
  return SRC.SEM_DADO;
}

// SPX é situacional (sem data). v1 conservador: só known-bad/known-good geram sinal;
// status desconhecido/ausente → sem_dado (não alerta) para evitar falso-positivo.
const SPX_OK = new Set(["ativo", "active", "found", "vigente", "nossa", "ja_e_nossa", "ja e nossa"]);
const SPX_WARN = new Set(["pendente", "pending", "em_analise", "em analise", "outra_agencia", "outra agencia"]);
const SPX_CRIT = new Set([
  "inativo", "inactive", "bloqueado", "blocked", "nao_cadastrado", "nao cadastrado", "not_found", "nao_encontrado", "reprovado", "suspenso",
]);

function classifySpx(s) {
  if (!s) return SRC.SEM_DADO;
  const st = norm(s.status);
  if (st) {
    if (SPX_OK.has(st)) return SRC.OK;
    if (SPX_WARN.has(st)) return SRC.ATENCAO;
    if (SPX_CRIT.has(st)) return SRC.CRITICO;
  }
  if (s.encontrado === true && !st) return SRC.OK;
  return SRC.SEM_DADO;
}

/**
 * Consolida o veredito do conjunto a partir das três fontes normalizadas.
 * Pior severidade vence; SEM_DADO só quando nenhuma fonte tem dado.
 * @param {{ angellira?: object|null, brk?: object|null, spx?: object|null }} input
 * @returns {{ status: string, reasons: string[] }}
 */
export function consolidateVerdict({ angellira, brk, spx } = {}) {
  const parts = [
    { source: SOURCE.ANGELLIRA, sev: classifyAngellira(angellira) },
    { source: SOURCE.BRK, sev: classifyBrk(brk) },
    { source: SOURCE.SPX, sev: classifySpx(spx) },
  ];
  const present = parts.filter((p) => p.sev !== SRC.SEM_DADO);
  if (present.length === 0) return { status: VERDICT.SEM_DADO, reasons: [] };

  const crit = present.filter((p) => p.sev === SRC.CRITICO).map((p) => p.source);
  const warn = present.filter((p) => p.sev === SRC.ATENCAO).map((p) => p.source);

  let status;
  if (crit.length) status = VERDICT.CRITICO;
  else if (warn.length) status = VERDICT.ATENCAO;
  else status = VERDICT.OK;

  const reasons = status === VERDICT.CRITICO ? crit : status === VERDICT.ATENCAO ? warn : [];
  return { status, reasons };
}

function expiryMessage(sourceLabel, alertLevel, days) {
  const n = typeof days === "number" ? days : 0;
  return alertLevel === "EXPIRED" ? `${sourceLabel} vencido há ${Math.abs(n)}d` : `${sourceLabel} vence em ${n}d`;
}

function withId(alert) {
  return { ...alert, id: `${alert.entityType}:${alert.entityId}:${alert.source}:${alert.alertType}` };
}

/**
 * Deriva os alertas de um motorista já normalizado.
 * @param {object} d { entityId, displayName, document, angellira, brk, spx }
 * @returns {object[]}
 */
export function deriveDriverAlerts(d) {
  if (!d) return [];
  const base = {
    entityType: "motorista",
    entityId: d.entityId,
    displayName: d.displayName || null,
    document: d.document || null,
    plate: null,
    plateRole: null,
    linkedDriver: null,
  };
  const alerts = [];

  const a = d.angellira;
  if (a) {
    if (a.alertLevel === "EXPIRED" || a.alertLevel === "EXPIRING_SOON") {
      alerts.push({
        ...base, source: SOURCE.ANGELLIRA, alertType: ALERT_TYPE.EXPIRY,
        severity: a.alertLevel === "EXPIRED" ? SEVERITY.CRIT : SEVERITY.WARN,
        daysUntilExpiry: a.daysUntilExpiry ?? null, dueDate: a.validUntil ?? null,
        message: expiryMessage("Angellira", a.alertLevel, a.daysUntilExpiry), checkedAt: a.checkedAt ?? null,
      });
    } else if (classifyAngellira(a) === SRC.CRITICO) {
      alerts.push({
        ...base, source: SOURCE.ANGELLIRA, alertType: ALERT_TYPE.STATE, severity: SEVERITY.CRIT,
        daysUntilExpiry: null, dueDate: null, message: "Angellira não conforme", checkedAt: a.checkedAt ?? null,
      });
    }
  }

  const b = d.brk;
  if (b) {
    if (b.conjuntoApto === false) {
      alerts.push({
        ...base, source: SOURCE.BRK, alertType: ALERT_TYPE.STATE, severity: SEVERITY.CRIT,
        daysUntilExpiry: null, dueDate: null, message: "Conjunto BRK reprovado", checkedAt: b.checkedAt ?? null,
      });
    } else if (b.alertLevel === "EXPIRED" || b.alertLevel === "EXPIRING_SOON") {
      alerts.push({
        ...base, source: SOURCE.BRK, alertType: ALERT_TYPE.EXPIRY,
        severity: b.alertLevel === "EXPIRED" ? SEVERITY.CRIT : SEVERITY.WARN,
        daysUntilExpiry: b.daysUntilExpiry ?? null, dueDate: b.validUntil ?? null,
        message: expiryMessage("BRK", b.alertLevel, b.daysUntilExpiry), checkedAt: b.checkedAt ?? null,
      });
    }
  }

  const spxSev = classifySpx(d.spx);
  if (spxSev === SRC.CRITICO || spxSev === SRC.ATENCAO) {
    const label = (d.spx && (d.spx.statusText || d.spx.status)) || "situação irregular";
    alerts.push({
      ...base, source: SOURCE.SPX, alertType: ALERT_TYPE.STATE,
      severity: spxSev === SRC.CRITICO ? SEVERITY.CRIT : SEVERITY.WARN,
      daysUntilExpiry: null, dueDate: null, message: `SPX: ${label}`, checkedAt: (d.spx && d.spx.checkedAt) ?? null,
    });
  }

  return alerts.map(withId);
}

/**
 * Deriva os alertas de um veículo já normalizado (só Angellira hoje).
 * @param {object} v { entityId, plate, plateRole, linkedDriver, angellira }
 * @returns {object[]}
 */
export function deriveVehicleAlerts(v) {
  if (!v) return [];
  const a = v.angellira;
  if (!a || (a.alertLevel !== "EXPIRED" && a.alertLevel !== "EXPIRING_SOON")) return [];
  const alert = {
    entityType: "veiculo",
    entityId: v.entityId,
    displayName: v.plate || null,
    document: null,
    plate: v.plate || null,
    plateRole: v.plateRole || null,
    linkedDriver: v.linkedDriver || null,
    source: SOURCE.ANGELLIRA,
    alertType: ALERT_TYPE.EXPIRY,
    severity: a.alertLevel === "EXPIRED" ? SEVERITY.CRIT : SEVERITY.WARN,
    daysUntilExpiry: a.daysUntilExpiry ?? null,
    dueDate: a.validUntil ?? null,
    message: expiryMessage("Angellira", a.alertLevel, a.daysUntilExpiry),
    checkedAt: a.checkedAt ?? null,
  };
  return [withId(alert)];
}

const SEV_RANK = { [SEVERITY.CRIT]: 0, [SEVERITY.WARN]: 1 };

function orderValue(a) {
  // Alertas de ESTADO (reprovado/inativo/não conforme) vão ao topo do grupo de severidade;
  // os de VENCIMENTO ordenam pelos dias restantes (mais vencido/mais próximo primeiro).
  if (a.alertType === ALERT_TYPE.STATE) return -1e9;
  return typeof a.daysUntilExpiry === "number" ? a.daysUntilExpiry : 1e9;
}

/** Ordena por urgência: crítico antes de atenção; dentro do grupo, estado e depois vencimento crescente. */
export function sortByUrgency(alerts) {
  return [...alerts].sort((x, y) => {
    const sr = (SEV_RANK[x.severity] ?? 9) - (SEV_RANK[y.severity] ?? 9);
    if (sr !== 0) return sr;
    const ov = orderValue(x) - orderValue(y);
    if (ov !== 0) return ov;
    return String(x.id).localeCompare(String(y.id));
  });
}
