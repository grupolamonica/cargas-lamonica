import { memo, useEffect, useMemo, useState } from "react";
import { CheckCircle2 } from "lucide-react";

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
import { WizardStepCard } from "../widgets/WizardStepCard";
import { WizardStepStack } from "../widgets/WizardStepStack";
import { A4Tag, type A4TagValue } from "./A4Tag";
import { A5Pancary, type A5PancaryValue } from "./A5Pancary";
import { A6Rastreador, type A6Data } from "./A6Rastreador";
import type { BcData } from "./BcDetalhesCavalo";
import { mergeBcFromOcr } from "../lib/mergeBcFromOcr";

export interface StepBData {
  placa: string;
  renavam: string;
  chassi: string;
  marca: string;
  ano: string;
  cor: string;
  ownerDoc: string;
  ownerDocType: "cpf" | "cnpj" | "";
  ownerNome?: string;
  /** CADASTRO-14: dados do CRLV preenchidos manualmente. */
  ocr_fallback_manual?: boolean;
  /**
   * Atributos do CAVALO (movidos da etapa A em 2026-05-16). Esses 3 campos
   * pertencem ao veículo, não ao motorista, embora o payload backend ainda
   * carregue-os sob `motorista` (migração de schema é task separada).
   */
  a4?: A4TagValue;
  a5?: A5PancaryValue;
  a6?: A6Data;
  /**
   * PLAN-CADASTRO-PARITY — detalhes extras do veiculo (modelo, tipo, carroceria,
   * eixos, frota, etc.). Todos opcionais; emitidos no payload final via
   * buildSubmitDados se preenchidos.
   */
  bc?: BcData;
  /**
   * Path do CRLV do cavalo no bucket `cadastro-drafts` (slot `cavalo_crlv`).
   * Persistido em background no upload — necessário para a UI re-abrir o
   * wizard mostrando o arquivo já anexado, sem o motorista ter que reenviar.
   */
  crlvStoragePath?: string;
}

export interface StepBDriverProfile {
  document_number: string;
}

export interface StepBCavaloProps {
  horsePlate: string;
  driverProfile: StepBDriverProfile;
  totalSteps: number;
  currentStep: number;
  value?: StepBData;
  onChange?: (data: StepBData) => void;
  onComplete: (
    data: StepBData & {
      ownerIsDriver: boolean;
      ownerDocFromCrlv: string;
    },
  ) => void;
  onBack: () => void;
  checkPlateRegistration?: (plate: string) => Promise<{ alreadyRegistered: boolean; daysUntilExpiry?: number }>;
  /** Contexto p/ persistência draft (slot cavalo_crlv). */
  cargaId?: string;
  cpf?: string;
  accessToken?: string | null;
}

const EMPTY_DATA: StepBData = {
  placa: "",
  renavam: "",
  chassi: "",
  marca: "",
  ano: "",
  cor: "",
  ownerDoc: "",
  ownerDocType: "",
  ownerNome: "",
  a4: "",
  a5: "",
  a6: { possui: "" },
};

/**
 * Converte o slice persistido (StepBData) de volta no shape que o
 * VehicleCrlvUploader entende — usado pra re-abrir o tile em "success"
 * quando o motorista volta/atualiza a página e o CRLV já foi enviado.
 */
function buildCrlvInitialFromStepB(data: StepBData): VehicleCrlvExtractedData {
  const base: VehicleCrlvExtractedData = {
    placa: data.placa,
    renavam: data.renavam,
    chassi: data.chassi,
    marca: data.marca,
    ano: data.ano,
    cor: data.cor,
    ownerNome: data.ownerNome ?? "",
    ocr_fallback_manual: data.ocr_fallback_manual,
  };
  if (data.ownerDocType === "cpf" && data.ownerDoc) base.cpf_proprietario = data.ownerDoc;
  if (data.ownerDocType === "cnpj" && data.ownerDoc) base.cnpj_proprietario = data.ownerDoc;
  if (data.bc?.modelo) base.modelo = data.bc.modelo;
  if (data.bc?.tipo) base.tipo = data.bc.tipo;
  if (data.bc?.carroceria) base.carroceria = data.bc.carroceria;
  if (data.bc?.ano_fabricacao) base.ano_fabricacao = data.bc.ano_fabricacao;
  if (data.bc?.eixos) base.eixos = data.bc.eixos;
  if (data.bc?.uf_emplacamento) base.uf_emplacamento = data.bc.uf_emplacamento;
  if (data.bc?.cidade_emplacamento) base.cidade_emplacamento = data.bc.cidade_emplacamento;
  if (data.bc?.ultimo_licenciamento) base.ultimo_licenciamento = data.bc.ultimo_licenciamento;
  return base;
}

