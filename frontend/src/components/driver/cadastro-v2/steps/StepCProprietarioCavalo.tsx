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
  describeOwnerPFFieldIssues,
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
// 2026-05-18 — CcDadosPessoaisPropPF (sub-card PF "Dados pessoais e RG") foi
// inlinado dentro do OwnerDocumentUploader como ProgressiveSection. Os dados
// agora fluem via `owner_extras` (OwnerExtras). O sub-card PJ (CcInscricaoPropPJ)
// continua como card separado.
import type { CcPropPFData } from "./CcDadosPessoaisPropPF";
import { CcInscricaoPropPJ, type CcPropPJData } from "./CcInscricaoPropPJ";

/**
 * @deprecated 2026-05-18 — Banco migrou para AnttTitularPrompt (kind=cavalo).
 * Tipo mantido apenas por compat com drafts antigos persistidos.
 */
export interface StepCBankData {
  bank?: import("@/lib/brazilianBanks").BrazilianBank | null;
  agencia: string;
  conta: string;
  tipo: "corrente" | "poupanca" | "";
}

export interface StepCEndereco {
  cep: string;
  numero: string;
  comprovanteUrl?: string;
}

export interface StepCDriverProfile {
  document_number: string;
  phone: string;
  nome?: string;
  endereco?: StepCEndereco;
}

export interface StepCData {
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
  /**
   * @deprecated 2026-05-18 — Banco migrou para AnttTitularPrompt cavalo.
   * Mantido na interface por compat com drafts antigos persistidos antes do
   * refactor. Nao eh mais lido nem emitido em payloads novos.
   */
  banking?: StepCBankData;
  /** Campos de contato/identidade do owner PF (telefone, CEP, numero). */
  pf?: {
    telefone: string;
    cep: string;
    numero: string;
    comprovanteFileName?: string;
  };
  /**
   * FEAT-ANTT-TITULAR — dados do titular do RNTRC quando difere do owner CRLV.
   * Undefined/null quando cascade confirmou que titular == owner (caso default).
   */
  anttTitular?: AnttTitularData | null;
  /**
   * @deprecated 2026-05-18 — substituido por `owner_extras`. Mantido na
   * interface por compat com drafts antigos persistidos antes do refactor.
   * Nao eh mais lido pelo wizard nem emitido em payloads novos.
   */
  ccPF?: CcPropPFData;
  /**
   * PLAN-CADASTRO-PARITY — inscricao estadual do proprietario PJ (opcionais).
   * Renderizado apenas quando ownerDocType === "cnpj".
   */
  ccPJ?: CcPropPJData;
  /**
   * 2026-05-18 — Extras opcionais do proprietario PF (filiacao, RG, detalhes
   * da CNH) editados inline no OwnerDocumentUploader (ProgressiveSection).
   * Substituiu o sub-card CcDadosPessoaisPropPF.
   */
  owner_extras?: OwnerExtras;
  /**
   * Path do documento do proprietário (CNH PF ou cartão CNPJ) no bucket
   * `cadastro-drafts` (slot `cavalo_owner_cnh`). Persistido em background;
   * usado para reabrir o wizard mostrando o arquivo já anexado.
   */
  ownerDocStoragePath?: string;
  /**
   * Path do comprovante de residência do proprietário (slot
   * `cavalo_owner_comprovante`). Necessário para o sub-card "Endereço do
   * proprietário" — espelha o pipeline do A3 do motorista.
   */
  ownerComprovanteStoragePath?: string;
  /**
   * Endereço do proprietário do cavalo. Espelha o shape do A3Data
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

export interface StepCProprietarioCavaloProps {
  ownerDocFromCrlv: string;
  horsePlate: string;
  driverProfile: StepCDriverProfile;
  totalSteps: number;
  currentStep: number;
  value?: StepCData;
  onChange?: (data: StepCData) => void;
  onComplete: (data: StepCData) => void;
  onBack: () => void;
  /** Modo motorista-proprietário: pula C1 (doc upload) e auto-dispara ANTT com CPF do motorista. */
  driverIsOwner?: boolean;
  /** Contexto p/ persistência draft (slots cavalo_owner_cnh, cavalo_antt). */
  cargaId?: string;
  cpf?: string;
}

