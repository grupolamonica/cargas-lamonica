/**
 * Pre-check Angellira: consulta vigência do motorista (por CPF) e dos veículos
 * (por placa). Usa o cliente `angellira-client.js` existente (que fala com
 * `api.angellira.com.br/profile/query`), sem tocar no bot — operação puramente
 * de leitura.
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

/**
 * Executa precheck para motorista + cavalo + carreta.
 *
 * @param {object} args
 * @param {object} args.cadastro       — row de pending_driver_registrations
 * @param {string} [args.correlationId]
 * @returns {Promise<{motorista, cavalo?, carreta?}>}
 */
export async function performAngelliraPrecheck({ cadastro, correlationId = null }) {
  const dados = cadastro?.dados || {};
  const cpf = digitsOnly(dados?.motorista?.cpf);
  const { cavalo, carreta } = extractPlacas(dados);

  const out = {};
  const lookupOpts = correlationId
    ? { correlationId, sourceEvent: "operator.cadastro.angellira_precheck" }
    : { sourceEvent: "operator.cadastro.angellira_precheck" };

  // Motorista
  if (cpf && cpf.length === 11) {
    try {
      out.motorista = await lookupAngelliraDriverByCpf(cpf, lookupOpts);
    } catch (err) {
      out.motorista = { status: "UNAVAILABLE", error: err?.message || String(err) };
    }
  } else {
    out.motorista = { status: "NOT_FOUND", reason: "CPF ausente ou inválido" };
  }

  // Cavalo
  if (cavalo) {
    try {
      out.cavalo = await lookupAngelliraPlate(cavalo, lookupOpts);
    } catch (err) {
      out.cavalo = { status: "UNAVAILABLE", error: err?.message || String(err) };
    }
  }
  // Carreta
  if (carreta) {
    try {
      out.carreta = await lookupAngelliraPlate(carreta, lookupOpts);
    } catch (err) {
      out.carreta = { status: "UNAVAILABLE", error: err?.message || String(err) };
    }
  }

  return out;
}
