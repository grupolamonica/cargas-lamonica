// B3 (DC-222 AC6): saúde dos sidecars de cadastro externo (Angellira/SPX/Unificada).
// Probe leve e read-only — o operador precisa saber, no /motoristas, se um robô
// está fora do ar; senão os cadastros falham "sem motivo aparente" e ele tenta às cegas.
import * as angelliraBot from "../../../infrastructure/cadastro-bots/angellira-bot-client.js";
import * as spxBot from "../../../infrastructure/cadastro-bots/spx-bot-client.js";
import * as unificadaBot from "../../../infrastructure/cadastro-bots/unificada-bot-client.js";

// Cada probe usa o método de liveness mais leve do respectivo client (todos já
// têm timeout interno e devolvem { ok, httpStatus, body }). SPX não tem health(),
// então usamos status() (GET /spx/status), que é igualmente read-only.
const BOTS = [
  { key: "angellira", label: "Angellira", probe: () => angelliraBot.health() },
  { key: "spx", label: "SPX / Shopee", probe: () => spxBot.status() },
  { key: "unificada", label: "Dossiê de risco", probe: () => unificadaBot.health() },
];

function normalizeProbe(result) {
  if (result?.ok) return { online: true, detail: null };
  const httpStatus = Number(result?.httpStatus ?? 0);
  const rawDetail = typeof result?.body?.detail === "string" ? result.body.detail.trim() : "";
  // httpStatus 0 = container fora do ar / rede inacessível; >0 = respondeu com erro.
  const detail =
    httpStatus === 0
      ? rawDetail || "sem resposta (robô fora do ar)"
      : `HTTP ${httpStatus}${rawDetail ? ` — ${rawDetail}` : ""}`;
  return { online: false, detail };
}

/**
 * Consulta a saúde dos 3 sidecars em paralelo. Nunca lança (allSettled): um robô
 * fora do ar vira `online:false`, não derruba a resposta.
 * @returns {Promise<{ bots: Array<{key,label,online,detail}>, anyOffline: boolean,
 *   offline: Array<{key,label,detail}>, meta: {correlationId, checkedAt} }>}
 */
export async function getCadastroBotsHealth({ correlationId } = {}) {
  const settled = await Promise.allSettled(BOTS.map((b) => b.probe()));
  const bots = BOTS.map((b, i) => {
    const s = settled[i];
    const norm =
      s.status === "fulfilled"
        ? normalizeProbe(s.value)
        : { online: false, detail: s.reason instanceof Error ? s.reason.message : String(s.reason) };
    return { key: b.key, label: b.label, online: norm.online, detail: norm.detail };
  });
  const offline = bots.filter((b) => !b.online);
  // Contrato dos read-models operator: { statusCode, payload } — o wrap() faz
  // `const { statusCode, payload } = await handler()`. Retornar objeto plano
  // fazia o endpoint dar 500 para operador autenticado (banner nunca aparecia).
  return {
    statusCode: 200,
    payload: {
      bots,
      anyOffline: offline.length > 0,
      offline: offline.map((b) => ({ key: b.key, label: b.label, detail: b.detail })),
      meta: { correlationId: correlationId ?? null, checkedAt: new Date().toISOString() },
    },
  };
}
