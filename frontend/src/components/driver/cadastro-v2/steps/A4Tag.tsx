import { useEffect, useState } from "react";

import { RadioCardGroup, type RadioCardOption } from "../widgets/RadioCardGroup";

export type A4TagValue =
  | "sem_parar"
  | "conectcar"
  | "move_mais"
  | "veloe"
  | "eixo_pass"
  | "nao_possuo"
  | "";

export interface A4TagProps {
  value?: A4TagValue;
  onChange: (data: A4TagValue) => void;
  onValid: (valid: boolean) => void;
}

const TAG_OPTIONS: RadioCardOption[] = [
  { value: "sem_parar", label: "Sem Parar" },
  { value: "conectcar", label: "ConectCar" },
  { value: "move_mais", label: "Move Mais" },
  { value: "veloe", label: "Veloe" },
  { value: "eixo_pass", label: "Eixo Pass" },
  { value: "nao_possuo", label: "Não possuo tag" },
];

/**
 * Sub-etapa A4 — Tag de pedagio (RadioCardGroup obrigatorio).
 */
export function A4Tag({ value, onChange, onValid }: A4TagProps) {
  const [selected, setSelected] = useState<A4TagValue>(value ?? "");

  useEffect(() => {
    onChange(selected);
    onValid(selected.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  return (
    <section className="space-y-3" aria-labelledby="step-a4-title">
      <header className="space-y-1">
        <h3 id="step-a4-title" className="text-base font-semibold text-foreground">
          Qual tag de pedágio você usa?
        </h3>
        <p className="text-sm text-muted-foreground">Selecione uma opção</p>
      </header>

      <RadioCardGroup
        name="a4-tag-pedagio"
        ariaLabel="Tag de pedagio"
        value={selected}
        onValueChange={(next) => setSelected(next as A4TagValue)}
        options={TAG_OPTIONS}
      />
    </section>
  );
}
