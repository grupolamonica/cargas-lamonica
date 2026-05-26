import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

import {
  CandidaturaApiError,
  requestCandidaturaPreCheck,
  useCandidaturaPreCheck,
  type CandidaturaPendency,
  type PreCheckResponse,
} from "@/api/candidaturaApi";
import { Skeleton } from "@/components/ui/skeleton";
import { useDriverAuth } from "@/hooks/useDriverAuth";
import { useDriverRegistrationDraft } from "@/hooks/useDriverRegistrationDraft";
import { cn } from "@/lib/utils";
import { onlyDigits } from "@/lib/brazilianValidators";
import {
  persistStoredLeadState,
  readStoredLeadState,
} from "@/lib/driverLeadStorage";
import { createPublicLoadLeadPreRegistration } from "@/services/loadClaims";
import { toast } from "@/components/ui/use-toast";

import {
  ConfirmationScreen,
  type ConfirmationCargaContext,
  type ConfirmationWizardData,
} from "./ConfirmationScreen";
import { RegistrationWizardShell } from "./RegistrationWizardShell";
import { StepAMotorista, type StepAData, type StepADriverProfile } from "./steps/StepAMotorista";
import { StepBCavalo, type StepBData } from "./steps/StepBCavalo";
import {
  StepCProprietarioCavalo,
  type StepCData,
} from "./steps/StepCProprietarioCavalo";
import {
  StepDCarretas,
  type CavaloOwnerCollected,
  type CollectedCarretaOwner,
  type StepDCarretaEntry,
  type StepDData,
  type StepDTrailerInput,
} from "./steps/StepDCarretas";
import {
  StepECarretaOwner,
  type StepEData,
} from "./steps/StepECarretaOwner";
import { StepCAnttCavalo } from "./steps/StepCAnttCavalo";
import { StepEAnttCarreta } from "./steps/StepEAnttCarreta";
import { SubmissionSuccess } from "./widgets/SubmissionSuccess";
import { AlreadyRegisteredScreen } from "./widgets/AlreadyRegisteredScreen";
import { TelaZeroPendencies } from "./TelaZeroPendencies";
import {
  describeSkippedStep,
  nextPendencyStep,
  type WizardStepKind as ComputedStepKind,
} from "./lib/computeNextStep";

export interface DriverRegistrationWizardContext {
  cargaId?: string;
  horsePlate: string;
  trailerPlates: string[];
}

export interface DriverRegistrationWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cargaId?: string;
  horsePlate?: string;
  trailerPlates?: string[];
  /**
   * Contexto opcional da carga (origem/destino/routeLabel) usado para exibir
   * um rótulo amigável no summary card da ConfirmationScreen em vez do UUID.
   */
  cargaContext?: ConfirmationCargaContext;
  /**
   * CPF digitado pelo motorista no DriverClaimPanel (sem máscara).
   * Pré-preenche o Step A e é usado como identificador no submit público.
   */
  cpf?: string;
  /**
   * Resultado do pre-check já executado pelo interceptor do DriverClaimPanel.
   * Quando fornecido, o wizard pula o runPreCheck interno e abre direto na Tela 0.
   */
  initialPreCheckResponse?: PreCheckResponse;
  onPreCheckPassed: (ctx: DriverRegistrationWizardContext) => void;
}

interface PendingCarretaForOwner {
  idx: number;
  ownerDocFromCrlv: string;
  partialEntry: Omit<StepDCarretaEntry, "owner_resolution">;
}

type WizardStepKind =
  | "tela0"
  | "step-a"
  | "step-b"
  | "step-c"
  | "step-c-antt"
  | "step-d"
  | "step-e"
  | "step-e-antt"
  | "confirmation"
  | "already-up-to-date"
  | "success";

type WizardState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "tela0"; response: PreCheckResponse }
  | { kind: "step-a"; response: PreCheckResponse }
  | { kind: "step-b" }
  | { kind: "step-c"; driverIsOwner?: boolean }
  | { kind: "step-c-antt" }
  | { kind: "step-d" }
  | { kind: "step-e"; pending: PendingCarretaForOwner }
  | { kind: "step-e-antt" }
  | { kind: "confirmation" }
  // 19/05 — quando o pre-check retorna zero pendencias, exibimos
  // AlreadyRegisteredScreen em vez de fechar silenciosamente o wizard.
  | { kind: "already-up-to-date"; response: PreCheckResponse }
  // BUG-WALK-04 + BUG-WALK-07: "submitting" não vive no FSM porque
  // desmontava ConfirmationScreen e destruía a React Query mutation antes
  // do onError disparar. O overlay "Enviando sua candidatura…" agora vive
  // dentro do ConfirmationScreen (via submitMutation.isPending).
  | { kind: "success"; protocolo: string }
  | { kind: "error"; message: string; status: number };

function maskPhoneLastTwo(phone?: string | null): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 2) return undefined;
  return `**${digits.slice(-2)}`;
}

function hasValidContext(horsePlate?: string, trailerPlates?: string[]): boolean {
  return Boolean(horsePlate && horsePlate.trim().length > 0 && Array.isArray(trailerPlates));
}

function pendenciasToTrailers(
  pendencias: CandidaturaPendency[],
): StepDTrailerInput[] {
  return pendencias
    .filter((pend) => pend.step === "D" && pend.plate)
    .map((pend) => ({
      plate: pend.plate as string,
      daysUntilExpiry: pend.daysUntilExpiry,
    }))
    .slice(0, 2);
}

function deriveCavaloOwnerCollected(
  stepCData: StepCData | null,
): CavaloOwnerCollected | undefined {
  if (!stepCData) return undefined;
  const doc = onlyDigits(stepCData.owner.documento);
  if (!doc) return undefined;
  const docType = stepCData.owner.docType;
  const collected: CavaloOwnerCollected = { doc, docType };
  if (docType === "cpf" && stepCData.pf) {
    // 2026-05-18 — Banco/PIS/cor_raca/estado_civil migraram para
    // anttTitularSchema (cavalo). Coletamos apenas contato.
    collected.pfData = {
      telefone: stepCData.pf.telefone,
      cep: stepCData.pf.cep,
      numero: stepCData.pf.numero,
      comprovanteFileName: stepCData.pf.comprovanteFileName,
    };
  } else if (docType === "cnpj") {
    collected.pjData = {};
  }
  return collected;
}

interface PersistedWizardSlices {
  stepA?: StepAData | null;
  stepB?: StepBData | null;
  stepC?: StepCData | null;
  stepD?: StepDData | null;
  stepE?: Record<number, StepEData>;
  ownerDocFromCrlv?: string;
  currentTrailerIdx?: number;
  collectedCarretaOwners?: CollectedCarretaOwner[];
  preCheckResponse?: PreCheckResponse | null;
}

function readPersistedSlice<K extends keyof PersistedWizardSlices>(
  data: Record<string, unknown>,
  key: K,
): PersistedWizardSlices[K] | undefined {
  const value = data[key];
  return value as PersistedWizardSlices[K] | undefined;
}

function isPersistedStepKind(value: string): value is WizardStepKind {
  return (
    value === "tela0" ||
    value === "step-a" ||
    value === "step-b" ||
    value === "step-c" ||
    value === "step-c-antt" ||
    value === "step-d" ||
    value === "step-e" ||
    value === "step-e-antt" ||
    value === "confirmation" ||
    value === "success"
  );
}

/**
 * Wizard root do cadastro v2.
 *
 * Fluxo:
 *  1. Ao montar (open=true + contexto válido) dispara POST /api/candidatura/pre-check.
 *  2. pendências.length === 0 -> fecha wizard + chama onPreCheckPassed (handoff para
 *     fluxo de candidatura existente). NÃO renderiza Tela 0 vazia.
 *  3. pendências.length > 0 -> renderiza Tela 0 com lista.
 *  4. Erro -> banner admin-tint-danger + retry (ou mensagem de sessão expirada em 401).
 *  5. Persistência (plan 12): rascunho é salvo em localStorage + servidor (debounced 500ms).
 *     Ao reabrir dentro de 72h, restaura o passo exato com toast informativo.
 */
