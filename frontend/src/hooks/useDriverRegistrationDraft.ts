import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  useCandidaturaDraftGet,
  useCandidaturaDraftSave,
} from "@/api/candidaturaApi";
import {
  clearDraft,
  readDraft,
  writeDraft,
} from "@/lib/registrationDraftStorage";

const AUTOSAVE_DEBOUNCE_MS = 500;
const RESTORE_SAFETY_TIMEOUT_MS = 1500;
const DEFAULT_STEP = "tela0";

interface UseDriverRegistrationDraftArgs {
  driverUserId: string;
  cargaId: string;
  /**
   * CPF normalizado (11 digitos). Quando o motorista NAO tem session
   * Supabase, o backend exige cpf no body do POST /draft (Bug-8 fix).
   * Sem cpf E sem session → save server-side e ignorado e o aviso publico
   * "salvo so nesse aparelho" e exibido uma vez.
   */
  cpf?: string;
}

export interface UseDriverRegistrationDraftReturn {
  data: Record<string, unknown>;
  currentStep: string;
  setData: (next: Record<string, unknown>) => void;
  setCurrentStep: (step: string) => void;
  isRestoring: boolean;
  flushAndClose: () => Promise<void>;
  clearAndReset: () => void;
}

function extractStep(dados: Record<string, unknown>): string {
  const raw = dados.__currentStep;
  return typeof raw === "string" && raw.length > 0 ? raw : DEFAULT_STEP;
}

/**
 * Hook do wizard v2 de cadastro (CADASTRO-09 / D-05).
 *
 * - Hidrata `data` + `currentStep` de localStorage sincronamente no mount.
 * - Concilia com o servidor (GET /api/candidatura/draft/me) — server > local.
 * - Persiste cada mutação em localStorage instantaneamente.
 * - Sync com backend (POST /api/candidatura/draft) debounced 500ms.
 * - `flushAndClose` cancela debounce, sincroniza imediatamente e mostra toast.
 * - `clearAndReset` apaga local + reseta estado (chamar após submit final).
 */
