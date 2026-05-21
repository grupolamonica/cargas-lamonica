import { memo, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DriverAlert } from "@/components/driver/ui/DriverAlert";
import {
  isValidCnpj,
  isValidCpf,
  isValidPlate,
  normalizePlateValue,
  onlyDigits,
} from "@/lib/brazilianValidators";

import { StepHeader } from "../StepHeader";
import { useVerifyDocument } from "../useVerifyDocument";
import {
  VehicleCrlvUploader,
  type VehicleCrlvExtractedData,
} from "../widgets/VehicleCrlvUploader";
import { OcrUploadTile, type OcrTileState } from "../widgets/OcrUploadTile";
import {
  WizardStepCard,
  type WizardStepStatus,
} from "../widgets/WizardStepCard";
import { WizardStepStack } from "../widgets/WizardStepStack";
import type { OwnerPFData } from "../widgets/OwnerAttributionFormPF";
import type { OwnerPJData } from "../widgets/OwnerAttributionFormPJ";
import type { BcData } from "./BcDetalhesCavalo";
import { mergeBcFromOcr } from "../lib/mergeBcFromOcr";

export type CarretaOwnerResolution =
  | "driver"
  | "reused_cavalo"
  | "reused_carreta"
  | "new";

export interface CollectedCarretaOwner {
  /** Documento do proprietario (digits only, 11=CPF, 14=CNPJ). */
  doc: string;
  docType: "cpf" | "cnpj";
  /** Dados complementares ja coletados (PF ou PJ). Pode ser undefined quando ownerIsDriver. */
  pfData?: OwnerPFData;
  pjData?: OwnerPJData;
}

export interface StepDCarretaEntry {
  plate: string;
  renavam: string;
  chassi: string;
  marca: string;
  ano: string;
  cor: string;
  owner_doc: string;
  owner_doc_type: "cpf" | "cnpj" | "";
  owner_resolution: CarretaOwnerResolution;
  /** CADASTRO-14: dados do CRLV preenchidos manualmente. */
  ocr_fallback_manual?: boolean;
  /**
   * BUG-WALK-01 — Quando o proprietario foi reusado (cavalo/outra carreta/motorista)
   * mas o motorista informou ter ANTT separado para ESTA carreta, guardamos o
   * nome do arquivo aqui para exibir no ConfirmationScreen. NAO eh enviado ao
   * backend (schema strict — carretaSchema nao aceita campo extra); por ora
   * existe apenas no state client p/ feedback. Sera promovido ao payload em
   * milestone futura.
   */
  antt_carreta_file_name?: string;
  /**
   * PLAN-CADASTRO-PARITY — detalhes extras da carreta (tipo, carroceria,
   * eixos, frota, etc.). Todos opcionais; emitidos no payload final via
   * buildSubmitDados se preenchidos.
   */
  bc?: BcData;
  /**
   * Path do CRLV da carreta no bucket `cadastro-drafts`
   * (slot `carreta_crlv_<idx>`). Persistido em background no upload — usado
   * para reabrir o wizard mostrando o arquivo já anexado.
   */
  crlvStoragePath?: string;
}

export interface StepDData {
  carretas: StepDCarretaEntry[];
}

export interface StepDTrailerInput {
  plate: string;
  daysUntilExpiry?: number;
}

export interface StepDDriverProfile {
  document_number: string;
}

/** Owner do cavalo ja coletado nesta sessao (vem do StepC). */
export interface CavaloOwnerCollected {
  doc: string;
  docType: "cpf" | "cnpj";
  pfData?: OwnerPFData;
  pjData?: OwnerPJData;
}

