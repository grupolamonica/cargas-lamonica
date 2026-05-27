import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  CandidaturaApiError,
  useCandidaturaAnttPrecheck,
  type AnttPrecheckResponse,
} from "@/api/candidaturaApi";
import { Button } from "@/components/ui/button";
import { useDriverAuth } from "@/hooks/useDriverAuth";
import { isValidCnpj, isValidCpf, onlyDigits } from "@/lib/brazilianValidators";

import { DriverAlert } from "@/components/driver/ui/DriverAlert";

import { StepHeader } from "../StepHeader";
import { WizardStepCard } from "../widgets/WizardStepCard";
import { WizardStepStack } from "../widgets/WizardStepStack";
import { AnttCascadeStatus, type AnttCascadeState } from "../widgets/AnttCascadeStatus";
import { useVerifyDocument } from "../useVerifyDocument";
import { buildOwnerDuplicateAlert } from "../widgets/OwnerDuplicateAlertCopy";
import {
  OwnerAttributionFormPF,
  buildEmptyOwnerPFData,
  isValidOwnerPFData,
  type OwnerPFData,
} from "../widgets/OwnerAttributionFormPF";
import {
  buildEmptyOwnerPJData,
  isValidOwnerPJData,
  type OwnerPJData,
} from "../widgets/OwnerAttributionFormPJ";
import {
  OwnerDocumentUploader,
  type OwnerExtractedData,
  type OwnerExtras,
} from "../widgets/OwnerDocumentUploader";
import type { OcrTileState } from "../widgets/OcrUploadTile";
import { OwnerEnderecoComprovante } from "../widgets/OwnerEnderecoComprovante";
import {
  AnttTitularPrompt,
  type AnttTitularData,
} from "../widgets/AnttTitularPrompt";
import type { CollectedCarretaOwner } from "./StepDCarretas";
import { ValidationBannerMessage } from "./StepCProprietarioCavalo";
// 2026-05-18 — CcDadosPessoaisPropPF inlinado no OwnerDocumentUploader.
// Tipo mantido só por compat com `ccPF?` (drafts antigos).
import type { CcPropPFData } from "./CcDadosPessoaisPropPF";
import { CcInscricaoPropPJ, type CcPropPJData } from "./CcInscricaoPropPJ";

export interface StepEEndereco {
  cep: string;
  numero: string;
}

export interface StepEDriverProfile {
  document_number: string;
  phone: string;
  endereco?: StepEEndereco;
}

export interface StepEData {
  owner: {
    nome: string;
    documento: string;
    docType: "cpf" | "cnpj";
    dataNascimento?: string;
    cnhNumero?: string;
    /** CADASTRO-14: owner document foi digitado manualmente. */
    ocr_fallback_manual?: boolean;
  };
  antt: {
    rntrc?: string;
    tipo?: string;
    situacao?: string;
    validade?: string;
    requiresUpload?: boolean;
    rntrcFileName?: string;
  };
  pf?: OwnerPFData;
  pj?: OwnerPJData;
  /** Indica que dados foram reusados de um owner ja coletado nesta sessao. */
  reusedFromSession?: boolean;
  /**
   * FEAT-ANTT-TITULAR — dados do titular do RNTRC da carreta quando difere do
   * owner CRLV da carreta. Undefined/null quando cascade confirmou que sao iguais.
   */
  anttTitular?: AnttTitularData | null;
  /**
   * @deprecated 2026-05-18 — substituido por `owner_extras`. Mantido na
   * interface por compat com drafts antigos.
   */
  ccPF?: CcPropPFData;
  /** PLAN-CADASTRO-PARITY — inscricao estadual do proprietario PJ (opcional). */
  ccPJ?: CcPropPJData;
  /**
   * 2026-05-18 — Extras opcionais do proprietario PF (filiacao, RG, detalhes
   * da CNH) editados inline no OwnerDocumentUploader (ProgressiveSection).
   */
  owner_extras?: OwnerExtras;
  /**
   * Path do documento do proprietário da carreta no bucket `cadastro-drafts`
   * (slot `carreta_owner_cnh_<idx>`). Persistido em background; usado para
   * reabrir o wizard mostrando o arquivo já anexado.
   */
  ownerDocStoragePath?: string;
  /**
   * Path do comprovante de residência do proprietário (slot
   * `carreta_owner_comprovante_<idx>`). Necessário para o sub-card "Endereço
   * do proprietário" — espelha o pipeline do A3 do motorista.
   */
  ownerComprovanteStoragePath?: string;
  /**
   * Endereço do proprietário da carreta. Espelha o shape do A3Data
   * (motorista) — preenchido via OcrUploadTile + ViaCEP com fallback
   * manual. 2026-05-20.
   */
  ownerEndereco?: {
    cep: string;
    numero: string;
    logradouro: string;
    bairro: string;
    cidade: string;
    uf: string;
    comprovanteUrl?: string;
    ocr_comprovante_fallback_manual?: boolean;
  };
}

