// backend/src/infrastructure/infosimples/infosimples-client.js
//
// Cliente HTTP para a API Infosimples — endpoint cnis/pre-inscricao usado pelo
// wizard /cadastro v2 para auto-preencher o PIS dos proprietarios PF (cavalo +
// carretas).
//
// Decisoes (vide .planning/quick/260515-loi-.../260515-loi-CONTEXT.md):
//   - Mock opt-in via env INFOSIMPLES_MOCK=1 (default: real). Gating no client,
//     handlers/use-case agnosticos.
//   - Auditoria de cobranca: logar header.signature/price/billable em todo
//     response (sucesso ou erro mapeado), via security-log.
//   - Sem circuit-breaker nesta v1 (custo de R$ 0,24 por consulta + uso raro no
//     wizard). Retry 3x backoff exponencial.
//
// Custo: R$ 0,24 / consulta real bem-sucedida.

import "../config/load-env.js";
import { logStructuredEvent } from "../security-log.js";

const INFOSIMPLES_URL =
  "https://api.infosimples.com/api/v2/consultas/cnis/pre-inscricao";
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];
// Mock PIS: algoritmicamente valido (passa isValidPis no frontend).
// digits 1..9 + 0, DV calculado = 0.
const MOCK_PIS = "12345678900";

function parsePositiveIntegerEnv(name, fallbackValue) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) return fallbackValue;
  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : fallbackValue;
}

function getTimeoutMs() {
  return parsePositiveIntegerEnv("INFOSIMPLES_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
}

function isMockEnabled() {
  const raw = (process.env.INFOSIMPLES_MOCK ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

function maskCpf(digits) {
  const value = String(digits || "");
  if (value.length === 0) return "***";
  return `${value.slice(0, 3)}***`;
}

function normalizeCpfDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function isValidIsoDate(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || getTimeoutMs());
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Consulta o PIS no CNIS da Infosimples (cnis/pre-inscricao).
 *
 * @param {object} params
 * @param {string} params.cpf  CPF (qualquer formato — sera normalizado para digits).
 * @param {string} params.nome Nome completo (validacao: trim, min 1 char).
 * @param {string} params.dataNascimento Data ISO `yyyy-mm-dd`.
 * @param {string} [params.correlationId]
 *
 * @returns {Promise<{ pis: string | null, source: "infosimples" | "mock", header: object | null }>}
 *
 * @throws Error("INFOSIMPLES_INVALID_INPUT")
 * @throws Error("INFOSIMPLES_NOT_CONFIGURED")
 * @throws Error("INFOSIMPLES_SOURCE_TIMEOUT")
 * @throws Error("INFOSIMPLES_SOURCE_UNAVAILABLE")
 * @throws Error("INFOSIMPLES_NO_CREDIT")
 * @throws Error("INFOSIMPLES_API_ERROR:<code>")
 */
export async function lookupPisCnis({ cpf, nome, dataNascimento, correlationId } = {}) {
  const cpfDigits = normalizeCpfDigits(cpf);
  const nomeTrim = typeof nome === "string" ? nome.trim() : "";

  if (cpfDigits.length !== 11 || nomeTrim.length === 0 || !isValidIsoDate(dataNascimento)) {
    throw new Error("INFOSIMPLES_INVALID_INPUT");
  }

  if (isMockEnabled()) {
    logStructuredEvent("info", "infosimples.lookup_pis.mock_hit", {
      correlationId: correlationId || null,
      cpfMasked: maskCpf(cpfDigits),
    });
    return { pis: MOCK_PIS, source: "mock", header: null };
  }

  const token = process.env.INFOSIMPLES_TOKEN?.trim();
  if (!token) {
    throw new Error("INFOSIMPLES_NOT_CONFIGURED");
  }

  const body = new URLSearchParams({
    token,
    cpf: cpfDigits,
    nome: nomeTrim,
    data_nascimento: dataNascimento,
  });

  let lastTimeoutCode = null;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(INFOSIMPLES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });
    } catch (networkError) {
      logStructuredEvent("warn", "infosimples.lookup_pis.network_error", {
        correlationId: correlationId || null,
        attempt: attempt + 1,
        message: networkError instanceof Error ? networkError.message : String(networkError),
      });

      if (attempt < RETRY_DELAYS_MS.length - 1) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new Error("INFOSIMPLES_SOURCE_TIMEOUT");
    }

    let payload;
    try {
      payload = await response.json();
    } catch (parseError) {
      logStructuredEvent("warn", "infosimples.lookup_pis.parse_error", {
        correlationId: correlationId || null,
        attempt: attempt + 1,
        httpStatus: response.status,
        message: parseError instanceof Error ? parseError.message : String(parseError),
      });

      if (attempt < RETRY_DELAYS_MS.length - 1) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new Error("INFOSIMPLES_API_ERROR:invalid_json");
    }

    const apiCode = payload?.code;
    const header = payload?.header || null;

    // Auditoria de cobranca — SEMPRE logar header (sucesso ou erro).
    logStructuredEvent("info", "infosimples.lookup_pis.response", {
      correlationId: correlationId || null,
      cpfMasked: maskCpf(cpfDigits),
      code: apiCode,
      signature: header?.signature || null,
      price: header?.price ?? null,
      billable: header?.billable ?? null,
      attempt: attempt + 1,
    });

    if (apiCode === 200) {
      const nit = payload?.data?.[0]?.nit;
      if (nit) {
        return {
          pis: String(nit).replace(/\D/g, ""),
          source: "infosimples",
          header,
        };
      }
      return { pis: null, source: "infosimples", header };
    }

    if (apiCode === 612 || apiCode === 613 || apiCode === 504) {
      lastTimeoutCode = apiCode;
      if (attempt < RETRY_DELAYS_MS.length - 1) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw new Error("INFOSIMPLES_SOURCE_TIMEOUT");
    }

    // 615 = fonte oficial pausada pela Infosimples (ex.: CNIS/INSS instavel).
    // Nao adianta retry: a Infosimples ja pausou ativamente o servico.
    // Validado em smoke 2026-05-15 (todos billable: false, price: 0.0).
    if (apiCode === 615) {
      throw new Error("INFOSIMPLES_SOURCE_UNAVAILABLE");
    }

    if (apiCode === 620) {
      throw new Error("INFOSIMPLES_NO_CREDIT");
    }

    throw new Error(`INFOSIMPLES_API_ERROR:${apiCode ?? "unknown"}`);
  }

  // Fallback: laco esgotado (nao deveria acontecer — saimos via throw acima).
  throw new Error(
    lastTimeoutCode ? "INFOSIMPLES_SOURCE_TIMEOUT" : "INFOSIMPLES_API_ERROR:retry_exhausted",
  );
}

/**
 * Reset utilizado em testes — reservado para estado futuro (cache, circuit breaker).
 * Atualmente no-op.
 */
export function resetInfosimplesClientStateForTests() {
  // no-op por enquanto.
}