export interface StepDCarretasProps {
  /** Carretas pendentes (max 2 — D-08, defensive slice aplicado). */
  trailersToCollect: StepDTrailerInput[];
  driverProfile: StepDDriverProfile;
  /** Owner do cavalo ja coletado nesta sessao (CADASTRO-08). */
  cavaloOwnerCollected?: CavaloOwnerCollected;
  /** Indice da carreta corrente (controlado pelo wizard). */
  currentTrailerIdx: number;
  /** Owners de carretas previas coletados nesta sessao. */
  previousCarretaOwners?: CollectedCarretaOwner[];
  currentStep: number;
  totalSteps: number;
  /** Dados acumulados das carretas resolvidas (hydration). */
  value?: StepDData;
  onChange?: (data: StepDData) => void;
  /** Auto-resolveu (driver / reuse) — wizard avanca currentTrailerIdx. */
  onTrailerAutoResolved: (entry: StepDCarretaEntry, owner: CollectedCarretaOwner | null) => void;
  /** Trailer precisa de owner novo — wizard switcha para Step E. */
  onTrailerNeedsOwner: (
    idx: number,
    entry: Omit<StepDCarretaEntry, "owner_resolution">,
    ownerDocFromCrlv: string,
    ownerDocType: "cpf" | "cnpj",
  ) => void;
  /** Todas as carretas processadas. */
  onComplete: (data: StepDData) => void;
  onBack: () => void;
  checkPlateRegistration?: (plate: string) => Promise<{ alreadyRegistered: boolean; daysUntilExpiry?: number }>;
  /** Contexto p/ persistência draft (slots carreta_crlv_{idx}, carreta_antt_{idx}). */
  cargaId?: string;
  cpf?: string;
  accessToken?: string | null;
}

interface ExtractedSnapshot {
  data: VehicleCrlvExtractedData;
  ownerDocDigits: string;
  ownerDocType: "cpf" | "cnpj" | "";
}

/**
 * Converte a entrada persistida da carreta no shape que o VehicleCrlvUploader
 * entende — re-abre o tile em "success" pos F5/voltar (mesmo padrao do StepB).
 */
function buildCrlvInitialFromCarreta(
  entry: StepDCarretaEntry | undefined,
): VehicleCrlvExtractedData | undefined {
  if (!entry) return undefined;
  const base: VehicleCrlvExtractedData = {
    placa: entry.plate,
    renavam: entry.renavam,
    chassi: entry.chassi,
    marca: entry.marca,
    ano: entry.ano,
    cor: entry.cor,
    ownerNome: "",
    ocr_fallback_manual: entry.ocr_fallback_manual,
  };
  if (entry.owner_doc_type === "cpf" && entry.owner_doc) {
    base.cpf_proprietario = entry.owner_doc;
  } else if (entry.owner_doc_type === "cnpj" && entry.owner_doc) {
    base.cnpj_proprietario = entry.owner_doc;
  }
  if (entry.bc?.modelo) base.modelo = entry.bc.modelo;
  if (entry.bc?.tipo) base.tipo = entry.bc.tipo;
  if (entry.bc?.carroceria) base.carroceria = entry.bc.carroceria;
  if (entry.bc?.ano_fabricacao) base.ano_fabricacao = entry.bc.ano_fabricacao;
  if (entry.bc?.eixos) base.eixos = entry.bc.eixos;
  if (entry.bc?.uf_emplacamento) base.uf_emplacamento = entry.bc.uf_emplacamento;
  if (entry.bc?.cidade_emplacamento) base.cidade_emplacamento = entry.bc.cidade_emplacamento;
  if (entry.bc?.ultimo_licenciamento) base.ultimo_licenciamento = entry.bc.ultimo_licenciamento;
  return base;
}

/**
 * Step D — Carretas. Itera sobre `trailersToCollect` (max 2 — D-08).
 *
 * Para cada carreta:
 *  1) <VehicleCrlvUploader> recolhe CRLV.
 *  2) Auto-attribution (CADASTRO-08):
 *     - ownerDoc === driverCpf -> resolution='driver', pula Step E.
 *     - ownerDoc === cavaloOwner.doc -> resolution='reused_cavalo', pula Step E.
 *     - ownerDoc === previousCarretaOwner.doc -> resolution='reused_carreta', pula E.
 *     - else -> sinaliza onTrailerNeedsOwner; wizard navega para Step E.
 *  3) Apos Step E (ou auto-resolve), wizard avanca currentTrailerIdx.
 *  4) Quando todas resolvidas, onComplete eh chamado com carretas[].
 */
