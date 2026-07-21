/**
 * Repom — Fase 3b PR2: GATES de validação da CNH (portados do sistema local).
 *
 * Funções PURAS: recebem os campos já achatados (flattenOcrCampos) e decidem
 *   (a) se parece mesmo uma CNH (sinal mínimo),
 *   (b) o status do cadastro (pendente vs em_revisao) + as observações.
 * NUNCA aprovam sozinhas — a decisão final é SEMPRE do operador (decisão do
 * Samuel). Aqui só populamos o pending com um veredito advisory.
 *
 * Tolerância a apelidos: o sidecar devolve chaves do Vision (schema conhecido)
 * OU do Infosimples (variam). Os gates olham uma lista de apelidos por campo e,
 * na dúvida, degradam para revisão do operador — nunca recusam à toa.
 *
 * Lições do sistema local embutidas:
 *  - "OCR suspeito" SÓ em campos numéricos (cpf, numero_registro) e só quando há
 *    LETRA no meio (confusão 1↔l, O↔0, S↔5). NUNCA no RG (é alfanumérico — o
 *    filtro numérico no RG causou loop de 91 fotos num motorista).
 *  - Falha parcial (validade vencida, CPF divergente) → em_revisao, não recusa.
 */

const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");

// Apelidos por campo lógico (Vision primeiro; variantes Infosimples defensivas).
const FIELD_ALIASES = {
  cpf: ["cpf"],
  nome: ["nome", "nome_condutor"],
  numero_registro: ["numero_registro", "registro", "num_registro", "n_registro"],
  categoria: ["categoria", "categoria_habilitacao", "cat_hab"],
  validade: ["validade", "data_validade", "validade_habilitacao", "vencimento"],
  data_nascimento: ["data_nascimento", "nascimento", "data_nasc"],
};

/** Primeiro valor não-vazio entre os apelidos do campo lógico; null se nenhum. */
export function pickField(fields, logical) {
  const aliases = FIELD_ALIASES[logical] || [logical];
  for (const key of aliases) {
    const v = fields?.[key];
    if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

const SIGNATURE_KEYS = ["cpf", "nome", "numero_registro", "categoria", "validade"];
export const SIGNATURE_MIN_CNH = 2;

/** ≥ SIGNATURE_MIN_CNH campos-âncora presentes → parece uma CNH (não doc trocado). */
export function hasMinimalCnhSignal(fields) {
  const n = SIGNATURE_KEYS.reduce((acc, k) => (pickField(fields, k) ? acc + 1 : acc), 0);
  return n >= SIGNATURE_MIN_CNH;
}

/**
 * "OCR suspeito" — SÓ em cpf e numero_registro, e só quando há LETRA no valor
 * (confusão de OCR). Máscara (./-) é normal, não é suspeita. NUNCA no RG.
 * @returns {string[]} campos lógicos suspeitos.
 */
export function detectSuspiciousNumericFields(fields) {
  const suspicious = [];
  for (const logical of ["cpf", "numero_registro"]) {
    const raw = pickField(fields, logical);
    if (raw && /[a-z]/i.test(raw)) suspicious.push(logical);
  }
  return suspicious;
}

function parseBrDate(s) {
  const m = String(s || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d) {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Avalia a extração da CNH. NÃO aprova — devolve o veredito para o pending.
 *  - accepted:false → não parece CNH (abaixo do sinal mínimo) → pedir reenvio.
 *  - accepted:true  → grava no pending; status 'em_revisao' se houver issues
 *                     (OCR suspeito, CPF inválido, nome curto, sem registro/
 *                     categoria, validade ilegível/vencida, CPF ≠ sessão),
 *                     senão 'pendente'. O operador SEMPRE decide a aprovação.
 *
 * @param {Record<string,unknown>} fields  campos achatados do OCR
 * @param {object} [opts]
 * @param {string} [opts.sessionCpf]  CPF que o motorista digitou (cross-check)
 * @param {Date}   [opts.now]         "hoje" (injetável p/ testes)
 */
export function evaluateCnhExtraction(fields, { sessionCpf, now = new Date() } = {}) {
  if (!hasMinimalCnhSignal(fields)) {
    return { accepted: false, reason: "not_a_cnh", issues: [], cpfMatchesSession: false };
  }

  const issues = [];

  const suspicious = detectSuspiciousNumericFields(fields);
  if (suspicious.length) issues.push({ code: "ocr_suspeito", fields: suspicious });

  const cpf = onlyDigits(pickField(fields, "cpf"));
  if (cpf.length !== 11) issues.push({ code: "cpf_invalido" });

  const nome = pickField(fields, "nome");
  if (!nome || nome.length < 5) issues.push({ code: "nome_curto" });

  if (!pickField(fields, "numero_registro") && !pickField(fields, "categoria")) {
    issues.push({ code: "sem_registro_nem_categoria" });
  }

  const validadeRaw = pickField(fields, "validade");
  const validade = parseBrDate(validadeRaw);
  if (validadeRaw && !validade) issues.push({ code: "validade_ilegivel" });
  if (validade && validade < startOfDay(now)) issues.push({ code: "cnh_vencida" });

  // Cross-check CPF (decisão do Samuel: divergente → revisão, NÃO recusa).
  const sessCpf = onlyDigits(sessionCpf);
  const cpfMatchesSession = Boolean(cpf.length === 11 && sessCpf.length === 11 && cpf === sessCpf);
  if (sessCpf.length === 11 && cpf.length === 11 && !cpfMatchesSession) {
    issues.push({ code: "cpf_diverge_sessao" });
  }

  return {
    accepted: true,
    status: issues.length ? "em_revisao" : "pendente",
    issues,
    cpfMatchesSession,
  };
}