export function DriverRegistrationWizard({
  open,
  onOpenChange,
  cargaId,
  horsePlate,
  trailerPlates,
  cargaContext,
  cpf,
  initialPreCheckResponse,
  onPreCheckPassed,
}: DriverRegistrationWizardProps) {
  const driverAuth = useDriverAuth();
  const driverUserId = driverAuth.user?.id ?? "";
  const accessToken = driverAuth.session?.access_token ?? null;
  const preCheck = useCandidaturaPreCheck();

  const [state, setState] = useState<WizardState>({ kind: "idle" });
  const [stepAData, setStepAData] = useState<StepAData | null>(null);
  const [stepBData, setStepBData] = useState<StepBData | null>(null);
  const [stepCData, setStepCData] = useState<StepCData | null>(null);
  const [stepDData, setStepDData] = useState<StepDData | null>(null);
  const [stepEDataMap, setStepEDataMap] = useState<Record<number, StepEData>>({});
  const [ownerDocFromCrlv, setOwnerDocFromCrlv] = useState<string>("");
  const [currentTrailerIdx, setCurrentTrailerIdx] = useState<number>(0);
  const [collectedCarretaOwners, setCollectedCarretaOwners] = useState<
    CollectedCarretaOwner[]
  >([]);
  const [preCheckResponse, setPreCheckResponse] = useState<PreCheckResponse | null>(null);
  const [cavaloOwnerIsDriver, setCavaloOwnerIsDriver] = useState<boolean>(false);
  // CPF adotado a partir da CNH (Bug 15/05). Quando preenchido, sobrescreve o
  // CPF original do driverProfile/cpf prop nas referências internas, sem mexer
  // na sessão Supabase (read-only) — apenas no que é persistido como lead.
  const [adoptedCpf, setAdoptedCpf] = useState<string | null>(null);

  // Passa cpf pro hook quando NÃO ha sessão Supabase — sem isso o hook trata
  // como "anonimo sem cpf" e pula o save no servidor. Tambem habilita o
  // fallback de chave localStorage `cpf:<cpf>` (cobre F5 no fluxo público).
  // FIX 20/05: usa adoptedCpf (CPF da CNH) quando o motorista clicou
  // "Atualizar candidatura para este CPF" no card de mismatch. Sem isso, o
  // save-draft-by-cpf gravava motorista.cpf com o CPF antigo do pre-check
  // mesmo após adoção (todos os uploads ficavam sob a key correta, mas o
  // JSONB referenciava CPF errado).
  const draftCpf = driverUserId
    ? undefined
    : onlyDigits(adoptedCpf ?? cpf ?? "") || undefined;
  const draft = useDriverRegistrationDraft({
    driverUserId,
    cargaId: cargaId ?? "",
    cpf: draftCpf,
  });
  const hasHydratedFromDraftRef = useRef(false);

  const driverProfile = useMemo<StepADriverProfile>(() => {
    const metadata = (driverAuth.user?.user_metadata ?? {}) as Record<string, unknown>;
    // Prefer authenticated document_number; fall back to cpf prop (public/no-auth flow).
    // Quando o motorista adota o CPF da CNH no Bug 15/05 (mismatch),
    // `adoptedCpf` sobrescreve as fontes anteriores para todo o restante do wizard.
    const baseDocumentNumber =
      typeof metadata.document_number === "string" && metadata.document_number
        ? metadata.document_number
        : (cpf ?? "");
    const documentNumber = adoptedCpf ?? baseDocumentNumber;
    const phone = typeof metadata.phone === "string" ? metadata.phone : "";
    const fullName =
      typeof metadata.full_name === "string" ? metadata.full_name : undefined;
    return {
      document_number: documentNumber,
      phone,
      nome: fullName,
    };
  }, [driverAuth.user, cpf, adoptedCpf]);

  const safeTrailerPlates = useMemo(
    () => (Array.isArray(trailerPlates) ? trailerPlates : []),
    [trailerPlates],
  );

  const handoffContext = useMemo<DriverRegistrationWizardContext | null>(() => {
    if (!horsePlate) return null;
    return {
      cargaId,
      horsePlate,
      trailerPlates: safeTrailerPlates,
    };
  }, [cargaId, horsePlate, safeTrailerPlates]);

  const trailersToCollect = useMemo<StepDTrailerInput[]>(
    () => (preCheckResponse ? pendenciasToTrailers(preCheckResponse.pendencias) : []),
    [preCheckResponse],
  );

  const cavaloOwnerCollected = useMemo<CavaloOwnerCollected | undefined>(
    () => deriveCavaloOwnerCollected(stepCData),
    [stepCData],
  );

  const totalSteps = useMemo(() => {
    if (!preCheckResponse) return 4;
    const hasStepA = preCheckResponse.pendencias.some((p) => p.step === "A");
    const hasStepB = preCheckResponse.pendencias.some((p) => p.step === "B");
    const stepDCount = preCheckResponse.pendencias.filter((p) => p.step === "D").length;
    // step-c is conditional: only when cavalo owner ≠ driver (discovered after step-b).
    // Use stepCData presence OR being in step-c/step-e state as signal.
    const hasStepC =
      stepCData !== null ||
      state.kind === "step-c" ||
      state.kind === "step-c-antt" ||
      state.kind === "step-e" ||
      state.kind === "step-e-antt";
    // 2026-05-20 — etapas ANTT: +1 quando há Step C (proprietário do cavalo),
    // +1 quando há Step E (proprietário da carreta). Não soma por carreta pra
    // não inflar a contagem no header.
    const hasStepCAntt = hasStepC;
    // 2026-05-26 BUG-40 fix — step-e (Proprietário da carreta) era detectado
    // como "hard to predict upfront" e não contado. Mas quando o owner CRLV
    // da carreta difere do cavalo (caso comum em arrendamentos), step-e
    // aparece com baseStep=6 e step-e-antt com baseStep=7 — gerando header
    // "ETAPA 7 DE 6". Contamos quando há sinal de step-e (state ou dados
    // coletados), espelho da heurística de hasStepC.
    const hasStepE =
      state.kind === "step-e" ||
      state.kind === "step-e-antt" ||
      Object.keys(stepEDataMap).length > 0 ||
      collectedCarretaOwners.length > 0;
    const hasStepEAntt = stepDCount > 0; // se há carreta, haverá owner ANTT
    return (
      (hasStepA ? 1 : 0) +
      (hasStepB ? 1 : 0) +
      (hasStepC ? 1 : 0) +
      (hasStepCAntt ? 1 : 0) +
      stepDCount +
      (hasStepE ? 1 : 0) +
      (hasStepEAntt ? 1 : 0)
    );
  }, [preCheckResponse, stepCData, state.kind, stepEDataMap, collectedCarretaOwners]);

  // Derived: whether step-A is among the pending items.
  // Used to compute correct currentStep numbers when step-A is absent.
  const hasStepAInPendencias = preCheckResponse?.pendencias.some((p) => p.step === "A") ?? true;

  // Hidrata o estado local a partir do rascunho persistido assim que ele
  // estiver disponível. Faz apenas uma vez por sessão de abertura.
  useEffect(() => {
    if (!open) {
      return;
    }
    if (draft.isRestoring) {
      return;
    }
    if (hasHydratedFromDraftRef.current) {
      return;
    }

    // Fix F5 publico: a query GET /draft/me?cpf=XXX resolve assincronamente,
    // entao o effect pode disparar com draft.data ainda vazio (antes da
    // reconciliacao terminar). Adia a marcacao de hasHydratedFromDraftRef
    // ate efetivamente termos uma slice pra hidratar — caso contrario o
    // ref selava o caminho e a hidratacao tardia era ignorada (todos os
    // campos a2/a3 ficavam vazios apos refresh).
    const persistedA = readPersistedSlice(draft.data, "stepA");
    const persistedB = readPersistedSlice(draft.data, "stepB");
    const persistedC = readPersistedSlice(draft.data, "stepC");
    const persistedD = readPersistedSlice(draft.data, "stepD");
    const persistedE = readPersistedSlice(draft.data, "stepE");
    const persistedOwnerDocFromCrlv = readPersistedSlice(draft.data, "ownerDocFromCrlv");
    const persistedTrailerIdx = readPersistedSlice(draft.data, "currentTrailerIdx");
    const persistedCarretaOwners = readPersistedSlice(draft.data, "collectedCarretaOwners");
    const persistedPreCheck = readPersistedSlice(draft.data, "preCheckResponse");

    // Se nao ha NENHUMA slice pra hidratar (draft.data ainda vazio porque a
    // query GET /draft/me esta pendente), nao marca o ref e retorna —
    // o useEffect re-disparara quando draft.data mudar.
    const hasAnythingToHydrate = !!persistedA || !!persistedB || !!persistedC || !!persistedD || !!persistedE || !!persistedOwnerDocFromCrlv || typeof persistedTrailerIdx === "number" || (Array.isArray(persistedCarretaOwners) && persistedCarretaOwners.length > 0) || !!persistedPreCheck;
    if (!hasAnythingToHydrate) {
      return;
    }

    hasHydratedFromDraftRef.current = true;

    // Migração 2026-05-16: drafts antigos persistiram a4/a5/a6 em stepA.
    // Quando o usuário reabre, movemos esses campos para stepB se ele ainda
    // não os tiver — sem destruir dados já preenchidos em stepB.
    const legacyA = persistedA as
      | (StepAData & { a4?: unknown; a5?: unknown; a6?: unknown })
      | null
      | undefined;
    const migratedFromA: Partial<StepBData> = {};
    if (legacyA && typeof legacyA === "object") {
      if ("a4" in legacyA && legacyA.a4 !== undefined) {
        migratedFromA.a4 = legacyA.a4 as StepBData["a4"];
      }
      if ("a5" in legacyA && legacyA.a5 !== undefined) {
        migratedFromA.a5 = legacyA.a5 as StepBData["a5"];
      }
      if ("a6" in legacyA && legacyA.a6 !== undefined) {
        migratedFromA.a6 = legacyA.a6 as StepBData["a6"];
      }
    }
    if (persistedA) {
      // Strip a4/a5/a6 do persistedA antes de hidratar — StepAData novo não
      // tem mais esses campos. Compatível com TS strict (tipos atuais).
      const { a4: _a4, a5: _a5, a6: _a6, ...cleanA } = legacyA as Record<
        string,
        unknown
      >;
      void _a4;
      void _a5;
      void _a6;
      // Só hidrata se o draft tem a estrutura mínima (a1 presente) —
      // drafts de versões antigas podem ter shape diferente.
      if (cleanA.a1 && typeof cleanA.a1 === "object") {
        setStepAData(cleanA as unknown as StepAData);
      }
    }
    if (persistedB || Object.keys(migratedFromA).length > 0) {
      const merged: StepBData = {
        ...(persistedB ?? ({} as StepBData)),
        ...migratedFromA,
        // persistedB sempre tem precedência sobre o migrado (usuário pode
        // ter sobrescrito numa sessão posterior).
        ...(persistedB?.a4 !== undefined ? { a4: persistedB.a4 } : {}),
        ...(persistedB?.a5 !== undefined ? { a5: persistedB.a5 } : {}),
        ...(persistedB?.a6 !== undefined ? { a6: persistedB.a6 } : {}),
      };
      setStepBData(merged);
    }
    if (persistedC) setStepCData(persistedC);
    if (persistedD) setStepDData(persistedD);
    if (persistedE) setStepEDataMap(persistedE);
    if (typeof persistedOwnerDocFromCrlv === "string") {
      setOwnerDocFromCrlv(persistedOwnerDocFromCrlv);
    }
    if (typeof persistedTrailerIdx === "number") {
      setCurrentTrailerIdx(persistedTrailerIdx);
    }
    if (Array.isArray(persistedCarretaOwners)) {
      setCollectedCarretaOwners(persistedCarretaOwners);
    }
    if (persistedPreCheck) {
      setPreCheckResponse(persistedPreCheck);
    }

    // Restaura o passo persistido (skip pre-check se já tivermos uma resposta válida).
    if (
      isPersistedStepKind(draft.currentStep) &&
      draft.currentStep !== "tela0" &&
      persistedPreCheck
    ) {
      if (draft.currentStep === "step-a") {
        setState({ kind: "step-a", response: persistedPreCheck });
      } else if (draft.currentStep === "step-b") {
        setState({ kind: "step-b" });
      } else if (draft.currentStep === "step-c") {
        setState({ kind: "step-c" });
      } else if (draft.currentStep === "step-c-antt") {
        setState({ kind: "step-c-antt" });
      } else if (draft.currentStep === "step-d") {
        setState({ kind: "step-d" });
      } else if (draft.currentStep === "step-e-antt") {
        setState({ kind: "step-e-antt" });
      } else if (draft.currentStep === "confirmation") {
        setState({ kind: "confirmation" });
      }
      // step-e não é restaurado diretamente — exige PendingCarreta em memória.
      // Em vez disso, volta para step-d e o usuário re-aciona o owner.
    }
  }, [open, draft.isRestoring, draft.data, draft.currentStep]);

  const runPreCheck = useCallback(() => {
    if (!accessToken) {
      setState({
        kind: "error",
        message: "Sessão expirou. Faça login novamente para continuar.",
        status: 401,
      });
      return;
    }

    if (!horsePlate) {
      setState({
        kind: "error",
        message: "Placa do veículo não informada.",
        status: 400,
      });
      return;
    }

    setState({ kind: "loading" });

    preCheck.mutate(
      {
        horsePlate,
        trailerPlates: safeTrailerPlates,
        accessToken,
      },
      {
        onSuccess: (response) => {
          if (response.pendencias.length === 0) {
            // 19/05 — em vez de fechar silenciosamente, mostra tela
            // AlreadyRegisteredScreen pra confirmar ao motorista que a
            // candidatura foi atualizada. CTA "Ver minhas candidaturas"
            // faz handoff pro fluxo existente.
            setPreCheckResponse(response);
            setState({ kind: "already-up-to-date", response });
            return;
          }

          setPreCheckResponse(response);
          draft.setData({
            ...draft.data,
            preCheckResponse: response as unknown as Record<string, unknown>,
          });
          setState({ kind: "tela0", response });
        },
        onError: (error) => {
          const status = error instanceof CandidaturaApiError ? error.status : 0;
          if (status === 401) {
            setState({
              kind: "error",
              message: "Sessão expirou. Faça login novamente para continuar.",
              status,
            });
            return;
          }
          setState({
            kind: "error",
            message: error.message || "Não conseguimos verificar seu cadastro agora",
            status,
          });
        },
      },
    );
  }, [accessToken, draft, handoffContext, horsePlate, onOpenChange, onPreCheckPassed, preCheck, safeTrailerPlates]);

  // Quando o wizard abre com contexto válido, usa o pre-check já feito pelo interceptor
  // (initialPreCheckResponse) ou dispara um novo — exceto se temos rascunho válido.
  useEffect(() => {
    if (!open) {
      return;
    }

    if (!hasValidContext(horsePlate, safeTrailerPlates)) {
      return;
    }

    if (draft.isRestoring) {
      return;
    }

    if (state.kind !== "idle") {
      return;
    }

    // Se temos rascunho com pre-check + currentStep != tela0, o effect de hidratação
    // já posicionou o estado. Caso contrário, dispara pre-check.
    const persistedPreCheck = readPersistedSlice(draft.data, "preCheckResponse");
    if (
      persistedPreCheck &&
      isPersistedStepKind(draft.currentStep) &&
      draft.currentStep !== "tela0"
    ) {
      return;
    }

    // O interceptor já fez o pre-check — usa o resultado diretamente (sem nova request).
    if (initialPreCheckResponse) {
      if (initialPreCheckResponse.pendencias.length === 0) {
        // 19/05 — exibe AlreadyRegisteredScreen em vez de fechar silenciosamente.
        setPreCheckResponse(initialPreCheckResponse);
        setState({ kind: "already-up-to-date", response: initialPreCheckResponse });
        return;
      }
      setPreCheckResponse(initialPreCheckResponse);
      setState({ kind: "tela0", response: initialPreCheckResponse });
      return;
    }

    runPreCheck();
  }, [
    open,
    horsePlate,
    safeTrailerPlates,
    state.kind,
    runPreCheck,
    initialPreCheckResponse,
    handoffContext,
    onOpenChange,
    onPreCheckPassed,
    draft,
  ]);

  // Reset do estado interno quando o wizard fecha (não limpa o draft).
  useEffect(() => {
    if (!open && state.kind !== "idle") {
      setState({ kind: "idle" });
      hasHydratedFromDraftRef.current = false;
    }
  }, [open, state.kind]);

  // Helper para persistir uma slice no draft mantendo as demais.
  const persistSlice = useCallback(
    (slice: Partial<PersistedWizardSlices>) => {
      draft.setData({
        ...draft.data,
        ...slice,
      } as Record<string, unknown>);
    },
    [draft],
  );

  const handleClose = useCallback(async () => {
    if (driverUserId && cargaId) {
      await draft.flushAndClose();
    }
    onOpenChange(false);
  }, [cargaId, draft, driverUserId, onOpenChange]);

  // Wrapper para o consumidor do Drawer/Dialog. Ao fechar, flush antes.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        onOpenChange(true);
        return;
      }
      void handleClose();
    },
    [handleClose, onOpenChange],
  );

  /**
   * Helper centraliza a logica de "ir pro proximo step pulando os ja
   * cadastrados" — chama nextPendencyStep e exibe toast quando o salto
   * for nao-trivial. Usado por todos os handleStep*Complete.
   *
   * Convencao de `currentTrailerIdx`: caller passa o indice da carreta JA
   * processada; nextPendencyStep faz +1 internamente pra decidir se ha
   * proxima a processar.
   */
  const advanceWithSkip = useCallback(
    (
      from: ComputedStepKind,
      args: {
        ownerIsDriver?: boolean;
        currentTrailerIdx?: number;
      } = {},
    ): ComputedStepKind => {
      const ownerIsDriver = args.ownerIsDriver ?? cavaloOwnerIsDriver;
      const idx = args.currentTrailerIdx ?? currentTrailerIdx;
      const next = nextPendencyStep({
        currentStep: from,
        pendencias: preCheckResponse?.pendencias ?? [],
        ownerIsDriver,
        trailersToCollect,
        currentTrailerIdx: idx,
      });
      const skipMsg = describeSkippedStep(from, next);
      if (skipMsg) {
        toast({
          title: "Pulamos uma etapa",
          description: skipMsg,
          duration: 4000,
        });
      }
      return next;
    },
    [cavaloOwnerIsDriver, currentTrailerIdx, preCheckResponse, trailersToCollect],
  );

  const handleTela0Confirm = useCallback(() => {
    setState((current) => {
      if (current.kind !== "tela0") return current;
      const next = advanceWithSkip("tela0");
      draft.setCurrentStep(next);
      if (next === "step-a") return { kind: "step-a", response: current.response };
      if (next === "step-b") return { kind: "step-b" };
      if (next === "step-d") return { kind: "step-d" };
      // step-c/step-e nao sao alcancaveis direto da tela0; fallback confirmation.
      return { kind: "confirmation" };
    });
  }, [advanceWithSkip, draft]);

  // Bug A — Sintoma 2 (Task 08-18): "Agora não" SOMENTE fecha o modal.
  // A candidatura com os dados novos (placa B) já foi persistida pelo
  // interceptor em DriverCargoDetails.handlePreSubmitInterceptor antes
  // de abrir o wizard — então fechar aqui é seguro: DB + localStorage já
  // refletem o que o motorista digitou.
  //
  // Caso o wizard tenha sido aberto via outra entrada (ex.: notificação
  // do DriverPortal), o pre-check já foi executado lá com os dados
  // armazenados e não há divergência a persistir.
  const handleTela0Dismiss = useCallback(() => {
    // Bug A — Sintoma 2: "Agora não" não pode descartar as alterações que o
    // motorista acabou de fazer (ex.: trocou placa A → placa B no
    // DriverClaimPanel). O submit v1 foi abortado pelo interceptor, então o
    // localStorage ainda guarda a placa antiga e a UI volta a exibi-la quando
    // o wizard fecha. Antes de fechar, sincroniza o `StoredLeadState` com as
    // placas que vieram via props para a UI ficar consistente com a intenção
    // do usuário (complementar depois).
    if (cargaId) {
      try {
        const stored = readStoredLeadState(cargaId);
        if (stored) {
          const nextHorsePlate = (horsePlate ?? "").trim();
          const nextTrailerPlates = Array.isArray(trailerPlates)
            ? trailerPlates.map((p) => (p ?? "").trim())
            : [];
          const currentHorsePlate = (stored.form.horsePlate ?? "").trim();
          const currentTrailerPlates = [
            (stored.form.trailerPlate ?? "").trim(),
            (stored.form.trailerPlate2 ?? "").trim(),
          ].filter((p) => p.length > 0);

          const horseChanged = nextHorsePlate.length > 0 && nextHorsePlate !== currentHorsePlate;
          const trailersChanged =
            nextTrailerPlates.join("|") !== currentTrailerPlates.join("|") &&
            nextTrailerPlates.some((p) => p.length > 0);

          if (horseChanged || trailersChanged) {
            const updatedForm = {
              ...stored.form,
              horsePlate: nextHorsePlate || stored.form.horsePlate,
              trailerPlate: nextTrailerPlates[0] ?? "",
              trailerPlate2: nextTrailerPlates[1] ?? "",
            };
            persistStoredLeadState({
              ...stored,
              form: updatedForm,
              updatedAt: new Date().toISOString(),
            });
            toast({
              title: "Alterações salvas",
              description: "Conclua o cadastro quando quiser. Sua candidatura ficou com os dados novos.",
            });
          }
        }
      } catch (persistError) {
        // Persistência local é best-effort; não deve bloquear fechamento.
        console.warn(
          "[DriverRegistrationWizard] falha ao persistir lead em 'Agora não'",
          persistError,
        );
      }
    }
    void handleClose();
  }, [cargaId, handleClose, horsePlate, trailerPlates]);

  /**
   * Bug 15/05 — adoção de CPF da CNH no cenário de mismatch (A1Cnh).
   *
   * Re-executa o POST /api/loads/:loadId/pre-registration (UPSERT idempotente)
   * com o CPF/nome extraído da CNH. O backend atualiza o lead in-place.
   *
   * Estratégia de dados:
   *  - placas: vêm via prop (`horsePlate`, `trailerPlates`) — refletem o que o
   *    motorista digitou no DriverClaimPanel.
   *  - phone: usa o do `StoredLeadState` (lead já criado pelo interceptor).
   *  - vehicleType: idem (preserva o perfil que o motorista escolheu).
   *  - cpf: o novo, vindo da CNH.
   *
   * Pós-sucesso: atualiza `adoptedCpf` (state) → driverProfile.document_number
   * já reflete o novo CPF e o cpfMismatch some no A1Cnh. Mid-form state (StepB
   * em diante) é preservado — o motorista continua a partir da próxima sub-etapa.
   */
  const handleAdoptCnhData = useCallback(
    async ({ cpf: newCpf, nome }: { cpf: string; nome: string }) => {
      if (!cargaId) {
        throw new Error("cargaId ausente — não foi possível atualizar candidatura");
      }
      const normalizedCpf = onlyDigits(newCpf);
      if (normalizedCpf.length !== 11) {
        throw new Error("CPF inválido");
      }

      const stored = readStoredLeadState(cargaId);
      if (!stored) {
        // Sem lead persistido localmente não dá pra reconstituir o payload sem
        // perder dados (phone/vehicleType). Falha cedo — A1Cnh mostra toast.
        throw new Error("Lead não encontrado no armazenamento local");
      }

      const horseFromProps = (horsePlate ?? "").trim();
      const trailerFromProps = Array.isArray(trailerPlates) ? trailerPlates : [];

      const payload = {
        cpf: normalizedCpf,
        phone: stored.form.phone,
        horsePlate: horseFromProps || stored.form.horsePlate,
        trailerPlate: (trailerFromProps[0] ?? stored.form.trailerPlate ?? "").trim(),
        trailerPlate2: (trailerFromProps[1] ?? stored.form.trailerPlate2 ?? "").trim(),
        vehicleType: stored.form.vehicleType,
      };

      const response = await createPublicLoadLeadPreRegistration(cargaId, payload);

      // Persiste localmente o novo CPF + payload alinhado.
      persistStoredLeadState({
        ...stored,
        leadId: response.lead.id ?? stored.leadId,
        form: { ...stored.form, ...payload },
        updatedAt: new Date().toISOString(),
      });

      setAdoptedCpf(normalizedCpf);

      // Se já houver stepAData parcial, atualiza CPF/nome para refletir a CNH.
      // Mantém demais campos (categoria, validade, documentUrl).
      //
      // BUG-FIX 2026-05-26: antes spread era feito no NÍVEL TOPO de stepAData
      // (`{ ...current, cpf, nome }`), mas a estrutura é aninhada em sub-keys
      // a1/a1b/a2/a3. Resultado: `stepAData.a1.nome` ficava vazio enquanto
      // `stepAData.nome` no topo era setado mas ignorado por buildSubmitDados.
      // Submit retornava 422 com "Motorista — Nome" obrigatório faltando, mesmo
      // após o motorista ter feito o adopt CPF da CNH com OCR bem-sucedido.
      // Fix: mergear corretamente em `a1.{nome,cpf}` (com fallback se current.a1
      // ainda não existia).
      setStepAData((current) => {
        if (!current) return current;
        const currentA1 = current.a1 ?? {};
        return {
          ...current,
          a1: {
            ...currentA1,
            cpf: normalizedCpf,
            nome: nome || currentA1.nome || "",
          },
        } as StepAData;
      });
    },
    [cargaId, horsePlate, trailerPlates],
  );

  // Progress callbacks — chamados em CADA mudanca dentro de um step (incluindo
  // logo apos OCR popular campos). Persistem slice parcial no draft via
  // debounce ja existente em draft.setData (500ms), garantindo que se o
  // motorista sair antes de clicar "Proximo", o servidor ja tem o estado.
  // Diferente dos handleStep*Complete: progress NAO transiciona de step e
  // NAO altera currentStep. Aceita Partial<StepXData> pq durante o preenchi-
  // mento sub-etapas podem estar vazias.
  // FIX 18/05: progress handlers ALEM de persistir no draft, atualizam o
  // state local do wizard. Sem isso, "Voltar" desmonta o StepX (state local
  // do componente filho perdido) e ao reabrir `value={stepXData}` vinha como
  // null/stale — motorista achava que tinha perdido tudo.
  const handleStepAProgress = useCallback(
    (data: Partial<StepAData>) => {
      setStepAData((prev) => {
        const merged = { ...(prev ?? {}), ...data } as StepAData;
        persistSlice({ stepA: merged });
        return merged;
      });
    },
    [persistSlice],
  );
  const handleStepBProgress = useCallback(
    (data: StepBData) => {
      setStepBData((prev) => {
        const merged = { ...(prev ?? {}), ...data } as StepBData;
        persistSlice({ stepB: merged });
        return merged;
      });
    },
    [persistSlice],
  );
  const handleStepCProgress = useCallback(
    (data: StepCData) => {
      setStepCData(data);
      persistSlice({ stepC: data });
    },
    [persistSlice],
  );
  const handleStepDProgress = useCallback(
    (data: StepDData) => {
      setStepDData(data);
      persistSlice({ stepD: data });
    },
    [persistSlice],
  );
  const handleStepEProgress = useCallback(
    (data: StepEData) => {
      // E e por-carreta: persiste o map inteiro com a entrada atualizada
      // para a carreta em curso.
      setStepEDataMap((prev) => {
        const merged = { ...prev, [currentTrailerIdx]: data };
        persistSlice({ stepE: merged });
        return merged;
      });
    },
    [persistSlice, currentTrailerIdx],
  );

  const handleStepAComplete = useCallback(
    (data: StepAData) => {
      setStepAData(data);
      persistSlice({ stepA: data });
      const next = advanceWithSkip("step-a");
      draft.setCurrentStep(next);
      if (next === "step-b") {
        setState({ kind: "step-b" });
      } else if (next === "step-d") {
        setState({ kind: "step-d" });
      } else {
        setState({ kind: "confirmation" });
      }
    },
    [advanceWithSkip, draft, persistSlice],
  );

  const handleStepABack = useCallback(() => {
    setState((current) => {
      if (current.kind === "step-a") {
        draft.setCurrentStep("tela0");
        return { kind: "tela0", response: current.response };
      }
      return current;
    });
  }, [draft]);

  const handleStepBComplete = useCallback(
    (data: StepBData & { ownerIsDriver: boolean; ownerDocFromCrlv: string }) => {
      // P0 stale-closure: usa functional setter para mesclar com o estado mais
      // recente em vez de capturar `data` de uma render anterior. Garante que
      // `placa` (e demais campos) não viram stale se múltiplos eventos
      // ocorrerem antes do re-render. Dep `trailersToCollect.length` removida
      // (não é referenciada no corpo do callback).
      setStepBData((prev) => ({
        ...(prev ?? {}),
        placa: data.placa,
        renavam: data.renavam,
        chassi: data.chassi,
        marca: data.marca,
        ano: data.ano,
        cor: data.cor,
        ownerDoc: data.ownerDoc,
        ownerDocType: data.ownerDocType,
        ownerNome: data.ownerNome,
        ocr_fallback_manual: data.ocr_fallback_manual,
        a4: data.a4,
        a5: data.a5,
        a6: data.a6,
      }));
      setCavaloOwnerIsDriver(data.ownerIsDriver);
      setOwnerDocFromCrlv(data.ownerDocFromCrlv);
      persistSlice({
        stepB: {
          placa: data.placa,
          renavam: data.renavam,
          chassi: data.chassi,
          marca: data.marca,
          ano: data.ano,
          cor: data.cor,
          ownerDoc: data.ownerDoc,
          ownerDocType: data.ownerDocType,
          ownerNome: data.ownerNome,
          ocr_fallback_manual: data.ocr_fallback_manual,
          a4: data.a4,
          a5: data.a5,
          a6: data.a6,
        },
        ownerDocFromCrlv: data.ownerDocFromCrlv,
      });
      // ownerIsDriver determina se pulamos step-c automaticamente.
      const next = advanceWithSkip("step-b", { ownerIsDriver: data.ownerIsDriver });
      draft.setCurrentStep(next);
      if (next === "step-c") {
        setState({ kind: "step-c", driverIsOwner: data.ownerIsDriver });
      } else if (next === "step-d") {
        setState({ kind: "step-d" });
      } else {
        setState({ kind: "confirmation" });
      }
    },
    [advanceWithSkip, draft, persistSlice],
  );

  const handleStepBBack = useCallback(() => {
    draft.setCurrentStep("step-b");
    setState({ kind: "step-b" });
  }, [draft]);

  const handleStepCComplete = useCallback(
    (data: StepCData) => {
      setStepCData(data);
      setCurrentTrailerIdx(0);
      persistSlice({
        stepC: data,
        currentTrailerIdx: 0,
      });
      // 2026-05-20 — depois do Step C (owner do cavalo) sempre passa pelo
      // Step C-ANTT (owner do RNTRC do cavalo), mesmo quando o cascade
      // detectou que titular == owner do CRLV. Dá visibilidade para o
      // motorista e cobre o caso de mudança manual.
      draft.setCurrentStep("step-c-antt");
      setState({ kind: "step-c-antt" });
    },
    [draft, persistSlice],
  );

  const handleStepCAnttComplete = useCallback(
    (data: StepCData) => {
      // Step C-ANTT atualiza apenas a slice anttTitular (+ storage_paths e
      // endereço do titular ANTT). Reutiliza StepCData pra simplificar e
      // manter o ANTT inteiro acoplado ao Step C.
      setStepCData(data);
      persistSlice({ stepC: data });
      const next = advanceWithSkip("step-c", { currentTrailerIdx: 0 });
      draft.setCurrentStep(next);
      if (next === "step-d") {
        setState({ kind: "step-d" });
      } else {
        setState({ kind: "confirmation" });
      }
    },
    [advanceWithSkip, draft, persistSlice],
  );

  const handleStepCAnttBack = useCallback(() => {
    draft.setCurrentStep("step-c");
    setState({ kind: "step-c" });
  }, [draft]);

  const handleStepCBack = useCallback(() => {
    draft.setCurrentStep("step-b");
    setState({ kind: "step-b" });
  }, [draft]);

  const handleStepDTrailerAutoResolved = useCallback(
    (entry: StepDCarretaEntry, owner: CollectedCarretaOwner | null) => {
      let nextStepD: StepDData | null = null;
      setStepDData((current) => {
        const carretas = current ? [...current.carretas] : [];
        const idx = carretas.findIndex((existing) => existing.plate === entry.plate);
        if (idx >= 0) carretas[idx] = entry;
        else carretas.push(entry);
        nextStepD = { carretas };
        return nextStepD;
      });
      let nextOwners = collectedCarretaOwners;
      if (owner) {
        nextOwners = (() => {
          const exists = collectedCarretaOwners.find((existing) => existing.doc === owner.doc);
          return exists ? collectedCarretaOwners : [...collectedCarretaOwners, owner];
        })();
        setCollectedCarretaOwners(nextOwners);
      }
      // nextPendencyStep decide via currentTrailerIdx (caller passa o JA
      // processado; funcao faz +1 internamente).
      const next = advanceWithSkip("step-d", {
        currentTrailerIdx,
      });
      if (next === "step-d") {
        const nextIdx = currentTrailerIdx + 1;
        setCurrentTrailerIdx(nextIdx);
        persistSlice({
          stepD: nextStepD,
          collectedCarretaOwners: nextOwners,
          currentTrailerIdx: nextIdx,
        });
        draft.setCurrentStep("step-d");
        setState({ kind: "step-d" });
      } else {
        persistSlice({
          stepD: nextStepD,
          collectedCarretaOwners: nextOwners,
        });
        draft.setCurrentStep("confirmation");
        setState({ kind: "confirmation" });
      }
    },
    [
      advanceWithSkip,
      collectedCarretaOwners,
      currentTrailerIdx,
      draft,
      persistSlice,
    ],
  );

  const handleStepDTrailerNeedsOwner = useCallback(
    (
      idx: number,
      partialEntry: Omit<StepDCarretaEntry, "owner_resolution">,
      ownerDocFromCrlvLocal: string,
      _ownerDocType: "cpf" | "cnpj",
    ) => {
      // step-e exige PendingCarreta em memória — não persistimos o pending no draft.
      draft.setCurrentStep("step-e");
      setState({
        kind: "step-e",
        pending: {
          idx,
          ownerDocFromCrlv: ownerDocFromCrlvLocal,
          partialEntry,
        },
      });
    },
    [draft],
  );

  const handleStepDComplete = useCallback(
    (data: StepDData) => {
      setStepDData(data);
      persistSlice({ stepD: data });
      draft.setCurrentStep("confirmation");
      setState({ kind: "confirmation" });
    },
    [draft, persistSlice],
  );

  const handleStepDBack = useCallback(() => {
    setCurrentTrailerIdx((current) => {
      if (current > 0) return current - 1;
      return 0;
    });
    if (currentTrailerIdx <= 0) {
      const nextKind: WizardStepKind = stepCData ? "step-c" : "step-b";
      draft.setCurrentStep(nextKind);
      setState({ kind: nextKind });
    }
  }, [currentTrailerIdx, draft, stepCData]);

  const handleStepEComplete = useCallback(
    (data: StepEData) => {
      setState((current) => {
        if (current.kind !== "step-e") return current;
        const pending = current.pending;
        const entry: StepDCarretaEntry = {
          ...pending.partialEntry,
          owner_resolution: "new",
        };
        let nextStepD: StepDData | null = null;
        setStepDData((currentDData) => {
          const carretas = currentDData ? [...currentDData.carretas] : [];
          const idx = carretas.findIndex((existing) => existing.plate === entry.plate);
          if (idx >= 0) carretas[idx] = entry;
          else carretas.push(entry);
          nextStepD = { carretas };
          return nextStepD;
        });
        const nextStepEMap = { ...stepEDataMap, [pending.idx]: data };
        setStepEDataMap(nextStepEMap);
        const collected: CollectedCarretaOwner = {
          doc: pending.ownerDocFromCrlv,
          docType: data.owner.docType,
          pfData: data.pf,
          pjData: data.pj,
        };
        const exists = collectedCarretaOwners.find((existing) => existing.doc === collected.doc);
        const nextOwners = exists ? collectedCarretaOwners : [...collectedCarretaOwners, collected];
        if (!exists) {
          setCollectedCarretaOwners(nextOwners);
        }

        // 2026-05-20 — depois do Step E (owner da carreta) sempre passa pelo
        // Step E-ANTT (owner do RNTRC da carreta corrente). O fluxo de avançar
        // para a próxima carreta (ou confirmation) acontece em handleStepEAnttComplete.
        persistSlice({
          stepD: nextStepD,
          stepE: nextStepEMap,
          collectedCarretaOwners: nextOwners,
        });
        draft.setCurrentStep("step-e-antt");
        return { kind: "step-e-antt" };
      });
    },
    [collectedCarretaOwners, draft, persistSlice, stepEDataMap],
  );

  const handleStepEAnttComplete = useCallback(
    (data: StepEData) => {
      const idx = currentTrailerIdx;
      const nextStepEMap = { ...stepEDataMap, [idx]: data };
      setStepEDataMap(nextStepEMap);
      const next = advanceWithSkip("step-e", { currentTrailerIdx: idx });
      if (next === "step-d") {
        const nextIdx = idx + 1;
        setCurrentTrailerIdx(nextIdx);
        persistSlice({
          stepE: nextStepEMap,
          currentTrailerIdx: nextIdx,
        });
        draft.setCurrentStep("step-d");
        setState({ kind: "step-d" });
        return;
      }
      persistSlice({ stepE: nextStepEMap });
      draft.setCurrentStep("confirmation");
      setState({ kind: "confirmation" });
    },
    [advanceWithSkip, currentTrailerIdx, draft, persistSlice, stepEDataMap],
  );

  const handleStepEAnttBack = useCallback(() => {
    draft.setCurrentStep("step-e");
    // step-e exige pending em memória; voltar pro step-d é o caminho seguro.
    setState({ kind: "step-d" });
  }, [draft]);

  const handleStepEBack = useCallback(() => {
    draft.setCurrentStep("step-d");
    setState({ kind: "step-d" });
  }, [draft]);

  const handleConfirmationBack = useCallback(
    (stepKey?: string) => {
      const target: WizardStepKind = (() => {
        if (
          stepKey === "step-a" ||
          stepKey === "step-b" ||
          stepKey === "step-c" ||
          stepKey === "step-d"
        ) {
          return stepKey;
        }
        if (stepKey === "step-e") {
          // step-e exige pending em memoria — voltar para step-d e o usuario
          // re-aciona a carreta que precisava do owner novo.
          return "step-d";
        }
        return "step-a";
      })();
      draft.setCurrentStep(target);
      if (target === "step-a" && preCheckResponse) {
        setState({ kind: "step-a", response: preCheckResponse });
        return;
      }
      setState({ kind: target } as WizardState);
    },
    [draft, preCheckResponse],
  );

  const handleConfirmationSuccess = useCallback(
    ({ protocolo }: { protocolo: string }) => {
      // Limpa draft (local + server) — candidatura ja submetida, evita reabrir
      // no mesmo passo se o motorista clicar "Candidatar-se" novamente.
      draft.clearAndReset();
      setState({ kind: "success", protocolo });
    },
    [draft],
  );

  // BUG-WALK-07: callbacks vazios mantidos por compatibilidade do contrato,
  // mas o overlay "Enviando…" e o retorno em caso de erro agora são
  // internos ao ConfirmationScreen — não há transição de state.kind aqui.
  const handleConfirmationSubmitStart = useCallback(() => {
    /* no-op — overlay vive dentro do ConfirmationScreen */
  }, []);
  const handleConfirmationSubmitError = useCallback(() => {
    /* no-op — ConfirmationScreen já renderiza banner de erro retryable */
  }, []);

  const handleSuccessClose = useCallback(() => {
    setState({ kind: "idle" });
    onOpenChange(false);
  }, [onOpenChange]);

  // 19/05 — Confirma a tela "Seus dados ja estao cadastrados" e dispara o
  // handoff pro fluxo existente (DriverPortal abre candidatura ja criada).
  const handleAlreadyRegisteredConfirm = useCallback(() => {
    draft.clearAndReset();
    onOpenChange(false);
    setState({ kind: "idle" });
    if (handoffContext) {
      onPreCheckPassed(handoffContext);
    }
  }, [draft, handoffContext, onOpenChange, onPreCheckPassed]);

  // Fecha a tela "Seus dados ja estao cadastrados" sem handoff (motorista
  // clica "Fechar" — apenas dispensa o wizard).
  const handleAlreadyRegisteredClose = useCallback(() => {
    draft.clearAndReset();
    onOpenChange(false);
    setState({ kind: "idle" });
  }, [draft, onOpenChange]);

  /**
   * Verifica se uma placa alternativa (escolhida via divergência de CRLV) já
   * tem cadastro vigente. Chama o pre-check substituindo a placa informada na
   * posição correta (cavalo ou carreta pelo índice atual).
   */
  const handleCheckPlateRegistration = useCallback(
    async (newPlate: string, role: "horse" | "trailer"): Promise<{ alreadyRegistered: boolean; daysUntilExpiry?: number }> => {
      try {
        const effectiveHorsePlate = role === "horse" ? newPlate : (horsePlate ?? "");
        const effectiveTrailers = role === "trailer"
          ? safeTrailerPlates.map((p, i) => (i === currentTrailerIdx ? newPlate : p))
          : safeTrailerPlates;

        const response = await requestCandidaturaPreCheck({
          cpf: driverProfile.document_number,
          horsePlate: effectiveHorsePlate,
          trailerPlates: effectiveTrailers,
        });

        // A placa está cadastrada (vigente) se aparecer em completos ou em pendencias
        // com razão EXPIRING (encontrada mas próxima do vencimento).
        const targetPlate = newPlate.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const inCompletos = response.completos.find(
          (c) => c.plate.toUpperCase().replace(/[^A-Z0-9]/g, "") === targetPlate,
        );
        if (inCompletos) {
          return { alreadyRegistered: true, daysUntilExpiry: inCompletos.daysUntilExpiry };
        }
        const inPendencias = response.pendencias.find(
          (p) => p.plate?.toUpperCase().replace(/[^A-Z0-9]/g, "") === targetPlate,
        );
        if (inPendencias && (inPendencias.reason === "EXPIRING" || inPendencias.reason === "EXPIRED")) {
          return { alreadyRegistered: true, daysUntilExpiry: inPendencias.daysUntilExpiry };
        }
        return { alreadyRegistered: false };
      } catch {
        // Silently fail — the mismatch alert already informed the driver; not finding
        // registration data is fine (they'll proceed and submit the CRLV normally).
        return { alreadyRegistered: false };
      }
    },
    [currentTrailerIdx, driverProfile.document_number, horsePlate, safeTrailerPlates],
  );

  const confirmationData = useMemo<ConfirmationWizardData>(
    () => ({
      stepA: stepAData,
      stepB: stepBData
        ? { ...stepBData, ownerIsDriver: cavaloOwnerIsDriver }
        : null,
      stepC: stepCData,
      stepD: stepDData,
      stepE: stepEDataMap,
      collectedCarretaOwners,
      horsePlate: horsePlate ?? undefined,
    }),
    [
      cavaloOwnerIsDriver,
      collectedCarretaOwners,
      horsePlate,
      stepAData,
      stepBData,
      stepCData,
      stepDData,
      stepEDataMap,
    ],
  );

  const phoneMasked = useMemo(
    () => maskPhoneLastTwo(driverProfile.phone),
    [driverProfile.phone],
  );

  // Idempotency-Key persistido no draft (P1 fix): garante que re-mount da
  // ConfirmationScreen após network drop reuse a mesma key, evitando
  // candidatura duplicada server-side. Reset automático ao trocar de carga
  // (draft é chaveado por carga) ou após clearAndReset (post-submit success).
  const persistedSubmitIdempotencyKey = useMemo(() => {
    const raw = (draft.data as Record<string, unknown>).__submitIdempotencyKey;
    return typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }, [draft.data]);

  const handleIdempotencyKeyGenerated = useCallback(
    (key: string) => {
      if (!key) return;
      const current = (draft.data as Record<string, unknown>).__submitIdempotencyKey;
      if (current === key) return;
      draft.setData({ ...draft.data, __submitIdempotencyKey: key });
    },
    [draft],
  );

  // Quando ainda restaurando o draft do servidor, renderiza skeleton para não
  // piscar a Tela 0 / step antigo (UI-SPEC "Server draft restore").
  if (draft.isRestoring && open) {
    return (
      <RegistrationWizardShell open={open} onOpenChange={handleOpenChange}>
        <DraftRestoreSkeleton />
      </RegistrationWizardShell>
    );
  }

  // CPF efetivo para persistência (digits only). Quando o motorista adotou o
  // CPF da CNH (Bug 15/05), usa o adotado; senão usa o do driverProfile.
  const draftCpfDigits = onlyDigits(driverProfile.document_number);

  return (
    <RegistrationWizardShell open={open} onOpenChange={handleOpenChange}>
      {renderState({
        state,
        onRetry: runPreCheck,
        onConfirmTela0: handleTela0Confirm,
        onDismissTela0: handleTela0Dismiss,
        driverProfile,
        onStepAComplete: handleStepAComplete,
        onStepABack: handleStepABack,
        onAdoptCnhData: handleAdoptCnhData,
        onStepAProgress: handleStepAProgress,
        onStepBProgress: handleStepBProgress,
        onStepCProgress: handleStepCProgress,
        onStepDProgress: handleStepDProgress,
        onStepEProgress: handleStepEProgress,
        horsePlate: horsePlate ?? "",
        trailerPlates: safeTrailerPlates,
        stepAValue: stepAData ?? undefined,
        stepBValue: stepBData ?? undefined,
        stepCValue: stepCData ?? undefined,
        stepDValue: stepDData ?? undefined,
        stepEDataMap,
        ownerDocFromCrlv,
        onStepBComplete: handleStepBComplete,
        onStepBBack: handleStepBBack,
        onStepCComplete: handleStepCComplete,
        onStepCBack: handleStepCBack,
        onStepCAnttComplete: handleStepCAnttComplete,
        onStepCAnttBack: handleStepCAnttBack,
        trailersToCollect,
        cavaloOwnerCollected,
        currentTrailerIdx,
        collectedCarretaOwners,
        onStepDTrailerAutoResolved: handleStepDTrailerAutoResolved,
        onStepDTrailerNeedsOwner: handleStepDTrailerNeedsOwner,
        onStepDComplete: handleStepDComplete,
        onStepDBack: handleStepDBack,
        onStepEComplete: handleStepEComplete,
        onStepEBack: handleStepEBack,
        onStepEAnttComplete: handleStepEAnttComplete,
        onStepEAnttBack: handleStepEAnttBack,
        totalSteps,
        hasStepAInPendencias,
        confirmationData,
        confirmationCargaId: cargaId ?? "",
        confirmationCargaContext: cargaContext,
        confirmationIdempotencyKey: persistedSubmitIdempotencyKey,
        onConfirmationIdempotencyKeyGenerated: handleIdempotencyKeyGenerated,
        onConfirmationBack: handleConfirmationBack,
        onConfirmationSuccess: handleConfirmationSuccess,
        onConfirmationSubmitStart: handleConfirmationSubmitStart,
        onConfirmationSubmitError: handleConfirmationSubmitError,
        onSuccessClose: handleSuccessClose,
        onAlreadyRegisteredConfirm: handleAlreadyRegisteredConfirm,
        onAlreadyRegisteredClose: handleAlreadyRegisteredClose,
        alreadyRegisteredCargaLabel: cargaContext?.routeLabel,
        phoneMasked,
        checkHorsePlateRegistration: (p) => handleCheckPlateRegistration(p, "horse"),
        checkTrailerPlateRegistration: (p) => handleCheckPlateRegistration(p, "trailer"),
        draftCargaId: cargaId,
        draftCpf: draftCpfDigits,
        draftAccessToken: accessToken,
      })}
    </RegistrationWizardShell>
  );
}

