/**
 * Coerência de identidade (front) — espelho de
 * `backend/src/domain/identity/identity-match.js`. Compara de forma TOLERANTE o
 * nome digitado com o nome da CNH (OCR), barrando só divergência clara (troca de
 * pessoa) e absorvendo ruído de OCR / nome do meio / abreviação / acento.
 */

const PARTICULAS = new Set(["de", "da", "do", "das", "dos", "e", "di", "du", "del", "la"]);

export function normalizeName(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameTokens(value: string | null | undefined): string[] {
  return normalizeName(value)
    .split(" ")
    .filter((t) => t && !PARTICULAS.has(t));
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let cur = new Array<number>(n + 1).fill(0);
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

function tokenSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  const max = Math.max(a.length, b.length);
  if (max <= 3) return a === b;
  if ((a.length === 1 || b.length === 1) && (a.startsWith(b) || b.startsWith(a))) return true;
  return editDistance(a, b) <= (max <= 6 ? 1 : 2);
}

/** true = deixa passar; false = divergência clara (barra). Lado vazio → true. */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
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

export const NOME_DIVERGENTE_CNH_MENSAGEM =
  "Os dados digitados não batem com os dados da CNH do motorista. Confira o nome ou anexe a CNH correta.";
