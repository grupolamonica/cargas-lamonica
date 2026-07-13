// Domínio puro do checklist de veículo (dados do LiraLOG replicados pelo robô
// GRIFFI numa planilha Google). Sem dependências externas — testável sem rede.
//
// O semáforo é calculado LOCALMENTE (regra RN-01 do doc): a validade × agora
// manda; o Status bruto ("Reprovado"/"Vencido") força vermelho. Assim a cor
// nunca fica "atrasada" mesmo que a linha da planilha tenha alguns minutos.

export const CHECKLIST_LEVEL = {
  OK: "ok", // verde — válido e longe de vencer
  WARNING: "warning", // amarelo — próximo a vencer
  OVERDUE: "overdue", // vermelho — vencido ou reprovado/problema
  UNKNOWN: "unknown", // cinza — sem dado de checklist
};

const DAY_MS = 86_400_000;

/**
 * Placa comparável: só alfanumérico, maiúsculo (ignora hífen/espaço/caixa).
 * "MTY-0443" e "mty0443" casam.
 */
export function normalizePlate(plate) {
  return String(plate ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizeStatusText(value) {
  // Status é ASCII ("Aprovado"/"Reprovado"/"Vencido") — basta minúsculo.
  return String(value ?? "").toLowerCase();
}

/**
 * Nível do semáforo de UM item de checklist.
 *
 * Fonte primária de "dias restantes" = a coluna **Vencimento** da planilha
 * (dias que o próprio robô/LiraLOG recalcula a cada ~5 min). A coluna
 * "Data Validade Checklist" NÃO é a expiração real — diverge sistematicamente
 * do Vencimento (ex.: validade 25/05 "passada" mas Vencimento=+16) — então só
 * serve de fallback quando não há Vencimento numérico. O Status bruto
 * ("Reprovado"/"Vencido") sempre força vermelho.
 *
 * @param {object} p
 * @param {number|null} [p.vencimentoDias] - dias restantes segundo o robô (negativo = vencido)
 * @param {number|null} [p.validadeMs] - fallback: validade em epoch ms
 * @param {string} p.statusRaw - coluna "Status" (Aprovado/Reprovado/Vencido)
 * @param {number} p.nowMs - agora (epoch ms), injetado para testabilidade
 * @param {number} [p.yellowDays=30] - janela do amarelo (dias)
 * @returns {{ level: string, daysToDue: number|null }}
 */
export function computeChecklistLevel({ vencimentoDias, validadeMs, statusRaw, nowMs, yellowDays = 30 }) {
  const s = normalizeStatusText(statusRaw);
  const isProblem = s.includes("reprovad"); // reprovado = problema
  const isExpiredStatus = s.includes("vencid");
  const isApproved = s.includes("aprovad");

  const daysToDue = Number.isFinite(vencimentoDias)
    ? vencimentoDias
    : Number.isFinite(validadeMs)
      ? Math.floor((validadeMs - nowMs) / DAY_MS)
      : null;

  // Status explícito de problema/vencido manda (vermelho).
  if (isProblem || isExpiredStatus) return { level: CHECKLIST_LEVEL.OVERDUE, daysToDue };

  if (daysToDue != null) {
    if (daysToDue < 0) return { level: CHECKLIST_LEVEL.OVERDUE, daysToDue };
    if (daysToDue <= yellowDays) return { level: CHECKLIST_LEVEL.WARNING, daysToDue };
    return { level: CHECKLIST_LEVEL.OK, daysToDue };
  }

  // Sem dias e sem status de problema: aprovado → verde, senão desconhecido.
  if (isApproved) return { level: CHECKLIST_LEVEL.OK, daysToDue: null };
  return { level: CHECKLIST_LEVEL.UNKNOWN, daysToDue: null };
}

const LEVEL_SEVERITY = {
  [CHECKLIST_LEVEL.OVERDUE]: 3,
  [CHECKLIST_LEVEL.WARNING]: 2,
  [CHECKLIST_LEVEL.OK]: 1,
  [CHECKLIST_LEVEL.UNKNOWN]: 0,
};

/**
 * Pior nível de uma lista (consolida vários itens de um mesmo veículo).
 * Vazio → UNKNOWN.
 */
export function aggregateLevel(levels) {
  let worst = CHECKLIST_LEVEL.UNKNOWN;
  for (const lvl of levels) {
    if ((LEVEL_SEVERITY[lvl] ?? 0) > (LEVEL_SEVERITY[worst] ?? 0)) worst = lvl;
  }
  return worst;
}
