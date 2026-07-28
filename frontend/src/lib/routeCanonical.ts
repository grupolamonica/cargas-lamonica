// Chave CANÔNICA de rota (origem→destino) para o Monitor — ESPELHO EXATO do backend
// `normalizeRouteCodeLocation` (backend/src/domain/operator-admin/route-utils.js).
//
// Precisa produzir a MESMA saída do backend, porque o arrastar/reordenar/reserva
// valida "mesma rota" nos DOIS lados: o front decide se solta (guarda visual + fila),
// o back re-valida (reassign/descend/assign-reserva). Se divergirem, o front deixa
// soltar e o back recusa com "Só é possível reordenar dentro da mesma rota…".
//
// Dobra APENAS variações de GRAFIA do mesmo local (acento, caixa, espaço, sufixo de
// UF "/BA" vs " / BA", sufixo operacional "-03") — SEM apelidos de cidade, então
// sub-locais distintos (Salvador Pirajá ≠ Retiro) seguem separados (mesma regra
// conservadora do código de rota, PR #329). Ao mudar aqui, mude no backend também.

function normalizeRouteLocation(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function stripRouteStateSuffix(value: string): string {
  return value.replace(/\s*[-/]\s*[a-z]{2}$/i, "").trim();
}

function stripOperationalLocationSuffix(value: string): string {
  return value
    .replace(/[-_/]\s*\d+\b/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Local canonicalizado por grafia (espelho de backend normalizeRouteCodeLocation). */
export function normalizeRouteCodeLocation(value: string | null | undefined): string {
  return stripOperationalLocationSuffix(stripRouteStateSuffix(normalizeRouteLocation(value)));
}

/** Chave de rota canônica "origem→destino" — comparável entre cargas do mesmo trecho. */
export function routeCanonKey(origem: string | null | undefined, destino: string | null | undefined): string {
  return `${normalizeRouteCodeLocation(origem)}→${normalizeRouteCodeLocation(destino)}`;
}
