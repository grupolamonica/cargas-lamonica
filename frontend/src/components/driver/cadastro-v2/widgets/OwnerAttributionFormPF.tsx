import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoreOptionsToggle } from "@/components/driver/ui";
import {
  isValidBrazilianPhone,
  onlyDigits,
} from "@/lib/brazilianValidators";
import { uploadDraftFile } from "@/services/cadastroApi";

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

export interface OwnerPFEndereco {
  cep: string;
  numero: string;
  comprovanteUrl?: string;
}

export interface OwnerPFData {
  telefone: string;
  cep: string;
  numero: string;
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
  /** Preencher campos a partir do OCR (nome lido). */
  prefillFromOcr?: { nome?: string };
  /** Dados de um owner ja coletado nesta sessao (cavalo ou outra carreta). */
  prefilledFromCavaloOwner?: OwnerPFData;
  /** Contexto: usado para namespacing aria/id. */
  context: "cavalo" | "carreta";
  /** Quando true, força expansão de "Dados de contato" (toggle StepC/E). */
  expandOptional?: boolean;
  /**
   * Quando true, o motorista tentou avançar com o form invalido. Usado para
   * sinalizar erros (auto-expand + badge) na seção progressive.
   */
  attemptedSubmit?: boolean;
  /**
   * Slot p/ persistência draft do comprovante opcional. Caller decide
   * (cavalo_owner_comprovante | carreta_owner_comprovante_{idx}). Quando
   * ausente, o comprovante segue best-effort apenas com fileName local.
   */
  comprovanteSlot?: string;
  cargaId?: string;
  cpf?: string;
  accessToken?: string | null;
  /**
   * Iter #7 — Callback invocado apos upload bem-sucedido do comprovante
   * (Supabase Storage). Wizard pode usar pra disparar `flushDraftImmediate`
   * e persistir o file path no draft sem aguardar o debounce.
   */
  onUploadComplete?: (storagePath: string) => void;
}