const TAG_LABEL: Record<string, string> = {
  sem_parar: "Sem Parar",
  conectcar: "ConectCar",
  move_mais: "Move Mais",
  veloe: "Veloe",
  eixo_pass: "Eixo Pass",
  nao_possuo: "Sem tag",
};

const PANCARY_LABEL: Record<string, string> = {
  sim: "Sim, possuo",
  nao: "Não possuo",
  desconhecido: "Não sei",
};

/**
 * Step B — Cavalo com OCR de CRLV (Infosimples) + auto-attribution gate
 * (D-13 / CADASTRO-04). Se o CPF do proprietario do CRLV bater com o CPF do
 * motorista autenticado, marca ownerIsDriver=true e o wizard pula o Step C
 * direto para o Step D.
 *
 * UX 2026-05-16: stepper-accordion — sub-etapas (CRLV + A4 + A5 + A6) ficam
 * em <WizardStepStack> com somente uma visível por vez.
 */
function StepBCavaloImpl({
  horsePlate,
  driverProfile,
  totalSteps,
  currentStep,
  value,
  onChange,
  onComplete,
  onBack,
  checkPlateRegistration,
  cargaId,
  cpf,
  accessToken,
}: StepBCavaloProps) {
  const initialData: StepBData = useMemo(
    () => value ?? { ...EMPTY_DATA, placa: horsePlate || "" },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [data, setData] = useState<StepBData>(initialData);
  const [manualMode, setManualMode] = useState(value?.ocr_fallback_manual ?? false);

  // Hidratação tardia: quando o draft é restaurado depois do mount (caso F5
  // público — GET /draft/me?cpf=XXX resolve após render), sincronizar com o
  // novo `value`. Mesmo padrão aplicado em A2/A3/StepAMotorista. Guard por
  // identidade evita loop com onChange→setStepBData no parent.
  useEffect(() => {
    if (!value) return;
    if (value === data) return;
    const samePlaca = (value.placa || "") === (data.placa || "");
    const sameOwner = (value.ownerDoc || "") === (data.ownerDoc || "");
    const sameStorage = (value.crlvStoragePath || "") === (data.crlvStoragePath || "");
    if (samePlaca && sameOwner && sameStorage) return;
    setData(value);
    if (value.a4 !== undefined) setA4Data(value.a4);
    if (value.a5 !== undefined) setA5Data(value.a5);
    if (value.a6 !== undefined) setA6Data(value.a6);
    if (value.bc !== undefined) setBcData(value.bc);
    if (value.ocr_fallback_manual !== undefined) {
      setManualMode(Boolean(value.ocr_fallback_manual));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Atributos do cavalo (movidos da etapa A em 2026-05-16). Mantemos como
  // states locais dedicados — mais simples do que aninhar em `data` e evita
  // recomputar handlers do CRLV/owner.
  const [a4Data, setA4Data] = useState<A4TagValue>(initialData.a4 ?? "");
  const [a5Data, setA5Data] = useState<A5PancaryValue>(initialData.a5 ?? "");
  const [a6Data, setA6Data] = useState<A6Data>(
    initialData.a6 ?? { possui: "" },
  );
  const [a4Valid, setA4Valid] = useState<boolean>(false);
  const [a5Valid, setA5Valid] = useState<boolean>(false);
  const [a6Valid, setA6Valid] = useState<boolean>(false);

  // PLAN-CADASTRO-PARITY — detalhes do cavalo. State alimentado pelo OCR
  // (mergeBcFromOcr) e propagado pro payload final via buildSubmitDados.
  // 19/05 — sub-card visivel removido a pedido: motorista nao precisa revisar
  // estes campos; CRLV vai direto pro backend.
  const [bcData, setBcData] = useState<BcData | undefined>(initialData.bc);

  const driverCpfDigits = onlyDigits(driverProfile.document_number);
  const ownerDocDigits = onlyDigits(data.ownerDoc);
  const ownerIsDriver =
    driverCpfDigits.length === 11 &&
    ownerDocDigits.length === 11 &&
    ownerDocDigits === driverCpfDigits;

  useEffect(() => {
    if (onChange)
      onChange({ ...data, a4: a4Data, a5: a5Data, a6: a6Data, bc: bcData });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, a4Data, a5Data, a6Data, bcData]);

  const handleExtracted = (extracted: VehicleCrlvExtractedData) => {
    const ownerDoc = onlyDigits(
      extracted.cpf_proprietario || extracted.cnpj_proprietario || "",
    );
    let ownerDocType: "cpf" | "cnpj" | "" = "";
    if (extracted.cpf_proprietario && onlyDigits(extracted.cpf_proprietario).length === 11) {
      ownerDocType = "cpf";
    } else if (
      extracted.cnpj_proprietario &&
      onlyDigits(extracted.cnpj_proprietario).length === 14
    ) {
      ownerDocType = "cnpj";
    }
    // Guard anti-flicker: o VehicleCrlvUploader emite com state=buildEmpty(plate)
    // tambem apos um `[plate]` reset (e.g., re-render que troca a referencia do
    // prop). Esse emit fantasma traz apenas placa e tudo mais vazio — se aplicarmos,
    // sobrescrevemos o draft hidratado. Detectamos "extraction vazia" pela ausencia
    // de qualquer campo OCR (RENAVAM, chassi, owner...) e ignoramos quando ja temos
    // dados meaningful no current.
    const hasAnyOcrContent = Boolean(
      extracted.renavam ||
        extracted.chassi ||
        extracted.marca ||
        extracted.ano ||
        extracted.cor ||
        ownerDoc ||
        extracted.ownerNome ||
        extracted.modelo ||
        extracted.tipo ||
        extracted.ocr_fallback_manual,
    );
    setData((current) => {
      const currentHasContent = Boolean(
        current.renavam ||
          current.chassi ||
          current.marca ||
          current.ownerDoc ||
          current.ownerNome,
      );
      if (!hasAnyOcrContent && currentHasContent) {
        return current;
      }
      return {
        ...current,
        placa: extracted.placa || horsePlate || current.placa,
        renavam: extracted.renavam || current.renavam,
        chassi: extracted.chassi || current.chassi,
        marca: extracted.marca || current.marca,
        ano: extracted.ano || current.ano,
        cor: extracted.cor || current.cor,
        ownerDoc: ownerDoc || current.ownerDoc,
        ownerDocType: ownerDocType || current.ownerDocType,
        ownerNome: extracted.ownerNome || current.ownerNome,
        ocr_fallback_manual: Boolean(extracted.ocr_fallback_manual),
      };
    });
    // PLAN-CADASTRO-PARITY — popula sub-card BC (Detalhes do cavalo) com o
    // que o OCR extraiu. mergeBcFromOcr preserva edição manual (prev || ocr).
    // Faz nada quando o OCR só devolveu campos vazios.
    const hasAnyBcField = Boolean(
      extracted.modelo ||
        extracted.tipo ||
        extracted.carroceria ||
        extracted.ano_fabricacao ||
        extracted.eixos ||
        extracted.uf_emplacamento ||
        extracted.cidade_emplacamento ||
        extracted.ultimo_licenciamento,
    );
    setBcData((prev) =>
      mergeBcFromOcr(prev, {
        modelo: extracted.modelo,
        tipo: extracted.tipo,
        carroceria: extracted.carroceria,
        ano_fabricacao: extracted.ano_fabricacao,
        eixos: extracted.eixos,
        uf_emplacamento: extracted.uf_emplacamento,
        cidade_emplacamento: extracted.cidade_emplacamento,
        ultimo_licenciamento: extracted.ultimo_licenciamento,
      }),
    );
    // hasAnyBcField calculado acima e mantido como sentinela pra evitar set
    // de bcData quando OCR retornou tudo vazio (mergeBcFromOcr ja e idempotente).
    void hasAnyBcField;
  };

  // 08-21 — Aviso de duplicidade quando a placa de cavalo extraída diverge da
  // placa inicial vinda do pre-check (horsePlate prop).
  const horsePlateDuplicate = useVerifyDocument({
    type: "horsePlate",
    value: data.placa,
    initialValue: horsePlate ?? "",
    isValid: isValidPlate,
    normalize: normalizePlateValue,
  });

  const revertHorsePlateToInitial = () => {
    setData((current) => ({ ...current, placa: horsePlate ?? "" }));
  };

  const placaValid = data.placa.trim().length >= 7;
  const ownerDocValid =
    (data.ownerDocType === "cpf" && isValidCpf(ownerDocDigits)) ||
    (data.ownerDocType === "cnpj" && isValidCnpj(ownerDocDigits));
  const crlvCompleted = placaValid && ownerDocValid;
  const continueEnabled = crlvCompleted && a4Valid && a5Valid && a6Valid;

  const handleContinue = () => {
    if (!continueEnabled) return;
    onComplete({
      ...data,
      a4: a4Data,
      a5: a5Data,
      a6: a6Data,
      ...(bcData ? { bc: bcData } : {}),
      ownerIsDriver,
      ownerDocFromCrlv: ownerDocDigits,
    });
  };

  // Summaries para cards collapsed.
  const crlvSummary =
    data.placa && data.marca
      ? `${data.placa} • ${data.marca}`
      : data.placa
        ? data.placa
        : undefined;
  const a4Summary = a4Data ? TAG_LABEL[a4Data] ?? a4Data : undefined;
  const a5Summary = a5Data ? `Pancary ${PANCARY_LABEL[a5Data] ?? a5Data}` : undefined;
  const a6Summary = a6Data?.possui
    ? a6Data.possui === "sim"
      ? `Rastreador sim${a6Data.rastreador?.empresa ? ` • ${a6Data.rastreador.empresa}` : ""}`
      : "Sem rastreador"
    : undefined;

  return (
    <div className="space-y-6">
      <StepHeader
        eyebrow={`ETAPA ${currentStep} DE ${totalSteps}`}
        title={`Cavalo ${data.placa || horsePlate || ""}`.trim()}
        description="Tire uma foto do CRLV para preencher os dados."
        currentStep={currentStep}
        totalSteps={totalSteps}
      />

      <WizardStepStack
        steps={[
          {
            id: "crlv",
            isCompleted: crlvCompleted,
            render: ({ status, onActivate }) => (
              <WizardStepCard
                position={1}
                total={4}
                title="CRLV do cavalo"
                description="Envie o CRLV — preenchemos os dados."
                summary={crlvSummary}
                status={status}
                onActivate={onActivate}
              >
                <div className="space-y-4">
                  <VehicleCrlvUploader
                    plate={horsePlate}
                    onExtracted={handleExtracted}
                    onManualFallback={() => setManualMode(true)}
                    manualMode={manualMode}
                    label="CRLV do cavalo"
                    checkPlateRegistration={checkPlateRegistration}
                    slot="cavalo_crlv"
                    cargaId={cargaId}
                    cpf={cpf}
                    accessToken={accessToken}
                    expectedVehicleType="cavalo"
                    onDraftPersisted={(storagePath) => {
                      setData((current) => ({ ...current, crlvStoragePath: storagePath }));
                    }}
                    draftPersisted={Boolean(initialData.crlvStoragePath)}
                    initialExtracted={
                      initialData.crlvStoragePath
                        ? buildCrlvInitialFromStepB(initialData)
                        : undefined
                    }
                  />

                  {horsePlateDuplicate.shouldWarn ? (
                    <DriverAlert
                      variant="warning"
                      title="Placa já cadastrada"
                      description="Essa placa de cavalo já tá cadastrada. Quer continuar com ela mesmo assim?"
                      primaryAction={{
                        label: "Continuar",
                        onClick: horsePlateDuplicate.dismiss,
                      }}
                      secondaryAction={{
                        label: "Usar a original",
                        onClick: () => {
                          revertHorsePlateToInitial();
                          horsePlateDuplicate.dismiss();
                        },
                      }}
                    />
                  ) : null}

                  {ownerDocValid && ownerIsDriver ? (
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
                </div>
              </WizardStepCard>
            ),
          },
          // 19/05 — sub-card "Detalhes do cavalo" (bc) NAO e mais renderizado
          // pra o motorista. Os dados continuam fluindo via OCR (mergeBcFromOcr
          // alimenta `bcData`) e sao emitidos no payload final pelo backend —
          // apenas a UI foi removida porque o motorista nao precisa revisar
          // esses campos manualmente.
          {
            id: "a4",
            isCompleted: a4Valid,
            render: ({ status, onActivate }) => (
              <WizardStepCard
                position={2}
                total={4}
                title="Tag de pedágio"
                description="Qual tag está instalada neste cavalo?"
                summary={a4Summary}
                status={status}
                onActivate={onActivate}
              >
                <A4Tag value={a4Data} onChange={setA4Data} onValid={setA4Valid} />
              </WizardStepCard>
            ),
          },
          {
            id: "a5",
            isCompleted: a5Valid,
            render: ({ status, onActivate }) => (
              <WizardStepCard
                position={3}
                total={4}
                title="Pancary Pleno"
                description="Você possui Pancary Pleno?"
                summary={a5Summary}
                status={status}
                onActivate={onActivate}
              >
                <A5Pancary value={a5Data} onChange={setA5Data} onValid={setA5Valid} />
              </WizardStepCard>
            ),
          },
          {
            id: "a6",
            isCompleted: a6Valid,
            render: ({ status, onActivate }) => (
              <WizardStepCard
                position={4}
                total={4}
                title="Rastreador"
                description="Você possui rastreador no veículo?"
                summary={a6Summary}
                status={status}
                onActivate={onActivate}
              >
                <A6Rastreador
                  value={a6Data}
                  onChange={setA6Data}
                  onValid={setA6Valid}
                />
              </WizardStepCard>
            ),
          },
        ]}
      />

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

export const StepBCavalo = memo(StepBCavaloImpl);
