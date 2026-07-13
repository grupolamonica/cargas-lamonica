// DC-195 — Anexo obrigatório dos documentos no cadastro.
//
// Valida que os documentos foram anexados (storage_path presente) para as
// entidades ENVIADAS COMPLETAS na submissão. Roda DEPOIS do merge do handler
// (`resolveCandidaturaSubmitResponse`), então recebe flags indicando o que
// veio parcial/reidratado — para NÃO exigir documento de entidade que o wizard
// nem mostrou (cadastro parcial: motorista/cavalo já vigente, pendência de
// outra parte). Isso evita bloquear re-submits legítimos e cadastros legados
// sem documento persistido.
//
// Campos (espelham buildSubmitDados.ts + candidatura-schemas.js):
//   motorista.cnh_url, motorista.selfie_cnh_url, motorista.comprovante_url
//   cavalo.crlv_url
//   cavalo_owner.owner_doc_url
//   carretas[i].crlv_url
//   carreta_owners[i].owner_doc_url
//
// Observação: o comprovante de residência do PROPRIETÁRIO PF já é exigido pelo
// superRefine do dadosSchema (Iter #7) — aqui cuidamos dos demais anexos.

function has(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * @param {object} dados  Payload `dados` já validado e mesclado (pós-merge).
 * @param {object} [opts]
 * @param {boolean} [opts.motoristaWasPartial]      Step A pulado (motorista mesclado do persistido).
 * @param {boolean} [opts.cavaloWasPartial]         Step B pulado (cavalo mesclado do persistido).
 * @param {boolean} [opts.cavaloOwnerWasRehydrated] cavalo_owner reidratado do persistido (não enviado).
 * @returns {Array<{ path: (string|number)[], message: string }>} faltas (vazio = ok).
 */
export function collectMissingRequiredDocuments(dados, opts = {}) {
  const {
    motoristaWasPartial = false,
    cavaloWasPartial = false,
    cavaloOwnerWasRehydrated = false,
  } = opts;

  const missing = [];
  if (!dados || typeof dados !== "object") return missing;

  const motorista = dados.motorista;
  if (motorista && typeof motorista === "object" && !motoristaWasPartial) {
    if (!has(motorista.cnh_url)) {
      missing.push({ path: ["motorista", "cnh_url"], message: "Anexe a CNH do motorista." });
    }
    if (!has(motorista.selfie_cnh_url)) {
      missing.push({ path: ["motorista", "selfie_cnh_url"], message: "Anexe a selfie segurando a CNH." });
    }
    if (!has(motorista.comprovante_url)) {
      missing.push({
        path: ["motorista", "comprovante_url"],
        message: "Anexe o comprovante de residência do motorista.",
      });
    }
  }

  const cavalo = dados.cavalo;
  if (cavalo && typeof cavalo === "object" && !cavaloWasPartial) {
    if (!has(cavalo.crlv_url)) {
      missing.push({ path: ["cavalo", "crlv_url"], message: "Anexe o CRLV do cavalo." });
    }
  }

  const cavaloOwner = dados.cavalo_owner;
  if (cavaloOwner && typeof cavaloOwner === "object" && !cavaloOwnerWasRehydrated) {
    if (!has(cavaloOwner.owner_doc_url)) {
      missing.push({
        path: ["cavalo_owner", "owner_doc_url"],
        message: "Anexe o documento do proprietário do cavalo (CNH ou cartão CNPJ).",
      });
    }
  }

  // Carretas e carreta_owners nunca são mesclados/reidratados pelo handler
  // (só existem quando o Step D/E foi realmente preenchido) → sempre exigidos.
  if (Array.isArray(dados.carretas)) {
    dados.carretas.forEach((carreta, i) => {
      if (carreta && typeof carreta === "object" && !has(carreta.crlv_url)) {
        missing.push({ path: ["carretas", i, "crlv_url"], message: `Anexe o CRLV da carreta ${i + 1}.` });
      }
    });
  }

  if (Array.isArray(dados.carreta_owners)) {
    dados.carreta_owners.forEach((owner, i) => {
      if (owner && typeof owner === "object" && !has(owner.owner_doc_url)) {
        missing.push({
          path: ["carreta_owners", i, "owner_doc_url"],
          message: `Anexe o documento do proprietário da carreta ${i + 1}.`,
        });
      }
    });
  }

  return missing;
}
