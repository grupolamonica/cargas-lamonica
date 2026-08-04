import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BrazilianBank } from "@/lib/brazilianBanks";
import { isValidPis, onlyDigits } from "@/lib/brazilianValidators";

import { BankSelector } from "../widgets/BankSelector";

// Reaproveitados de StepCAnttCavalo (mesmo vocabulário; o mapeamento p/ os
// códigos do Rodopar — ESTCIV 1..6, CORPEL BRANCO/NEGRO/PARDO — acontece no
// disparo, não aqui).
const ESTADO_CIVIL_OPTIONS = [
  { value: "solteiro", label: "Solteiro(a)" },
  { value: "casado", label: "Casado(a)" },
  { value: "divorciado", label: "Divorciado(a)" },
  { value: "viuvo", label: "Viúvo(a)" },
  { value: "separado", label: "Separado(a)" },
  { value: "uniao_estavel", label: "União estável" },
];

const COR_RACA_OPTIONS = [
  { value: "branca", label: "Branca" },
  { value: "preta", label: "Preta" },
  { value: "parda", label: "Parda" },
  { value: "amarela", label: "Amarela" },
  { value: "indigena", label: "Indígena" },
  { value: "prefere_nao_declarar", label: "Prefere não declarar" },
];

export interface A4Bank {
  bank: BrazilianBank | null;
  agencia: string;
  conta: string;
  tipo: "corrente" | "poupanca" | "";
}

export interface A4Data {
  sexo?: "masculino" | "feminino" | "";
  estado_civil?: string;
  cor_raca?: string;
  pis?: string;
  rg_data?: string; // YYYY-MM-DD (data de expedição do RG)
  banco?: A4Bank;
}

const EMPTY_BANK: A4Bank = { bank: null, agencia: "", conta: "", tipo: "" };

function emptyData(): A4Data {
  return { sexo: "", estado_civil: "", cor_raca: "", pis: "", rg_data: "", banco: { ...EMPTY_BANK } };
}

/** Todos os campos são obrigatórios (decisão: "obrigatórios já", fiel ao PRD). */
export function isA4Complete(d: A4Data | undefined): boolean {
  if (!d) return false;
  const bankOk = Boolean(
    d.banco?.bank && d.banco.agencia?.trim() && d.banco.conta?.trim() && d.banco.tipo,
  );
  return Boolean(
    d.sexo &&
      d.estado_civil &&
      d.cor_raca &&
      isValidPis(d.pis) &&
      d.rg_data &&
      bankOk,
  );
}

interface A4Props {
  value?: A4Data;
  onChange: (data: A4Data) => void;
  onValid: (valid: boolean) => void;
}

/**
 * Etapa A4 — dados complementares do MOTORISTA exigidos pelo cadastro
 * (Rodopar): sexo, estado civil, cor/raça, PIS, dados bancários e data de
 * expedição do RG. Só entrada manual (sem OCR/documento). Para o motorista
 * dono-operador, é o ÚNICO ponto que coleta PIS/estado civil/cor/banco (o passo
 * do titular do RNTRC é pulado quando ele é o dono) — sem entrada dupla.
 */
