import { memo, useState } from "react";

import { Button } from "@/components/ui/button";

import { StepHeader } from "../StepHeader";
import {
  AnttTitularPrompt,
  type AnttTitularData,
  type AnttTitularCascadeResult,
} from "../widgets/AnttTitularPrompt";
import { OwnerEnderecoComprovante, type OwnerEnderecoData } from "../widgets/OwnerEnderecoComprovante";
import { OwnerDocumentUploader } from "../widgets/OwnerDocumentUploader";

import type { StepEData } from "./StepECarretaOwner";

/**
 * Step E-ANTT — Proprietário ANTT da carreta corrente (2026-05-20).
 *
 * Equivalente ao StepCAnttCavalo mas para a carreta em flight (controle do
 * `currentTrailerIdx` no wizard). Slots de upload são indexados (0 ou 1) para
 * suportar até 2 carretas com titulares distintos.
 */

export interface StepEAnttCarretaProps {
  currentStep: number;
  totalSteps: number;
  trailerIdx: 0 | 1;
  value: StepEData;
  cascadeResult: AnttTitularCascadeResult | null | undefined;
  ownerDocFromCrlv: string;
  ownerNomeFromCrlv?: string;
  onChange?: (data: StepEData) => void;
  onComplete: (data: StepEData) => void;
  onBack: () => void;
  cargaId?: string;
  cpf?: string;
  accessToken?: string | null;
}