interface RenderStateArgs {
  state: WizardState;
  onRetry: () => void;
  onConfirmTela0: () => void;
  onDismissTela0: () => void;
  driverProfile: StepADriverProfile;
  onStepAComplete: (data: StepAData) => void;
  onStepABack: () => void;
  onAdoptCnhData?: (data: { cpf: string; nome: string }) => Promise<void>;
  onStepAProgress: (data: Partial<StepAData>) => void;
  onStepBProgress: (data: StepBData) => void;
  onStepCProgress: (data: StepCData) => void;
  onStepDProgress: (data: StepDData) => void;
  onStepEProgress: (data: StepEData) => void;
  horsePlate: string;
  trailerPlates: string[];
  stepAValue?: StepAData;
  stepBValue?: StepBData;
  stepCValue?: StepCData;
  stepDValue?: StepDData;
  stepEDataMap: Record<number, StepEData>;
  ownerDocFromCrlv: string;
  onStepBComplete: (
    data: StepBData & { ownerIsDriver: boolean; ownerDocFromCrlv: string },
  ) => void;
  onStepBBack: () => void;
  onStepCComplete: (data: StepCData) => void;
  onStepCBack: () => void;
  onStepCAnttComplete: (data: StepCData) => void;
  onStepCAnttBack: () => void;
  trailersToCollect: StepDTrailerInput[];
  cavaloOwnerCollected?: CavaloOwnerCollected;
  currentTrailerIdx: number;
  collectedCarretaOwners: CollectedCarretaOwner[];
  onStepDTrailerAutoResolved: (
    entry: StepDCarretaEntry,
    owner: CollectedCarretaOwner | null,
  ) => void;
  onStepDTrailerNeedsOwner: (
    idx: number,
    partialEntry: Omit<StepDCarretaEntry, "owner_resolution">,
    ownerDocFromCrlv: string,
    ownerDocType: "cpf" | "cnpj",
  ) => void;
  onStepDComplete: (data: StepDData) => void;
  onStepDBack: () => void;
  onStepEComplete: (data: StepEData) => void;
  onStepEBack: () => void;
  onStepEAnttComplete: (data: StepEData) => void;
  onStepEAnttBack: () => void;
  totalSteps: number;
  hasStepAInPendencias: boolean;
  confirmationData: ConfirmationWizardData;
  confirmationCargaId: string;
  confirmationCargaContext?: ConfirmationCargaContext;
  confirmationIdempotencyKey?: string;
  onConfirmationIdempotencyKeyGenerated?: (key: string) => void;
  onConfirmationBack: (stepKey?: string) => void;
  onConfirmationSuccess: (result: { protocolo: string }) => void;
  onConfirmationSubmitStart: () => void;
  onConfirmationSubmitError: () => void;
  onSuccessClose: () => void;
  onAlreadyRegisteredConfirm: () => void;
  onAlreadyRegisteredClose: () => void;
  alreadyRegisteredCargaLabel?: string;
  phoneMasked?: string;
  checkHorsePlateRegistration?: (plate: string) => Promise<{ alreadyRegistered: boolean; daysUntilExpiry?: number }>;
  checkTrailerPlateRegistration?: (plate: string) => Promise<{ alreadyRegistered: boolean; daysUntilExpiry?: number }>;
  /** Contexto p/ persistência draft no Supabase Storage (slot -> arquivo). */
  draftCargaId?: string;
  draftCpf?: string;
  draftAccessToken?: string | null;
}