export interface StepECarretaOwnerProps {
  /** Placa da carreta em flight (usado para ANTT cascade). */
  trailerPlate: string;
  /** Documento do owner extraido do CRLV (digits only). */
  ownerDocFromCrlv: string;
  driverProfile: StepEDriverProfile;
  /** Owner do cavalo ja coletado (defensivo — Step D ja cobre esse case). */
  cavaloOwnerCollected?: CollectedCarretaOwner;
  /** Owners de carretas previas coletados nesta sessao (defensivo). */
  previousCarretaOwners?: CollectedCarretaOwner[];
  currentStep: number;
  totalSteps: number;
  value?: StepEData;
  onChange?: (data: StepEData) => void;
  onComplete: (data: StepEData) => void;
  onBack: () => void;
  /** Indice da carreta — usado para construir slot dinâmico (carreta_owner_cnh_{idx}). */
  carretaIdx?: number;
  /** Contexto p/ persistência draft. */
  cargaId?: string;
  cpf?: string;
}

function buildInitialPFData(value: StepEData | undefined): OwnerPFData {
  if (value?.pf) return value.pf;
  return buildEmptyOwnerPFData();
}

function buildInitialPJData(value: StepEData | undefined): OwnerPJData {
  if (value?.pj) return value.pj;
  return buildEmptyOwnerPJData();
}

/**
 * Step E — Proprietario da Carreta. Estrutura espelha o Step C, mas usa o
 * contexto "da carreta" (UI-SPEC eyebrow "PROPRIETARIO DA CARRETA").
 *
 * Renderizado pelo wizard somente quando o Step D nao conseguiu auto-resolver
 * (i.e., owner != driver E owner != cavalo owner E owner != owner de carreta
 * previa). Defensive: se prevCarretaOwners contem matching doc, pre-popula
 * (CADASTRO-08).
 */
