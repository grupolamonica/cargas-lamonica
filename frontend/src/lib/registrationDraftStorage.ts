/**
 * Persistência local do rascunho do wizard de cadastro v2 (CADASTRO-09 / D-05).
 *
 * Cache imediato em localStorage. Chave inclui `driverUserId` para evitar
 * vazamento de dados entre contas. TTL deslizante de 72h é renovado a cada
 * `writeDraft`. O servidor (POST /api/candidatura/draft) é a source of truth
 * para recuperação cross-device — este módulo cuida apenas do cache local.
 */

const DRAFT_STORAGE_PREFIX = "lamonica-cadastro-v2-draft";
const TTL_MS = 72 * 60 * 60 * 1000;

export interface StoredDraft {
  driverUserId: string;
  cargaId: string;
  data: Record<string, unknown>;
  currentStep: string;
  updatedAt: number;
  expiresAt: number;
}

function getDraftKey(driverUserId: string): string {
  return `${DRAFT_STORAGE_PREFIX}:${driverUserId}`;
}

export function readDraft(driverUserId: string): StoredDraft | null {
  if (typeof window === "undefined") {
    return null;
  }

  if (!driverUserId) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(getDraftKey(driverUserId));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as StoredDraft;

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    if (parsed.driverUserId !== driverUserId) {
      return null;
    }

    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt < Date.now()) {
      window.localStorage.removeItem(getDraftKey(driverUserId));
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function writeDraft(
  draft: Omit<StoredDraft, "updatedAt" | "expiresAt">,
): StoredDraft {
  const now = Date.now();
  const next: StoredDraft = {
    ...draft,
    updatedAt: now,
    expiresAt: now + TTL_MS,
  };

  if (typeof window !== "undefined" && draft.driverUserId) {
    try {
      window.localStorage.setItem(
        getDraftKey(draft.driverUserId),
        JSON.stringify(next),
      );
    } catch {
      // Storage cheio ou desabilitado — ignora silenciosamente.
    }
  }

  return next;
}

export function clearDraft(driverUserId: string): void {
  if (typeof window === "undefined") {
    return;
  }

  if (!driverUserId) {
    return;
  }

  try {
    window.localStorage.removeItem(getDraftKey(driverUserId));
  } catch {
    // ignore
  }
}