function StepDCarretasImpl({
  trailersToCollect,
  driverProfile,
  cavaloOwnerCollected,
  currentTrailerIdx,
  previousCarretaOwners,
  currentStep,
  totalSteps,
  value,
  onChange,
  onTrailerAutoResolved,
  onTrailerNeedsOwner,
  onComplete,
  onBack,
  checkPlateRegistration,
  cargaId,
  cpf,
  accessToken,
}: StepDCarretasProps) {
  // D-08: defensive cap at 2 trailers (CADASTRO-05).
  const trailers = useMemo(() => trailersToCollect.slice(0, 2), [trailersToCollect]);
  const safeIdx = Math.min(Math.max(currentTrailerIdx, 0), trailers.length - 1);

  const driverCpfDigits = onlyDigits(driverProfile.document_number);
  const cavaloOwnerDoc = cavaloOwnerCollected?.doc
    ? onlyDigits(cavaloOwnerCollected.doc)
    : "";

  // Carretas ja resolvidas (hydration vinda do wizard).
  const resolvedCarretas: StepDCarretaEntry[] = value?.carretas ?? [];

  // Snapshot do OCR do trailer corrente.
  const [extracted, setExtracted] = useState<ExtractedSnapshot | null>(null);

  // BUG-WALK-01 — quando o proprietario sera reusado (driver/cavalo/outra
  // carreta), o motorista pode declarar que a carreta tem ANTT separado.
  // Default false (reusa ANTT do cavalo). Quando true, exigimos upload do
  // documento ANTT especifico desta carreta antes de continuar.
  const [carretaAnttSeparado, setCarretaAnttSeparado] = useState(false);
  const [carretaAnttFile, setCarretaAnttFile] = useState<File | undefined>(undefined);
  const [carretaAnttUploadState, setCarretaAnttUploadState] = useState<OcrTileState>("empty");

  // PLAN-CADASTRO-PARITY — detalhes da carreta. State por-carreta alimentado
  // pelo OCR (mergeBcFromOcr) e propagado pro payload via buildSubmitDados.
  // 19/05 — UI removida; data flow segue pro backend transparentemente.
  const [bcData, setBcData] = useState<BcData | undefined>(undefined);
  // Storage path do CRLV da carreta corrente (slot `carreta_crlv_<idx>`).
  // Persistido em background pelo VehicleCrlvUploader; entra no entry final
  // via buildEntryFromExtracted para sobreviver a reload do wizard.
  const [crlvStoragePath, setCrlvStoragePath] = useState<string | undefined>(undefined);

  // Quando muda o currentTrailerIdx, reseta o snapshot.
  useEffect(() => {
    setExtracted(null);
    setCarretaAnttSeparado(false);
    setCarretaAnttFile(undefined);
    setCarretaAnttUploadState("empty");
    setBcData(undefined);
    // Hidrata o storage_path se a carreta corrente já foi resolvida antes
    // (rehydration via `value.carretas[safeIdx]`).
    setCrlvStoragePath(value?.carretas?.[safeIdx]?.crlvStoragePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTrailerIdx, trailers.length]);

  // Hidratação tardia (F5 público): re-sincroniza crlvStoragePath quando
  // o draft chega via reconciliação servidor após o mount inicial. Sem isso
  // o motorista vê o tile vazio mesmo com o documento já salvo no Supabase.
  useEffect(() => {
    const incoming = value?.carretas?.[safeIdx]?.crlvStoragePath;
    if (incoming && incoming !== crlvStoragePath) {
      setCrlvStoragePath(incoming);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, safeIdx]);

  // Quando o upload do CRLV da carreta corrente completa (crlvStoragePath
  // chega), propaga IMEDIATAMENTE para o pai. Antes desse fix o storage_path
  // só era enviado ao backend quando o motorista clicava "Continuar" — se ele
  // saísse ou recarregasse antes, perdia o documento.
  useEffect(() => {
    if (!crlvStoragePath) return;
    if (!onChange) return;
    const existing = value?.carretas ?? [];
    const currentEntry = existing[safeIdx];
    if (currentEntry?.crlvStoragePath === crlvStoragePath) return;
    const updated: StepDCarretaEntry[] = existing.slice();
    if (currentEntry) {
      updated[safeIdx] = { ...currentEntry, crlvStoragePath };
    } else {
      updated[safeIdx] = {
        plate: trailers[safeIdx]?.plate ?? "",
        renavam: "",
        chassi: "",
        marca: "",
        ano: "",
        cor: "",
        owner_doc: "",
        owner_doc_type: "",
        owner_resolution: "skip",
        crlvStoragePath,
      };
    }
    onChange({ carretas: updated });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crlvStoragePath, safeIdx]);

  // Sincroniza data com o pai sempre que resolvedCarretas mudar.
  useEffect(() => {
    if (onChange) onChange({ carretas: resolvedCarretas });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedCarretas]);

  const ownerDocValid =
    extracted &&
    ((extracted.ownerDocType === "cpf" && isValidCpf(extracted.ownerDocDigits)) ||
      (extracted.ownerDocType === "cnpj" && isValidCnpj(extracted.ownerDocDigits)));

  // Pre-calculo do owner reusado de outra carreta (hooks devem ficar antes do early return).
  const previousMatch = useMemo(() => {
    if (!extracted || !ownerDocValid) return undefined;
    return (previousCarretaOwners ?? []).find(
      (owner) => owner.doc === extracted.ownerDocDigits,
    );
  }, [extracted, ownerDocValid, previousCarretaOwners]);

  // 08-21 — Aviso de duplicidade da placa da carreta corrente. Disparado quando
  // o CRLV trouxe uma placa diferente da que veio no pre-check para este
  // índice de carreta. Hook precisa rodar antes do early return abaixo.
  const trailerInitialPlate = trailers[safeIdx]?.plate ?? "";
  const trailerPlateDuplicate = useVerifyDocument({
    type: "trailerPlate",
    value: extracted?.data.placa ?? "",
    initialValue: trailerInitialPlate,
    isValid: isValidPlate,
    normalize: normalizePlateValue,
  });

  // Caso defensive: sem trailers para processar (nao deveria acontecer).
  if (trailers.length === 0) {
    return (
      <div className="space-y-6">
        <StepHeader
          eyebrow={`ETAPA ${currentStep} DE ${totalSteps}`}
          title="Sem carretas pendentes"
          description="Nada para cadastrar agora."
          currentStep={currentStep}
          totalSteps={totalSteps}
        />
        <div className="flex flex-col-reverse items-stretch gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <Button type="button" variant="ghost" onClick={onBack} className="sm:w-auto">
            Voltar
          </Button>
          <Button
            type="button"
            variant="cta"
            onClick={() => onComplete({ carretas: resolvedCarretas })}
            className="py-3.5 sm:w-auto sm:py-2.5"
          >
            Continuar
          </Button>
        </div>
      </div>
    );
  }

  const currentTrailer = trailers[safeIdx];

  const handleExtracted = (data: VehicleCrlvExtractedData) => {
    const cpf = data.cpf_proprietario ? onlyDigits(data.cpf_proprietario) : "";
    const cnpj = data.cnpj_proprietario ? onlyDigits(data.cnpj_proprietario) : "";
    let docDigits = "";
    let docType: "cpf" | "cnpj" | "" = "";
    if (cpf.length === 11) {
      docDigits = cpf;
      docType = "cpf";
    } else if (cnpj.length === 14) {
      docDigits = cnpj;
      docType = "cnpj";
    }
    setExtracted({ data, ownerDocDigits: docDigits, ownerDocType: docType });
    // PLAN-CADASTRO-PARITY — popula sub-card BC da carreta atual com os campos
    // extras do OCR. Carreta nao tem `modelo` (omitido no render do
    // BcDetalhesCavalo quando kind="carreta") mas armazenamos no state — campo
    // extra inofensivo e nao quebra payload (buildSubmitDados emite condicional).
    const hasAnyBcField = Boolean(
      data.modelo ||
        data.tipo ||
        data.carroceria ||
        data.ano_fabricacao ||
        data.eixos ||
        data.uf_emplacamento ||
        data.cidade_emplacamento ||
        data.ultimo_licenciamento,
    );
    setBcData((prev) =>
      mergeBcFromOcr(prev, {
        modelo: data.modelo,
        tipo: data.tipo,
        carroceria: data.carroceria,
        ano_fabricacao: data.ano_fabricacao,
        eixos: data.eixos,
        uf_emplacamento: data.uf_emplacamento,
        cidade_emplacamento: data.cidade_emplacamento,
        ultimo_licenciamento: data.ultimo_licenciamento,
      }),
    );
    // hasAnyBcField mantido como sentinela; mergeBcFromOcr ja e idempotente.
    void hasAnyBcField;
  };

  const placaValid = extracted ? (extracted.data.placa || "").trim().length >= 7 : false;
  // BUG-WALK-01 — quando o motorista marca "ANTT diferente desta carreta",
  // exige upload do arquivo antes de liberar Continuar.
  const carretaAnttFulfilled = !carretaAnttSeparado || Boolean(carretaAnttFile);
  const continueEnabled = Boolean(ownerDocValid && placaValid && carretaAnttFulfilled);

  // Auto-attribution preview (banner) — calculado pre-Continue.
  const ownerIsDriver =
    Boolean(ownerDocValid) &&
    extracted?.ownerDocType === "cpf" &&
    driverCpfDigits.length === 11 &&
    extracted?.ownerDocDigits === driverCpfDigits;

  const ownerReusedFromCavalo =
    !ownerIsDriver &&
    Boolean(ownerDocValid) &&
    cavaloOwnerDoc.length > 0 &&
    extracted?.ownerDocDigits === cavaloOwnerDoc;

  const ownerReusedFromCarreta =
    !ownerIsDriver && !ownerReusedFromCavalo && Boolean(previousMatch);

  const buildEntryFromExtracted = (
    resolution: CarretaOwnerResolution,
  ): StepDCarretaEntry => ({
    plate: extracted?.data.placa || currentTrailer.plate,
    renavam: extracted?.data.renavam ?? "",
    chassi: extracted?.data.chassi ?? "",
    marca: extracted?.data.marca ?? "",
    ano: extracted?.data.ano ?? "",
    cor: extracted?.data.cor ?? "",
    owner_doc: extracted?.ownerDocDigits ?? "",
    owner_doc_type: extracted?.ownerDocType ?? "",
    owner_resolution: resolution,
    ocr_fallback_manual: Boolean(extracted?.data.ocr_fallback_manual),
    // BUG-WALK-01 — propaga nome do arquivo ANTT separado, quando habilitado.
    antt_carreta_file_name:
      carretaAnttSeparado && carretaAnttFile ? carretaAnttFile.name : undefined,
    // PLAN-CADASTRO-PARITY — detalhes opcionais da carreta.
    ...(bcData ? { bc: bcData } : {}),
    // Path persistido — necessário para reabrir o wizard com o arquivo já
    // anexado no upload tile (sem motorista ter que reenviar).
    ...(crlvStoragePath ? { crlvStoragePath } : {}),
  });

  const handleContinue = () => {
    if (!continueEnabled || !extracted) return;
    if (extracted.ownerDocType === "") return;

    if (ownerIsDriver) {
      const entry = buildEntryFromExtracted("driver");
      // Se o proprietário do cavalo já foi coletado (step-C com driverIsOwner),
      // reutiliza os dados bancários/complementares para a carreta também.
      const ownerDataForTrailer =
        cavaloOwnerCollected && onlyDigits(cavaloOwnerCollected.doc) === driverCpfDigits
          ? {
              doc: cavaloOwnerCollected.doc,
              docType: cavaloOwnerCollected.docType,
              pfData: cavaloOwnerCollected.pfData,
              pjData: cavaloOwnerCollected.pjData,
            }
          : null;
      onTrailerAutoResolved(entry, ownerDataForTrailer);
      return;
    }

    if (ownerReusedFromCavalo && cavaloOwnerCollected) {
      const entry = buildEntryFromExtracted("reused_cavalo");
      onTrailerAutoResolved(entry, {
        doc: cavaloOwnerCollected.doc,
        docType: cavaloOwnerCollected.docType,
        pfData: cavaloOwnerCollected.pfData,
        pjData: cavaloOwnerCollected.pjData,
      });
      return;
    }

    if (ownerReusedFromCarreta && previousMatch) {
      const entry = buildEntryFromExtracted("reused_carreta");
      onTrailerAutoResolved(entry, previousMatch);
      return;
    }

    // Caso default: precisa cadastrar owner no Step E.
    const baseEntry = buildEntryFromExtracted("new");
    const { owner_resolution: _unused, ...entryWithoutResolution } = baseEntry;
    onTrailerNeedsOwner(
      safeIdx,
      entryWithoutResolution,
      extracted.ownerDocDigits,
      extracted.ownerDocType as "cpf" | "cnpj",
    );
  };

  return (
    <div className="space-y-6">
      <StepHeader
        eyebrow={`ETAPA ${currentStep} DE ${totalSteps} • CARRETA ${safeIdx + 1} DE ${trailers.length}`}
        title={`Carreta ${currentTrailer.plate}`}
        description="Tire uma foto do CRLV para preencher os dados."
        currentStep={currentStep}
        totalSteps={totalSteps}
      />

      {(() => {
        const crlvCardCompleted = Boolean(ownerDocValid && placaValid);
        const ownerReused = ownerIsDriver || ownerReusedFromCavalo || ownerReusedFromCarreta;
        const showAnttCard = crlvCardCompleted && ownerReused;
        const anttCardCompleted =
          !showAnttCard || !carretaAnttSeparado || Boolean(carretaAnttFile);
        const totalCards = 1 + (showAnttCard ? 1 : 0);

        const crlvSummary = extracted?.data.placa
          ? extracted.data.marca
            ? `${extracted.data.placa} • ${extracted.data.marca}`
            : extracted.data.placa
          : undefined;
        const anttCardSummary = !carretaAnttSeparado
          ? "Mesma ANTT do cavalo"
          : carretaAnttFile
            ? `Documento ${carretaAnttFile.name}`
            : undefined;

        return (
          <WizardStepStack
            steps={[
              {
                id: "crlv",
                isCompleted: crlvCardCompleted,
                render: ({ status, onActivate }) => (
                  <WizardStepCard
                    position={1}
                    total={totalCards}
                    title="CRLV da carreta"
                    description="Envie o CRLV para preenchermos os dados automaticamente."
                    summary={crlvSummary}
                    status={status}
                    onActivate={onActivate}
                  >
                    <div className="space-y-4">
                      <VehicleCrlvUploader
                        plate={currentTrailer.plate}
                        onExtracted={handleExtracted}
                        label="CRLV da carreta"
                        checkPlateRegistration={checkPlateRegistration}
                        slot={`carreta_crlv_${safeIdx}`}
                        cargaId={cargaId}
                        cpf={cpf}
                        accessToken={accessToken}
                        expectedVehicleType="carreta"
                        onResetExtracted={() => {
                          setCrlvStoragePath(undefined);
                        }}
                        onDraftPersisted={(storagePath) => {
                          setCrlvStoragePath(storagePath);
                        }}
                        draftPersisted={Boolean(crlvStoragePath)}
                        initialExtracted={
                          crlvStoragePath
                            ? buildCrlvInitialFromCarreta(value?.carretas?.[safeIdx])
                            : undefined
                        }
                      />

                      {trailerPlateDuplicate.shouldWarn ? (
                        <DriverAlert
                          variant="warning"
                          title="Placa já cadastrada"
                          description="Essa placa de carreta já tá cadastrada. Quer continuar com ela mesmo assim?"
                          primaryAction={{
                            label: "Continuar",
                            onClick: trailerPlateDuplicate.dismiss,
                          }}
                          secondaryAction={{
                            label: "Usar a original",
                            onClick: () => {
                              setExtracted((current) =>
                                current
                                  ? {
                                      ...current,
                                      data: {
                                        ...current.data,
                                        placa: currentTrailer.plate,
                                      },
                                    }
                                  : current,
                              );
                              trailerPlateDuplicate.dismiss();
                            },
                          }}
                        />
                      ) : null}

                      {ownerIsDriver ? (
                        <div className="admin-tint-success rounded-2xl border p-3.5 sm:p-4">
                          <div className="flex items-start gap-2.5 sm:gap-3">
                            <CheckCircle2
                              className="mt-0.5 size-5 shrink-0 text-emerald-700"
                              aria-hidden="true"
                            />
                            <div>
                              <p className="text-sm font-semibold text-foreground sm:text-base">
                                Você é o proprietário. Vamos pular pro próximo.
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                Vamos pular a etapa de proprietário.
                              </p>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {ownerReusedFromCavalo ? (
                        <div className="admin-tint-info rounded-2xl border p-3.5 sm:p-4">
                          <div className="flex items-start gap-2.5 sm:gap-3">
                            <Info
                              className="mt-0.5 size-5 shrink-0 text-primary"
                              aria-hidden="true"
                            />
                            <div>
                              <p className="text-sm font-semibold text-foreground sm:text-base">
                                Mesmo proprietário do cavalo — dados reutilizados.
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                Vamos pular a etapa de proprietário desta carreta.
                              </p>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      {ownerReusedFromCarreta ? (
                        <div className="admin-tint-info rounded-2xl border p-3.5 sm:p-4">
                          <div className="flex items-start gap-2.5 sm:gap-3">
                            <Info
                              className="mt-0.5 size-5 shrink-0 text-primary"
                              aria-hidden="true"
                            />
                            <div>
                              <p className="text-sm font-semibold text-foreground sm:text-base">
                                Mesmo proprietário de outra carreta — dados reutilizados.
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                Vamos pular a etapa de proprietário desta carreta.
                              </p>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </WizardStepCard>
                ),
              },
              // 19/05 — sub-card "Detalhes da carreta" (bc-carreta) NAO e
              // mais renderizado. State `bcData` segue alimentado pelo OCR e
              // chega no payload via buildSubmitDados. UI removida a pedido.
              ...(showAnttCard
                ? [
                    {
                      id: "antt-carreta",
                      isCompleted: anttCardCompleted,
                      render: ({
                        status,
                        onActivate,
                      }: {
                        status: WizardStepStatus;
                        onActivate: () => void;
                      }) => (
                        <WizardStepCard
                          position={2}
                          total={totalCards}
                          title="ANTT desta carreta"
                          description="A licença ANTT desta carreta é a mesma do cavalo?"
                          summary={anttCardSummary}
                          status={status}
                          onActivate={onActivate}
                        >
                          <fieldset className="space-y-3">
                            <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
                              <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm">
                                <input
                                  type="radio"
                                  name={`carreta-antt-${safeIdx}`}
                                  checked={!carretaAnttSeparado}
                                  onChange={() => {
                                    setCarretaAnttSeparado(false);
                                    setCarretaAnttFile(undefined);
                                    setCarretaAnttUploadState("empty");
                                  }}
                                  className="size-4"
                                />
                                <span>Mesma ANTT do cavalo</span>
                              </label>
                              <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm">
                                <input
                                  type="radio"
                                  name={`carreta-antt-${safeIdx}`}
                                  checked={carretaAnttSeparado}
                                  onChange={() => setCarretaAnttSeparado(true)}
                                  className="size-4"
                                />
                                <span>ANTT diferente desta carreta</span>
                              </label>
                            </div>

                            {carretaAnttSeparado ? (
                              <div className="pt-2">
                                <OcrUploadTile
                                  accept="image/*,application/pdf"
                                  maxSizeMb={8}
                                  label="Documento ANTT da carreta"
                                  helper="ANTT específico desta carreta (PDF ou foto)"
                                  state={carretaAnttUploadState}
                                  previewName={carretaAnttFile?.name}
                                  onFile={(file) => {
                                    setCarretaAnttFile(file);
                                    setCarretaAnttUploadState("success");
                                  }}
                                  onRetry={() => {
                                    setCarretaAnttFile(undefined);
                                    setCarretaAnttUploadState("empty");
                                  }}
                                  onManualFallback={() => {
                                    setCarretaAnttUploadState("success");
                                  }}
                                  slot={`carreta_antt_${safeIdx}`}
                                  cargaId={cargaId}
                                  cpf={cpf}
                                  accessToken={accessToken}
                                />
                              </div>
                            ) : null}
                          </fieldset>
                        </WizardStepCard>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        );
      })()}

      <div className="flex flex-col-reverse items-stretch gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="ghost" onClick={onBack} className="sm:w-auto">
          Voltar
        </Button>
        <Button
          type="button"
          variant="cta"
          onClick={handleContinue}
          disabled={!continueEnabled}
          className="py-3.5 sm:w-auto sm:py-2.5"
        >
          Continuar
        </Button>
      </div>
    </div>
  );
}

export const StepDCarretas = memo(StepDCarretasImpl);
