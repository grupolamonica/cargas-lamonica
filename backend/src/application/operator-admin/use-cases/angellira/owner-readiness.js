/**
 * Preflight de prontidão do PROPRIETÁRIO para o cadastro no Angellira.
 *
 * O Angellira exige `birth` (data de nascimento) ao criar um proprietário PF em
 * POST /owners (Joi: "birth is required" — sem default). Quando um proprietário
 * terceiro é cadastrado SEM data de nascimento, o disparo falhava com um 422/502
 * CRÍPTICO ("birth is required" embrulhado em BOT_DOWNSTREAM_FAIL) e cascateava
 * ("owner não cadastrado" no veículo). O operador não sabia o que corrigir e ia
 * pro cadastro manual (GLPI #29 — caso Fhilipe).
 *
 * Este gate roda ANTES do disparo e barra com mensagem ACIONÁVEL, nomeando o(s)
 * proprietário(s) e o campo faltante. Espelha a resolução de owner do próprio
 * pipeline (stepProprietarioCavalo / stepProprietarioCarreta) para checar
 * EXATAMENTE quem seria registrado — inclusive pulando a carreta que reaproveita
 * o proprietário do cavalo e os owners PJ (que não têm `birth`).
 */

import {
  extractCarretaOwner,
  extractCavaloOwner,
  extractPlacas,
  ownerReusesCavalo,
  resolveVehicleOwner,
} from "./payload-mapper.js";

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/** Proprietário é PF? (só PF exige `birth` no Angellira). */
function ownerIsPf(owner, embeddedDocType) {
  const doc = digitsOnly(owner?.doc || owner?.cpf || owner?.cnpj);
  const docType = owner?.doc_type || embeddedDocType || (doc.length === 14 ? "cnpj" : "cpf");
  return docType !== "cnpj";
}

function ownerBirth(owner) {
  return String(owner?.data_nascimento || owner?.nascimento || "").trim();
}

/**
 * @param {object} dados — pending_driver_registrations.dados (formato wizard v2)
 * @returns {null | {code:string, message:string, blocked_by:string, step:string, owners:Array}}
 *   bloqueio quando algum proprietário PF a ser cadastrado está sem data de
 *   nascimento; null quando tudo pronto (ou não há o que checar).
 */
export function checkOwnerAngelliraReadiness(dados) {
  if (!dados || typeof dados !== "object") return null;

  const { cavalo, carreta } = extractPlacas(dados);
  const faltando = [];

  // ── Proprietário do cavalo (mesma resolução do stepProprietarioCavalo) ──────
  let cavaloOwner = extractCavaloOwner(dados);
  if (!cavaloOwner || !cavaloOwner.doc) cavaloOwner = resolveVehicleOwner(dados, dados?.cavalo);
  const cavaloOwnerDoc = digitsOnly(cavaloOwner?.doc);
  if (cavalo && cavaloOwner?.doc && ownerIsPf(cavaloOwner, dados?.cavalo?.owner_doc_type) && !ownerBirth(cavaloOwner)) {
    faltando.push({ papel: "proprietário do cavalo", nome: cavaloOwner.nome || "", doc: cavaloOwnerDoc, step: "proprietario_cavalo" });
  }

  // ── Proprietário(s) da carreta — só os que NÃO reaproveitam o cavalo ────────
  const carretas = Array.isArray(dados?.carretas)
    ? dados.carretas
    : (dados?.carreta ? [dados.carreta] : []);
  carretas.forEach((carretaEntry, idx) => {
    let owner = extractCarretaOwner(dados, idx);
    if (!owner || !owner.doc) owner = resolveVehicleOwner(dados, carretaEntry);
    if (!owner || !owner.doc) return;

    const sameAsCavalo = !!cavaloOwnerDoc && digitsOnly(owner.doc) === cavaloOwnerDoc;
    if (ownerReusesCavalo(dados) || sameAsCavalo) return; // reaproveita → não cadastra separado

    if (ownerIsPf(owner, carretaEntry?.owner_doc_type) && !ownerBirth(owner)) {
      faltando.push({ papel: `proprietário da carreta ${idx + 1}`, nome: owner.nome || "", doc: digitsOnly(owner.doc), step: "proprietario_carreta" });
    }
  });

  if (faltando.length === 0) return null;
  void carreta; // (placa da carreta já considerada via carretas[])

  const lista = faltando
    .map((f) => `${f.papel}${f.nome ? ` (${f.nome})` : ""}`)
    .join("; ");
  return {
    code: "OWNER_SEM_DATA_NASCIMENTO",
    message:
      `Proprietário sem data de nascimento: ${lista}. `
      + "Complete a data de nascimento do proprietário antes de disparar ao Angellira "
      + "(o portal exige e o cadastro falha sem ela).",
    blocked_by: "owner_birth",
    step: faltando[0].step,
    owners: faltando,
  };
}
