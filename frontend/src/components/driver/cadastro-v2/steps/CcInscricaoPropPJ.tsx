import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Sub-card "Inscrição estadual do proprietario PJ" — paridade com /cadastro.
 *
 * Renderizado apenas quando `ownerDocType === "cnpj"`. Reusado em StepC e
 * StepE. Campos opcionais; marcamos como "Concluido" quando
 * `inscricao_estadual` foi preenchida OU `isento_ie` esta marcado.
 */

export interface CcPropPJData {
  inscricao_estadual?: string;
  isento_ie?: boolean;
}

export interface CcInscricaoPropPJProps {
  value?: CcPropPJData;
  onChange: (data: CcPropPJData) => void;
  onValid: (valid: boolean) => void;
}

const EMPTY_DATA: CcPropPJData = {
  inscricao_estadual: "",
  isento_ie: false,
};

export function CcInscricaoPropPJ({
  value,
  onChange,
  onValid,
}: CcInscricaoPropPJProps) {
  const [data, setData] = useState<CcPropPJData>(value ?? EMPTY_DATA);

  useEffect(() => {
    if (value) setData((current) => ({ ...current, ...value }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onChange(data);
    const hasIe = Boolean(
      data.inscricao_estadual && data.inscricao_estadual.trim().length > 0,
    );
    onValid(hasIe || Boolean(data.isento_ie));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const update = (patch: Partial<CcPropPJData>) => {
    setData((current) => ({ ...current, ...patch }));
  };

  return (
    <section className="space-y-4" aria-labelledby="cc-propPJ-title">
      <header className="space-y-1">
        <h3 id="cc-propPJ-title" className="text-base font-semibold text-foreground">
          Inscrição estadual da empresa
        </h3>
        <p className="text-sm text-muted-foreground">
          Opcional — informe a inscrição estadual da empresa, ou marque
          “Isento” quando aplicável.
        </p>
      </header>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="cc-pj-ie">Inscrição estadual</Label>
          <Input
            id="cc-pj-ie"
            value={data.inscricao_estadual ?? ""}
            onChange={(event) =>
              update({ inscricao_estadual: event.target.value })
            }
            disabled={Boolean(data.isento_ie)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={Boolean(data.isento_ie)}
            onChange={(event) => {
              const isento = event.target.checked;
              update({
                isento_ie: isento,
                ...(isento ? { inscricao_estadual: "" } : {}),
              });
            }}
          />
          <span>Empresa isenta de inscrição estadual</span>
        </label>
      </div>
    </section>
  );
}
