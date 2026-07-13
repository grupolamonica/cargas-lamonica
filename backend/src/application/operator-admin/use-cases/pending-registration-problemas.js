// Classificador de cadastros pendentes — aba "Dados incompletos".
//
// A partir do JSONB `dados`, lista os problemas que impedem a revisão/aprovação:
//   - dado faltando (incompleto): campo obrigatório ausente
//   - não conforme: dado presente porém inválido/vencido (ex.: CNH vencida)
//
// É READ-ONLY e DERIVADO: nenhuma linha do banco muda. A aba de revisão mostra
// os cadastros SEM problemas; esta aba mostra os COM problemas, com o motivo,
// para o operador entender o que ocorreu.
//
// Só avalia componentes PRESENTES no `dados` — cadastro parcial (entidade já
// vigente, wizard pulou o step) não é penalizado por "faltar" o que nem foi
// enviado. Espelha os campos de buildSubmitDados.ts / candidatura-schemas.js.

function isBlank(value) {
  return value == null || String(value).trim() === "";
}

/**
 * Interpreta datas em dd/mm/aaaa ou aaaa-mm-dd. Retorna Date (meia-noite UTC) ou
 * null quando não der pra interpretar com segurança (evita falso "vencida").
 */
function parseDateSafe(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  let y;
  let m;
  let d;
  let match;
  if ((match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    [, y, m, d] = match;
  } else if ((match = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/))) {
    [, d, m, y] = match;
  } else {
    return null;
  }
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function add(problemas, area, tipo, motivo) {
  problemas.push({ area, tipo, motivo });
}

/**
 * @param {object} dados  JSONB do pending_driver_registrations.
 * @param {object} [opts]
 * @param {Date}   [opts.hoje]  Data de referência (injeção p/ testes). Default: agora.
 * @returns {Array<{area:string, tipo:'incompleto'|'nao_conforme', motivo:string}>}
 */
export function getCadastroProblemas(dados, opts = {}) {
  const problemas = [];
  if (!dados || typeof dados !== "object") return problemas;
  const hoje = opts.hoje instanceof Date ? opts.hoje : new Date();
  const hojeUTC = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()));

  // ── Motorista ──
  const m = dados.motorista;
  // Só cobra o motorista quando ele veio de forma "completa" (tem nome). O
  // partial { cpf } de skip-Step-A não é penalizado aqui.
  if (m && typeof m === "object" && !isBlank(m.nome)) {
    if (isBlank(m.cpf)) add(problemas, "motorista", "incompleto", "Motorista sem CPF.");
    if (isBlank(m.cnh_url)) add(problemas, "motorista", "incompleto", "CNH do motorista não anexada.");
    if (isBlank(m.selfie_cnh_url)) add(problemas, "motorista", "incompleto", "Selfie com a CNH não anexada.");
    if (isBlank(m.comprovante_url)) {
      add(problemas, "motorista", "incompleto", "Comprovante de residência do motorista não anexado.");
    }
    const validadeCnh = parseDateSafe(m.cnh?.validade);
    if (validadeCnh && validadeCnh < hojeUTC) {
      add(problemas, "motorista", "nao_conforme", "CNH do motorista vencida.");
    }
  }

  // ── Cavalo ──
  const cavalo = dados.cavalo;
  if (cavalo && typeof cavalo === "object") {
    if (isBlank(cavalo.placa)) add(problemas, "cavalo", "incompleto", "Cavalo sem placa.");
    if (isBlank(cavalo.crlv_url)) add(problemas, "cavalo", "incompleto", "CRLV do cavalo não anexado.");
  }

  // ── Proprietário do cavalo ──
  const cavaloOwner = dados.cavalo_owner;
  if (cavaloOwner && typeof cavaloOwner === "object" && isBlank(cavaloOwner.owner_doc_url)) {
    add(problemas, "proprietario", "incompleto", "Documento do proprietário do cavalo não anexado.");
  }

  // ── Carretas ──
  if (Array.isArray(dados.carretas)) {
    dados.carretas.forEach((carreta, i) => {
      if (!carreta || typeof carreta !== "object") return;
      if (isBlank(carreta.placa)) add(problemas, "carreta", "incompleto", `Carreta ${i + 1} sem placa.`);
      if (isBlank(carreta.crlv_url)) add(problemas, "carreta", "incompleto", `CRLV da carreta ${i + 1} não anexado.`);
    });
  }

  // ── Proprietários das carretas ──
  if (Array.isArray(dados.carreta_owners)) {
    dados.carreta_owners.forEach((owner, i) => {
      if (owner && typeof owner === "object" && isBlank(owner.owner_doc_url)) {
        add(problemas, "proprietario", "incompleto", `Documento do proprietário da carreta ${i + 1} não anexado.`);
      }
    });
  }

  return problemas;
}

/** Conveniência: true quando o cadastro tem ao menos um problema. */
export function isCadastroIncompleto(dados, opts = {}) {
  return getCadastroProblemas(dados, opts).length > 0;
}
