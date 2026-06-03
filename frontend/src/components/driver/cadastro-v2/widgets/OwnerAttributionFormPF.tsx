import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  isValidBrazilianPhone,
  onlyDigits,
} from "@/lib/brazilianValidators";

/**
 * Formulario de identidade complementar do proprietario PF do CRLV.
 *
 * Decisao 2026-05-18 (refatoracao do escopo de pagamento):
 *   - Lamonica paga o detentor do RNTRC (titular ANTT do cavalo), nao o
 *     proprietario do CRLV. Por isso os campos financeiros (banco, agencia,
 *     conta, tipo) e sociais (PIS, cor/raca, estado civil) FORAM REMOVIDOS
 *     deste formulario. Migraram para o `AnttTitularPrompt` quando
 *     `kind === "cavalo" && tipo === "pf"`.
 *   - Este form fica responsavel apenas por identidade basica do owner CRLV:
 *     telefone, CEP, numero, comprovante (opcional). Reusado por Step C
 *     (cavalo) e Step E (carreta).
 */

/** @deprecated Mantido apenas para compat com drafts antigos persistidos. */
export interface OwnerPFEndereco {
  cep: string;
  numero: string;
  comprovanteUrl?: string;
}

export interface OwnerPFData {
  telefone: string;
  /**
   * @deprecated CEP, número e comprovante migraram para OwnerEnderecoComprovante.
   * Mantidos na interface apenas para leitura de drafts antigos.
   */
  cep?: string;
  numero?: string;
  comprovanteFileName?: string;
}

export interface OwnerAttributionFormPFDriverProfile {
  document_number: string;
  phone: string;
  endereco?: OwnerPFEndereco;
}

export interface OwnerAttributionFormPFProps {
  value: OwnerPFData;
  onChange: (data: OwnerPFData) => void;
  driverProfile: OwnerAttributionFormPFDriverProfile;
  /** Documento do proprietario (digits only) — usado para detectar driver==owner. */
  ownerDoc: string;
  /** Dados de um owner ja coletado nesta sessao (cavalo ou outra carreta). */
  prefilledFromCavaloOwner?: OwnerPFData;
  /** Contexto: usado para namespacing aria/id. */
  context: "cavalo" | "carreta";
  /** @deprecated Sem efeito — campo único não precisa de toggle. */
  expandOptional?: boolean;
  /** @deprecated Sem efeito — mantido para compat de callers existentes. */
  attemptedSubmit?: boolean;
}

export function buildEmptyOwnerPFData(): OwnerPFData {
  return {
    telefone: "",
  };
}

function formatPhoneMask(raw: string): string {
  const digits = onlyDigits(raw).slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

function formatCepMask(value: string): string {
  const digits = onlyDigits(value).slice(0, 8);
  if (digits.length <= 5) return digits;
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

/**
 * Formulario de dados complementares do proprietario PF, reutilizado por:
 *  - Step C (cavalo)
 *  - Step E (carreta)
 *
 * - D-13 bonus: se ownerDoc === driverProfile.document_number, pre-popula
 *   telefone/CEP/numero (CADASTRO-08).
 * - Reuse: se prefilledFromCavaloOwner for fornecido, congela campos como
 *   readonly e oferece botao "Editar" (CADASTRO-08).
 *
 * Caller deve calcular validade externamente via isValidOwnerPFData().
 */
export function OwnerAttributionFormPF({
  value,
  onChange,
  driverProfile,
  ownerDoc,
  prefilledFromCavaloOwner,
  context,
}: OwnerAttributionFormPFProps) {
  const ownerDocDigits = useMemo(() => onlyDigits(ownerDoc), [ownerDoc]);
  const driverCpfDigits = useMemo(
    () => onlyDigits(driverProfile.document_number),
    [driverProfile.document_number],
  );
  const ownerEqualsDriver =
    ownerDocDigits.length === 11 &&
    ownerDocDigits === driverCpfDigits &&
    driverCpfDigits.length === 11;

  const hasReusedData = Boolean(prefilledFromCavaloOwner);
  const [editingReuse, setEditingReuse] = useState<boolean>(!hasReusedData);

  // Pre-fill por reuso de owner já coletado nesta sessão.
  useEffect(() => {
    if (hasReusedData && !editingReuse) {
      const reused = prefilledFromCavaloOwner as OwnerPFData;
      if (value.telefone !== reused.telefone) {
        onChange(reused);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasReusedData, editingReuse]);

  // D-13 pre-fill: quando o motorista é o próprio proprietário, preenche telefone.
  useEffect(() => {
    if (hasReusedData) return;
    if (!ownerEqualsDriver) return;
    if (!value.telefone && driverProfile.phone) {
      onChange({ ...value, telefone: formatPhoneMask(driverProfile.phone) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerEqualsDriver]);

  const readOnly = hasReusedData && !editingReuse;
  const idPrefix = `owner-pf-${context}`;

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
      ) : null}

      {/* Contato: apenas telefone — endereço e comprovante ficam no card "Endereço do proprietário" */}
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-telefone`}>
          Telefone <span className="text-destructive">*</span>
        </Label>
        <Input
          id={`${idPrefix}-telefone`}
          inputMode="tel"
          value={value.telefone}
          onChange={(event) =>
            onChange({ ...value, telefone: formatPhoneMask(event.target.value) })
          }
          placeholder="(00) 00000-0000"
          aria-invalid={value.telefone.length > 0 && !isValidBrazilianPhone(value.telefone)}
          disabled={readOnly}
          required
          className="h-12"
        />
        {value.telefone.length > 0 && !isValidBrazilianPhone(value.telefone) ? (
          <p className="text-xs text-destructive">
            Telefone inválido. Confira o DDD e número.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Helper: classifica campos do PF entre "missing" e "invalid".
 * Após refactor 2026-06-03: apenas Telefone é coletado aqui.
 * CEP/número/comprovante migraram para OwnerEnderecoComprovante.
 */
export interface OwnerPFFieldIssues {
  missing: string[];
  invalid: string[];
}

export function describeOwnerPFFieldIssues(data: OwnerPFData): OwnerPFFieldIssues {
  const missing: string[] = [];
  const invalid: string[] = [];
  if (!data.telefone) missing.push("Telefone");
  else if (!isValidBrazilianPhone(data.telefone)) invalid.push("Telefone");
  return { missing, invalid };
}

/** Helper: determina se os dados do PF estão completos para habilitar Continuar. */
export function isValidOwnerPFData(data: OwnerPFData): boolean {
  return isValidBrazilianPhone(data.telefone);
}
