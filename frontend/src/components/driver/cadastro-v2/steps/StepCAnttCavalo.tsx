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

import type { StepCData } from "./StepCProprietarioCavalo";

/**
 * Step C-ANTT — Proprietário ANTT do cavalo (2026-05-20).
 *
 * Promovido a etapa top-level pra dar visibilidade ao motorista: o detentor do
 * RNTRC (Registro Nacional de Transportadores Rodoviários de Cargas) pode ser
 * outra pessoa que não o dono do CRLV — e é ele quem a Lamonica paga. Esta
 * etapa coleta:
 *   1) Identidade do titular ANTT (`AnttTitularPrompt`, já existente).
 *   2) Upload da CNH PF ou cartão CNPJ do titular (slot `cavalo_antt_owner_cnh`).
 *   3) Endereço com comprovante de residência (`OwnerEnderecoComprovante`,
 *      slot `cavalo_antt_owner_comprovante`).
 *
 * Quando o cascade detectou que o titular == owner do CRLV, o widget
 * `AnttTitularPrompt` pré-popula tudo e o motorista só confirma; ainda assim
 * recomendamos coletar o endereço/comprovante separado por completude.
 */

export interface StepCAnttCavaloProps {
  currentStep: number;
  totalSteps: number;
  /** Dados atuais do Step C (anttTitular + endereço ANTT + storage paths). */
  value: StepCData;
  cascadeResult: AnttTitularCascadeResult | null | undefined;
  /** CPF/CNPJ do proprietário do CRLV — pra detectar cenário "mesmo titular". */
  ownerDocFromCrlv: string;
  /** Nome do proprietário do CRLV. */
  ownerNomeFromCrlv?: string;
  onChange?: (data: StepCData) => void;
  onComplete: (data: StepCData) => void;
  onBack: () => void;
  cargaId?: string;
  cpf?: string;
  accessToken?: string | null;
}

function StepCAnttCavaloImpl({
  currentStep,
  totalSteps,
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
}: StepCAnttCavaloProps) {
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

  const mergeTitular = (updates: Partial<AnttTitularData>): AnttTitularData => {
    const base: AnttTitularData = anttTitular ?? {
      tipo: "pf",
      doc: ownerDocFromCrlv,
      nome: ownerNomeFromCrlv ?? "",
    };
    return { ...base, ...updates };
  };

  const buildPayload = (): StepCData => {
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

  // 2026-05-26 — Comprovante só obrigatório p/ titular ANTT PF. PJ usa o
  // endereço do cartão CNPJ (Infosimples), sem conta de luz.
  const anttIsPJ = anttTitular?.tipo === "pj";
  const canContinue =
    !!anttTitular &&
    anttTitular.doc.length >= 11 &&
    anttTitular.nome.trim().length > 0 &&
    (anttIsPJ ? true : !!enderecoAnttOwner.comprovanteUrl) &&
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
        title="Proprietário ANTT do cavalo"
        description="Quem detém o RNTRC do cavalo. Pode ser o mesmo dono do CRLV ou outra pessoa — é quem a Lamônica paga."
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
          context="cavalo"
          kind="cavalo"
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
          key={`antt-doc-cavalo`}
          ownerDocType={anttTitular?.tipo === "pj" ? "cnpj" : "cpf"}
          expectedDocument={anttTitular?.doc.replace(/\D/g, "") ?? ""}
          onExtracted={(extracted) => {
            // 2026-05-26 — PJ: prefill endereço do titular ANTT a partir do
            // cartão CNPJ (Infosimples), pra não exigir comprovante.
            if (anttTitular?.tipo === "pj" && extracted.raw) {
              const raw = extracted.raw as Record<string, unknown>;
              const str = (k: string) => {
                const v = raw[k];
                return v != null ? String(v).trim() : "";
              };
              const cep = str("cep");
              const cidade = str("cidade") || str("municipio");
              const uf = str("uf");
              if (cep || cidade || uf) {
                setEnderecoAnttOwner((current) => {
                  if (current.comprovanteUrl) return current;
                  return {
                    cep: cep || current.cep,
                    numero: str("numero") || current.numero,
                    logradouro: str("logradouro") || str("endereco") || current.logradouro,
                    bairro: str("bairro") || current.bairro,
                    cidade: cidade || current.cidade,
                    uf: uf || current.uf,
                    comprovanteUrl: current.comprovanteUrl,
                  };
                });
              }
            }
          }}
          slot="cavalo_antt_owner_cnh"
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
          idPrefix="step-c-antt-owner-end"
          slot="cavalo_antt_owner_comprovante"
          title="Endereço do titular ANTT"
          description="Conta de luz/água/internet — últimos 3 meses."
          requireComprovante={!anttIsPJ}
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

export const StepCAnttCavalo = memo(StepCAnttCavaloImpl);
