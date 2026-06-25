/**
 * Resolve a vigência (rad_expire_date) do dossiê de gerenciamento de risco para
 * o disparo SPX, consultando o status no AngelLira via unificada-bot
 * (/relatorio/status → item.limitDate). Espelha getRiskExpiryFromAngellira da
 * produção, mas usando a API do sidecar Lamônica.
 *
 * REGRA: o SPX REJEITA rad_expire_date nulo. Então quando não resolve a vigência
 * real, cai em defaultExpiryIso() (hoje + RISK_DOC_VALIDITY_DAYS). NUNCA null.
 *
 * Cache curto (10min) só de resultados found:true — found:false é transitório
 * (o Risk Doc pode ter acabado de ser gerado), então não cacheia.
 *
 * Epic SPX (extensão Lamônica) — Fase 4 (orquestração).
 */

import { consultarStatus } from "../../../../infrastructure/cadastro-bots/unificada-bot-client.js";
import { logStructuredEvent } from "../../../../infrastructure/security-log.js";

const RISK_DOC_VALIDITY_DAYS = Number(process.env.RISK_DOC_VALIDITY_DAYS || 90);
const CACHE_TTL_MS = 10 * 60 * 1000;
const _cache = new Map(); // cpf(dígitos) -> { at, value }

/** Data de validade default: hoje + N dias, em 'YYYY-MM-DD'. Nunca retorna null. */
export function defaultExpiryIso(days = RISK_DOC_VALIDITY_DAYS) {
  const n = Number.isFinite(days) ? days : 90;
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function _isRealDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const ano = +m[1], mes = +m[2], dia = +m[3];
  return mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31 && ano >= 2000 && ano <= 2100;
}

/** Normaliza limitDate (ISO datetime / 'YYYY-MM-DD' / 'DD/MM/YYYY') → 'YYYY-MM-DD' ou null. */
function normalizeIsoDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    return _isRealDate(iso) ? iso : null;
  }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return _isRealDate(iso) ? iso : null;
  }
  return null;
}

/**
 * Consulta a vigência do gerenciamento de risco para um CPF.
 * @returns {Promise<{ok:boolean, found:boolean, rad_expire_date:string|null, status_description?:string|null}>}
 *          rad_expire_date é a data REAL quando found; null caso contrário (o
 *          pipeline deve cair em defaultExpiryIso()).
 */
export async function consultRiskExpiry({ cpf, correlationId } = {}) {
  const key = String(cpf || "").replace(/\D/g, "");
  if (!key) return { ok: false, found: false, rad_expire_date: null };

  const cached = _cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    const r = await consultarStatus({ queryValue: key, qFor: "cpf", correlationId });
    const item = (r && r.item) || {};
    const iso = normalizeIsoDate(item.limitDate ?? item.limit_date ?? item.vigencia ?? null);
    const value = iso
      ? { ok: true, found: true, rad_expire_date: iso, status_description: r?.status_description ?? null }
      : { ok: true, found: false, rad_expire_date: null, status_description: r?.status_description ?? null };
    if (value.found) _cache.set(key, { at: Date.now(), value }); // só cacheia found:true (transitório)
    return value;
  } catch (err) {
    logStructuredEvent("warn", "spx.risk_expiry.failed", {
      correlationId: correlationId ?? null,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, found: false, rad_expire_date: null };
  }
}

export function __clearRiskExpiryCacheForTests() {
  _cache.clear();
}