function StepEAnttCarretaImpl({
  currentStep,
  totalSteps,
  trailerIdx,
  value,
  cascadeResult,
  ownerDocFromCrlv,
  ownerNomeFromCrlv,
  onChange,
  onComplete,
  onBack,
  cargaId,
  cpf,
  accessToken,
}: StepEAnttCarretaProps) {
  const [anttTitular, setAnttTitular] = useState<AnttTitularData | null>(
    value.anttTitular ?? null,
  );
  const [anttOwnerDocPath, setAnttOwnerDocPath] = useState<string | undefined>(
    value.anttTitular?.anttOwnerDocStoragePath,
  );
  const [enderecoAnttOwner, setEnderecoAnttOwner] = useState<OwnerEnderecoData>(() => ({
    cep: value.anttTitular?.endereco?.cep ?? "",
    numero: value.anttTitular?.endereco?.numero ?? "",
    logradouro: value.anttTitular?.endereco?.logradouro ?? "",
    bairro: value.anttTitular?.endereco?.bairro ?? "",
    cidade: value.anttTitular?.endereco?.cidade ?? "",
    uf: value.anttTitular?.endereco?.uf ?? "",
    comprovanteUrl: value.anttTitular?.endereco?.comprovanteUrl,
    ocr_comprovante_fallback_manual:
      value.anttTitular?.endereco?.ocr_comprovante_fallback_manual,
  }));

  const docSlot = (trailerIdx === 1
    ? "carreta_antt_owner_cnh_1"
    : "carreta_antt_owner_cnh_0") as
    | "carreta_antt_owner_cnh_0"
    | "carreta_antt_owner_cnh_1";
  const compSlot = (trailerIdx === 1
    ? "carreta_antt_owner_comprovante_1"
    : "carreta_antt_owner_comprovante_0") as
    | "carreta_antt_owner_comprovante_0"
    | "carreta_antt_owner_comprovante_1";

  const mergeTitular = (updates: Partial<AnttTitularData>): AnttTitularData => {
    const base: AnttTitularData = anttTitular ?? {
      tipo: "pf",
      doc: ownerDocFromCrlv,
      nome: ownerNomeFromCrlv ?? "",
    };
    return { ...base, ...updates };
  };

  const buildPayload = (): StepEData => {
    const titularBase = anttTitular ?? mergeTitular({});
    const merged: AnttTitularData = {
      ...titularBase,
      anttOwnerDocStoragePath: anttOwnerDocPath,
      anttOwnerComprovanteStoragePath: enderecoAnttOwner.comprovanteUrl,
      endereco: {
        cep: enderecoAnttOwner.cep,
        numero: enderecoAnttOwner.numero,
        logradouro: enderecoAnttOwner.logradouro,
        bairro: enderecoAnttOwner.bairro,
        cidade: enderecoAnttOwner.cidade,
        uf: enderecoAnttOwner.uf,
        comprovanteUrl: enderecoAnttOwner.comprovanteUrl,
        ocr_comprovante_fallback_manual:
          enderecoAnttOwner.ocr_comprovante_fallback_manual,
      },
    };
    return { ...value, anttTitular: merged };
  };

  const canContinue =
    !!anttTitular &&
    anttTitular.doc.length >= 11 &&
    anttTitular.nome.trim().length > 0 &&
    !!enderecoAnttOwner.comprovanteUrl &&
    enderecoAnttOwner.cep.replace(/\D/g, "").length === 8 &&
    enderecoAnttOwner.numero.trim().length > 0 &&
    enderecoAnttOwner.cidade.trim().length > 0 &&
    enderecoAnttOwner.uf.trim().length > 0;

  const handleContinue = () => {
    if (!canContinue) return;
    onComplete(buildPayload());
  };

  return (
    <div className="space-y-6">
      <StepHeader
        eyebrow={`ETAPA ${currentStep} DE ${totalSteps}`}
        title={`Proprietário ANTT da carreta ${trailerIdx + 1}`}
        description="Quem detém o RNTRC desta carreta. Coletamos endereço e comprovante."
        currentStep={currentStep}
        totalSteps={totalSteps}
      />

      <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
        <h3 className="text-base font-semibold text-foreground">
          Identidade do titular ANTT
        </h3>
        <AnttTitularPrompt
          cascadeResult={cascadeResult ?? null}
          ownerDoc={ownerDocFromCrlv}
          ownerNome={ownerNomeFromCrlv}
          value={anttTitular}
          onChange={(next) => {
            setAnttTitular(next);
            if (onChange) {
              onChange({ ...value, anttTitular: next ?? undefined });
            }
          }}
          context={`carreta_${trailerIdx}`}
          kind="carreta"
        />
      </div>

      <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
        <h3 className="text-base font-semibold text-foreground">
          Documento do titular ANTT
        </h3>
        <p className="text-sm text-muted-foreground">
          {anttTitular?.tipo === "pj"
            ? "Envie o cartão CNPJ do titular do RNTRC."
            : "Envie a CNH do titular do RNTRC."}
        </p>
        <OwnerDocumentUploader
          key={`antt-doc-carreta-${trailerIdx}`}
          ownerDocType={anttTitular?.tipo === "pj" ? "cnpj" : "cpf"}
          expectedDocument={anttTitular?.doc.replace(/\D/g, "") ?? ""}
          onExtracted={() => {
            /* extras só ficam no widget */
          }}
          slot={docSlot}
          cargaId={cargaId}
          cpf={cpf}
          accessToken={accessToken}
          onDraftPersisted={(storagePath) => {
            setAnttOwnerDocPath(storagePath);
            if (onChange) {
              onChange({
                ...value,
                anttTitular: mergeTitular({
                  anttOwnerDocStoragePath: storagePath,
                }),
              });
            }
          }}
          draftPersisted={Boolean(anttOwnerDocPath)}
        />
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <OwnerEnderecoComprovante
          idPrefix={`step-e-antt-${trailerIdx}-owner-end`}
          slot={compSlot}
          title="Endereço do titular ANTT"
          description="Conta de luz/água/internet — últimos 3 meses."
          value={enderecoAnttOwner}
          onChange={(data) => {
            setEnderecoAnttOwner(data);
            if (onChange) {
              onChange({
                ...value,
                anttTitular: mergeTitular({
                  endereco: {
                    cep: data.cep,
                    numero: data.numero,
                    logradouro: data.logradouro,
                    bairro: data.bairro,
                    cidade: data.cidade,
                    uf: data.uf,
                    comprovanteUrl: data.comprovanteUrl,
                    ocr_comprovante_fallback_manual:
                      data.ocr_comprovante_fallback_manual,
                  },
                  anttOwnerComprovanteStoragePath: data.comprovanteUrl,
                }),
              });
            }
          }}
          cargaId={cargaId}
          cpf={cpf}
          accessToken={accessToken}
        />
      </div>

      <div className="flex flex-col-reverse items-stretch gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <Button type="button" variant="ghost" onClick={onBack} className="sm:w-auto">
          Voltar
        </Button>
        <Button
          type="button"
          variant="cta"
          onClick={handleContinue}
          aria-disabled={!canContinue}
          className="py-3.5 sm:w-auto sm:py-2.5"
        >
          Continuar
        </Button>
      </div>
    </div>
  );
}

export const StepEAnttCarreta = memo(StepEAnttCarretaImpl);
