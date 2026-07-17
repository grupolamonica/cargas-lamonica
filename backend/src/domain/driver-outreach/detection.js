/**
 * driver-outreach — regras PURAS de detecção de oportunidades de contato com
 * motoristas (Wave A). Sem I/O: recebe um "bundle" normalizado por motorista
 * (montado na camada application a partir da planilha Shopee, cadastros, leads
 * e cargas abertas) e devolve as oportunidades detectadas. Mantém a lógica de
 * negócio testável e desacoplada do banco.
 *
 * Gatilhos:
 *   churn             — já carregou mas parou há N dias (win-back)
 *   lost_registration — cadastro iniciado e não finalizado
 *   abandonment       — candidatura parada / no-show / reserva expirada
 *   return_load       — carga OPEN de retorno que casa com o trajeto do motorista
 *   preferences       — perfil de preferências inferido (exibição, sem envio)
 */

export const OUTREACH_TRIGGERS = Object.freeze({
  CHURN: "churn",
  LOST_REGISTRATION: "lost_registration",
  ABANDONMENT: "abandonment",
  RETURN_LOAD: "return_load",
  PREFERENCES: "preferences",
});

export const DEFAULT_OUTREACH_OPTIONS = Object.freeze({
  churnDays: 30,
  minLoadsForChurn: 1,
  minLoadsForPreferences: 2,
  staleRegistrationHours: 24,
  abandonedLeadHours: 48,
  maxReturnLoadSuggestions: 3,
});

// Passos do wizard de cadastro v2 (ordem canônica — ver computeNextStep.ts).
// Usado para dizer ao operador o que falta o motorista enviar.
export const WIZARD_STEPS = Object.freeze([
  { key: "step-a", label: "Dados do motorista (CNH, selfie, telefone, endereço)" },
  { key: "step-b", label: "Documentos do cavalo (CRLV)" },
  { key: "step-c", label: "Proprietário e ANTT do cavalo" },
  { key: "step-d", label: "Documentos das carretas (CRLV)" },
  { key: "step-e", label: "Proprietário e ANTT das carretas" },
  { key: "confirmation", label: "Revisão e envio do cadastro" },
]);

// ── helpers puros ─────────────────────────────────────────────────────────────

/** Normaliza texto: remove acentos, uppercase, colapsa espaços. */
export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** UF = trecho após a última "/". "Jaboatão / PE" -> "PE"; fallback "". */
export function extractUf(place) {
  const s = String(place ?? "");
  const idx = s.lastIndexOf("/");
  return idx === -1 ? "" : normalizeText(s.slice(idx + 1));
}

function isoDayMs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}

/** Dias de calendário entre duas datas ISO (YYYY-MM-DD), em espaço UTC. */
export function diffCalendarDays(fromIso, toIso) {
  const a = isoDayMs(fromIso);
  const b = isoDayMs(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  const t = Date.parse(String(value ?? ""));
  return Number.isNaN(t) ? NaN : t;
}

/** Horas entre dois instantes (Date ou ISO). null se algum for inválido. */
export function diffHours(fromValue, toValue) {
  const a = toMs(fromValue);
  const b = toMs(toValue);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return (b - a) / 3_600_000;
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function topN(map, n) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

function mostRecentLoad(loads) {
  if (!Array.isArray(loads) || loads.length === 0) return null;
  return loads.reduce((a, b) => (String(b.dateIso) > String(a.dateIso) ? b : a));
}

function homeBaseUf(loads) {
  const counts = new Map();
  for (const l of loads || []) {
    const uf = extractUf(l.origem);
    if (uf) bump(counts, uf);
  }
  return topN(counts, 1)[0]?.key ?? "";
}

/**
 * Frequência de rotas com rótulo legível. Retorna [{ key, count, label }] ordenado.
 * `key` = normalizado (p/ matching); `label` = "Origem → Destino" (p/ exibir).
 */
function routeStats(list) {
  const m = new Map();
  for (const l of list || []) {
    if (!l?.origem || !l?.destino) continue;
    const key = `${normalizeText(l.origem)} -> ${normalizeText(l.destino)}`;
    const entry = m.get(key) || { count: 0, label: `${l.origem} → ${l.destino}` };
    entry.count += 1;
    m.set(key, entry);
  }
  return [...m.entries()]
    .sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1))
    .map(([key, v]) => ({ key, count: v.count, label: v.label }));
}

// ── detectores ────────────────────────────────────────────────────────────────