export function buildEmptyOwnerPFData(): OwnerPFData {
  return {
    telefone: "",
    cep: "",
    numero: "",
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
  expandOptional,
  attemptedSubmit = false,
  comprovanteSlot,
  cargaId,
  cpf,
  accessToken,
  onUploadComplete,
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

  // Inicializacao: prefilled from cavalo > driver pre-fill > value vazio
  useEffect(() => {
    if (hasReusedData && !editingReuse) {
      // garante que o valor reflita o reuso (mesmo se caller passou um value vazio)
      const reused = prefilledFromCavaloOwner as OwnerPFData;
      const isEqual =
        value.telefone === reused.telefone &&
        value.cep === reused.cep &&
        value.numero === reused.numero;
      if (!isEqual) {
        onChange(reused);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasReusedData, editingReuse]);

  // D-13 pre-fill (somente se nao for reuse e os campos ainda estiverem vazios)
  useEffect(() => {
    if (hasReusedData) return;
    if (!ownerEqualsDriver) return;
    const patch: Partial<OwnerPFData> = {};
    if (!value.telefone && driverProfile.phone) {
      patch.telefone = formatPhoneMask(driverProfile.phone);
    }
    if (!value.cep && driverProfile.endereco?.cep) {
      patch.cep = formatCepMask(driverProfile.endereco.cep);
    }
    if (!value.numero && driverProfile.endereco?.numero) {
      patch.numero = driverProfile.endereco.numero;
    }
    if (Object.keys(patch).length > 0) {
      onChange({ ...value, ...patch });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerEqualsDriver]);

  const readOnly = hasReusedData && !editingReuse;
  const idPrefix = `owner-pf-${context}`;

  const update = (patch: Partial<OwnerPFData>) => {
    onChange({ ...value, ...patch });
  };

  // Progressive disclosure: campos de contato atrás de toggle.
  // Default aberto se já existe algum valor preenchido (reuso/prefill) ou em modo readonly.
  const hasAdditionalData =
    Boolean(value.telefone) ||
    Boolean(value.cep) ||
    Boolean(value.numero) ||
    Boolean(value.comprovanteFileName);

  // Detectar campos OBRIGATORIOS pendentes dentro da seção progressive.
  // Alimenta o badge no toggle (colapsado) e força expansão quando o motorista
  // tenta clicar em Continuar com erros.
  const hiddenSectionInvalid = useMemo(() => {
    const invalid: string[] = [];
    if (!isValidBrazilianPhone(value.telefone)) invalid.push("telefone");
    if (onlyDigits(value.cep).length !== 8) invalid.push("cep");
    if (!value.numero.trim()) invalid.push("numero");
    // Iter #7: comprovante obrigatorio.
    if (!value.comprovanteFileName) invalid.push("comprovante");
    return invalid;
  }, [value.telefone, value.cep, value.numero, value.comprovanteFileName]);

  const hiddenErrorCount = hiddenSectionInvalid.length;
  const hasHiddenError =
    attemptedSubmit && hiddenErrorCount > 0 && !readOnly;

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

      <MoreOptionsToggle
        label="Contato do proprietário"
        collapseLabel="Esconder contato"
        defaultOpen={hasAdditionalData || readOnly}
        forceOpen={expandOptional || hasHiddenError}
        hasError={hasHiddenError}
        errorCount={hasHiddenError ? hiddenErrorCount : undefined}
      >
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-telefone`}>
            Telefone <span className="text-destructive">*</span>
          </Label>
          <Input
            id={`${idPrefix}-telefone`}
            inputMode="tel"
            value={value.telefone}
            onChange={(event) =>
              update({ telefone: formatPhoneMask(event.target.value) })
            }
            placeholder="(00) 00000-0000"
            aria-invalid={
              value.telefone.length > 0 &&
              !isValidBrazilianPhone(value.telefone)
            }
            disabled={readOnly}
            required
          />
          {value.telefone.length > 0 &&
          !isValidBrazilianPhone(value.telefone) ? (
            <p className="text-xs text-destructive">
              Telefone inválido. Confira o DDD e número.
            </p>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-cep`}>
              CEP <span className="text-destructive">*</span>
            </Label>
            <Input
              id={`${idPrefix}-cep`}
              inputMode="numeric"
              value={value.cep}
              onChange={(event) =>
                update({ cep: formatCepMask(event.target.value) })
              }
              placeholder="00000-000"
              disabled={readOnly}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-numero`}>
              Número <span className="text-destructive">*</span>
            </Label>
            <Input
              id={`${idPrefix}-numero`}
              inputMode="numeric"
              value={value.numero}
              onChange={(event) => update({ numero: event.target.value.trim() })}
              disabled={readOnly}
              required
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-comprovante`}>
            Comprovante de residência <span className="text-destructive">*</span> — foto ou arquivo
          </Label>
          <Input
            id={`${idPrefix}-comprovante`}
            type="file"
            accept="image/*,application/pdf"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              update({ comprovanteFileName: file.name });
              // Best-effort persistência draft. Falha silenciosa — apenas log
              // em DEV. Não bloqueia o submit (comprovante é opcional).
              if (comprovanteSlot && cargaId) {
                // Iter #7 — apos upload bem-sucedido, dispara onUploadComplete
                // pra que o wizard chame flushDraftImmediate e persista o
                // storage_path imediatamente (nao espera debounce 200ms).
                void uploadDraftFile(file, comprovanteSlot, cargaId, {
                  cpf,
                  accessToken,
                })
                  .then((result) => {
                    if (onUploadComplete && result?.storage_path) {
                      onUploadComplete(result.storage_path);
                    }
                  })
                  .catch((err) => {
                    if (import.meta.env.DEV) {
                      console.warn(
                        `[OwnerAttributionFormPF/${comprovanteSlot}] upload failed`,
                        err,
                      );
                    }
                    toast.message(
                      "Não conseguimos guardar esse arquivo agora — refaça depois se precisar.",
                    );
                  });
              }
            }}
            disabled={readOnly}
          />
          {value.comprovanteFileName ? (
            <p className="text-xs text-muted-foreground">
              Arquivo selecionado: {value.comprovanteFileName}
            </p>
          ) : null}
        </div>
      </MoreOptionsToggle>
    </div>
  );
}

/**
 * Helper: classifica campos do PF entre "missing" (vazio) e "invalid" (preenchido
 * mas com formato/checksum incorreto). Usado pelo banner de validação no step
 * pai para gerar mensagens específicas em vez do genérico "Faltam campos
 * obrigatórios" (BUG-WALK-03).
 */
export interface OwnerPFFieldIssues {
  missing: string[];
  invalid: string[];
}

const PF_FIELD_LABELS: Record<string, string> = {
  telefone: "Telefone",
  cep: "CEP",
  numero: "Número",
  comprovante: "Comprovante de residência",
};

export function describeOwnerPFFieldIssues(data: OwnerPFData): OwnerPFFieldIssues {
  const missing: string[] = [];
  const invalid: string[] = [];
  if (!data.telefone) missing.push(PF_FIELD_LABELS.telefone);
  else if (!isValidBrazilianPhone(data.telefone))
    invalid.push(PF_FIELD_LABELS.telefone);
  const cepDigits = onlyDigits(data.cep);
  if (cepDigits.length === 0) missing.push(PF_FIELD_LABELS.cep);
  else if (cepDigits.length !== 8) invalid.push(PF_FIELD_LABELS.cep);
  if (!data.numero.trim()) missing.push(PF_FIELD_LABELS.numero);
  // Iter #7: comprovante obrigatorio (PF cavalo + carreta).
  if (!data.comprovanteFileName) missing.push(PF_FIELD_LABELS.comprovante);
  return { missing, invalid };
}

/** Helper: determina se os dados do PF estão completos para habilitar Continuar. */
export function isValidOwnerPFData(data: OwnerPFData): boolean {
  return Boolean(
    isValidBrazilianPhone(data.telefone) &&
      onlyDigits(data.cep).length === 8 &&
      data.numero.trim().length > 0 &&
      // Iter #7: comprovante obrigatorio.
      data.comprovanteFileName,
  );
}
