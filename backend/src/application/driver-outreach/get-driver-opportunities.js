/**
 * driver-outreach — use-case: monta o "bundle" de um motorista a partir dos
 * dados reais (planilha Shopee, cadastros pendentes, leads, cargas OPEN), roda
 * os detectores puros (domain/driver-outreach) e devolve as oportunidades já
 * com a mensagem + link wa.me prontos para o operador disparar (Wave A).
 *
 * Tolerante a tabelas ausentes (42P01): funciona antes da migration
 * 20260707120000 estar aplicada — apenas trata opt-out/log como vazios.
 */

import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { getSaoPauloWallClock } from "../../domain/sao-paulo-time.js";
import { toIsoDate } from "../../domain/recurrence.js";
import {
  OUTREACH_TRIGGERS,
  detectOpportunitiesForDriver,
  extractUf,
  normalizeText,
} from "../../domain/driver-outreach/detection.js";
import {
  buildDriverWhatsAppUrl,
  composeOutreachMessage,
  composeSuggestedLoadMessage,
} from "./messages.js";
import { checkAngelliraVigencia } from "./angellira-check.js";

const MAX_SUGGESTED_LOADS = 12;

/** Cargas OPEN que casam com as preferências inferidas do motorista. */
function buildSuggestedLoads(prefData, openLoads, { nome, phone, optedOut }) {
  const ufSet = new Set(
    [prefData.homeBaseUf, ...(prefData.topDestinoUf || [])].filter(Boolean),
  );
  const routeSet = new Set((prefData.topRoutes || []).map((r) => r.key));
  const scored = [];
  for (const l of openLoads) {
    const routeKey = `${normalizeText(l.origem)} -> ${normalizeText(l.destino)}`;
    const oUf = extractUf(l.origem);
    const dUf = extractUf(l.destino);
    let score = 0;
    if (routeSet.has(routeKey)) score = 3;
    else if (ufSet.has(oUf) && ufSet.has(dUf)) score = 2;
    else if (ufSet.has(oUf) || ufSet.has(dUf)) score = 1;
    if (score === 0) continue;
    scored.push({ score, load: l });
  }
  scored.sort(
    (a, b) => b.score - a.score || String(a.load.dateIso).localeCompare(String(b.load.dateIso)),
  );
  return scored.slice(0, MAX_SUGGESTED_LOADS).map(({ load }) => ({
    id: load.id,
    origem: load.origem,
    destino: load.destino,
    dateIso: load.dateIso,
    perfil: load.perfil,
    whatsappUrl: optedOut
      ? null
      : buildDriverWhatsAppUrl(phone, composeSuggestedLoadMessage(nome, load)),
  }));
}

const onlyDigits = (v) => String(v || "").replace(/\D/g, "");

function isMissingTableError(err) {
  return Boolean(err) && (err.code === "42P01" || /relation .* does not exist/i.test(err.message || ""));
}

/** Cargas passadas do motorista (nome) a partir do snapshot da planilha Shopee. */
async function loadSheetLoads(client, nomeNorm, todayIso) {
  if (!nomeNorm) return [];
  const { rows } = await client.query(
    `SELECT rows_json FROM public.sheet_monitor_snapshot WHERE id = 1`,
  );
  const arr = Array.isArray(rows[0]?.rows_json) ? rows[0].rows_json : [];
  const loads = [];
  for (const r of arr) {
    if (normalizeText(r?.motoristas) !== nomeNorm) continue;
    const d = String(r?.data || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > todayIso) continue;
    loads.push({ origem: r.origem || "", destino: r.destino || "", perfil: null, dateIso: d });
  }
  return loads;
}

/** Cadastro em andamento (draft/pendente) do motorista, se houver. */
async function loadRegistration(client, cpfDigits) {
  if (!cpfDigits) return null;
  let rows;
  try {
    // Filtra pelo CPF no SQL (armazenado em dígitos em dados->motorista->cpf).
    // Antes lia o `dados` de TODOS os cadastros não-finalizados; uma única linha
    // com byte nulo (0x00) na coluna quebrava a query inteira ("invalid byte
    // sequence for encoding UTF8: 0x00") e derrubava o painel de oportunidades
    // para todo motorista. Filtrando, só o cadastro do motorista alvo é lido.
    ({ rows } = await client.query(
      `SELECT status, dados, created_at
         FROM public.pending_driver_registrations
        WHERE status NOT IN ('concluido', 'aprovado', 'rejeitado')
          AND dados->'motorista'->>'cpf' = $1
        ORDER BY created_at DESC`,
      [cpfDigits],
    ));
  } catch (err) {
    if (isMissingTableError(err)) return null;
    throw err;
  }
  for (const r of rows) {
    const dados = r.dados || {};
    const mot = dados.motorista || {};
    if (onlyDigits(mot.cpf) !== cpfDigits) continue;
    return {
      status: r.status,
      currentStep: dados.__currentStep ?? null,
      hasProtocolo: Object.prototype.hasOwnProperty.call(dados, "protocolo"),
      createdAt: r.created_at,
      phone: mot.telefone ?? null,
    };
  }
  return null;
}

