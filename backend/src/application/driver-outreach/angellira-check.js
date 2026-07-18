/**
 * driver-outreach — checagem de vigência no Angellira (fonte da verdade de
 * "já cadastrado"). Reusa o cliente de leitura `lookupAngelliraDriverByCpf`
 * (api.angellira.com.br/profile/query). Usado para NÃO cobrar "finalize seu
 * cadastro" de quem já tem cadastro vigente (o status local — pendente/
 * migrado_bot — não é confiável).
 */

import { lookupAngelliraDriverByCpf } from "../../infrastructure/angellira/angellira-client.js";
import { getSaoPauloWallClock } from "../../domain/sao-paulo-time.js";

/**
 * @param {string} cpf
 * @returns {Promise<{checked:boolean, status?:string, found?:boolean, validUntil?:string|null, vigente:boolean, name?:string|null, error?:string}>}
 */
export async function checkAngelliraVigencia(cpf) {
  const cpfDigits = String(cpf || "").replace(/\D/g, "");
  if (cpfDigits.length !== 11) return { checked: false, vigente: false };
  try {
    const r = await lookupAngelliraDriverByCpf(cpfDigits, {
      sourceEvent: "driver-outreach.angellira_check",
    });
    const today = getSaoPauloWallClock().dateIso;
    const vigente = r.status === "FOUND" && Boolean(r.validUntil) && String(r.validUntil) >= today;
    return {
      checked: true,
      status: r.status,
      found: Boolean(r.found),
      validUntil: r.validUntil ?? null,
      vigente,
      name: r.displayName ?? null,
    };
  } catch (err) {
    return { checked: false, vigente: false, error: err instanceof Error ? err.message : String(err) };
  }
}
