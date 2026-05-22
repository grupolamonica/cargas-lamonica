import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isValidBrazilianPhone } from "@/lib/brazilianValidators";
import { MoreOptionsToggle } from "@/components/driver/ui";

export interface A2Data {
  telefones: string[];
  telefone_primario: string;
}

export interface A2DriverProfile {
  phone: string;
}

export interface A2TelefoneProps {
  driverProfile: A2DriverProfile;
  value?: A2Data;
  onChange: (data: A2Data) => void;
  onValid: (valid: boolean) => void;
  /** Quando true, força expansão do telefone alternativo (toggle "Ver tudo" do StepA). */
  expandOptional?: boolean;
}

function formatPhone(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

/**
 * Sub-etapa A2 — Telefone.
 *
 * - Telefone primario pre-populado com driverProfile.phone (mascarado).
 * - Telefone secundario opcional.
 * - Validacao: primario obrigatorio + DDD valido; secundario opcional mas se preenchido precisa ser valido.
 */
export function A2Telefone({
  driverProfile,
  value,
  onChange,
  onValid,
  expandOptional,
}: A2TelefoneProps) {
  const initialPrimary = value?.telefone_primario || driverProfile.phone || "";
  const initialSecondary = value?.telefones?.[1] || "";

  const [primary, setPrimary] = useState(formatPhone(initialPrimary));
  const [secondary, setSecondary] = useState(formatPhone(initialSecondary));

  // Sync externo → state interno. Necessario pra hidratacao tardia do draft
  // (fluxo publico apos F5 — GET /draft/me?cpf=XXX resolve depois do mount).
  // Guard por digits evita loop com o effect onChange.
  useEffect(() => {
    if (!value) return;
    const primaryDigits = primary.replace(/\D/g, "");
    const secondaryDigits = secondary.replace(/\D/g, "");
    const valuePrimaryDigits = (value.telefone_primario || "").replace(/\D/g, "");
    const valueSecondaryDigits = (value.telefones?.[1] || "").replace(/\D/g, "");
    if (valuePrimaryDigits && valuePrimaryDigits !== primaryDigits) {
      setPrimary(formatPhone(valuePrimaryDigits));
    }
    if (valueSecondaryDigits !== secondaryDigits) {
      setSecondary(formatPhone(valueSecondaryDigits));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    const primaryDigits = primary.replace(/\D/g, "");
    const secondaryDigits = secondary.replace(/\D/g, "");
    const telefones = [primaryDigits];
    if (secondaryDigits) telefones.push(secondaryDigits);
    onChange({ telefones, telefone_primario: primaryDigits });

    const primaryValid = isValidBrazilianPhone(primaryDigits);
    const secondaryValid =
      secondaryDigits.length === 0 || isValidBrazilianPhone(secondaryDigits);
    onValid(primaryValid && secondaryValid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary, secondary]);

  const primaryDigits = primary.replace(/\D/g, "");
  const secondaryDigits = secondary.replace(/\D/g, "");
  const primaryError =
    primaryDigits.length > 0 && !isValidBrazilianPhone(primaryDigits)
      ? "Telefone inválido. Use DDD + número."
      : "";
  const secondaryError =
    secondaryDigits.length > 0 && !isValidBrazilianPhone(secondaryDigits)
      ? "Telefone inválido. Use DDD + número."
      : "";

  return (
    <section className="space-y-4" aria-labelledby="step-a2-title">
      <header className="space-y-1">
        <h3 id="step-a2-title" className="text-base font-semibold text-foreground">
          Seu telefone
        </h3>
        <p className="text-sm text-muted-foreground">
          Confirme o número que aparece para nossa equipe e adicione um alternativo se quiser.
        </p>
      </header>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="a2-primary">
            Telefone principal <span className="text-destructive">*</span>
          </Label>
          <Input
            id="a2-primary"
            type="tel"
            inputMode="tel"
            value={primary}
            onChange={(event) => setPrimary(formatPhone(event.target.value))}
            placeholder="(00) 00000-0000"
            autoComplete="tel"
            aria-invalid={Boolean(primaryError)}
            aria-describedby={primaryError ? "a2-primary-error" : undefined}
            required
          />
          {primaryError ? (
            <p id="a2-primary-error" className="text-xs text-destructive">
              {primaryError}
            </p>
          ) : null}
        </div>
        <MoreOptionsToggle
          label="Adicionar telefone alternativo"
          collapseLabel="Esconder telefone alternativo"
          defaultOpen={secondaryDigits.length > 0}
          forceOpen={expandOptional}
        >
          <div className="space-y-1.5">
            <Label htmlFor="a2-secondary">Telefone alternativo (opcional)</Label>
            <Input
              id="a2-secondary"
              type="tel"
              inputMode="tel"
              value={secondary}
              onChange={(event) => setSecondary(formatPhone(event.target.value))}
              placeholder="(00) 00000-0000"
              autoComplete="tel"
              aria-invalid={Boolean(secondaryError)}
              aria-describedby={
                secondaryError ? "a2-secondary-error" : undefined
              }
            />
            {secondaryError ? (
              <p id="a2-secondary-error" className="text-xs text-destructive">
                {secondaryError}
              </p>
            ) : null}
          </div>
        </MoreOptionsToggle>
      </div>
    </section>
  );
}