function renderState({
  state,
  onRetry,
  onConfirmTela0,
  onDismissTela0,
  driverProfile,
  onStepAComplete,
  onStepABack,
  onAdoptCnhData,
  onStepAProgress,
  onStepBProgress,
  onStepCProgress,
  onStepDProgress,
  onStepEProgress,
  horsePlate,
  stepAValue,
  stepBValue,
  stepCValue,
  stepDValue,
  stepEDataMap,
  ownerDocFromCrlv,
  onStepBComplete,
  onStepBBack,
  onStepCComplete,
  onStepCBack,
  onStepCAnttComplete,
  onStepCAnttBack,
  trailersToCollect,
  cavaloOwnerCollected,
  currentTrailerIdx,
  collectedCarretaOwners,
  onStepDTrailerAutoResolved,
  onStepDTrailerNeedsOwner,
  onStepDComplete,
  onStepDBack,
  onStepEComplete,
  onStepEBack,
  onStepEAnttComplete,
  onStepEAnttBack,
  totalSteps,
  hasStepAInPendencias,
  confirmationData,
  confirmationCargaId,
  confirmationCargaContext,
  confirmationIdempotencyKey,
  onConfirmationIdempotencyKeyGenerated,
  onConfirmationBack,
  onConfirmationSuccess,
  onConfirmationSubmitStart,
  onConfirmationSubmitError,
  onSuccessClose,
  onAlreadyRegisteredConfirm,
  onAlreadyRegisteredClose,
  alreadyRegisteredCargaLabel,
  phoneMasked,
  checkHorsePlateRegistration,
  checkTrailerPlateRegistration,
  draftCargaId,
  draftCpf,
  draftAccessToken,
}: RenderStateArgs) {
  switch (state.kind) {
    case "idle":
    case "loading":
      return <PreCheckLoading />;

    case "tela0":
      return (
        <TelaZeroPendencies
          pendencias={state.response.pendencias}
          completos={state.response.completos}
          onConfirm={onConfirmTela0}
          onDismiss={onDismissTela0}
        />
      );

    case "step-a": {
      return (
        <StepAMotorista
          driverProfile={driverProfile}
          currentStep={1}
          totalSteps={totalSteps}
          value={stepAValue}
          onChange={onStepAProgress}
          onComplete={onStepAComplete}
          onBack={onStepABack}
          onAdoptCnhData={onAdoptCnhData}
          cargaId={draftCargaId}
          cpf={draftCpf}
          accessToken={draftAccessToken}
        />
      );
    }
    case "step-b": {
      return (
        <StepBCavalo
          horsePlate={horsePlate}
          driverProfile={driverProfile}
          currentStep={hasStepAInPendencias ? 2 : 1}
          totalSteps={totalSteps}
          value={stepBValue}
          onChange={onStepBProgress}
          onComplete={onStepBComplete}
          onBack={onStepBBack}
          checkPlateRegistration={checkHorsePlateRegistration}
          cargaId={draftCargaId}
          cpf={draftCpf}
          accessToken={draftAccessToken}
        />
      );
    }
    case "step-c": {
      return (
        <StepCProprietarioCavalo
          ownerDocFromCrlv={ownerDocFromCrlv}
          horsePlate={horsePlate}
          driverProfile={{
            document_number: driverProfile.document_number,
            phone: driverProfile.phone,
            nome: driverProfile.nome,
          }}
          currentStep={hasStepAInPendencias ? 3 : 2}
          totalSteps={totalSteps}
          value={stepCValue}
          driverIsOwner={state.driverIsOwner}
          onChange={onStepCProgress}
          onComplete={onStepCComplete}
          onBack={onStepCBack}
          cargaId={draftCargaId}
          cpf={draftCpf}
        />
      );
    }
    case "step-c-antt": {
      if (!stepCValue) {
        return null;
      }
      const baseStep = hasStepAInPendencias ? 4 : 3;
      return (
        <StepCAnttCavalo
          currentStep={baseStep}
          totalSteps={totalSteps}
          value={stepCValue}
          cascadeResult={null}
          ownerDocFromCrlv={ownerDocFromCrlv}
          ownerNomeFromCrlv={stepCValue.owner?.nome}
          onChange={onStepCProgress}
          onComplete={onStepCAnttComplete}
          onBack={onStepCAnttBack}
          cargaId={draftCargaId}
          cpf={draftCpf}
          accessToken={draftAccessToken}
        />
      );
    }
    case "step-d": {
      const baseStep = stepCValue
        ? (hasStepAInPendencias ? 5 : 4)
        : (hasStepAInPendencias ? 3 : 2);
      return (
        <StepDCarretas
          trailersToCollect={trailersToCollect}
          driverProfile={{ document_number: driverProfile.document_number }}
          cavaloOwnerCollected={cavaloOwnerCollected}
          currentTrailerIdx={currentTrailerIdx}
          previousCarretaOwners={collectedCarretaOwners}
          currentStep={baseStep}
          totalSteps={totalSteps}
          value={stepDValue}
          onChange={onStepDProgress}
          onTrailerAutoResolved={onStepDTrailerAutoResolved}
          onTrailerNeedsOwner={onStepDTrailerNeedsOwner}
          onComplete={onStepDComplete}
          onBack={onStepDBack}
          checkPlateRegistration={checkTrailerPlateRegistration}
          cargaId={draftCargaId}
          cpf={draftCpf}
          accessToken={draftAccessToken}
        />
      );
    }
    case "step-e": {
      const pending = state.pending;
      const partialEntry = pending.partialEntry;
      const baseStep = stepCValue
        ? (hasStepAInPendencias ? 6 : 5)
        : (hasStepAInPendencias ? 4 : 3);
      return (
        <StepECarretaOwner
          trailerPlate={partialEntry.plate}
          ownerDocFromCrlv={pending.ownerDocFromCrlv}
          driverProfile={{
            document_number: driverProfile.document_number,
            phone: driverProfile.phone,
          }}
          cavaloOwnerCollected={
            cavaloOwnerCollected
              ? {
                  doc: cavaloOwnerCollected.doc,
                  docType: cavaloOwnerCollected.docType,
                  pfData: cavaloOwnerCollected.pfData,
                  pjData: cavaloOwnerCollected.pjData,
                }
              : undefined
          }
          previousCarretaOwners={collectedCarretaOwners}
          currentStep={baseStep}
          totalSteps={totalSteps}
          value={stepEDataMap[pending.idx]}
          onChange={onStepEProgress}
          onComplete={onStepEComplete}
          onBack={onStepEBack}
          carretaIdx={pending.idx}
          cargaId={draftCargaId}
          cpf={draftCpf}
        />
      );
    }
    case "step-e-antt": {
      const currentEData = stepEDataMap[currentTrailerIdx];
      if (!currentEData) {
        return null;
      }
      const baseStep = stepCValue
        ? (hasStepAInPendencias ? 7 : 6)
        : (hasStepAInPendencias ? 5 : 4);
      return (
        <StepEAnttCarreta
          currentStep={baseStep}
          totalSteps={totalSteps}
          trailerIdx={(currentTrailerIdx === 1 ? 1 : 0) as 0 | 1}
          value={currentEData}
          cascadeResult={null}
          ownerDocFromCrlv={currentEData.owner?.documento ?? ""}
          ownerNomeFromCrlv={currentEData.owner?.nome}
          onChange={onStepEProgress}
          onComplete={onStepEAnttComplete}
          onBack={onStepEAnttBack}
          cargaId={draftCargaId}
          cpf={draftCpf}
          accessToken={draftAccessToken}
        />
      );
    }
    case "confirmation":
      return (
        <ConfirmationScreen
          data={confirmationData}
          cargaId={confirmationCargaId}
          cargaContext={confirmationCargaContext}
          idempotencyKey={confirmationIdempotencyKey}
          onIdempotencyKeyGenerated={onConfirmationIdempotencyKeyGenerated}
          onBack={onConfirmationBack}
          onSuccess={onConfirmationSuccess}
          onSubmitStart={onConfirmationSubmitStart}
          onSubmitError={onConfirmationSubmitError}
        />
      );

    case "already-up-to-date":
      return (
        <AlreadyRegisteredScreen
          completos={state.response.completos}
          cargaLabel={alreadyRegisteredCargaLabel}
          onConfirm={onAlreadyRegisteredConfirm}
          onClose={onAlreadyRegisteredClose}
        />
      );

    case "success":
      return (
        <SubmissionSuccess
          protocolo={state.protocolo}
          phoneMasked={phoneMasked}
          onClose={onSuccessClose}
        />
      );

    case "error":
      return <PreCheckError state={state} onRetry={onRetry} />;

    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function PreCheckLoading() {
  return (
    <div
      className="flex min-h-[260px] flex-col items-center justify-center gap-4 text-center"
      aria-live="polite"
      aria-atomic="true"
    >
      <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
      <div className="space-y-1.5">
        <p className="text-base font-semibold text-foreground">Verificando seu cadastro…</p>
        <p className="text-sm text-muted-foreground">
          Estamos confirmando seu cadastro junto à Angellira e ASPX
        </p>
      </div>
    </div>
  );
}

// SubmittingState removido em BUG-WALK-07 — overlay vive dentro do
// ConfirmationScreen para manter a React Query mutation viva durante o POST.

function DraftRestoreSkeleton() {
  return (
    <div
      className="flex min-h-[260px] flex-col gap-4 px-1 py-3"
      aria-live="polite"
      aria-atomic="true"
      aria-label="Carregando seu rascunho"
    >
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <div className="space-y-3 pt-2">
        <Skeleton className="h-12 w-full rounded-2xl" />
        <Skeleton className="h-12 w-full rounded-2xl" />
        <Skeleton className="h-12 w-full rounded-2xl" />
      </div>
      <Skeleton className="ml-auto mt-4 h-10 w-32 rounded-full" />
    </div>
  );
}

interface PreCheckErrorProps {
  state: Extract<WizardState, { kind: "error" }>;
  onRetry: () => void;
}

function PreCheckError({ state, onRetry }: PreCheckErrorProps) {
  const isSessionExpired = state.status === 401;
  const headline = isSessionExpired ? "Sessão expirou" : "Não conseguimos verificar seu cadastro agora";

  return (
    <div
      role="alert"
      className={cn("admin-tint-danger rounded-[22px] border p-4 sm:rounded-3xl sm:p-5")}
    >
      <div className="flex items-start gap-2.5 sm:gap-3">
        <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-semibold text-foreground sm:text-base">{headline}</p>
          <p className="text-sm text-muted-foreground leading-relaxed">{state.message}</p>
          {!isSessionExpired ? (
            <div className="pt-1">
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center justify-center gap-2 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Tentar novamente
              </button>
            </div>
          ) : (
            <p className="pt-1 text-xs text-muted-foreground">
              Faça login novamente pelo portal para continuar.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

