import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Bloco do proprietario PJ do CRLV.
 *
 * Decisao 2026-05-18 — Lamonica paga o detentor do RNTRC (titular ANTT do
 * cavalo), nao o proprietario do CRLV. Por isso os campos bancarios (banco,
 * agencia, conta, tipo) FORAM REMOVIDOS deste formulario. Migraram para o
 * `AnttTitularPrompt` quando `kind === "cavalo"`.
 *
 * O proprietario PJ do CRLV mantem apenas identidade basica (doc + nome
 * coletados upstream). Inscricao estadual (IE) permanece em `CcInscricaoPropPJ`.
 *
 * Quando nao ha dados de reuso, este componente renderiza apenas um aviso
 * indicando que nao ha campos adicionais a coletar aqui (o card do banco foi
 * removido do stepper — Step C/E ajustados).
 */

export interface OwnerPJData {
  /**
   * Marcador residual — sem campos bancarios apos refatoracao 2026-05-18.
   * Mantido como objeto vazio (`{}`) para minimizar churn nas interfaces
   * que ja referenciam `OwnerPJData` em StepC/StepE/StepD.
   */
  _placeholder?: never;
}

export interface OwnerAttributionFormPJProps {
  value: OwnerPJData;
  onChange: (data: OwnerPJData) => void;
  /** CNPJ do proprietario (digits only) — usado para namespacing aria/id. */
  ownerDoc: string;
  /** Preencher campos a partir do OCR (razao social). */
  prefillFromOcr?: { razao_social?: string };
  /** Dados de outro owner PJ ja coletado nesta sessao. */
  prefilledFromCavaloOwner?: OwnerPJData;
  /** Contexto: usado para namespacing aria/id. */
  context: "cavalo" | "carreta";
}

export function buildEmptyOwnerPJData(): OwnerPJData {
  return {};
}

export function OwnerAttributionFormPJ({
  value,
  onChange,
  prefilledFromCavaloOwner,
}: OwnerAttributionFormPJProps) {
  const hasReusedData = Boolean(prefilledFromCavaloOwner);
  const [editingReuse, setEditingReuse] = useState<boolean>(!hasReusedData);

  useEffect(() => {
    if (hasReusedData && !editingReuse) {
      // Sem campos persistidos PJ apos refatoracao — simplesmente garante
      // que onChange seja chamado uma vez com o objeto reusado (vazio).
      onChange(prefilledFromCavaloOwner as OwnerPJData);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasReusedData, editingReuse]);

  // Evitar warning de unused var em CI strict.
  void value;
  const readOnly = hasReusedData && !editingReuse;

  return (
    <div className="space-y-3">
      {readOnly ? (
        <div className="admin-tint-info rounded-2xl border p-3.5 sm:p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-foreground sm:text-base">
                Dados reutilizados do proprietário já cadastrado nesta sessão.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Você pode revisar e editar se necessário.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEditingReuse(true)}
            >
              Editar
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Sem informações financeiras a coletar aqui. Os dados bancários ficam
          no titular ANTT do cavalo.
        </p>
      )}
    </div>
  );
}

/**
 * Apos refatoracao 2026-05-18, o owner PJ do CRLV nao possui mais campos
 * obrigatorios neste formulario (banco migrou para AnttTitularPrompt do cavalo).
 * Mantemos a funcao para o caller (`complementaryFulfilled`) — sempre retorna
 * true.
 */
export function isValidOwnerPJData(_data: OwnerPJData): boolean {
  return true;
}
