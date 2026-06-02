/**
 * Pre-check Angellira: consulta vigência do motorista (por CPF) e dos veículos
 * (por placa). Usa o cliente `angellira-client.js` existente (que fala com
 * `api.angellira.com.br/profile/query`), sem tocar no bot — operação puramente
 * de leitura.
 *
 * Performance (DC-111 / 2026-05-29):
 * - Motorista + cavalo + carreta executam em PARALELO (Promise.allSettled).
 *   Cada query externa leva 3-5s; paralelizando, tempo total = max(...) ≈ 3-5s
 *   em vez de soma (9-15s).
 * - Cache server-side de 60s por (cadastroId) — operador re-abrindo modal usa
 *   cache. Coerente com TTL do resultCache do angellira-client.js.
 *
 * Epic DC-111 / Sprint 1 / DC-117.
 */

import {
  lookupAngelliraDriverByCpf,
  lookupAngelliraPlate,
} from "../../../../infrastructure/angellira/angellira-client.js";
import { extractPlacas } from "./payload-mapper.js";

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

// Cache server-side curto — chave (cadastroId), TTL 60s.
// Compartilha process com todas as instâncias do backend (single replica VPS).
const PRECHECK_CACHE = new Map();
const PRECHECK_CACHE_TTL_MS = 60_000;
const PRECHECK_CACHE_MAX_SIZE = 500;

function getCached(cadastroId) {
  const entry = PRECHECK_CACHE.get(cadastroId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    PRECHECK_CACHE.delete(cadastroId);
    return null;
  }
  return entry.value;
}

function setCached(cadastroId, value) {
  if (PRECHECK_CACHE.size >= PRECHECK_CACHE_MAX_SIZE) {
    PRECHECK_CACHE.delete(PRECHECK_CACHE.keys().next().value);
  }
  PRECHECK_CACHE.set(cadastroId, {
    value,
    expiresAt: Date.now() + PRECHECK_CACHE_TTL_MS,
  });
}

/** Invalida cache de um cadastro (chamado pelos dispatch use cases após sucesso). */
export function invalidateAngelliraPrecheckCache(cadastroId) {
  if (cadastroId) PRECHECK_CACHE.delete(cadastroId);
}

/**
 * Executa precheck para motorista + cavalo + carreta em PARALELO.
 *
 * @param {object} args
 * @param {object} args.cadastro       — row de pending_driver_registrations
 * @param {string} [args.correlationId]
 * @param {boolean} [args.skipCache]    — força refresh ignorando cache
 * @returns {Promise<{motorista, cavalo?, carreta?, _cached?: boolean, _durationMs?: number}>}
 */
export async function performAngelliraPrecheck({ cadastro, correlationId = null, skipCache = false }) {
  const dados = cadastro?.dados || {};
  const cpf = digitsOnly(dados?.motorista?.cpf);
  const { cavalo, carreta } = extractPlacas(dados);

  // Cache hit?
  if (!skipCache && cadastro?.id) {
    const cached = getCached(cadastro.id);
    if (cached) {
      return { ...cached, _cached: true, _durationMs: 0 };
    }
  }

  const startedAt = Date.now();
  const lookupOpts = correlationId
    ? { correlationId, sourceEvent: "operator.cadastro.angellira_precheck" }
    : { sourceEvent: "operator.cadastro.angellira_precheck" };

  // Monta promises só pros campos presentes. `null` indica "skip".
  const motoristaP = (cpf && cpf.length === 11)
    ? lookupAngelliraDriverByCpf(cpf, lookupOpts)
    : Promise.resolve({ status: "NOT_FOUND", reason: "CPF ausente ou inválido" });
  const cavaloP = cavalo
    ? lookupAngelliraPlate(cavalo, lookupOpts)
    : Promise.resolve(null);
  const carretaP = carreta
    ? lookupAngelliraPlate(carreta, lookupOpts)
    : Promise.resolve(null);

  // PARALELIZADO — sem await sequencial. Promise.allSettled garante que falha
  // de uma não afeta as outras (cada uma vira { status: 'UNAVAILABLE', error }).
  const [motoristaR, cavaloR, carretaR] = await Promise.allSettled([motoristaP, cavaloP, carretaP]);

  const out = {};
  out.motorista = motoristaR.status === "fulfilled"
    ? motoristaR.value
    : { status: "UNAVAILABLE", error: motoristaR.reason?.message || String(motoristaR.reason) };
  if (cavalo) {
    out.cavalo = cavaloR.status === "fulfilled"
      ? cavaloR.value
      : { status: "UNAVAILABLE", error: cavaloR.reason?.message || String(cavaloR.reason) };
  }
  if (carreta) {
    out.carreta = carretaR.status === "fulfilled"
      ? carretaR.value
      : { status: "UNAVAILABLE", error: carretaR.reason?.message || String(carretaR.reason) };
  }

  const durationMs = Date.now() - startedAt;
  out._cached = false;
  out._durationMs = durationMs;

  // Cacheia somente quando todas as consultas tiveram resposta válida
  // (incluindo NOT_FOUND); falhas (UNAVAILABLE) não cacheiam pra deixar retry.
  const allOk = Object.values(out).every((v) => !v || typeof v !== "object" || v.status !== "UNAVAILABLE");
  if (allOk && cadastro?.id) {
    setCached(cadastro.id, { motorista: out.motorista, cavalo: out.cavalo, carreta: out.carreta });
  }

  return out;
}