export function A4Complementares({ value, onChange, onValid }: A4Props) {
  const [data, setData] = useState<A4Data>(() => value ?? emptyData());

  // Emite validade inicial (draft restaurado já completo conta como válido).
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    onValid(isA4Complete(data));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hidratação tardia do draft: só re-sincroniza quando o `value` (ref) muda e
  // tem conteúdo significativo, evitando loop com o onChange abaixo.
  useEffect(() => {
    if (!value || value === data) return;
    if (
      isA4Complete(value) ||
      value.sexo ||
      value.estado_civil ||
      value.cor_raca ||
      value.pis ||
      value.rg_data ||
      value.banco?.bank
    ) {
      setData(value);
      onValid(isA4Complete(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function apply(next: A4Data) {
    setData(next);
    onChange(next);
    onValid(isA4Complete(next));
  }

  const banco = data.banco ?? EMPTY_BANK;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Precisamos destes dados para concluir seu cadastro (todos obrigatórios).
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="a4-sexo">Sexo</Label>
          <Select value={data.sexo || ""} onValueChange={(v) => apply({ ...data, sexo: v as A4Data["sexo"] })}>
            <SelectTrigger id="a4-sexo" className="h-12">
              <SelectValue placeholder="Selecione" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="masculino">Masculino</SelectItem>
              <SelectItem value="feminino">Feminino</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="a4-civil">Estado civil</Label>
          <Select value={data.estado_civil || ""} onValueChange={(v) => apply({ ...data, estado_civil: v })}>
            <SelectTrigger id="a4-civil" className="h-12">
              <SelectValue placeholder="Selecione" />
            </SelectTrigger>
            <SelectContent>
              {ESTADO_CIVIL_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="a4-raca">Cor / raça</Label>
          <Select value={data.cor_raca || ""} onValueChange={(v) => apply({ ...data, cor_raca: v })}>
            <SelectTrigger id="a4-raca" className="h-12">
              <SelectValue placeholder="Selecione" />
            </SelectTrigger>
            <SelectContent>
              {COR_RACA_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="a4-pis">PIS / PASEP</Label>
          <Input
            id="a4-pis"
            inputMode="numeric"
            value={data.pis || ""}
            onChange={(e) => apply({ ...data, pis: e.target.value.replace(/\D/g, "").slice(0, 11) })}
            className="h-12"
            placeholder="11 dígitos"
            maxLength={11}
            aria-invalid={onlyDigits(data.pis).length > 0 && !isValidPis(data.pis)}
          />
          {onlyDigits(data.pis).length > 0 && !isValidPis(data.pis) ? (
            <p className="text-xs text-destructive">
              PIS/PASEP inválido — confira os 11 dígitos.
            </p>
          ) : null}
        </div>

        <div className="space-y-1">
          <Label htmlFor="a4-rg-data">Data de expedição do RG</Label>
          <Input
            id="a4-rg-data"
            type="date"
            value={data.rg_data || ""}
            onChange={(e) => apply({ ...data, rg_data: e.target.value })}
            className="h-12"
          />
        </div>
      </div>

      {/* Dados bancários — conta que a Lamônica usa para pagar o frete. */}
      <div className="space-y-2 rounded-2xl border border-border bg-card p-4">
        <Label>Dados bancários</Label>
        <p className="text-xs text-muted-foreground">Conta para depósito do frete.</p>
        <BankSelector
          value={banco.bank}
          onChange={(bank) => apply({ ...data, banco: { ...banco, bank } })}
        />
        {banco.bank ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="a4-agencia">Agência</Label>
              <Input
                id="a4-agencia"
                value={banco.agencia}
                onChange={(e) => apply({ ...data, banco: { ...banco, agencia: e.target.value } })}
                className="h-12"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="a4-conta">Conta</Label>
              <Input
                id="a4-conta"
                value={banco.conta}
                onChange={(e) => apply({ ...data, banco: { ...banco, conta: e.target.value } })}
                className="h-12"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="a4-tipo">Tipo</Label>
              <Select
                value={banco.tipo || ""}
                onValueChange={(v) => apply({ ...data, banco: { ...banco, tipo: v as A4Bank["tipo"] } })}
              >
                <SelectTrigger id="a4-tipo" className="h-12">
                  <SelectValue placeholder="Tipo de conta" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="corrente">Conta corrente</SelectItem>
                  <SelectItem value="poupanca">Conta poupança</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : null}
      </div>

      {isA4Complete(data) ? (
        <p className="text-xs text-emerald-700 dark:text-emerald-300">✓ Dados complementares preenchidos.</p>
      ) : null}
    </div>
  );
}
