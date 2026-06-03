import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  useCandidaturaDraftGet,
  useCandidaturaDraftSave,
} from "@/api/candidaturaApi";
import { getCadastro, patchCadastroDados } from "@/services/readModels";
import {
  clearDraft,
  readDraft,
  writeDraft,
} from "@/lib/registrationDraftStorage";

// Iter #7 — reduzido de 500ms -> 200ms pra minimizar a janela de perda em
// cenarios mobile (motorista alterna apps logo apos upload de documento).
const AUTOSAVE_DEBOUNCE_MS = 200;
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
  /**
   * Modo operador (resgate de rascunho pelo painel). Quando presente, o draft é
   * carregado e salvo por ID via endpoints do operador
   * (GET/PATCH /api/operator/cadastros/:id) em vez do fluxo motorista/CPF.
   * O token do operador é resolvido internamente pelos services (readModels).
   */
  operatorCadastroId?: string;
}

export interface UseDriverRegistrationDraftReturn {
  data: Record<string, unknown>;
  currentStep: string;
  setData: (next: Record<string, unknown>) => void;
  setCurrentStep: (step: string) => void;
  isRestoring: boolean;
  flushAndClose: () => Promise<void>;
  /**
   * Iter #7 — Flush sincrono do draft (debounce cancelado, save imediato).
   * Chamado apos upload de documento (CNH/comprovante) para garantir que o
   * path persistido nao se perca se o motorista alterna app/aba antes do
   * debounce padrao disparar.
   */
  flushDraftImmediate: () => Promise<void>;
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
  operatorCadastroId,
}: UseDriverRegistrationDraftArgs): UseDriverRegistrationDraftReturn {
  const isOperator = !!operatorCadastroId;
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

  // Modo operador: carrega o draft por ID via endpoint do operador (full dados).
  // `enabled` só quando há cadastroId — caso contrário a query fica inerte e o
  // fluxo motorista/CPF acima permanece intocado.
  const operatorQuery = useQuery({
    queryKey: ["operator-cadastro-draft", operatorCadastroId],
    queryFn: () => getCadastro(operatorCadastroId as string),
    enabled: isOperator,
    staleTime: 30_000,
  });

  // Salva o draft do operador por ID (PATCH /api/operator/cadastros/:id/dados).
  const operatorSave = useCallback(
    (next: Record<string, unknown>) => {
      if (!operatorCadastroId) return Promise.resolve();
      return patchCadastroDados(operatorCadastroId, next).catch(() => {
        /* autosave best-effort — estado local preservado */
      });
    },
    [operatorCadastroId],
  );

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

  // Reconciliação modo operador: hidrata data + currentStep a partir do
  // cadastro carregado por ID. Roda uma vez quando a query resolve.
  useEffect(() => {
    if (!isOperator || hasReconciledRef.current) {
      return;
    }
    if (operatorQuery.isLoading) {
      return;
    }
    if (!operatorQuery.isSuccess && !operatorQuery.isError) {
      return;
    }

    hasReconciledRef.current = true;

    const dados = (operatorQuery.data?.cadastro?.dados ?? {}) as Record<string, unknown>;
    setDataState(dados);
    setCurrentStepState(extractStep(dados));
    setIsRestoring(false);
  }, [
    isOperator,
    operatorQuery.data,
    operatorQuery.isError,
    operatorQuery.isLoading,
    operatorQuery.isSuccess,
  ]);

  // Reconciliação com o servidor (ocorre uma vez quando a query resolve).
  useEffect(() => {
    if (isOperator || hasReconciledRef.current) {
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
    isOperator,
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
      // Modo operador: salva por ID (PATCH), debounced. Independe de cargaId
      // (rascunho standalone tem carga_id NULL).
      if (isOperator) {
        if (debounceTimer.current) {
          clearTimeout(debounceTimer.current);
        }
        debounceTimer.current = setTimeout(() => {
          void operatorSave(nextData);
        }, AUTOSAVE_DEBOUNCE_MS);
        return;
      }

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
    [cargaId, cpf, isAnonymous, isOperator, operatorSave, saveMutation],
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

    // Modo operador: flush imediato via PATCH por ID. Sem toast (UX operador).
    if (isOperator) {
      await operatorSave({ ...data, __currentStep: currentStep });
      return;
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
  }, [cargaId, cpf, currentStep, data, isAnonymous, isOperator, operatorSave, saveMutation]);

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

  /**
   * Iter #7 — Flush sincrono: cancela debounce, dispara save imediato.
   * Usado apos upload de documento pra garantir persistencia.
   */
  const flushDraftImmediate = useCallback(async () => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    if (isOperator) {
      await operatorSave(data);
      return;
    }
    if (!cargaId) return;
    if (isAnonymous && !cpf) {
      // Sem chave server-side, localStorage ja foi atualizado em setData.
      return;
    }
    try {
      await saveMutation.mutateAsync({
        cargaId,
        dados: data,
        ...(isAnonymous && cpf ? { cpf } : {}),
      });
    } catch {
      // Erro de rede aqui nao bloqueia o flow — localStorage ainda tem o draft.
    }
  }, [cargaId, cpf, data, isAnonymous, isOperator, operatorSave, saveMutation]);

  // Iter #7 — beforeunload + visibilitychange: flush antes de fechar/trocar
  // de aba garante que uploads recem-feitos nao se percam no debounce.
  // sendBeacon via fetch nao funciona com tokens Bearer — entao usamos
  // fetch sincrono (keepalive: true) que sobrevive ao unload.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isOperator) return; // operador salva via PATCH debounced; sem sync driver
    if (!cargaId) return;
    if (isAnonymous && !cpf) return; // sem chave server-side, sem flush

    const flushSync = () => {
      try {
        const url = "/api/candidatura/draft";
        const body = JSON.stringify({
          cargaId,
          dados: data,
          ...(isAnonymous && cpf ? { cpf } : {}),
        });
        // keepalive=true permite que a request termine apos o unload.
        // Bearer token nao esta em scope aqui pois saveMutation o injeta —
        // usamos o cookie de sessao do navegador (fluxo anonimo) ou o token
        // ja salvo pelo client (auth flow). Best-effort: silent fail.
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        // Tenta capturar access token do localStorage Supabase (driver session).
        try {
          const sessionRaw =
            window.localStorage.getItem("lamonica-driver-auth");
          if (sessionRaw) {
            const parsed = JSON.parse(sessionRaw);
            const token = parsed?.currentSession?.access_token;
            if (token) headers.Authorization = `Bearer ${token}`;
          }
        } catch {
          // ignore
        }
        void fetch(url, {
          method: "POST",
          headers,
          body,
          keepalive: true,
        }).catch(() => {});
      } catch {
        // ignore
      }
    };

    const handleBeforeUnload = () => {
      flushSync();
    };
    const handleVisibilityChange = () => {
      if (document.hidden) flushSync();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [cargaId, cpf, data, isAnonymous, isOperator]);

  return {
    data,
    currentStep,
    setData,
    setCurrentStep,
    isRestoring,
    flushAndClose,
    flushDraftImmediate,
    clearAndReset,
  };
}
