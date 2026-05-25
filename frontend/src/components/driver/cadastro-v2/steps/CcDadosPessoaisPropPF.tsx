import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UFS } from "@/lib/ufs";

/**
 * Sub-card "Dados pessoais e CNH do proprietario PF" — paridade com /cadastro.
 *
 * Reusado em StepC (proprietario do cavalo) e StepE (proprietario da carreta).
 * Todos os campos sao OPCIONAIS no backend. Marcamos como "Concluido" quando
 * `rg` OU `cnh.registro` estiverem preenchidos (campos centrais).
 */

export interface CcPropPFCnh {
  registro?: string;
  categoria?: string;
  validade?: string;
  codigo_seguranca?: string;
  numero_espelho?: string;
  uf_emissor?: string;
  primeira_emissao?: string;
}

export interface CcPropPFData {
  nome_pai?: string;
  nome_mae?: string;
  naturalidade?: string;
  rg?: string;
  rg_orgao?: string;
  rg_uf?: string;
  situacao_cnh?: string;
  tem_cnh?: boolean;
  cnh?: CcPropPFCnh;
}

export interface CcDadosPessoaisPropPFProps {
  value?: CcPropPFData;
  onChange: (data: CcPropPFData) => void;
  onValid: (valid: boolean) => void;
}

const EMPTY_DATA: CcPropPFData = {
  nome_pai: "",
  nome_mae: "",
  naturalidade: "",
  rg: "",
  rg_orgao: "",
  rg_uf: "",
  situacao_cnh: "",
  tem_cnh: true,
  cnh: {
    registro: "",
    categoria: "",
    validade: "",
    codigo_seguranca: "",
    numero_espelho: "",
    uf_emissor: "",
    primeira_emissao: "",
  },
};

export function CcDadosPessoaisPropPF({
  value,
  onChange,
  onValid,
}: CcDadosPessoaisPropPFProps) {
  const [data, setData] = useState<CcPropPFData>(value ?? EMPTY_DATA);

  useEffect(() => {
    if (value) setData((current) => ({ ...current, ...value }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onChange(data);
    const hasRg = Boolean(data.rg && data.rg.trim().length > 0);
    const hasCnhRegistro = Boolean(
      data.cnh?.registro && data.cnh.registro.trim().length > 0,
    );
    onValid(hasRg || hasCnhRegistro);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const update = (patch: Partial<CcPropPFData>) => {
    setData((current) => ({ ...current, ...patch }));
  };

  const updateCnh = (patch: Partial<CcPropPFCnh>) => {
    setData((current) => ({
      ...current,
      cnh: { ...(current.cnh ?? {}), ...patch },
    }));
  };

  return (
    <section className="space-y-4" aria-labelledby="cc-propPF-title">
      <header className="space-y-1">
        <h3 id="cc-propPF-title" className="text-base font-semibold text-foreground">
          Dados pessoais e CNH do proprietário
        </h3>
        <p className="text-sm text-muted-foreground">
          Opcional — filiação, RG e dados da CNH do proprietário PF.
        </p>
      </header>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="cc-pf-nome-pai">Nome do pai</Label>
          <Input
            id="cc-pf-nome-pai"
            value={data.nome_pai ?? ""}
            onChange={(event) => update({ nome_pai: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cc-pf-nome-mae">Nome da mãe</Label>
          <Input
            id="cc-pf-nome-mae"
            value={data.nome_mae ?? ""}
            onChange={(event) => update({ nome_mae: event.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cc-pf-naturalidade">Naturalidade</Label>
          <Input
            id="cc-pf-naturalidade"
            value={data.naturalidade ?? ""}
            onChange={(event) => update({ naturalidade: event.target.value })}
            placeholder="Cidade/UF de nascimento"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_140px_100px]">
          <div className="space-y-1.5">
            <Label htmlFor="cc-pf-rg">RG</Label>
            <Input
              id="cc-pf-rg"
              value={data.rg ?? ""}
              onChange={(event) => update({ rg: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cc-pf-rg-orgao">Órgão emissor</Label>
            <Input
              id="cc-pf-rg-orgao"
              value={data.rg_orgao ?? ""}
              onChange={(event) => update({ rg_orgao: event.target.value })}
              placeholder="SSP"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cc-pf-rg-uf">UF</Label>
            <select
              id="cc-pf-rg-uf"
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

        <fieldset className="space-y-2 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">
            CNH do proprietário <span className="text-destructive">*</span>
          </legend>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={data.tem_cnh ?? true}
              onChange={(event) =>
                update({ tem_cnh: event.target.checked })
              }
            />
            <span>Possui CNH</span>
          </label>

          {data.tem_cnh === false ? (
            <div className="space-y-1.5">
              <Label htmlFor="cc-pf-situacao-cnh">Situação da CNH</Label>
              <Input
                id="cc-pf-situacao-cnh"
                value={data.situacao_cnh ?? ""}
                onChange={(event) => update({ situacao_cnh: event.target.value })}
                placeholder="Ex.: Suspensa, cassada, em renovação"
              />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="cc-pf-cnh-registro">Número de registro</Label>
                  <Input
                    id="cc-pf-cnh-registro"
                    value={data.cnh?.registro ?? ""}
                    onChange={(event) =>
                      updateCnh({ registro: event.target.value })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cc-pf-cnh-categoria">Categoria</Label>
                  <Input
                    id="cc-pf-cnh-categoria"
                    value={data.cnh?.categoria ?? ""}
                    onChange={(event) =>
                      updateCnh({ categoria: event.target.value })
                    }
                    placeholder="AB, AE, D, E…"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="cc-pf-cnh-validade">Validade</Label>
                  <Input
                    id="cc-pf-cnh-validade"
                    type="date"
                    value={data.cnh?.validade ?? ""}
                    onChange={(event) =>
                      updateCnh({ validade: event.target.value })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cc-pf-cnh-primeira">Primeira emissão</Label>
                  <Input
                    id="cc-pf-cnh-primeira"
                    type="date"
                    value={data.cnh?.primeira_emissao ?? ""}
                    onChange={(event) =>
                      updateCnh({ primeira_emissao: event.target.value })
                    }
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_100px]">
                <div className="space-y-1.5">
                  <Label htmlFor="cc-pf-cnh-codseg">Código de segurança</Label>
                  <Input
                    id="cc-pf-cnh-codseg"
                    value={data.cnh?.codigo_seguranca ?? ""}
                    onChange={(event) =>
                      updateCnh({ codigo_seguranca: event.target.value })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cc-pf-cnh-espelho">Número do espelho</Label>
                  <Input
                    id="cc-pf-cnh-espelho"
                    value={data.cnh?.numero_espelho ?? ""}
                    onChange={(event) =>
                      updateCnh({ numero_espelho: event.target.value })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cc-pf-cnh-uf-emissor">UF emissor</Label>
                  <select
                    id="cc-pf-cnh-uf-emissor"
                    value={data.cnh?.uf_emissor ?? ""}
                    onChange={(event) =>
                      updateCnh({ uf_emissor: event.target.value })
                    }
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
          )}
        </fieldset>
      </div>
    </section>
  );
}