/** Última candidatura pública (lead) do motorista por CPF. */
async function loadLead(client, cpfDigits) {
  if (!cpfDigits) return null;
  let rows;
  try {
    ({ rows } = await client.query(
      `SELECT status, created_at, phone
         FROM public.load_public_leads
        WHERE cpf = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [cpfDigits],
    ));
  } catch (err) {
    if (isMissingTableError(err)) return null;
    throw err;
  }
  return rows[0]
    ? { status: rows[0].status, createdAt: rows[0].created_at, phone: rows[0].phone }
    : null;
}

/** Rotas em que o motorista SE CANDIDATOU (leads → carga). Parte 2. */
async function loadAppliedLoads(client, cpfDigits) {
  if (!cpfDigits) return [];
  let rows;
  try {
    ({ rows } = await client.query(
      `SELECT c.origem, c.destino, c.perfil, c.data
         FROM public.load_public_leads l
         JOIN public.cargas c ON c.id = l.load_id
        WHERE l.cpf = $1`,
      [cpfDigits],
    ));
  } catch (err) {
    if (isMissingTableError(err)) return [];
    throw err;
  }
  return rows.map((r) => ({
    origem: r.origem || "",
    destino: r.destino || "",
    perfil: r.perfil ?? null,
    dateIso: r.data ? toIsoDate(r.data) : null,
  }));
}

/** Melhor carga OPEN que casa com o histórico do motorista (rota/UF). Parte 1. */
function pickOpenLoadForDriver(loaded, applied, openLoads) {
  const hist = [...(loaded || []), ...(applied || [])];
  if (!hist.length || !openLoads.length) return null;
  const routeSet = new Set(hist.map((l) => `${normalizeText(l.origem)} -> ${normalizeText(l.destino)}`));
  const ufSet = new Set();
  for (const l of hist) {
    const o = extractUf(l.origem);
    const d = extractUf(l.destino);
    if (o) ufSet.add(o);
    if (d) ufSet.add(d);
  }
  let best = null;
  let bestScore = 0;
  for (const l of openLoads) {
    const rk = `${normalizeText(l.origem)} -> ${normalizeText(l.destino)}`;
    const oUf = extractUf(l.origem);
    const dUf = extractUf(l.destino);
    let score = 0;
    if (routeSet.has(rk)) score = 3;
    else if (ufSet.has(oUf) && ufSet.has(dUf)) score = 2;
    else if (ufSet.has(oUf) || ufSet.has(dUf)) score = 1;
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }
  if (!best) return null;
  return `${best.origem} → ${best.destino}${best.dateIso ? ` (${best.dateIso})` : ""}`;
}

/**
 * Cargas OPEN candidatas a retorno. Filtra em JS por data >= hoje (BRT) para
 * NÃO sugerir cargas passadas — o filtro no SQL exigiria comparar data BRT com
 * BRT-hoje, e as datas em `cargas.data` são armazenadas como DATE (dia local
 * do carregamento). Filtro por string ISO é seguro (YYYY-MM-DD comparável).
 */
async function loadOpenLoads(client, todayIso) {
  const { rows } = await client.query(
    `SELECT id, origem, destino, perfil, data FROM public.cargas WHERE status = 'OPEN'`,
  );
  return rows
    .map((r) => ({
      id: r.id,
      origem: r.origem,
      destino: r.destino,
      perfil: r.perfil ?? null,
      dateIso: r.data ? toIsoDate(r.data) : null,
    }))
    .filter((l) => !l.dateIso || String(l.dateIso) >= String(todayIso));
}

async function isOptedOut(client, cpfDigits, nomeNorm) {
  try {
    const { rows } = await client.query(
      `SELECT 1 FROM public.driver_outreach_optout WHERE driver_key = $1 OR driver_key = $2 LIMIT 1`,
      [cpfDigits || " ", nomeNorm || " "],
    );
    return rows.length > 0;
  } catch (err) {
    if (isMissingTableError(err)) return false;
    throw err;
  }
}

async function resolvePhone(client, cpfDigits, fallbacks) {
  if (cpfDigits) {
    try {
      const { rows } = await client.query(
        `SELECT telefone FROM public.motoristas_historico WHERE cpf = $1 LIMIT 1`,
        [cpfDigits],
      );
      if (rows[0]?.telefone) return rows[0].telefone;
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
    }
  }
  return fallbacks.find((v) => v) ?? null;
}

function buildMessageCtx(opp) {
  const d = opp.data || {};
  if (opp.trigger === OUTREACH_TRIGGERS.CHURN) return { daysSinceLastLoad: d.daysSinceLastLoad };
  if (opp.trigger === OUTREACH_TRIGGERS.LOST_REGISTRATION) return { currentStep: d.currentStep };
  if (opp.trigger === OUTREACH_TRIGGERS.RETURN_LOAD) {
    return { fromUf: d.fromUf, suggestion: d.suggestions?.[0] };
  }
  return {};
}

/**
 * @param {{cpf?:string, nome?:string, phone?:string, options?:object, correlationId?:string}} input
 * @returns {Promise<{driver:object, optedOut:boolean, opportunities:Array<object>, meta:object}>}
 */
export async function getDriverOpportunities({
  cpf,
  nome,
  phone,
  options = {},
  correlationId,
} = {}) {
  const cpfDigits = onlyDigits(cpf);
  const nomeNorm = normalizeText(nome);
  const now = new Date();
  const todayIso = getSaoPauloWallClock(now).dateIso;

  return withPgClient(async (client) => {
    // Sequencial: um único client pg não executa queries concorrentes
    // (Promise.all dispara o warning "client is already executing a query").
    const loads = await loadSheetLoads(client, nomeNorm, todayIso);
    const appliedLoads = await loadAppliedLoads(client, cpfDigits);
    const registration = await loadRegistration(client, cpfDigits);
    const lead = await loadLead(client, cpfDigits);
    const openLoads = await loadOpenLoads(client, todayIso);
    const optedOut = await isOptedOut(client, cpfDigits, nomeNorm);

    const lastLoadIso = loads.reduce((max, l) => (l.dateIso > max ? l.dateIso : max), "");
    const resolvedPhone = await resolvePhone(client, cpfDigits, [
      lead?.phone,
      registration?.phone,
      phone,
    ]);

    const bundle = {
      todayIso,
      now,
      loads,
      appliedLoads,
      lastLoadIso: lastLoadIso || null,
      totalLoads: loads.length,
      registration,
      lead,
      claim: null,
    };

    let detected = detectOpportunitiesForDriver(bundle, { openLoads }, options);

    // Parte 4a: não cobrar "cadastro não finalizado" de quem já tem cadastro
    // VIGENTE no Angellira (o status local não é confiável). Só consulta quando
    // o gatilho foi detectado (evita chamada externa desnecessária).
    if (cpfDigits && detected.some((o) => o.trigger === OUTREACH_TRIGGERS.LOST_REGISTRATION)) {
      const vig = await checkAngelliraVigencia(cpfDigits);
      if (vig.vigente) detected = detected.filter((o) => o.trigger !== OUTREACH_TRIGGERS.LOST_REGISTRATION);
    }

    // Parte 1: mensagem de churn cita a última rota do motorista + uma carga
    // OPEN existente que casa (sem criar carga nova).
    const lastLoad = loads.length ? loads.reduce((a, b) => (String(b.dateIso) > String(a.dateIso) ? b : a)) : null;
    const churnLastRoute = lastLoad?.origem && lastLoad?.destino ? `${lastLoad.origem} → ${lastLoad.destino}` : null;
    const churnOpenLoad = pickOpenLoadForDriver(loads, appliedLoads, openLoads);

    const opportunities = detected.map((opp) => {
      const ctx = { nome, ...buildMessageCtx(opp) };
      if (opp.trigger === OUTREACH_TRIGGERS.CHURN) {
        ctx.lastRoute = churnLastRoute;
        ctx.openLoad = churnOpenLoad;
      }
      const text = composeOutreachMessage(opp.trigger, ctx);
      const whatsappUrl = text && !optedOut ? buildDriverWhatsAppUrl(resolvedPhone, text) : null;
      let data = opp.data;
      if (opp.trigger === OUTREACH_TRIGGERS.PREFERENCES) {
        data = {
          ...opp.data,
          suggestedLoads: buildSuggestedLoads(opp.data, openLoads, {
            nome,
            phone: resolvedPhone,
            optedOut,
          }),
        };
      }
      return { ...opp, data, message: text, whatsappUrl };
    });

    return {
      driver: { cpf: cpfDigits || null, nome: nome || null, phone: resolvedPhone || null },
      optedOut,
      opportunities,
      meta: {
        correlationId: correlationId || null,
        generatedAt: now.toISOString(),
        totalLoads: loads.length,
        lastLoadIso: lastLoadIso || null,
      },
    };
  });
}