export function useDriverRegistrationDraft({
  driverUserId,
  cargaId,
  cpf,
}: UseDriverRegistrationDraftArgs): UseDriverRegistrationDraftReturn {
  const localInitialRef = useRef(readDraft(driverUserId));
  const localInitial = localInitialRef.current;

  const [data, setDataState] = useState<Record<string, unknown>>(
    localInitial?.data ?? {},
  );
  const [currentStep, setCurrentStepState] = useState<string>(
    localInitial?.currentStep ?? DEFAULT_STEP,
  );
  const [isRestoring, setIsRestoring] = useState<boolean>(true);

  // Fix F5 publico: passa o CPF pro server-query quando nao ha session — assim
  // o GET /api/candidatura/draft/me?cpf=XXX hidrata o draft anonimo apos refresh.
  // Iter #7: passa cargaId pra escopar o draft a esta carga (multi-draft).
  const serverDraftQuery = useCandidaturaDraftGet(driverUserId || null, cpf ?? null, cargaId);
  const saveMutation = useCandidaturaDraftSave();

  // True quando NAO ha session Supabase do motorista. Nesse fluxo (Bug-8 P1)
  // o backend aceita o draft via CPF; sem CPF o save fica so localStorage.
  const isAnonymous = !driverUserId;

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasReconciledRef = useRef(false);

  // Safety: nunca deixar isRestoring travado mais que 1.5s.
  useEffect(() => {
    if (!isRestoring) {
      return;
    }

    restoreFallbackTimer.current = setTimeout(() => {
      setIsRestoring(false);
    }, RESTORE_SAFETY_TIMEOUT_MS);

    return () => {
      if (restoreFallbackTimer.current) {
        clearTimeout(restoreFallbackTimer.current);
        restoreFallbackTimer.current = null;
      }
    };
  }, [isRestoring]);

  // Reconciliação com o servidor (ocorre uma vez quando a query resolve).
  useEffect(() => {
    if (hasReconciledRef.current) {
      return;
    }

    // Fix F5 publico: aceita reconciliacao quando ha session (driverUserId)
    // OU quando ha CPF (fluxo anonimo). Sem nenhum dos dois nao ha chave
    // pra identificar o draft no servidor.
    const cpfDigits = (cpf ?? "").replace(/\D/g, "");
    const canReconcile = !!driverUserId || cpfDigits.length === 11;
    if (!canReconcile) {
      return;
    }

    if (serverDraftQuery.isLoading) {
      return;
    }

    if (!serverDraftQuery.isSuccess && !serverDraftQuery.isError) {
      return;
    }

    hasReconciledRef.current = true;

    const serverPayload = serverDraftQuery.data;

    if (serverPayload && serverPayload.draft) {
      const serverDados = serverPayload.draft.dados ?? {};
      const serverStep = extractStep(serverDados);
      const serverCargaId = serverPayload.draft.cargaId ?? cargaId;

      setDataState(serverDados);
      setCurrentStepState(serverStep);
      if (driverUserId) {
        writeDraft({
          driverUserId,
          cargaId: serverCargaId,
          data: serverDados,
          currentStep: serverStep,
        });
      }

      if (localInitial && serverStep !== DEFAULT_STEP) {
        toast.info("Continuando de onde você parou.", { duration: 3000 });
      } else if (!localInitial && serverStep !== DEFAULT_STEP) {
        toast.info("Continuando de onde você parou.", { duration: 3000 });
      }
    } else if (localInitial && localInitial.expiresAt < Date.now()) {
      clearDraft(driverUserId);
      setDataState({});
      setCurrentStepState(DEFAULT_STEP);
      toast.info(
        "Seu rascunho anterior expirou. Vamos recomeçar do zero.",
        { duration: 5000 },
      );
    }

    setIsRestoring(false);
  }, [
    cargaId,
    cpf,
    driverUserId,
    localInitial,
    serverDraftQuery.data,
    serverDraftQuery.isError,
    serverDraftQuery.isLoading,
    serverDraftQuery.isSuccess,
  ]);

  // Limpa o debounce ao desmontar.
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, []);

  const scheduleServerSave = useCallback(
    (nextData: Record<string, unknown>) => {
      if (!cargaId) {
        return;
      }

      // Bug-8: anonimo SEM cpf → so localStorage (writeDraft ja rodou
      // no setData/setCurrentStep). Sem toast para nao poluir UX quando
      // motorista entra via notificacao ("atualizar documentos") — ele
      // so quer continuar, nao esta pensando em multi-device.
      if (isAnonymous && !cpf) {
        return;
      }

      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }

      debounceTimer.current = setTimeout(() => {
        saveMutation.mutate({
          cargaId,
          dados: nextData,
          ...(isAnonymous && cpf ? { cpf } : {}),
        });
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [cargaId, cpf, isAnonymous, saveMutation],
  );

  const setData = useCallback(
    (next: Record<string, unknown>) => {
      setDataState(next);
      if (driverUserId) {
        writeDraft({
          driverUserId,
          cargaId,
          data: next,
          currentStep,
        });
      }
      scheduleServerSave(next);
    },
    [cargaId, currentStep, driverUserId, scheduleServerSave],
  );

  const setCurrentStep = useCallback(
    (step: string) => {
      setCurrentStepState(step);
      const merged = { ...data, __currentStep: step };
      setDataState(merged);
      if (driverUserId) {
        writeDraft({
          driverUserId,
          cargaId,
          data: merged,
          currentStep: step,
        });
      }
      scheduleServerSave(merged);
    },
    [cargaId, data, driverUserId, scheduleServerSave],
  );

  const flushAndClose = useCallback(async () => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }

    if (!cargaId) {
      return;
    }

    const payload = { ...data, __currentStep: currentStep };

    // Bug-8: anonimo sem cpf → flush so localStorage (writeDraft ja rodou).
    // Sem toast — silent. Motorista nao precisa saber.
    if (isAnonymous && !cpf) {
      return;
    }

    try {
      await saveMutation.mutateAsync({
        cargaId,
        dados: payload,
        ...(isAnonymous && cpf ? { cpf } : {}),
      });
      toast.info(
        "Rascunho salvo. Continue depois pelo botão Candidatar-se.",
        { duration: 4000 },
      );
    } catch {
      toast.error(
        "Não conseguimos salvar o rascunho. Verifique sua conexão.",
        { duration: 5000 },
      );
    }
  }, [cargaId, cpf, currentStep, data, isAnonymous, saveMutation]);

  const clearAndReset = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (driverUserId) {
      clearDraft(driverUserId);
    }
    setDataState({});
    setCurrentStepState(DEFAULT_STEP);
    hasReconciledRef.current = true;
  }, [driverUserId]);

  return {
    data,
    currentStep,
    setData,
    setCurrentStep,
    isRestoring,
    flushAndClose,
    clearAndReset,
  };
}