function buildInitialPFData(value: StepCData | undefined): OwnerPFData {
  const base = buildEmptyOwnerPFData();
  if (!value?.pf) return base;
  return {
    telefone: value.pf.telefone ?? "",
    cep: value.pf.cep ?? "",
    numero: value.pf.numero ?? "",
    comprovanteFileName: value.pf.comprovanteFileName,
  };
}

function buildInitialPJData(_value: StepCData | undefined): OwnerPJData {
  return buildEmptyOwnerPJData();
}

/**
 * Step C — Proprietario do Cavalo. Bifurca PF (CPF) vs PJ (CNPJ) com sub-etapas
 * C1 (documento) -> C2 (ANTT cascade inline, W-03) -> C3 (PF: dados complementares)
 * OU C4 (PJ: apenas banking).
 *
 * Refator plan 07-10: C3 e C4 foram extraidos para OwnerAttributionFormPF /
 * OwnerAttributionFormPJ (compartilhados com Step E). C1 e C2 permanecem inline.
 *
 * D-13 bonus: pre-popula telefone/endereco do motorista quando ownerCpf === driverCpf
 * (delegado para OwnerAttributionFormPF).
 */
function StepCProprietarioCavaloImpl({
  ownerDocFromCrlv,
  horsePlate,
  driverProfile,
  totalSteps,
  currentStep,
  value,
  onChange,
  onComplete,
  onBack,
  driverIsOwner = false,
  cargaId,
  cpf,
}: StepCProprietarioCavaloProps) {
  const driverAuth = useDriverAuth();
  const accessToken = driverAuth.session?.access_token ?? null;

  // Quando driverIsOwner, o doc do proprietário é o CPF do motorista.
  // Fallback para ownerDocFromCrlv caso driverProfile.document_number não esteja disponível.
  const ownerDocDigits = useMemo(
    () =>
      driverIsOwner
        ? (onlyDigits(driverProfile.document_number) || onlyDigits(ownerDocFromCrlv))
        : onlyDigits(ownerDocFromCrlv),
    [driverIsOwner, driverProfile.document_number, ownerDocFromCrlv],
  );
  const ownerDocType: "cpf" | "cnpj" = ownerDocDigits.length === 11 ? "cpf" : "cnpj";

  // C1 — Owner doc state.
  const [ownerData, setOwnerData] = useState<{
    nome: string;
    documento: string;
    dataNascimento?: string;
    cnhNumero?: string;
    ocrFallbackManual: boolean;
  }>(() => {
    if (value?.owner) {
      return {
        nome: value.owner.nome,
        documento: value.owner.documento,
        dataNascimento: value.owner.dataNascimento,
        cnhNumero: value.owner.cnhNumero,
        ocrFallbackManual: Boolean(value.owner.ocr_fallback_manual),
      };
    }
    if (driverIsOwner) {
      return {
        nome: driverProfile.nome ?? "",
        documento: onlyDigits(driverProfile.document_number),
        ocrFallbackManual: false,
      };
    }
    return {
      nome: "",
      documento: "",
      ocrFallbackManual: false,
    };
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

  // FEAT-ANTT-TITULAR — captura dos dados do titular RNTRC quando difere do owner.
  const [anttTitular, setAnttTitular] = useState<AnttTitularData | null>(
    value?.anttTitular ?? null,
  );

  // 2026-05-20 — Resultado do OCR do RNTRC quando o cascade ANTT retorna
  // "not-found" e o motorista anexa o documento manualmente. Alimenta o
  // AnttTitularPrompt como cascadeResult (mesma forma do cascade da API),
  // permitindo que o prompt entre em cenario B/C e exija upload da CNH/CNPJ
  // do titular com validacao cruzada.
  const [rntrcOcrResult, setRntrcOcrResult] = useState<{
    titular_doc?: string;
    titular_nome?: string;
    rntrc?: string;
  } | null>(null);

  // 2026-05-18 — Verifica duplicidade do PROPRIETARIO (AngelLira + ASPX + DB).
  // Dispara quando ownerData.documento e DIFERENTE de (a) CPF do motorista
  // (driverProfile.document_number) e (b) doc inicial vindo do CRLV
  // (ownerDocFromCrlv). Driver-as-owner pula a verificacao porque o CPF ja
  // foi validado no pre-check do motorista.
  const ownerDocDigitsFromState = useMemo(
    () => onlyDigits(ownerData.documento),
    [ownerData.documento],
  );
  const ownerCpfDuplicate = useVerifyDocument({
    type: "ownerCpf",
    value: ownerDocDigitsFromState.length === 11 && !driverIsOwner ? ownerData.documento : "",
    initialValue: onlyDigits(driverProfile.document_number) === ownerDocDigitsFromState
      ? ownerData.documento
      : ownerDocFromCrlv,
    isValid: (raw) => isValidCpf(raw) && onlyDigits(raw) !== onlyDigits(driverProfile.document_number),
    normalize: onlyDigits,
  });
  const ownerCnpjDuplicate = useVerifyDocument({
    type: "ownerCnpj",
    value: ownerDocDigitsFromState.length === 14 ? ownerData.documento : "",
    initialValue: ownerDocFromCrlv,
    isValid: isValidCnpj,
    normalize: onlyDigits,
  });
  const ownerDuplicate =
    ownerDocDigitsFromState.length === 14 ? ownerCnpjDuplicate : ownerCpfDuplicate;
  // Bump quando o motorista clica "Trocar documento" — remonta o uploader
  // (efeito equivalente a OwnerDocumentUploader.handleRetry).
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
    setOwnerExtras(undefined);
    setUploaderResetCounter((current) => current + 1);
  }, [ownerDuplicate]);

  // 2026-05-18 — Extras PF migraram para `owner_extras` editados inline no
  // OwnerDocumentUploader (ProgressiveSection colapsado). PJ continua como
  // card separado (CcInscricaoPropPJ) — validity opcional.
  const [ownerExtras, setOwnerExtras] = useState<OwnerExtras | undefined>(
    value?.owner_extras,
  );
  const [ccPJData, setCcPJData] = useState<CcPropPJData | undefined>(value?.ccPJ);
  const [ccPJValid, setCcPJValid] = useState<boolean>(false);

  // Storage path do documento do proprietário (slot `cavalo_owner_cnh`).
  // Persistido em background pelo OwnerDocumentUploader; entra no payload
  // do StepCData para sobreviver a reload (badge "arquivo já enviado").
  const [ownerDocStoragePath, setOwnerDocStoragePath] = useState<string | undefined>(
    value?.ownerDocStoragePath,
  );
  const [ownerComprovanteStoragePath, setOwnerComprovanteStoragePath] = useState<
    string | undefined
  >(value?.ownerComprovanteStoragePath);
  const [ownerEndereco, setOwnerEndereco] = useState<StepCData["ownerEndereco"]>(
    value?.ownerEndereco,
  );

  // Hidratação tardia (F5 público): sincroniza storage paths quando o draft
  // chega após o mount. Sem isso, motorista perderia o badge "guardado" mesmo
  // com o documento no DB. Padrão aplicado em A2/A3/StepA/StepB.
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
    if (value.anttTitular && !anttTitular) {
      setAnttTitular(value.anttTitular);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Bug 3 fix: tentativa de submit. Quando o motorista clica "Continuar"
  // com o form invalido (em particular: campos obrigatórios escondidos atrás
  // do toggle "Dados fiscais e endereço"), `attemptedSubmit` é flipado para
  // true e o OwnerAttributionFormPF expande automaticamente a seção com erro.
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);

  const triggerAnttPrecheck = useCallback(
    (docDigits: string) => {
      if (!accessToken) {
        // No auth session — fall back to manual RNTRC upload instead of blocking silently.
        setAnttState("not-found");
        return;
      }
      if (!docDigits) return;
      if (lastTriggeredDocRef.current === docDigits) return;
      lastTriggeredDocRef.current = docDigits;
      setAnttState("loading");
      setAnttErrorMessage(undefined);
      anttMutation.mutate(
        {
          docType: ownerDocType,
          doc: docDigits,
          placa: horsePlate,
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
    [accessToken, horsePlate, ownerDocType],
  );

  // 2026-05-20 — Cascade ANTT backend-only (rodada em submit-final.js).
  // triggerAnttPrecheck/handleRetryAntt mantidos por compat com drafts antigos,
  // mas nao sao chamados em nenhum lugar do fluxo visivel atual.

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
      if (ownerDocType === "cpf" && extracted.extras) {
        setOwnerExtras(extracted.extras);
      }
      // 2026-05-26 — PJ: o cartão CNPJ (Infosimples) já traz o endereço
      // cadastral. Pré-preenche o sub-card de endereço pra que o motorista
      // não precise anexar comprovante de residência (só confere/edita).
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
            // Não sobrescreve se o motorista já editou (tem comprovante salvo).
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
    },
    [ownerDocType],
  );

  // Re-emit data to parent whenever any field changes.
  useEffect(() => {
    if (!onChange) return;
    const payload = buildStepCPayload(
      ownerData,
      ownerDocType,
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

  // Quando driverIsOwner, o CPF já foi validado no pre-check; assume sempre válido.
  const ownerDocValid = driverIsOwner
    ? true
    : ownerDocType === "cpf"
      ? isValidCpf(ownerData.documento)
      : isValidCnpj(ownerData.documento);

  // 2026-05-20 — Cascade ANTT roda 100% no backend (submit-final.js). Frontend
  // nao executa pre-emptive cascade. anttFulfilled deriva apenas do que o
  // motorista respondeu no novo card "Proprietário da ANTT" (toggle sim/nao +
  // mini-form quando "outra pessoa"). AnttTitularPrompt em noCascadeMode so
  // emite onChange(anttTitular) quando a resposta esta completa.
  const anttFulfilled = anttTitular !== null;

  const complementaryFulfilled =
    ownerDocType === "cpf" ? isValidOwnerPFData(pfData) : isValidOwnerPJData(pjData);

  const continueEnabled =
    (driverIsOwner || ownerData.nome.trim().length > 0) &&
    ownerDocValid &&
    anttFulfilled &&
    complementaryFulfilled;

  const handleContinue = () => {
    if (!continueEnabled) {
      // Bug 3: sinaliza tentativa para o OwnerAttributionFormPF abrir
      // o toggle "Dados fiscais e endereço" com campos invalidos.
      setAttemptedSubmit(true);
      return;
    }
    // Garante que owner.nome é preenchido quando motorista é o proprietário.
    const resolvedOwnerData =
      driverIsOwner && !ownerData.nome
        ? { ...ownerData, nome: driverProfile.nome ?? "" }
        : ownerData;
    const payload = buildStepCPayload(
      resolvedOwnerData,
      ownerDocType,
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
    );
    onComplete(payload);
  };

  return (
    <div className="space-y-6">
      <StepHeader
        eyebrow={`ETAPA ${currentStep} DE ${totalSteps}`}
        title={driverIsOwner ? "Você como proprietário do cavalo" : "Proprietário do cavalo"}
        description={
          driverIsOwner
            ? "Vamos pegar seu ANTT e a conta para receber o pagamento."
            : "Vamos cadastrar quem é dono do cavalo."
        }
        currentStep={currentStep}
        totalSteps={totalSteps}
      />

      {(() => {
        const docCardCompleted =
          ownerDocValid && (driverIsOwner || ownerData.nome.trim().length > 0);
        const anttCardCompleted = anttFulfilled;
        const contactCardCompleted = complementaryFulfilled;
        // 2026-05-18 — PF: card "Dados pessoais e RG" foi inlinado no
        // OwnerDocumentUploader (sem card extra). PJ mantem card de IE.
        // Card "Banco/Conta para receber" foi REMOVIDO — banco migrou para
        // AnttTitularPrompt do cavalo. Para PF, o contato (telefone/CEP/numero)
        // vira card proprio "Contato do proprietario". PJ nao tem card de
        // contato (sem campos a coletar — apenas IE).
        const hasContactCard = ownerDocType === "cpf";
        const hasCcCard = ownerDocType === "cnpj";
        // Sub-card "Endereço do proprietário". PF exige comprovante salvo no
        // Storage; PJ usa endereço do cartão CNPJ (Infosimples) — comprovante
        // opcional. 2026-05-26.
        const hasEnderecoCard = true;
        const ownerEnderecoCompleted = Boolean(
          ownerEndereco?.cep &&
            ownerEndereco?.numero &&
            ownerEndereco?.cidade &&
            ownerEndereco?.uf &&
            (ownerDocType === "cpf" ? ownerEndereco?.comprovanteUrl : true),
        );
        const baseCards = driverIsOwner ? 1 : 2; // antt + (opcional) doc
        const totalCards =
          baseCards +
          (hasContactCard ? 1 : 0) +
          (hasEnderecoCard ? 1 : 0) +
          (hasCcCard ? 1 : 0);

        const docSummary = ownerData.nome
          ? `${ownerData.nome}`
          : ownerDocDigits
            ? ownerDocDigits
            : undefined;
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

        // 2026-05-20 — Card "Consulta ANTT" REMOVIDO (backend faz cascade no
        // submit). Substituido pelo card "Proprietário da ANTT do cavalo"
        // (id="antt-titular") posicionado APOS endereco — propriedade do CRLV
        // primeiro, depois RNTRC. anttCardCompleted depende de anttTitular !==
        // null (AnttTitularPrompt em noCascadeMode garante completude do form).
        let cursor = 1;
        const stackSteps: Array<{
          id: "doc" | "antt-titular" | "contact" | "endereco" | "cc";
          isCompleted: boolean;
          position: number;
        }> = [];
        if (!driverIsOwner) {
          stackSteps.push({
            id: "doc",
            isCompleted: docCardCompleted,
            position: cursor++,
          });
        }
        if (hasContactCard) {
          stackSteps.push({
            id: "contact",
            isCompleted: contactCardCompleted,
            position: cursor++,
          });
        }
        if (hasEnderecoCard) {
          stackSteps.push({
            id: "endereco",
            isCompleted: ownerEnderecoCompleted,
            position: cursor++,
          });
        }
        if (hasCcCard) {
          stackSteps.push({
            id: "cc",
            isCompleted: ccPJValid,
            position: cursor++,
          });
        }
        stackSteps.push({
          id: "antt-titular",
          isCompleted: anttCardCompleted,
          position: cursor++,
        });

        return (
          <WizardStepStack
            steps={stackSteps.map((meta) => ({
              id: meta.id,
              isCompleted: meta.isCompleted,
              render: ({ status, onActivate }) => {
                if (meta.id === "doc") {
                  return (
                    <WizardStepCard
                      position={meta.position}
                      total={totalCards}
                      title={
                        ownerDocType === "cpf" ? "CNH do proprietário" : "Cartão CNPJ"
                      }
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
                        slot="cavalo_owner_cnh"
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
                  );
                }
                if (meta.id === "antt-titular") {
                  return (
                    <WizardStepCard
                      position={meta.position}
                      total={totalCards}
                      title="Proprietário da ANTT do cavalo"
                      description="É o mesmo proprietário do CRLV ou outra pessoa? A cascade no governo roda automática no envio."
                      summary={anttSummary}
                      status={status}
                      onActivate={onActivate}
                    >
                      <AnttTitularPrompt
                        cascadeResult={null}
                        ownerDoc={ownerData.documento || ownerDocDigits}
                        ownerNome={ownerData.nome || driverProfile.nome}
                        value={anttTitular}
                        onChange={setAnttTitular}
                        context="cavalo"
                        kind="cavalo"
                        cargaId={cargaId}
                        cpf={cpf}
                        accessToken={accessToken}
                        titularDocSlot="cavalo_antt_owner_cnh"
                        rntrcSlot="cavalo_antt"
                        noCascadeMode
                      />
                    </WizardStepCard>
                  );
                }
                if (meta.id === "contact") {
                  // 2026-05-18 — Card pos-refator: substituiu o card "Banco/Conta".
                  // So renderiza para PF (PJ nao tem campos de contato proprios).
                  return (
                    <WizardStepCard
                      position={meta.position}
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
                        context="cavalo"
                        attemptedSubmit={attemptedSubmit}
                        comprovanteSlot="cavalo_owner_comprovante"
                        cargaId={cargaId}
                        cpf={cpf}
                        accessToken={accessToken}
                      />
                    </WizardStepCard>
                  );
                }
                if (meta.id === "endereco") {
                  // Sub-card novo (2026-05-20): comprovante de residência do
                  // proprietário com OCR (cep+número via ocrComprovante) +
                  // ViaCEP. Espelha o A3Endereco do motorista. Source of
                  // truth para `ownerEndereco` no payload final.
                  const enderecoSummary = ownerEndereco?.cep
                    ? `CEP ${ownerEndereco.cep}, nº ${ownerEndereco.numero}`
                    : undefined;
                  return (
                    <WizardStepCard
                      position={meta.position}
                      total={totalCards}
                      title="Endereço do proprietário do cavalo"
                      description="Envie um comprovante (luz/água/internet)."
                      summary={enderecoSummary}
                      status={status}
                      onActivate={onActivate}
                    >
                      <OwnerEnderecoComprovante
                        idPrefix="step-c-owner-end"
                        slot="cavalo_owner_comprovante"
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
                }
                // cc — PJ-only (IE). 2026-05-18: PF foi inlinado no
                // OwnerDocumentUploader (ProgressiveSection).
                return (
                  <WizardStepCard
                    position={meta.position}
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
                );
              },
            }))}
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
            ownerHasName={
              driverIsOwner || ownerData.nome.trim().length > 0
            }
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

export const StepCProprietarioCavalo = memo(StepCProprietarioCavaloImpl);

/**
 * Banner de validação especifico: diferencia campos vazios (missing) de campos
 * preenchidos mas com formato/checksum invalido (invalid) — BUG-WALK-03.
 * Compartilhado entre Step C e Step E via re-export.
 */
export function ValidationBannerMessage({
  ownerDocType,
  pfData,
  anttFulfilled = true,
  ownerDocValid = true,
  ownerHasName = true,
}: {
  ownerDocType: "cpf" | "cnpj";
  pfData: OwnerPFData;
  anttFulfilled?: boolean;
  ownerDocValid?: boolean;
  ownerHasName?: boolean;
}) {
  // 2026-05-26 — antes mostrava "Faltam dados bancários obrigatórios" sempre que
  // ownerDocType !== "cpf", mas o formulário PJ não tem campos bancários
  // (banking vive em AnttTitularPrompt do cavalo, não aqui). A mensagem genérica
  // confundia o motorista. Agora apontamos o problema real:
  //   1. Falta escolher titular do RNTRC (anttFulfilled=false)
  //   2. Falta nome do proprietário (ownerHasName=false)
  //   3. Documento (CPF/CNPJ) inválido (ownerDocValid=false)
  if (!ownerDocValid) {
    return (
      <span>
        O <strong>{ownerDocType === "cpf" ? "CPF" : "CNPJ"}</strong> do
        proprietário está incompleto ou inválido.
      </span>
    );
  }
  if (!ownerHasName) {
    return (
      <span>
        Falta preencher o <strong>nome do proprietário</strong>.
      </span>
    );
  }
  if (!anttFulfilled) {
    return (
      <span>
        Escolha quem é o <strong>titular do RNTRC</strong> em{" "}
        <em>Proprietário da ANTT do cavalo</em>.
      </span>
    );
  }
  if (ownerDocType !== "cpf") {
    return (
      <span>
        Faltam campos obrigatórios. Verifique a seção{" "}
        <strong>Proprietário da ANTT do cavalo</strong> (banco, agência, conta).
      </span>
    );
  }
  const { missing, invalid } = describeOwnerPFFieldIssues(pfData);
  if (invalid.length > 0 && missing.length === 0) {
    return (
      <span>
        Confira os campos:{" "}
        <strong>{invalid.join(", ")}</strong>. Os números informados não passam
        na validação.
      </span>
    );
  }
  if (invalid.length > 0 && missing.length > 0) {
    return (
      <span>
        Faltam preencher: <strong>{missing.join(", ")}</strong>. Também confira{" "}
        <strong>{invalid.join(", ")}</strong> (formato inválido).
      </span>
    );
  }
  if (missing.length > 0) {
    return (
      <span>
        Faltam preencher: <strong>{missing.join(", ")}</strong>. Toque em{" "}
        <em>Contato do proprietário</em> para abrir.
      </span>
    );
  }
  return (
    <span>
      Faltam campos obrigatórios. Verifique a seção{" "}
      <strong>Contato do proprietário</strong>.
    </span>
  );
}

function buildStepCPayload(
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
  _pjData: OwnerPJData,
  anttTitular: AnttTitularData | null,
  ownerExtras?: OwnerExtras,
  ccPJData?: CcPropPJData,
  ownerDocStoragePath?: string,
  ownerComprovanteStoragePath?: string,
  ownerEndereco?: StepCData["ownerEndereco"],
): StepCData {
  const payload: StepCData = {
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
    ...(ownerDocStoragePath ? { ownerDocStoragePath } : {}),
    ...(ownerComprovanteStoragePath ? { ownerComprovanteStoragePath } : {}),
    ...(ownerEndereco ? { ownerEndereco } : {}),
  };
  if (ownerDocType === "cpf") {
    payload.pf = {
      telefone: pfData.telefone,
      cep: pfData.cep,
      numero: pfData.numero,
      comprovanteFileName: pfData.comprovanteFileName,
    };
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