function StepECarretaOwnerImpl({
  trailerPlate,
  ownerDocFromCrlv,
  driverProfile,
  cavaloOwnerCollected,
  previousCarretaOwners,
  currentStep,
  totalSteps,
  value,
  onChange,
  onComplete,
  onBack,
  carretaIdx,
  cargaId,
  cpf,
}: StepECarretaOwnerProps) {
  const driverAuth = useDriverAuth();
  const accessToken = driverAuth.session?.access_token ?? null;

  const ownerDocDigits = useMemo(() => onlyDigits(ownerDocFromCrlv), [ownerDocFromCrlv]);
  const ownerDocType: "cpf" | "cnpj" = ownerDocDigits.length === 11 ? "cpf" : "cnpj";

  // Defensive reuse: caso o owner ja tenha sido coletado nesta sessao.
  const reusedSource = useMemo<CollectedCarretaOwner | undefined>(() => {
    if (
      cavaloOwnerCollected &&
      onlyDigits(cavaloOwnerCollected.doc) === ownerDocDigits
    ) {
      return cavaloOwnerCollected;
    }
    return (previousCarretaOwners ?? []).find(
      (owner) => onlyDigits(owner.doc) === ownerDocDigits,
    );
  }, [cavaloOwnerCollected, previousCarretaOwners, ownerDocDigits]);

  // C1 — Owner doc state.
  const [ownerData, setOwnerData] = useState<{
    nome: string;
    documento: string;
    dataNascimento?: string;
    cnhNumero?: string;
    ocrFallbackManual: boolean;
  }>({
    nome: value?.owner?.nome ?? "",
    documento: value?.owner?.documento ?? ownerDocDigits,
    dataNascimento: value?.owner?.dataNascimento,
    cnhNumero: value?.owner?.cnhNumero,
    ocrFallbackManual: Boolean(value?.owner?.ocr_fallback_manual),
  });

  // C2 — ANTT cascade state — restaurado do draft se disponível.
  const anttMutation = useCandidaturaAnttPrecheck();
  const [anttState, setAnttState] = useState<AnttCascadeState>(() => {
    if (!value?.antt) return "idle";
    if (value.antt.rntrc && !value.antt.requiresUpload) return "success";
    if (value.antt.requiresUpload) return "not-found";
    return "idle";
  });
  const [anttResult, setAnttResult] = useState<AnttPrecheckResponse | null>(() => {
    if (!value?.antt?.rntrc) return null;
    return {
      rntrc: value.antt.rntrc,
      tipo: value.antt.tipo,
      situacao: value.antt.situacao,
      validade: value.antt.validade,
      requiresUpload: value.antt.requiresUpload ?? false,
    };
  });
  const [anttErrorMessage, setAnttErrorMessage] = useState<string | undefined>(undefined);
  const [rntrcUploadState, setRntrcUploadState] = useState<OcrTileState>(() =>
    value?.antt?.rntrcFileName ? "success" : "empty",
  );
  const [rntrcFile, setRntrcFile] = useState<File | undefined>(undefined);
  // Inicia com o doc já persistido para evitar re-trigger do ANTT no mount.
  const lastTriggeredDocRef = useRef<string>(value?.owner?.documento ?? "");

  // C3 (PF) / C4 (PJ) data.
  const [pfData, setPfData] = useState<OwnerPFData>(() => buildInitialPFData(value));
  const [pjData, setPjData] = useState<OwnerPJData>(() => buildInitialPJData(value));

  // FEAT-ANTT-TITULAR — titular RNTRC da carreta (quando difere do owner CRLV).
  const [anttTitular, setAnttTitular] = useState<AnttTitularData | null>(
    value?.anttTitular ?? null,
  );

  // 2026-05-20 — Resultado OCR do RNTRC quando cascade falha (cenario C).
  // Mesmo padrao do StepC.
  const [rntrcOcrResult, setRntrcOcrResult] = useState<{
    titular_doc?: string;
    titular_nome?: string;
    rntrc?: string;
  } | null>(null);

  // 2026-05-18 — Verifica duplicidade do PROPRIETARIO da carreta (AngelLira +
  // ASPX + DB local). Dispara quando ownerData.documento e DIFERENTE de
  // (a) CPF do motorista, (b) doc inicial vindo do CRLV (ownerDocFromCrlv) e
  // (c) docs ja coletados nesta sessao (cavalo / carretas previas). Quando
  // `reusedSource` esta presente, o motorista ja reusou — pula o alert.
  const ownerDocDigitsFromState = useMemo(
    () => onlyDigits(ownerData.documento),
    [ownerData.documento],
  );
  const knownDocsInSession = useMemo(() => {
    const set = new Set<string>();
    set.add(onlyDigits(driverProfile.document_number));
    set.add(onlyDigits(ownerDocFromCrlv));
    if (cavaloOwnerCollected?.doc) set.add(onlyDigits(cavaloOwnerCollected.doc));
    (previousCarretaOwners ?? []).forEach((owner) => {
      if (owner.doc) set.add(onlyDigits(owner.doc));
    });
    set.delete("");
    return set;
  }, [driverProfile.document_number, ownerDocFromCrlv, cavaloOwnerCollected, previousCarretaOwners]);
  const isKnownDoc = knownDocsInSession.has(ownerDocDigitsFromState);
  const ownerCpfDuplicate = useVerifyDocument({
    type: "ownerCpf",
    value:
      ownerDocDigitsFromState.length === 11 && !isKnownDoc ? ownerData.documento : "",
    initialValue: ownerDocFromCrlv,
    isValid: isValidCpf,
    normalize: onlyDigits,
  });
  const ownerCnpjDuplicate = useVerifyDocument({
    type: "ownerCnpj",
    value:
      ownerDocDigitsFromState.length === 14 && !isKnownDoc ? ownerData.documento : "",
    initialValue: ownerDocFromCrlv,
    isValid: isValidCnpj,
    normalize: onlyDigits,
  });
  const ownerDuplicate =
    ownerDocDigitsFromState.length === 14 ? ownerCnpjDuplicate : ownerCpfDuplicate;
  const [uploaderResetCounter, setUploaderResetCounter] = useState(0);
  const handleOwnerDuplicateReset = useCallback(() => {
    ownerDuplicate.dismiss();
    setOwnerData((current) => ({
      ...current,
      nome: "",
      documento: "",
      dataNascimento: undefined,
      cnhNumero: undefined,
      ocrFallbackManual: false,
    }));
    setUploaderResetCounter((current) => current + 1);
  }, [ownerDuplicate]);

  // 2026-05-18 — Extras PF migraram para `owner_extras` editados inline no
  // OwnerDocumentUploader. PJ continua como card separado (IE).
  // Storage path do documento do proprietário (slot `carreta_owner_cnh_<idx>`).
  // Persistido em background pelo OwnerDocumentUploader; entra no payload
  // do StepEData para sobreviver a reload (badge "arquivo já enviado").
  const [ownerDocStoragePath, setOwnerDocStoragePath] = useState<string | undefined>(
    value?.ownerDocStoragePath,
  );
  const [ownerComprovanteStoragePath, setOwnerComprovanteStoragePath] = useState<
    string | undefined
  >(value?.ownerComprovanteStoragePath);
  const [ownerEndereco, setOwnerEndereco] = useState<StepEData["ownerEndereco"]>(
    value?.ownerEndereco,
  );

  // Hidratação tardia (F5 público): sincroniza storage paths quando o draft
  // chega após o mount. Sem isso o motorista vê o tile vazio mesmo com o
  // documento já salvo no Supabase. Padrão idêntico ao StepC/StepB.
  useEffect(() => {
    if (!value) return;
    if (value.ownerDocStoragePath && value.ownerDocStoragePath !== ownerDocStoragePath) {
      setOwnerDocStoragePath(value.ownerDocStoragePath);
    }
    if (
      value.ownerComprovanteStoragePath &&
      value.ownerComprovanteStoragePath !== ownerComprovanteStoragePath
    ) {
      setOwnerComprovanteStoragePath(value.ownerComprovanteStoragePath);
    }
    if (value.ownerEndereco && value.ownerEndereco !== ownerEndereco) {
      setOwnerEndereco(value.ownerEndereco);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const [ownerExtras, setOwnerExtras] = useState<OwnerExtras | undefined>(
    value?.owner_extras,
  );
  const [ccPJData, setCcPJData] = useState<CcPropPJData | undefined>(value?.ccPJ);
  const [ccPJValid, setCcPJValid] = useState<boolean>(false);


  // Bug 3 fix: tentativa de submit. Quando o motorista clica "Continuar"
  // com o form invalido (campos obrigatórios escondidos), `attemptedSubmit`
  // vira true e o OwnerAttributionFormPF expande automaticamente a seção.
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);

  // Se o owner ja foi coletado nesta sessao, pre-popula dados (CADASTRO-08).
  useEffect(() => {
    if (!reusedSource) return;
    if (ownerDocType === "cpf" && reusedSource.pfData) {
      setPfData(reusedSource.pfData);
    } else if (ownerDocType === "cnpj" && reusedSource.pjData) {
      setPjData(reusedSource.pjData);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reusedSource]);

  const triggerAnttPrecheck = useCallback(
    (docDigits: string) => {
      if (!accessToken) return;
      if (!docDigits) return;
      if (lastTriggeredDocRef.current === docDigits) return;
      lastTriggeredDocRef.current = docDigits;
      setAnttState("loading");
      setAnttErrorMessage(undefined);
      anttMutation.mutate(
        {
          docType: ownerDocType,
          doc: docDigits,
          placa: trailerPlate,
          accessToken,
        },
        {
          onSuccess: (response) => {
            setAnttResult(response);
            if (response.requiresUpload) {
              setAnttState("not-found");
            } else {
              setAnttState("success");
            }
          },
          onError: (error) => {
            setAnttErrorMessage(
              error instanceof CandidaturaApiError
                ? error.message
                : "Tente novamente em alguns instantes.",
            );
            setAnttState("error");
          },
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accessToken, trailerPlate, ownerDocType],
  );

  const handleOwnerExtracted = useCallback(
    (extracted: OwnerExtractedData) => {
      const docDigits = onlyDigits(extracted.documento);
      setOwnerData({
        nome: extracted.nome ?? "",
        documento: docDigits,
        dataNascimento: extracted.dataNascimento,
        cnhNumero: extracted.cnhNumero,
        ocrFallbackManual: Boolean(extracted.ocr_fallback_manual),
      });
      // 2026-05-18 — Extras (filiacao/RG/CNH) chegam ja editados via
      // `extracted.extras` do OwnerDocumentUploader (ProgressiveSection inline).
      if (ownerDocType === "cpf" && extracted.extras) {
        setOwnerExtras(extracted.extras);
      }
      // 2026-05-26 — PJ: prefill endereço do cartão CNPJ (Infosimples), pra
      // não exigir comprovante de residência. Mesma lógica do StepC.
      if (docDigits.length === 14 && extracted.raw) {
        const raw = extracted.raw as Record<string, unknown>;
        const str = (k: string) => {
          const v = raw[k];
          return v != null ? String(v).trim() : "";
        };
        const cep = str("cep");
        const cidade = str("cidade") || str("municipio");
        const uf = str("uf");
        if (cep || cidade || uf) {
          setOwnerEndereco((current) => {
            if (current?.comprovanteUrl) return current;
            return {
              cep: cep || current?.cep || "",
              numero: str("numero") || current?.numero || "",
              logradouro: str("logradouro") || str("endereco") || current?.logradouro || "",
              bairro: str("bairro") || current?.bairro || "",
              cidade: cidade || current?.cidade || "",
              uf: uf || current?.uf || "",
              comprovanteUrl: current?.comprovanteUrl,
            };
          });
        }
      }
      // 2026-05-20 — Cascade ANTT backend-only; nao dispara aqui no front.
    },
    [ownerDocType],
  );

  // Re-emit dados ao pai quando algum campo muda.
  useEffect(() => {
    if (!onChange) return;
    const payload = buildStepEPayload(
      ownerData,
      ownerDocType,
      anttResult,
      rntrcFile,
      pfData,
      pjData,
      Boolean(reusedSource),
      anttTitular,
      ownerExtras,
      ccPJData,
      ownerDocStoragePath,
      ownerComprovanteStoragePath,
      ownerEndereco,
    );
    onChange(payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ownerData.nome,
    ownerData.documento,
    ownerData.dataNascimento,
    ownerData.cnhNumero,
    anttResult,
    rntrcFile,
    pfData,
    pjData,
    anttTitular,
    ownerExtras,
    ccPJData,
    ownerDocStoragePath,
    ownerComprovanteStoragePath,
    ownerEndereco,
  ]);

  const handleRntrcFile = (file: File) => {
    setRntrcFile(file);
    setRntrcUploadState("success");
  };

  const handleRetryAntt = () => {
    lastTriggeredDocRef.current = "";
    triggerAnttPrecheck(ownerData.documento);
  };

  const ownerDocValid =
    ownerDocType === "cpf" ? isValidCpf(ownerData.documento) : isValidCnpj(ownerData.documento);

  // 2026-05-20 — Cascade ANTT backend-only. anttFulfilled deriva apenas do
  // novo card "Proprietário da ANTT da carreta" (AnttTitularPrompt noCascadeMode).
  const anttFulfilled = anttTitular !== null;

  const complementaryFulfilled =
    ownerDocType === "cpf" ? isValidOwnerPFData(pfData) : isValidOwnerPJData(pjData);

  const continueEnabled =
    ownerData.nome.trim().length > 0 &&
    ownerDocValid &&
    anttFulfilled &&
    complementaryFulfilled;

  const handleContinue = () => {
    if (!continueEnabled) {
      setAttemptedSubmit(true);
      return;
    }
    const payload = buildStepEPayload(
      ownerData,
      ownerDocType,
      anttResult,
      rntrcFile,
      pfData,
      pjData,
      Boolean(reusedSource),
      anttTitular,
      ownerExtras,
      ccPJData,
      ownerDocStoragePath,
      ownerComprovanteStoragePath,
      ownerEndereco,
    );
    onComplete(payload);
  };

  return (
    <div className="space-y-6">
      <StepHeader
        eyebrow={`ETAPA ${currentStep} DE ${totalSteps}`}
        title="Proprietário da carreta"
        description="Vamos cadastrar quem é dono da carreta."
        currentStep={currentStep}
        totalSteps={totalSteps}
      />

      {(() => {
        const docCardCompleted = ownerDocValid && ownerData.nome.trim().length > 0;
        const anttCardCompleted = anttFulfilled;
        const contactCardCompleted = complementaryFulfilled;
        // 2026-05-18 — Card "Banco/Conta da empresa" REMOVIDO (banco migrou
        // para AnttTitularPrompt cavalo). PF mantem card de contato
        // (telefone/CEP/numero). PJ apenas IE (sem contato proprio).
        const hasContactCard = ownerDocType === "cpf";
        const hasCcCard = ownerDocType === "cnpj";
        // Sub-card "Endereço do proprietário". PF exige comprovante; PJ usa
        // endereço do cartão CNPJ (Infosimples) — comprovante opcional. 2026-05-26.
        const hasEnderecoCard = true;
        const ownerEnderecoCompleted = Boolean(
          ownerEndereco?.cep &&
            ownerEndereco?.numero &&
            ownerEndereco?.cidade &&
            ownerEndereco?.uf &&
            (ownerDocType === "cpf" ? ownerEndereco?.comprovanteUrl : true),
        );
        const totalCards =
          2 + (hasContactCard ? 1 : 0) + (hasEnderecoCard ? 1 : 0) + (hasCcCard ? 1 : 0);

        const docSummary = ownerData.nome
          ? ownerData.nome
          : ownerDocDigits || undefined;
        const anttSummary = anttResult?.rntrc
          ? `RNTRC ${anttResult.rntrc}`
          : anttState === "not-found" && rntrcFile
            ? `Documento ${rntrcFile.name}`
            : undefined;
        const contactSummary = (() => {
          if (ownerDocType !== "cpf") return undefined;
          const parts: string[] = [];
          if (pfData.telefone) parts.push(pfData.telefone);
          if (pfData.cep) parts.push(`CEP ${pfData.cep}`);
          return parts.length > 0 ? parts.join(" • ") : undefined;
        })();
        const ccSummary = ccPJData?.isento_ie
          ? "Isento de IE"
          : ccPJData?.inscricao_estadual
            ? `IE ${ccPJData.inscricao_estadual}`
            : undefined;

        let cursor = 1;
        const positions = {
          doc: cursor++,
          contact: hasContactCard ? cursor++ : 0,
          endereco: hasEnderecoCard ? cursor++ : 0,
          cc: hasCcCard ? cursor++ : 0,
          // 2026-05-20: "Proprietário da ANTT" agora posicionado APOS endereco/cc.
          antt: cursor++,
        };

        return (
          <WizardStepStack
            steps={[
              {
                id: "doc",
                isCompleted: docCardCompleted,
                render: ({ status, onActivate }) => (
                  <WizardStepCard
                    position={positions.doc}
                    total={totalCards}
                    title={ownerDocType === "cpf" ? "CNH do proprietário" : "Cartão CNPJ"}
                    description={
                      ownerDocType === "cpf"
                        ? "Envie a foto da CNH do proprietário."
                        : "Envie a foto do cartão CNPJ."
                    }
                    summary={docSummary}
                    status={status}
                    onActivate={onActivate}
                  >
                    <OwnerDocumentUploader
                      key={`owner-doc-${uploaderResetCounter}`}
                      ownerDocType={ownerDocType}
                      expectedDocument={ownerDocDigits}
                      onExtracted={handleOwnerExtracted}
                      initialExtras={ownerExtras}
                      slot={
                        carretaIdx != null
                          ? `carreta_owner_cnh_${carretaIdx}`
                          : undefined
                      }
                      cargaId={cargaId}
                      cpf={cpf}
                      accessToken={accessToken}
                      onDraftPersisted={(storagePath) => {
                        setOwnerDocStoragePath(storagePath);
                      }}
                      draftPersisted={Boolean(ownerDocStoragePath)}
                    />
                    {ownerDuplicate.shouldWarn ? (
                      <DriverAlert
                        variant="info"
                        className="mt-3"
                        title={buildOwnerDuplicateAlert(ownerDuplicate.result).title}
                        description={buildOwnerDuplicateAlert(ownerDuplicate.result).description}
                        primaryAction={{
                          label: "Usar este proprietário",
                          onClick: ownerDuplicate.dismiss,
                        }}
                        secondaryAction={{
                          label: "Trocar documento",
                          onClick: handleOwnerDuplicateReset,
                        }}
                      />
                    ) : null}
                  </WizardStepCard>
                ),
              },
              ...(hasContactCard
                ? [
                    {
                      id: "contact" as const,
                      isCompleted: contactCardCompleted,
                      render: ({
                        status,
                        onActivate,
                      }: {
                        status: "active" | "completed" | "pending";
                        onActivate: () => void;
                      }) => (
                        <WizardStepCard
                          position={positions.contact}
                          total={totalCards}
                          title="Contato do proprietário"
                          description="Telefone e endereço pra Lamônica ligar se precisar."
                          summary={contactSummary}
                          status={status}
                          onActivate={onActivate}
                        >
                          <OwnerAttributionFormPF
                            value={pfData}
                            onChange={setPfData}
                            driverProfile={driverProfile}
                            ownerDoc={ownerDocDigits}
                            prefillFromOcr={{ nome: ownerData.nome }}
                            prefilledFromCavaloOwner={reusedSource?.pfData}
                            context="carreta"
                            attemptedSubmit={attemptedSubmit}
                            comprovanteSlot={
                              carretaIdx != null
                                ? `carreta_owner_comprovante_${carretaIdx}`
                                : undefined
                            }
                            cargaId={cargaId}
                            cpf={cpf}
                            accessToken={accessToken}
                          />
                        </WizardStepCard>
                      ),
                    },
                  ]
                : []),
              ...(hasEnderecoCard
                ? [
                    {
                      id: "endereco" as const,
                      isCompleted: ownerEnderecoCompleted,
                      render: ({
                        status,
                        onActivate,
                      }: {
                        status: "active" | "completed" | "pending";
                        onActivate: () => void;
                      }) => {
                        const enderecoSummary = ownerEndereco?.cep
                          ? `CEP ${ownerEndereco.cep}, nº ${ownerEndereco.numero}`
                          : undefined;
                        return (
                          <WizardStepCard
                            position={positions.endereco}
                            total={totalCards}
                            title="Endereço do proprietário da carreta"
                            description="Envie um comprovante (luz/água/internet)."
                            summary={enderecoSummary}
                            status={status}
                            onActivate={onActivate}
                          >
                            <OwnerEnderecoComprovante
                              idPrefix={`step-e-${carretaIdx ?? 0}-owner-end`}
                              slot={
                                carretaIdx === 1
                                  ? "carreta_owner_comprovante_1"
                                  : "carreta_owner_comprovante_0"
                              }
                              title="Endereço do proprietário"
                              description="Conta de luz/água/internet — últimos 3 meses."
                              requireComprovante={ownerDocType === "cpf"}
                              value={ownerEndereco}
                              onChange={(data) => {
                                setOwnerEndereco(data);
                                if (data.comprovanteUrl) {
                                  setOwnerComprovanteStoragePath(data.comprovanteUrl);
                                }
                              }}
                              cargaId={cargaId}
                              cpf={cpf}
                              accessToken={accessToken}
                            />
                          </WizardStepCard>
                        );
                      },
                    },
                  ]
                : []),
              ...(hasCcCard
                ? [
                    {
                      id: "cc" as const,
                      isCompleted: ccPJValid,
                      render: ({
                        status,
                        onActivate,
                      }: {
                        status: "active" | "completed" | "pending";
                        onActivate: () => void;
                      }) => (
                        <WizardStepCard
                          position={positions.cc}
                          total={totalCards}
                          title="Inscrição estadual da empresa"
                          description="Opcional — inscrição estadual ou isento."
                          summary={ccSummary}
                          status={status}
                          onActivate={onActivate}
                        >
                          <CcInscricaoPropPJ
                            value={ccPJData}
                            onChange={setCcPJData}
                            onValid={setCcPJValid}
                          />
                        </WizardStepCard>
                      ),
                    },
                  ]
                : []),
              {
                id: "antt" as const,
                isCompleted: anttCardCompleted,
                render: ({
                  status,
                  onActivate,
                }: {
                  status: "active" | "completed" | "pending";
                  onActivate: () => void;
                }) => (
                  <WizardStepCard
                    position={positions.antt}
                    total={totalCards}
                    title="Proprietário da ANTT da carreta"
                    description="É o mesmo proprietário do CRLV ou outra pessoa? A cascade no governo roda automática no envio."
                    summary={anttSummary}
                    status={status}
                    onActivate={onActivate}
                  >
                    <AnttTitularPrompt
                      cascadeResult={null}
                      ownerDoc={ownerData.documento || ownerDocDigits}
                      ownerNome={ownerData.nome}
                      value={anttTitular}
                      onChange={setAnttTitular}
                      context={`carreta_${carretaIdx ?? 0}`}
                      kind="carreta"
                      cargaId={cargaId}
                      cpf={cpf}
                      accessToken={accessToken}
                      titularDocSlot={
                        carretaIdx != null
                          ? `carreta_antt_owner_cnh_${carretaIdx}`
                          : undefined
                      }
                      rntrcSlot={
                        carretaIdx != null ? `carreta_antt_${carretaIdx}` : undefined
                      }
                      noCascadeMode
                    />
                  </WizardStepCard>
                ),
              },
            ]}
          />
        );
      })()}

      {anttMutation.isPending ? (
        <p className="flex items-center gap-2 text-sm text-foreground/80">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Sincronizando com ANTT…
        </p>
      ) : null}

      {attemptedSubmit && !continueEnabled ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive bg-destructive/5 p-3 text-sm text-destructive"
        >
          <span aria-hidden="true">⚠</span>
          <ValidationBannerMessage
            ownerDocType={ownerDocType}
            pfData={pfData}
            anttFulfilled={anttFulfilled}
            ownerDocValid={ownerDocValid}
            ownerHasName={ownerData.nome.trim().length > 0}
          />
        </div>
      ) : null}

      <div className="flex flex-col-reverse items-stretch gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="ghost" onClick={onBack} className="sm:w-auto">
          Voltar
        </Button>
        <Button
          type="button"
          variant="cta"
          onClick={handleContinue}
          aria-disabled={!continueEnabled}
          className="py-3.5 sm:w-auto sm:py-2.5"
        >
          Continuar
        </Button>
      </div>
    </div>
  );
}

export const StepECarretaOwner = memo(StepECarretaOwnerImpl);

function buildStepEPayload(
  ownerData: {
    nome: string;
    documento: string;
    dataNascimento?: string;
    cnhNumero?: string;
    ocrFallbackManual: boolean;
  },
  ownerDocType: "cpf" | "cnpj",
  anttResult: AnttPrecheckResponse | null,
  rntrcFile: File | undefined,
  pfData: OwnerPFData,
  pjData: OwnerPJData,
  reusedFromSession: boolean,
  anttTitular: AnttTitularData | null,
  ownerExtras?: OwnerExtras,
  ccPJData?: CcPropPJData,
  ownerDocStoragePath?: string,
  ownerComprovanteStoragePath?: string,
  ownerEndereco?: StepEData["ownerEndereco"],
): StepEData {
  const payload: StepEData = {
    owner: {
      nome: ownerData.nome,
      documento: ownerData.documento,
      docType: ownerDocType,
      dataNascimento: ownerData.dataNascimento,
      cnhNumero: ownerData.cnhNumero,
      ocr_fallback_manual: ownerData.ocrFallbackManual,
    },
    antt: {
      rntrc: anttResult?.rntrc,
      tipo: anttResult?.tipo,
      situacao: anttResult?.situacao,
      validade: anttResult?.validade,
      requiresUpload: anttResult?.requiresUpload,
      rntrcFileName: rntrcFile?.name,
    },
    reusedFromSession,
    ...(ownerDocStoragePath ? { ownerDocStoragePath } : {}),
    ...(ownerComprovanteStoragePath ? { ownerComprovanteStoragePath } : {}),
    ...(ownerEndereco ? { ownerEndereco } : {}),
  };
  if (ownerDocType === "cpf") {
    payload.pf = pfData;
  } else {
    payload.pj = pjData;
  }
  if (anttTitular) {
    payload.anttTitular = anttTitular;
  }
  if (ownerExtras && ownerDocType === "cpf") {
    payload.owner_extras = ownerExtras;
  }
  if (ccPJData && ownerDocType === "cnpj") {
    payload.ccPJ = ccPJData;
  }
  return payload;
}
