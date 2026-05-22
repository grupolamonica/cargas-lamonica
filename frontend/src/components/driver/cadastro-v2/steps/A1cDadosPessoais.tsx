import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UFS } from "@/lib/ufs";

/**
 * Sub-etapa A1c — Dados pessoais e RG (PLAN-CADASTRO-PARITY).
 *
 * Todos os campos sao OPCIONAIS — o motorista pode pular o card. Marcamos o
 * card como "Concluido" apenas quando ao menos `rg` foi preenchido (campo
 * central), permitindo summary informativo.
 */

export interface A1cData {
  nome_pai?: string;
  nome_mae?: string;
  naturalidade?: string;
  rg?: string;
  rg_orgao?: string;
  rg_uf?: string;
}

export interface A1cDadosPessoaisProps {
  value?: A1cData;
  onChange: (data: A1cData) => void;
  /** Considerado "valido" quando RG preenchido (campo central). */
  onValid: (valid: boolean) => void;
}

const EMPTY_DATA: A1cData = {
  nome_pai: "",
  nome_mae: "",
  naturalidade: "",
  rg: "",
  rg_orgao: "",
  rg_uf: "",
};

export function A1cDadosPessoais({ value, onChange, onValid }: A1cDadosPessoaisProps) {
  const [data, setData] = useState<A1cData>(value ?? EMPTY_DATA);

  useEffect(() => {
    if (value) setData((current) => ({ ...current, ...value }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onChange(data);
    // Considera concluido quando o RG foi preenchido (campo central).
    onValid(Boolean(data.rg && data.rg.trim().length > 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const update = (patch: Partial<A1cData>) => {
    setData((current) => ({ ...current, ...patch }));
  };

  return (
    <section className="space-y-4" aria-labelledby="step-a1c-title">
      <header className="space-y-1">
        <h3 id="step-a1c-title" className="text-base font-semibold text-foreground">
          Dados pessoais e RG
        </h3>
        <p className="text-sm text-muted-foreground">
          Opcional — preencha agora ou pule. Esses dados ajudam a equipe da
          Lamônica a validar seu cadastro.
        </p>
      </header>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="a1c-nome-pai">Nome do pai</Label>
          <Input
            id="a1c-nome-pai"
            value={data.nome_pai ?? ""}
            onChange={(event) => update({ nome_pai: event.target.value })}
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="a1c-nome-mae">Nome da mãe</Label>
          <Input
            id="a1c-nome-mae"
            value={data.nome_mae ?? ""}
            onChange={(event) => update({ nome_mae: event.target.value })}
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="a1c-naturalidade">Naturalidade</Label>
          <Input
            id="a1c-naturalidade"
            value={data.naturalidade ?? ""}
            onChange={(event) => update({ naturalidade: event.target.value })}
            placeholder="Cidade/UF de nascimento"
            autoComplete="off"
          />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_140px_100px]">
          <div className="space-y-1.5">
            <Label htmlFor="a1c-rg">RG</Label>
            <Input
              id="a1c-rg"
              value={data.rg ?? ""}
              onChange={(event) => update({ rg: event.target.value })}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a1c-rg-orgao">Órgão emissor</Label>
            <Input
              id="a1c-rg-orgao"
              value={data.rg_orgao ?? ""}
              onChange={(event) => update({ rg_orgao: event.target.value })}
              placeholder="SSP"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a1c-rg-uf">UF</Label>
            <select
              id="a1c-rg-uf"
              value={data.rg_uf ?? ""}
              onChange={(event) => update({ rg_uf: event.target.value })}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <option value="">--</option>
              {UFS.map((uf) => (
                <option key={uf.value} value={uf.value}>
                  {uf.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </section>
  );
}
