import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UFS } from "@/lib/ufs";

/**
 * Sub-card de paridade com /cadastro — Detalhes extras do veiculo
 * (cavalo OU carreta — reusavel via prop `kind`). Todos os campos sao
 * OPCIONAIS no backend; consideramos o card "Concluido" quando ao menos
 * `tipo` estiver preenchido.
 *
 * 19/05 — removido `frota` (regime de frota): retirado da UI a pedido. O
 * card todo deixou de ser renderizado pelo wizard (CRLV vai apenas pro
 * backend), mas mantemos o componente exportado pra cobertura de drafts
 * legacy e testes.
 *
 * Quando usado em CARRETA, ocultamos o campo `modelo` (carretas nao tem
 * marca/modelo de motor — apenas tipo de carroceria).
 */

export interface BcData {
  modelo?: string;
  ano_fabricacao?: string;
  tipo?: string;
  carroceria?: string;
  uf_emplacamento?: string;
  cidade_emplacamento?: string;
  eixos?: string;
  ultimo_licenciamento?: string;
}

export interface BcDetalhesCavaloProps {
  kind: "cavalo" | "carreta";
  value?: BcData;
  onChange: (data: BcData) => void;
  onValid: (valid: boolean) => void;
  /**
   * Quando true, o sub-card foi populado a partir do OCR do CRLV — exibe
   * banner emerald de confirmacao visual ("Detalhes preenchidos pelo CRLV").
   * Caller deve zerar quando o motorista clica "Trocar arquivo".
   */
  prefilledByOcr?: boolean;
}

const EMPTY_DATA: BcData = {
  modelo: "",
  ano_fabricacao: "",
  tipo: "",
  carroceria: "",
  uf_emplacamento: "",
  cidade_emplacamento: "",
  eixos: "",
  ultimo_licenciamento: "",
};

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

export function BcDetalhesCavalo({
  kind,
  value,
  onChange,
  onValid,
  prefilledByOcr,
}: BcDetalhesCavaloProps) {
  const [data, setData] = useState<BcData>(value ?? EMPTY_DATA);

  // Bug 19/05: deps `[]` impedia hidratação quando o OCR do CRLV populava `value`
  // depois do mount. Agora reage a `value` mas com guard de igualdade pra não
  // entrar em loop com o `onChange` que o pai dispara a cada keystroke.
  useEffect(() => {
    if (!value) return;
    setData((current) => {
      const next = { ...current, ...value };
      const keys = Object.keys(next) as (keyof BcData)[];
      const same = keys.every((k) => next[k] === current[k]);
      return same ? current : next;
    });
  }, [value]);

  useEffect(() => {
    onChange(data);
    // Validacao reduzida (19/05): `frota` foi removido. Sub-card so renderiza
    // se o caller insistir; pela politica atual (CRLV invisivel ao motorista),
    // este componente nao e mais montado. Mantido como base pra `tipo`.
    onValid(Boolean(data.tipo));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const update = (patch: Partial<BcData>) => {
    setData((current) => ({ ...current, ...patch }));
  };

  const isCavalo = kind === "cavalo";
  const tipoPlaceholder = isCavalo
    ? "Ex.: Cavalo mecânico, Truck, Toco, Bitruck"
    : "Ex.: Carreta, Bitrem, Rodotrem";
  const carroceriaPlaceholder = "Ex.: Graneleira, Baú, Sider, Frigorífico";

  return (
    <section className="space-y-4" aria-labelledby={`step-${kind}-bc-title`}>
      <header className="space-y-1">
        <h3
          id={`step-${kind}-bc-title`}
          className="text-base font-semibold text-foreground"
        >
          Detalhes da {isCavalo ? "cavalo" : "carreta"}
        </h3>
        <p className="text-sm text-muted-foreground">
          Opcional — esses dados ajudam a equipe a operar a carga.
        </p>
      </header>

      {prefilledByOcr ? (
        <div
          className="flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-3 text-xs text-emerald-700"
          role="status"
          aria-live="polite"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Detalhes preenchidos pelo CRLV.</span>
        </div>
      ) : null}

      <div className="space-y-3">
        {isCavalo ? (
          <div className="space-y-1.5">
            <Label htmlFor={`bc-${kind}-modelo`}>Modelo</Label>
            <Input
              id={`bc-${kind}-modelo`}
              value={data.modelo ?? ""}
              onChange={(event) => update({ modelo: event.target.value })}
              placeholder="Ex.: Volvo FH 460"
            />
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`bc-${kind}-tipo`}>Tipo</Label>
            <Input
              id={`bc-${kind}-tipo`}
              value={data.tipo ?? ""}
              onChange={(event) => update({ tipo: event.target.value })}
              placeholder={tipoPlaceholder}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`bc-${kind}-carroceria`}>Carroceria</Label>
            <Input
              id={`bc-${kind}-carroceria`}
              value={data.carroceria ?? ""}
              onChange={(event) => update({ carroceria: event.target.value })}
              placeholder={carroceriaPlaceholder}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`bc-${kind}-ano-fabricacao`}>Ano de fabricação</Label>
            <Input
              id={`bc-${kind}-ano-fabricacao`}
              value={data.ano_fabricacao ?? ""}
              onChange={(event) =>
                update({ ano_fabricacao: onlyDigits(event.target.value).slice(0, 4) })
              }
              inputMode="numeric"
              placeholder="AAAA"
              maxLength={4}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`bc-${kind}-eixos`}>Eixos</Label>
            <Input
              id={`bc-${kind}-eixos`}
              value={data.eixos ?? ""}
              onChange={(event) =>
                update({ eixos: onlyDigits(event.target.value).slice(0, 1) })
              }
              inputMode="numeric"
              placeholder="2 a 9"
              maxLength={1}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_100px]">
          <div className="space-y-1.5">
            <Label htmlFor={`bc-${kind}-cidade-emplacamento`}>Cidade de emplacamento</Label>
            <Input
              id={`bc-${kind}-cidade-emplacamento`}
              value={data.cidade_emplacamento ?? ""}
              onChange={(event) =>
                update({ cidade_emplacamento: event.target.value })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`bc-${kind}-uf-emplacamento`}>UF</Label>
            <select
              id={`bc-${kind}-uf-emplacamento`}
              value={data.uf_emplacamento ?? ""}
              onChange={(event) => update({ uf_emplacamento: event.target.value })}
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

        <div className="space-y-1.5">
          <Label htmlFor={`bc-${kind}-ultimo-licenciamento`}>
            Último licenciamento
          </Label>
          <Input
            id={`bc-${kind}-ultimo-licenciamento`}
            type="date"
            value={data.ultimo_licenciamento ?? ""}
            onChange={(event) =>
              update({ ultimo_licenciamento: event.target.value })
            }
          />
        </div>
      </div>
    </section>
  );
}
