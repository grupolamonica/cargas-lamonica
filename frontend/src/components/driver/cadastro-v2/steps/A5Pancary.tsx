import { useEffect, useState } from "react";

import { RadioCardGroup, type RadioCardOption } from "../widgets/RadioCardGroup";

export type A5PancaryValue = "sim" | "nao" | "desconhecido" | "";

export interface A5PancaryProps {
  value?: A5PancaryValue;
  onChange: (data: A5PancaryValue) => void;
  onValid: (valid: boolean) => void;
}

const PANCARY_OPTIONS: RadioCardOption[] = [
  { value: "sim", label: "Sim, possuo" },
  { value: "nao", label: "Não possuo" },
  { value: "desconhecido", label: "Não sei" },
];

/**
 * Sub-etapa A5 — Pancary Pleno.
 *
 * 2026-05-20: tornou-se obrigatório. Vem sem opção marcada e bloqueia o
 * Continuar até o motorista escolher uma das 3 opções (sim / não / não sei).
 */
export function A5Pancary({ value, onChange, onValid }: A5PancaryProps) {
  const [selected, setSelected] = useState<A5PancaryValue>(value ?? "");

  useEffect(() => {
    onChange(selected);
    onValid(selected !== "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  return (
    <section className="space-y-3" aria-labelledby="step-a5-title">
      <header className="space-y-1">
        <h3
          id="step-a5-title"
          className="text-base font-semibold text-foreground"
        >
          Você possui Pancary Pleno? <span className="text-destructive">*</span>
        </h3>
        <p className="text-sm text-muted-foreground">
          Selecione uma das opções para continuar.
        </p>
      </header>

      <RadioCardGroup
        name="a5-pancary"
        ariaLabel="Pancary Pleno"
        value={selected}
        onValueChange={(next) => setSelected(next as A5PancaryValue)}
        options={PANCARY_OPTIONS}
      />
    </section>
  );
}
