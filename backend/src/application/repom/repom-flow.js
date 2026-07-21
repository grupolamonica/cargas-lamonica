/**
 * Repom — Fase 3d: spec declarativa do fluxo de coleta do MOTORISTA + funções
 * puras "próximo passo / o que falta". Espelha o findNextStep/ORDER do sistema
 * de cadastro local: o bot NÃO improvisa a ordem — a spec dita a sequência, uma
 * função pura calcula o próximo passo, e o progresso é DERIVÁVEL de
 * `dados.motorista` (não de um status novo — o read-model do operador só varre
 * status='pendente', então o progresso vive no JSONB).
 *
 * Escopo (decisão do Samuel): só MOTORISTA — CNH (Fase 3b) + selfie + comprovante
 * + telefone. Veículo (CRLV/ANTT/carreta) fica para um épico futuro.
 *
 * Módulo PURO (sem I/O): a fiação (pedir o próximo passo, ler, validar, gravar)
 * é o PR de continuação; aqui só definimos a ordem e o cálculo.
 */

const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");
const has = (v) => v !== null && v !== undefined && String(v).trim() !== "";

/**
 * Ordem dos passos do cadastro do motorista. Cada passo:
 *  - key: identificador do passo;
 *  - tipo: 'doc' (foto/PDF) | 'texto';
 *  - label: nome curto (para observações/telemetria);
 *  - field: onde o valor coletado é gravado em `dados.motorista` (mesmo nome do
 *    wizard — buildSubmitDados.ts — pra o cadastro nascer idêntico);
 *  - slot: (só 'doc') slot do bucket cadastro-drafts (allowlist do uploadDraftFile);
 *  - satisfied(motorista): true quando o dado já foi coletado;
 *  - normalize(texto): (só 'texto') extrai o valor canônico do texto do motorista,
 *    ou null se inválido (o bot então repete o pedido);
 *  - ask: a mensagem que o bot manda para pedir esse passo.
 */
export const REPOM_MOTORISTA_STEPS = [
  {
    key: "cnh",
    tipo: "doc",
    label: "CNH",
    field: "cnh_url",
    slot: "motorista_cnh",
    satisfied: (m) => has(m?.cnh_url),
    ask: "📷 Pra começar, me envia uma *foto da sua CNH* (frente, aberta e bem iluminada).",
  },
  {
    key: "selfie_cnh",
    tipo: "doc",
    label: "selfie com a CNH",
    field: "selfie_cnh_url",
    slot: "motorista_selfie_cnh",
    satisfied: (m) => has(m?.selfie_cnh_url),
    ask: "Agora manda uma *selfie segurando a sua CNH* — é só pra confirmar que é você mesmo. 🤳",
  },
  {
    key: "comprovante",
    tipo: "doc",
    label: "comprovante de residência",
    field: "comprovante_url",
    slot: "motorista_comprovante",
    satisfied: (m) => has(m?.comprovante_url),
    ask: "Manda um *comprovante de residência* recente (conta de luz, água ou telefone) — pode ser foto ou PDF. 🏠",
  },
  {
    key: "telefone",
    tipo: "texto",
    label: "telefone",
    field: "telefone",
    satisfied: (m) => onlyDigits(m?.telefone).length >= 10,
    normalize: normalizeTelefoneBr,
    ask: "Por fim, me confirma um *telefone com DDD* para contato. 📱",
  },
];

/**
 * Normaliza um telefone BR a partir de texto livre: só dígitos, tira o 55 de país
 * quando presente, e exige DDD + número (10 dígitos fixo, 11 celular). Devolve os
 * dígitos canônicos ou null (o bot repete o pedido). NÃO usa o número do WhatsApp
 * — o motorista confirma o telefone de contato (decisão do Samuel: não pré-preencher).
 */
export function normalizeTelefoneBr(texto) {
  let d = onlyDigits(texto);
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : null;
}

/** O próximo passo pendente (o que o bot deve pedir agora), ou null se completo. */
export function proximoPasso(dados) {
  const motorista = dados?.motorista || {};
  return REPOM_MOTORISTA_STEPS.find((step) => !step.satisfied(motorista)) || null;
}

/** Keys dos passos que ainda faltam (para completude e "quanto falta"). */
export function faltantes(dados) {
  const motorista = dados?.motorista || {};
  return REPOM_MOTORISTA_STEPS.filter((step) => !step.satisfied(motorista)).map((step) => step.key);
}

/** true quando todos os passos do motorista estão satisfeitos (cadastro completo). */
export function isCadastroCompleto(dados) {
  return proximoPasso(dados) === null;
}
