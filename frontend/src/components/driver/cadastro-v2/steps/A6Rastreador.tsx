import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoreOptionsToggle } from "@/components/driver/ui";

import { RadioCardGroup, type RadioCardOption } from "../widgets/RadioCardGroup";

export interface A6RastreadorDetails {
  empresa: string;
  login: string;
  senha: string;
  id_equipamento: string;
}

export interface A6Data {
  possui: "sim" | "nao" | "";
  rastreador?: A6RastreadorDetails;
}

export interface A6RastreadorProps {
  value?: A6Data;
  onChange: (data: A6Data) => void;
  onValid: (valid: boolean) => void;
  /** Quando true, força expansão de "ID do equipamento" (toggle StepA). */
  expandOptional?: boolean;
}

const POSSUI_OPTIONS: RadioCardOption[] = [
  { value: "sim", label: "Sim, possuo rastreador" },
  { value: "nao", label: "Não possuo" },
];

const EMPTY_DETAILS: A6RastreadorDetails = {
  empresa: "",
  login: "",
  senha: "",
  id_equipamento: "",
};

/**
 * Sub-etapa A6 — Rastreador.
 *
 * - Pergunta inicial: Sim / Nao.
 * - Se "Sim", revela 4 campos OBRIGATORIOS (empresa, login, senha, id_equipamento).
 * - Campo "senha" tem toggle Eye/EyeOff.
 * - "Nao" sempre valido (sem campos extras).
 */
export function A6Rastreador({
  value,
  onChange,
  onValid,
  expandOptional,
}: A6RastreadorProps) {
  const [possui, setPossui] = useState<A6Data["possui"]>(value?.possui ?? "");
  const [details, setDetails] = useState<A6RastreadorDetails>(
    value?.rastreador ?? EMPTY_DETAILS,
  );
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    const next: A6Data =
      possui === "sim" ? { possui, rastreador: details } : { possui };
    onChange(next);
    if (possui === "nao") {
      onValid(true);
    } else if (possui === "sim") {
      // ID do equipamento moveu para "Mais opções" (opcional). Mínimo viável:
      // empresa + login + senha.
      const allFilled =
        details.empresa.trim().length > 0 &&
        details.login.trim().length > 0 &&
        details.senha.trim().length > 0;
      onValid(allFilled);
    } else {
      onValid(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [possui, details]);

  const updateDetails = (patch: Partial<A6RastreadorDetails>) => {
    setDetails((current) => ({ ...current, ...patch }));
  };

  return (
    <section className="space-y-4" aria-labelledby="step-a6-title">
      <header className="space-y-1">
        <h3 id="step-a6-title" className="text-base font-semibold text-foreground">
          Você possui rastreador no seu veículo?
        </h3>
      </header>

      <RadioCardGroup
        name="a6-possui-rastreador"
        ariaLabel="Possui rastreador"
        value={possui}
        onValueChange={(next) => setPossui(next as A6Data["possui"])}
        options={POSSUI_OPTIONS}
      />

      {possui === "sim" ? (
        <div className="space-y-3 rounded-2xl border border-border bg-muted/30 p-4">
          <div className="space-y-1.5">
            <Label htmlFor="a6-empresa">
              Empresa do rastreador <span className="text-destructive">*</span>
            </Label>
            <Input
              id="a6-empresa"
              value={details.empresa}
              onChange={(event) => updateDetails({ empresa: event.target.value })}
              placeholder="Ex: Sascar, Onixsat, Autotrac"
              required
            />
            <p className="text-xs text-muted-foreground">Ex: Sascar, Onixsat, Autotrac</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a6-login">
              Login de acesso <span className="text-destructive">*</span>
            </Label>
            <Input
              id="a6-login"
              value={details.login}
              onChange={(event) => updateDetails({ login: event.target.value })}
              autoComplete="username"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="a6-senha">
              Senha de acesso <span className="text-destructive">*</span>
            </Label>
            <div className="relative">
              <Input
                id="a6-senha"
                type={showPassword ? "text" : "password"}
                value={details.senha}
                onChange={(event) => updateDetails({ senha: event.target.value })}
                autoComplete="current-password"
                className="pr-10"
                required
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setShowPassword((current) => !current)}
                className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2"
                aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Eye className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Apenas a equipe da Lamônica vê esta senha
            </p>
          </div>
          <MoreOptionsToggle
            label="Adicionar ID do equipamento (opcional)"
            collapseLabel="Esconder ID do equipamento"
            defaultOpen={details.id_equipamento.trim().length > 0}
            forceOpen={expandOptional}
          >
            <div className="space-y-1.5">
              <Label htmlFor="a6-id">ID do equipamento</Label>
              <Input
                id="a6-id"
                value={details.id_equipamento}
                onChange={(event) =>
                  updateDetails({ id_equipamento: event.target.value })
                }
              />
              <p className="text-xs text-muted-foreground">
                Geralmente no contrato ou app do rastreador
              </p>
            </div>
          </MoreOptionsToggle>
        </div>
      ) : null}
    </section>
  );
}