/** #1 churn — motorista com histórico de cargas, sem carregar há >= N dias. */
export function detectChurn(bundle, options = {}) {
  const o = { ...DEFAULT_OUTREACH_OPTIONS, ...options };
  const totalLoads = Number(bundle.totalLoads || 0);
  if (!bundle.lastLoadIso || totalLoads < o.minLoadsForChurn) return null;
  const days = diffCalendarDays(bundle.lastLoadIso, bundle.todayIso);
  if (days == null || days < o.churnDays) return null;
  return {
    trigger: OUTREACH_TRIGGERS.CHURN,
    severity: days >= o.churnDays * 3 ? "high" : "medium",
    reason: `Sem carregar há ${days} dias (${totalLoads} carga(s) no histórico).`,
    data: { daysSinceLastLoad: days, lastLoadIso: bundle.lastLoadIso, totalLoads },
  };
}

/**
 * #2 preferences — perfil inferido do histórico. Considera cargas CARREGADAS
 * (planilha) e cargas em que o motorista SE CANDIDATOU (bundle.appliedLoads),
 * para sugerir as melhores cargas e mostrar as rotas que ele mais roda/candidata.
 */
export function inferPreferences(bundle, options = {}) {
  const o = { ...DEFAULT_OUTREACH_OPTIONS, ...options };
  const loaded = Array.isArray(bundle.loads) ? bundle.loads : [];
  const applied = Array.isArray(bundle.appliedLoads) ? bundle.appliedLoads : [];
  const all = [...loaded, ...applied];
  if (all.length < o.minLoadsForPreferences) return null;

  const perfis = new Map();
  const destUf = new Map();
  for (const l of all) {
    if (l.perfil) bump(perfis, normalizeText(l.perfil));
    const du = extractUf(l.destino);
    if (du) bump(destUf, du);
  }

  const topRoutes = routeStats(all).slice(0, 5);
  const topRoutesLoaded = routeStats(loaded).slice(0, 3);
  const topRoutesApplied = routeStats(applied).slice(0, 3);

  return {
    trigger: OUTREACH_TRIGGERS.PREFERENCES,
    severity: "low",
    reason:
      `Perfil inferido de ${loaded.length} carga(s) carregada(s)` +
      (applied.length ? ` e ${applied.length} candidatura(s).` : "."),
    data: {
      sampleSize: all.length,
      loadedCount: loaded.length,
      appliedCount: applied.length,
      topRoutes,
      topRoutesLoaded,
      topRoutesApplied,
      topPerfil: topN(perfis, 1)[0]?.key ?? null,
      homeBaseUf: homeBaseUf(all) || null,
      topDestinoUf: topN(destUf, 3).map((r) => r.key),
    },
  };
}

/** #3 lost_registration — cadastro iniciado e não finalizado há >= N horas. */
export function detectLostRegistration(bundle, options = {}) {
  const o = { ...DEFAULT_OUTREACH_OPTIONS, ...options };
  const reg = bundle.registration;
  if (!reg) return null;
  const status = normalizeText(reg.status);
  // migrado_bot = já migrado/enviado ao Angellira → não é "cadastro não finalizado".
  const finished =
    Boolean(reg.hasProtocolo) ||
    ["CONCLUIDO", "APROVADO", "REJEITADO", "MIGRADO_BOT"].includes(status);
  if (finished) return null;
  const ageHours = diffHours(reg.createdAt, bundle.now);
  if (ageHours == null || ageHours < o.staleRegistrationHours) return null;

  // "O que falta": passos a partir de onde parou (inclusive) até o envio.
  const curKey = String(reg.currentStep || "").toLowerCase().trim();
  let idx = WIZARD_STEPS.findIndex((s) => s.key === curKey);
  if (idx < 0) idx = 0; // passo desconhecido/tela0 => tudo pendente
  const completedSteps = WIZARD_STEPS.slice(0, idx).map((s) => ({ ...s }));
  const missingSteps = WIZARD_STEPS.slice(idx).map((s) => ({ ...s }));
  const currentStepLabel = WIZARD_STEPS[idx]?.label ?? null;

  return {
    trigger: OUTREACH_TRIGGERS.LOST_REGISTRATION,
    severity: "high",
    reason:
      `Cadastro iniciado e não finalizado há ${Math.floor(ageHours)}h` +
      (currentStepLabel ? ` — parou em "${currentStepLabel}".` : "."),
    data: {
      status: reg.status ?? null,
      currentStep: reg.currentStep ?? null,
      currentStepLabel,
      ageHours: Math.floor(ageHours),
      completedSteps,
      missingSteps,
    },
  };
}

