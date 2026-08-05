// Conflito de alocação (mesmo motorista/placa em outra carga do dia) devolvido pelo
// backend como 409 com `details.code = "DUPLICATE_ALLOCATION"`.
//
// Discriminar por `status === 409` seria ERRADO: os mesmos endpoints devolvem 409 para
// outras situações que NÃO são confirmáveis (código de viagem duplicado
// DUPLICATE_TRIP_CODE, carga unificada CARGO_MERGED_OR_RETIRED) e que devem continuar
// como erro puro. Por isso o predicado casa o código, não o status.

export const DUPLICATE_ALLOCATION_CODE = "DUPLICATE_ALLOCATION";

/** Carga em conflito, como o backend descreve (find-allocation-conflicts.js). */
export type AllocationConflict = {
  lh: string | null;
  data: string | null;
  horario: string | null;
  origem: string | null;
  destino: string | null;
  motorista: string | null;
  cavalo: string | null;
  conflitaMotorista: boolean;
  conflitaCavalo: boolean;
};

/**
 * É o aviso de duplicidade — confirmável pelo operador?
 * `ApiError` não é exportado pelo apiClient, então o teste é por forma (duck-typing).
 */
export function isDuplicateAllocationError(e: unknown): boolean {
  return (e as { details?: { code?: string } } | null)?.details?.code === DUPLICATE_ALLOCATION_CODE;
}

/** Lista de conflitos que o backend anexou ao erro (vazia se ausente/malformada). */
export function duplicateAllocationConflicts(e: unknown): AllocationConflict[] {
  const raw = (e as { details?: { conflitos?: unknown } } | null)?.details?.conflitos;
  return Array.isArray(raw) ? (raw as AllocationConflict[]) : [];
}

// ── Edição simultânea ────────────────────────────────────────────────────────

export const ALLOCATION_CHANGED_CODE = "ALLOCATION_CHANGED";

/**
 * Outra pessoa alterou esta carga entre o carregamento da tela e o save?
 * Também confirmável — mesma razão de casar por CÓDIGO e não por status 409.
 */
export function isAllocationChangedError(e: unknown): boolean {
  return (e as { details?: { code?: string } } | null)?.details?.code === ALLOCATION_CHANGED_CODE;
}

/**
 * Carimbo que o backend manda no erro para servir de baseline ao reenviar. Sem usá-lo,
 * confirmar a sobrescrita cairia no MESMO aviso, em loop.
 */
export function allocationChangedBaseline(e: unknown): string | null {
  const raw = (e as { details?: { allocUpdatedAt?: unknown } } | null)?.details?.allocUpdatedAt;
  return typeof raw === "string" ? raw : null;
}
