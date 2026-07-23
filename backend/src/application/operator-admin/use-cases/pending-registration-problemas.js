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

  // ── Cadastro externo (Angellira/SPX) falhou ao aprovar ──
  // Marcador gravado pelo handler de aprovação quando o disparo externo falha:
  // o cadastro NÃO foi aprovado e segue na fila; aparece aqui com o motivo para
  // o operador conferir e tentar aprovar de novo (o pipeline re-tenta só o que
  // faltou). Ver resolveOperatorAprovarCadastroResponse.
  const falhaExterna = dados.cadastro_externo_falhou;
  if (falhaExterna && typeof falhaExterna === "object") {
    const alvos = [];
    if (falhaExterna.angellira && falhaExterna.angellira.ok === false) alvos.push("Angellira");
    if (falhaExterna.spx && falhaExterna.spx.ok === false) alvos.push("SPX");
    // Só sinaliza quando de fato há uma integração que falhou (defensivo: um
    // marcador com tudo OK não deveria existir, mas não vira problema à toa).
    if (alvos.length) {
      add(problemas, "geral", "nao_conforme", `Cadastro ${alvos.join(" e ")} falhou ao aprovar — revise e tente aprovar novamente.`);
    }
  }

  // ── Motorista ──
  const m = dados.motorista;
  // Só cobra o motorista quando ele veio de forma "completa" (tem nome). O
  // partial { cpf } de skip-Step-A não é penalizado aqui.
  if (m && typeof m === "object" && !isBlank(m.nome)) {
    if (isBlank(m.cpf)) add(problemas, "motorista", "incompleto", "Motorista sem CPF.");
    if (isBlank(m.cnh_url)) add(problemas, "motorista", "incompleto", "CNH do motorista não anexada.");
    if (isBlank(m.selfie_cnh_url)) add(problemas, "motorista", "incompleto", "Selfie com a CNH não anexada.");
    // NOTA (decisão do operador, 13/07): a falta do COMPROVANTE DE RESIDÊNCIA do
    // motorista NÃO tira o cadastro da fila de revisão. Os pendentes antigos foram
    // criados antes de o comprovante virar campo capturado (lacuna de dado, não
    // cadastro "ruim"): exigi-lo migraria 22 de 26 da fila só por isso. Se um dia
    // virar obrigatório de verdade, reativar a checagem aqui.
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

// Motivo sintético para o backlog antigo (cadastros criados até o cutoff) que
// não tem nenhum problema de dado — pra não aparecer "sem motivo" na aba.
export const BACKLOG_PROBLEMA = Object.freeze({
  area: "geral",
  tipo: "incompleto",
  motivo: "Backlog anterior — revisar e completar.",
});

/**
 * Decide o balde de um pendente ("incompletos" | "revisao") combinando:
 *  - problemas de dado (getCadastroProblemas), e
 *  - o cutoff de backlog (feature "zerar a fila"): criado ATÉ o cutoff → backlog.
 * Puro e testável. Quando é backlog sem problema, injeta BACKLOG_PROBLEMA pra a
 * aba mostrar um motivo.
 * @returns {{ bucket: "incompletos"|"revisao", problemas: Array }}
 */
export function resolveBucket({ createdAt, problemas, cutoffIso }) {
  const list = Array.isArray(problemas) ? [...problemas] : [];
  const created = createdAt ? new Date(createdAt).getTime() : NaN;
  const cutoff = cutoffIso ? new Date(cutoffIso).getTime() : NaN;
  const isBacklog = Number.isFinite(created) && Number.isFinite(cutoff) && created <= cutoff;
  if (isBacklog && list.length === 0) list.push({ ...BACKLOG_PROBLEMA });
  return { bucket: isBacklog || list.length > 0 ? "incompletos" : "revisao", problemas: list };
}
