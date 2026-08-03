/**
 * Coerência de identidade (domínio) — comparação tolerante de NOME e CPF entre
 * o que o motorista digitou e o que a CNH (OCR) diz. Base anti-fraude do
 * "documento de outra pessoa": o wizard só deixa o NOME editável, então um
 * fraudador anexa a CNH da vítima (OCR preenche tudo) e reescreve só o nome.
 *
 * Puro (sem deps de infra) — reusado pelo submit da candidatura e pelo backstop
 * do disparo Angellira. Espelho no front: frontend/src/lib/identityMatch.ts.
 *
 * Filosofia anti falso-positivo: só BARRA em divergência CLARA (troca de
 * pessoa). Ruído de OCR (0↔O, acento), nome do meio faltando e abreviação
 * passam. Fonte ausente (sem snapshot da CNH) → não barra (fail-open).
 */

const PARTICULAS = new Set(["de", "da", "do", "das", "dos", "e", "di", "du", "del", "la"]);

/** Normaliza: NFD sem acento, minúsculo, só [a-z0-9 ], espaços colapsados. */
export function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Junta apóstrofos ANTES de trocar pontuação por espaço: "sant'anna" →
    // "santanna" (casa com a forma juntada que a base externa costuma gravar).
    .replace(/['’`´]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokens significativos do nome (sem partículas de ligação). */
export function nameTokens(value) {
  return normalizeName(value)
    .split(" ")
    .filter((t) => t && !PARTICULAS.has(t));
}

/** Distância de Levenshtein entre dois tokens. */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** Dois tokens "iguais o suficiente" — tolera ruído de OCR proporcional ao tamanho. */
export function tokenSimilar(a, b) {
  if (a === b) return true;
  const max = Math.max(a.length, b.length);
  // 1–2 chars: igualdade exata. 3 chars: tolera 1 erro de OCR (ANA↔AMA) — senão
  // corrigir um nome curto lido errado ficava sem saída (incentivo invertido).
  if (max <= 2) return a === b;
  // prefixo/inicial: "j" vs "jose" (abreviação comum na CNH/RG)
  if ((a.length === 1 || b.length === 1) && (a.startsWith(b) || b.startsWith(a))) return true;
  return editDistance(a, b) <= (max <= 6 ? 1 : 2);
}

/**
 * Os nomes conferem? true = deixa passar. Barra só em divergência CLARA.
 * Regra: primeiro E último token significativos batem, OU cobertura de tokens
 * do menor conjunto ≥ 60%. Qualquer lado vazio → true (nada a comparar).
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function namesMatch(a, b) {
  const A = nameTokens(a);
  const B = nameTokens(b);
  if (A.length === 0 || B.length === 0) return true;

  const firstOk = tokenSimilar(A[0], B[0]);
  const lastOk = tokenSimilar(A[A.length - 1], B[B.length - 1]);
  if (firstOk && lastOk) return true;

  const [menor, maior] = A.length <= B.length ? [A, B] : [B, A];
  const cobertos = menor.filter((t) => maior.some((u) => tokenSimilar(t, u))).length;
  return cobertos / menor.length >= 0.6;
}

/** Só os dígitos do documento. */
export function onlyDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * CPFs conferem? Comparação EXATA por dígitos (sem tolerância). Retorna true
 * quando algum lado não tem 11 dígitos (nada confiável a comparar → fail-open).
 */
export function cpfMatches(a, b) {
  const da = onlyDigits(a);
  const db = onlyDigits(b);
  if (da.length !== 11 || db.length !== 11) return true;
  return da === db;
}

/**
 * Backstop anti-fraude sobre o payload do wizard: o NOME digitado (editável) bate
 * com o NOME da CNH (OCR, imutável em `motorista.cnh.nome`) e o CPF da
 * candidatura bate com o CPF da CNH.
 *
 * Fail-open quando não há snapshot da CNH (`motorista.cnh.nome` ausente) — não
 * barra, mas devolve `skipped` para auditoria (senão o backstop vira inócuo).
 *
 * @param {object} args
 * @param {object} args.dados      — pending_driver_registrations.dados (wizard v2)
 * @param {string} [args.driverCpf] — CPF da candidatura (só-dígitos), quando houver
 * @returns {{ok:true, skipped?:boolean} | {ok:false, code:string, message:string, issues:Array}}
 */
export function checkTypedVsCnh({ dados, driverCpf }) {
  const motorista = dados?.motorista || {};
  // cnh pode vir sob motorista (buildSubmitDados) ou no topo de dados (fixture/
  // legado) — mesma dupla-leitura do mapMotoristaPayload.
  const cnh = motorista.cnh || dados?.cnh || {};
  const nomeDigitado = String(motorista.nome || "").trim();
  const nomeCnh = String(cnh.nome || "").trim();
  const cpfCnh = onlyDigits(motorista.cpf || cnh.cpf);

  // Sem snapshot do nome da CNH → nada a comparar (fail-open observável).
  if (!nomeCnh) return { ok: true, skipped: true };

  if (!namesMatch(nomeDigitado, nomeCnh)) {
    return {
      ok: false,
      code: "NOME_DIVERGENTE_CNH",
      message:
        "Os dados digitados não batem com os dados da CNH do motorista. "
        + `O nome informado ("${nomeDigitado}") diverge do nome da CNH anexada ("${nomeCnh}").`,
      issues: [{ path: "motorista.nome", message: "Nome diverge da CNH anexada." }],
    };
  }

  // CPF da candidatura × CPF da CNH. Efetivo no fluxo AUTENTICADO (driverCpf =
  // profile.document_number ≠ motorista.cpf do OCR). No público driverCpf é
  // derivado do próprio motorista.cpf → aqui vira no-op; lá a divergência
  // OCR×pré-check é barrada no front (cpfMismatch em A1Cnh).
  if (driverCpf && !cpfMatches(driverCpf, cpfCnh)) {
    return {
      ok: false,
      code: "CPF_DIVERGENTE_CNH",
      message:
        "O CPF informado no início do cadastro é diferente do CPF da CNH anexada. "
        + "Confira o documento e o CPF da candidatura.",
      issues: [{ path: "motorista.cpf", message: "CPF diverge da CNH anexada." }],
    };
  }

  return { ok: true };
}
