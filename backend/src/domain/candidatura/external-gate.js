// backend/src/domain/candidatura/external-gate.js
//
// Regra de negócio (nova RF001) do gate de candidatura por fontes EXTERNAS
// (Angellira + SPX), pura e testável. Substitui — quando a flag do pré-check
// estiver ligada — a exigência de "cadastro local completo" pela consulta a
// Angellira + SPX:
//
//   - Angellira CONFORME + VIGENTE  E  SPX ATIVO NA NOSSA AGÊNCIA
//        → PASS (passa direto; o caller cria/ativa o driver_profile e libera a reserva)
//   - Angellira conforme+vigente, mas SPX NÃO é "ativo na nossa agência"
//        → SEND_DATA_NO_SPX (mandar os dados, avisando que não tem cadastro no SPX)
//   - Angellira ENCONTRADO mas VENCIDO
//        → SEND_DATA_EXPIRED (reenviar os dados)
//   - Angellira não encontrado / não conforme
//        → SEND_DATA (cadastrar)
//   - Fonte INDISPONÍVEL (não dá pra confirmar Angellira ou SPX)
//        → UNAVAILABLE (o caller NÃO auto-passa; cai no comportamento atual/seguro)
//
// "SPX ativo na nossa agência" = mapSpxLookupToVigency(...).status === 'ativo'
// (na_minha_agencia). Outra agência / inativo / bloqueado / pendente / não
// cadastrado NÃO contam.

export const EXTERNAL_GATE = Object.freeze({
  PASS: "PASS",
  SEND_DATA: "SEND_DATA",
  SEND_DATA_EXPIRED: "SEND_DATA_EXPIRED",
  SEND_DATA_NO_SPX: "SEND_DATA_NO_SPX",
  UNAVAILABLE: "UNAVAILABLE",
});

function isConforme(statusText) {
  return typeof statusText === "string" && statusText.trim().toLowerCase() === "conforme";
}

/**
 * Vigente = validUntil (YYYY-MM-DD) >= hoje (YYYY-MM-DD). Comparação lexical de
 * datas ISO equivale à cronológica. validUntil ausente/ilegível → não vigente.
 */
function isVigente(validUntil, today) {
  const m = String(validUntil || "").match(/^\d{4}-\d{2}-\d{2}/);
  if (!m) return false;
  return m[0] >= String(today);
}

/**
 * @param {object} args
 * @param {{ availability?:string, found?:boolean, statusText?:string, validUntil?:string }} args.angellira
 * @param {{ availability?:string, status?:string }} args.spx  status vindo de mapSpxLookupToVigency
 * @param {string} [args.today]  'YYYY-MM-DD' (default: hoje UTC)
 * @returns {{ gate:string, angelliraConforme:boolean, angelliraVigente:boolean, spxStatus:string|null }}
 */
export function resolveExternalGate({ angellira, spx, today } = {}) {
  const a = angellira || {};
  const s = spx || {};
  const t = today || new Date().toISOString().slice(0, 10);

  const angelliraFound = Boolean(a.found);
  const angelliraConforme = angelliraFound && isConforme(a.statusText);
  const angelliraVigente = angelliraFound && isVigente(a.validUntil, t);
  const spxAtivoNossa = s.status === "ativo";

  const base = {
    angelliraConforme,
    angelliraVigente,
    spxStatus: s.status ?? null,
  };

  // Indisponibilidade: sem confirmação de Angellira OU SPX não auto-passa — o
  // caller deve manter o comportamento seguro atual (não liberar por engano).
  if (a.availability === "UNAVAILABLE" || s.availability === "UNAVAILABLE") {
    return { gate: EXTERNAL_GATE.UNAVAILABLE, ...base };
  }

  const angelliraOk = angelliraConforme && angelliraVigente;

  if (angelliraOk && spxAtivoNossa) {
    return { gate: EXTERNAL_GATE.PASS, ...base };
  }
  if (angelliraOk && !spxAtivoNossa) {
    return { gate: EXTERNAL_GATE.SEND_DATA_NO_SPX, ...base };
  }
  // Angellira encontrado + conforme, mas VENCIDO → reenviar (vencido).
  if (angelliraFound && angelliraConforme && !angelliraVigente) {
    return { gate: EXTERNAL_GATE.SEND_DATA_EXPIRED, ...base };
  }
  // Não encontrado ou não conforme → cadastrar.
  return { gate: EXTERNAL_GATE.SEND_DATA, ...base };
}
