// backend/src/domain/operator-admin/aspx-trip-presence.js
//
// Regras puras de "a viagem da carga lançada ainda existe no ASPX/SPX?".
//
// Contexto: uma carga lançada pela Programação (lh_manual = número da viagem "LT…")
// nasce colada a uma viagem do portal SPX. Se a Shopee cancela/remove essa viagem, a
// carga fica órfã: continua aberta no sistema/portal do motorista sem lastro nenhum.
//
// Política (pedido do operador): NUNCA apagar. A carga fica na tela de Cargas com o
// selo "Fora do ASPX", SAI do Monitor (não é mais viagem operável) e o operador é
// avisado — sempre, com re-aviso periódico enquanto a viagem não voltar.

/** Só viagens reais do SPX começam com "LT" (mesmo gate do auto-lançamento/assign).
 *  Nestlé (NESTLE-…), códigos manuais e importações NÃO são cobertos por esta regra. */
export function isSpxTripNumber(lh) {
  return /^LT/i.test(String(lh ?? "").trim());
}

/**
 * Decide o que fazer com uma carga a partir da presença da viagem no índice do SPX.
 *
 *  - "mark"     → sumiu agora (1º ciclo em que falta): marca + avisa
 *  - "renotify" → continua sumida e o último aviso já é antigo: avisa de novo
 *  - "clear"    → voltou a aparecer no ASPX: limpa a marca (volta ao Monitor)
 *  - "none"     → nada a fazer
 *
 * @param {{ present: boolean, missingSince?: Date|string|null,
 *   notifiedAt?: Date|string|null, now?: Date, realertHours?: number }} args
 * @returns {{ action: 'mark'|'renotify'|'clear'|'none' }}
 */
export function classifyAspxPresence({
  present,
  missingSince = null,
  notifiedAt = null,
  now = new Date(),
  realertHours = 6,
} = {}) {
  const marked = missingSince != null && String(missingSince) !== "";

  if (present) return { action: marked ? "clear" : "none" };
  if (!marked) return { action: "mark" };

  // Já marcada: re-avisa quando o último aviso passou da janela. Sem aviso registrado
  // (linha marcada por versão anterior / aviso falhou) → avisa agora.
  const last = notifiedAt ? Date.parse(String(notifiedAt)) : NaN;
  if (!Number.isFinite(last)) return { action: "renotify" };
  const hours = Math.max(0, Number(realertHours) || 0);
  const elapsedMs = now.getTime() - last;
  return elapsedMs >= hours * 3600_000 ? { action: "renotify" } : { action: "none" };
}

// ─── Rota retirada do ASPX ──────────────────────────────────────────────────────
//
// Para carga cujo carregamento JÁ PASSOU, a ausência de UMA viagem não prova nada (a
// presença dependeria da aba Concluído — janela + paginação). Mas a ausência da ROTA
// INTEIRA prova: se o portal não tem nenhuma viagem do trecho e todas as cargas
// lançadas daquele trecho estão ausentes, a Shopee retirou a rota (caso real: Simões
// Filho/BA → Itaitinga/CE, 41 cargas, 0 viagens para o CE no portal).

/** Chave canônica da rota: sem acento, minúscula, "origem>destino".
 *  NÃO remove sufixo operacional ("São Paulo-02" ≠ "São Paulo") — a granularidade do
 *  portal é a estação, e fundir estações misturaria rotas diferentes. */
export function routeKeyFromLabels(origem, destino) {
  const norm = (v) =>
    String(v ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // remove diacríticos
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const o = norm(origem);
  const d = norm(destino);
  return o && d ? `${o}>${d}` : "";
}

/**
 * Classifica uma rota candidata a "retirada do ASPX".
 *
 *  - "none"        → há viagem da rota no portal, ou o recorte é pequeno demais
 *  - "observing"   → ausência ainda não sustentada (1ª observação / dentro da janela)
 *  - "route_removed" → ausência confirmada: pode marcar as cargas e avisar
 *
 * Exige TODAS as condições: portal sem nenhuma viagem da rota; todas as cargas
 * lançadas avaliadas da rota ausentes; volume mínimo (uma carga órfã isolada não é
 * retirada de rota); e ausência sustentada por minAbsentHours desde a 1ª observação.
 *
 * @param {{ portalTripsOnRoute: number, launchedOnRoute: number, missingOnRoute: number,
 *   minLoads?: number, firstAbsentAt?: Date|string|null, now?: Date, minAbsentHours?: number }} args
 * @returns {{ action: 'none'|'observing'|'route_removed', reason?: string }}
 */
export function classifyRouteRemoval({
  portalTripsOnRoute,
  launchedOnRoute,
  missingOnRoute,
  minLoads = 3,
  firstAbsentAt = null,
  now = new Date(),
  minAbsentHours = 6,
} = {}) {
  if (Number(portalTripsOnRoute) > 0) return { action: "none", reason: "rota_presente_no_portal" };
  if (Number(launchedOnRoute) < Math.max(1, Number(minLoads) || 1)) {
    return { action: "none", reason: "poucas_cargas_na_rota" };
  }
  if (Number(missingOnRoute) !== Number(launchedOnRoute)) {
    return { action: "none", reason: "rota_parcialmente_presente" };
  }

  const first = firstAbsentAt ? Date.parse(String(firstAbsentAt)) : NaN;
  if (!Number.isFinite(first)) return { action: "observing", reason: "primeira_observacao" };
  const horas = Math.max(0, Number(minAbsentHours) || 0);
  return now.getTime() - first >= horas * 3600_000
    ? { action: "route_removed" }
    : { action: "observing", reason: "janela_de_confirmacao" };
}