// lead_stalled NÃO é abandono do motorista: ele se candidatou e está aguardando
// a alocação da nossa parte. Rotulamos como candidatura (positivo/neutro).
const ABANDON_LABELS = Object.freeze({
  lead_stalled: "candidatura enviada, aguardando alocação",
  claim_noshow: "no-show em carga reservada",
  claim_expired: "reserva expirada sem confirmar",
  claim_cancelled: "reserva cancelada",
});

/** #4 abandonment — candidatura QUEUED (aguardando) e/ou no-show/reserva encerrada. */
export function detectAbandonment(bundle, options = {}) {
  const o = { ...DEFAULT_OUTREACH_OPTIONS, ...options };
  const signals = [];
  if (bundle.lead) {
    const st = normalizeText(bundle.lead.status);
    const ageH = diffHours(bundle.lead.createdAt, bundle.now);
    if (st === "QUEUED" && ageH != null && ageH >= o.abandonedLeadHours) {
      signals.push({
        kind: "lead_stalled",
        label: ABANDON_LABELS.lead_stalled,
        ageHours: Math.floor(ageH),
      });
    }
  }
  if (bundle.claim) {
    const cs = normalizeText(bundle.claim.status);
    if (["NOSHOW", "EXPIRED", "CANCELLED"].includes(cs)) {
      const kind = `claim_${cs.toLowerCase()}`;
      signals.push({ kind, label: ABANDON_LABELS[kind] || kind });
    }
  }
  if (signals.length === 0) return null;
  // Candidatura aguardando alocação NÃO é sinal de abandono/oportunidade —
  // não gera card. Só reserve/noshow/expired/cancelled disparam.
  const actionable = signals.filter((s) => s.kind !== "lead_stalled");
  if (actionable.length === 0) return null;
  const labels = actionable.map((s) => ABANDON_LABELS[s.kind] || s.kind);
  return {
    trigger: OUTREACH_TRIGGERS.ABANDONMENT,
    severity: "medium",
    reason: `Abandono detectado: ${labels.join("; ")}.`,
    data: { signals: actionable },
  };
}

/** #5 return_load — cargas OPEN saindo da UF do último destino do motorista. */
export function detectReturnLoad(bundle, context = {}, options = {}) {
  const o = { ...DEFAULT_OUTREACH_OPTIONS, ...options };
  const openLoads = Array.isArray(context.openLoads) ? context.openLoads : [];
  const last = mostRecentLoad(bundle.loads);
  const fromUf = last ? extractUf(last.destino) : "";
  if (!fromUf || openLoads.length === 0) return null;
  const baseUf = homeBaseUf(bundle.loads);
  const suggestions = openLoads
    .filter((l) => extractUf(l.origem) === fromUf)
    .map((l) => ({
      id: l.id ?? null,
      origem: l.origem,
      destino: l.destino,
      dateIso: l.dateIso ?? null,
      perfil: l.perfil ?? null,
      backToBase: baseUf ? extractUf(l.destino) === baseUf : false,
    }))
    .sort(
      (a, b) =>
        Number(b.backToBase) - Number(a.backToBase) ||
        String(a.dateIso).localeCompare(String(b.dateIso)),
    )
    .slice(0, o.maxReturnLoadSuggestions);
  if (suggestions.length === 0) return null;
  return {
    trigger: OUTREACH_TRIGGERS.RETURN_LOAD,
    severity: suggestions.some((s) => s.backToBase) ? "high" : "medium",
    reason:
      `${suggestions.length} carga(s) de retorno saindo de ${fromUf}` +
      (baseUf ? ` (base ${baseUf}).` : "."),
    data: { fromUf, homeBaseUf: baseUf || null, suggestions },
  };
}

/**
 * Compositor: roda todos os detectores sobre um bundle e devolve as
 * oportunidades encontradas (ações primeiro, preferências por último).
 * @returns {Array<{trigger:string, severity:string, reason:string, data:object}>}
 */
export function detectOpportunitiesForDriver(bundle, context = {}, options = {}) {
  const opts = { ...DEFAULT_OUTREACH_OPTIONS, ...options };
  return [
    detectChurn(bundle, opts),
    detectLostRegistration(bundle, opts),
    detectAbandonment(bundle, opts),
    detectReturnLoad(bundle, context, opts),
    inferPreferences(bundle, opts),
  ].filter(Boolean);
}
