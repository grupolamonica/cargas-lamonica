import crypto from "node:crypto";

// Token de posse do rascunho anônimo de candidatura (DC-283 / CRIT-3).
//
// O rascunho não tem dono autenticado: o motorista preenche o wizard sem login.
// Autorizar pelo CPF é o mesmo que não autorizar — CPF não é segredo. O token
// resolve isso trocando "quem você diz ser" por "o que você tem": só quem criou
// o rascunho recebeu o token, então uma lista de CPFs não abre nada.
//
// 32 bytes de aleatoriedade criptográfica; base64url para viajar em header sem
// escape. Guardamos apenas o SHA-256 — vazamento da coluna não dá acesso a
// rascunho nenhum, e comparar hash de tamanho fixo é o que permite usar
// timingSafeEqual sem vazar comprimento.
const TOKEN_BYTES = 32;
const HASH_HEX_LENGTH = 64; // sha256 em hex

export function mintDraftToken() {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, hash: hashDraftToken(token) };
}

export function hashDraftToken(token) {
  const normalized = String(token ?? "").trim();
  if (!normalized) return null;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

/**
 * Compara em tempo constante o token apresentado com o hash guardado.
 *
 * Comparação com `===` aqui vazaria, por tempo, quantos caracteres iniciais o
 * atacante acertou — e com um oráculo desses o token deixa de ser opaco.
 */
export function draftTokenMatches(token, storedHash) {
  const candidate = hashDraftToken(token);

  if (!candidate || typeof storedHash !== "string" || storedHash.length !== HASH_HEX_LENGTH) {
    return false;
  }

  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(storedHash, "hex");

  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}
