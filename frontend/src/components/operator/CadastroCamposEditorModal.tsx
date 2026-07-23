import { useMemo, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { onlyDigits } from "@/lib/brazilianValidators";

type Dados = Record<string, unknown>;
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/**
 * Editor de CAMPOS do cadastro (amigável) — corrige dados que vieram errados
 * (OCR ruim, CPF não informado, etc.) ANTES de aprovar. Edita motorista + CNH +
 * endereço + placas; preserva o resto do JSONB. Salva o `dados` mesclado via
 * onSave (patchCadastroDados no pai). Read-modify-write; nunca apaga chaves não
 * editadas aqui (documentos, owner, repom, nao_conformidade, etc. ficam intactos).
 */
export function CadastroCamposEditorModal({
  open,
  dados,
  onClose,
  onSave,
  isSaving,
}: {
  open: boolean;
  dados: Dados | null;
  onClose: () => void;
  onSave: (dados: Dados) => void;
  isSaving: boolean;
}) {
  const base = useMemo(() => asObj(dados), [dados]);
  const m0 = asObj(base.motorista);
  const cnh0 = asObj(m0.cnh);
  const end0 = asObj(m0.endereco);
  const cav0 = asObj(base.cavalo);
  const carretas0 = Array.isArray(base.carretas) ? (base.carretas as Dados[]) : [];

  const [f, setF] = useState(() => ({
    nome: str(m0.nome),
    cpf: str(m0.cpf),
    data_nascimento: str(m0.data_nascimento),
    telefone: str(Array.isArray(m0.telefones) ? (m0.telefones as unknown[])[0] : m0.telefone_primario),
    rg: str(m0.rg),
    rg_orgao: str(m0.rg_orgao),
    rg_uf: str(m0.rg_uf),
    nome_pai: str(m0.nome_pai),
    nome_mae: str(m0.nome_mae),
    naturalidade: str(m0.naturalidade),
    // CNH
    registro: str(cnh0.registro),
    categoria: str(cnh0.categoria),
    validade: str(cnh0.validade),
    primeira_emissao: str(cnh0.primeira_emissao),
    codigo_seguranca: str(cnh0.codigo_seguranca),
    numero_espelho: str(cnh0.numero_espelho),
    uf_emissor: str(cnh0.uf_emissor),
    // Endereço
    cep: str(end0.cep),
    logradouro: str(end0.logradouro),
    numero: str(end0.numero),
    bairro: str(end0.bairro),
    cidade: str(end0.cidade),
    uf: str(end0.uf),
    // Veículos
    cavaloPlaca: str(cav0.placa),
    carretaPlacas: carretas0.map((c) => str(c.placa)),
  }));

  const set = (k: keyof typeof f, v: string) => setF((cur) => ({ ...cur, [k]: v }));
  const setCarreta = (i: number, v: string) =>
    setF((cur) => ({ ...cur, carretaPlacas: cur.carretaPlacas.map((p, idx) => (idx === i ? v : p)) }));

  const handleSave = () => {
    // put(obj, key, value): grava trimmed se não-vazio; senão remove a chave.
    const put = (obj: Record<string, unknown>, k: string, v: string) => {
      const t = v.trim();
      if (t) obj[k] = t;
      else delete obj[k];
    };
    const next: Dados = { ...base };
    const motorista: Record<string, unknown> = { ...m0 };
    put(motorista, "nome", f.nome);
    motorista.cpf = onlyDigits(f.cpf); // CPF é chave — sempre dígitos
    put(motorista, "data_nascimento", f.data_nascimento);
    put(motorista, "rg", f.rg);
    put(motorista, "rg_orgao", f.rg_orgao);
    put(motorista, "rg_uf", f.rg_uf);
    put(motorista, "nome_pai", f.nome_pai);
    put(motorista, "nome_mae", f.nome_mae);
    put(motorista, "naturalidade", f.naturalidade);
    // Telefone → telefones[] + telefone_primario (contrato do submit/aprovação W-09).
    const tel = onlyDigits(f.telefone);
    if (tel) {
      motorista.telefones = [tel];
      motorista.telefone_primario = tel;
    }
    const cnh: Record<string, unknown> = { ...cnh0 };
    put(cnh, "registro", f.registro);
    put(cnh, "categoria", f.categoria);
    put(cnh, "validade", f.validade);
    put(cnh, "primeira_emissao", f.primeira_emissao);
    put(cnh, "codigo_seguranca", f.codigo_seguranca);
    put(cnh, "numero_espelho", f.numero_espelho);
    put(cnh, "uf_emissor", f.uf_emissor);
    if (Object.keys(cnh).length) motorista.cnh = cnh;
    const endereco: Record<string, unknown> = { ...end0 };
    put(endereco, "cep", f.cep);
    put(endereco, "logradouro", f.logradouro);
    put(endereco, "numero", f.numero);
    put(endereco, "bairro", f.bairro);
    put(endereco, "cidade", f.cidade);
    put(endereco, "uf", f.uf);
    if (Object.keys(endereco).length) motorista.endereco = endereco;
    next.motorista = motorista;

    if (base.cavalo && f.cavaloPlaca.trim()) {
      next.cavalo = { ...cav0, placa: f.cavaloPlaca.trim().toUpperCase() };
    }
    if (carretas0.length) {
      next.carretas = carretas0.map((c, i) => {
        const placa = f.carretaPlacas[i]?.trim().toUpperCase();
        return placa ? { ...c, placa } : c;
      });
    }
    onSave(next);
  };

  const field = (label: string, k: keyof typeof f, opts?: { upper?: boolean; mono?: boolean; placeholder?: string }) => (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input
        value={f[k] as string}
        onChange={(e) => set(k, opts?.upper ? e.target.value.toUpperCase() : e.target.value)}
        placeholder={opts?.placeholder}
        disabled={isSaving}
        className={opts?.mono ? "h-8 font-mono text-sm" : "h-8 text-sm"}
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto rounded-3xl">
        <DialogHeader>
          <DialogTitle>Editar dados do cadastro</DialogTitle>
          <DialogDescription>Corrija os campos que vieram errados. O que não estiver aqui (documentos, proprietário…) é preservado.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-primary/60">Motorista</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {field("Nome", "nome")}
              {field("CPF", "cpf", { mono: true, placeholder: "só números" })}
              {field("Data de nascimento", "data_nascimento", { placeholder: "DD/MM/AAAA" })}
              {field("Telefone (WhatsApp)", "telefone", { mono: true, placeholder: "DDD + número" })}
              {field("RG", "rg")}
              {field("Órgão emissor (RG)", "rg_orgao")}
              {field("UF do RG", "rg_uf", { upper: true })}
              {field("Naturalidade", "naturalidade")}
              {field("Nome do pai", "nome_pai")}
              {field("Nome da mãe", "nome_mae")}
            </div>
          </section>

          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-primary/60">CNH</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {field("Nº de registro", "registro", { mono: true })}
              {field("Categoria", "categoria", { upper: true })}
              {field("Validade", "validade", { placeholder: "AAAA-MM-DD" })}
              {field("1ª habilitação", "primeira_emissao", { placeholder: "AAAA-MM-DD" })}
              {field("Código de segurança", "codigo_seguranca", { mono: true })}
              {field("Nº do espelho", "numero_espelho", { mono: true })}
              {field("UF emissor", "uf_emissor", { upper: true })}
            </div>
          </section>

          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-primary/60">Endereço</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {field("CEP", "cep", { mono: true })}
              {field("Logradouro", "logradouro")}
              {field("Número", "numero")}
              {field("Bairro", "bairro")}
              {field("Cidade", "cidade")}
              {field("UF", "uf", { upper: true })}
            </div>
          </section>

          {(base.cavalo || carretas0.length > 0) && (
            <section className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-primary/60">Veículos</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {base.cavalo ? field("Placa do cavalo", "cavaloPlaca", { upper: true }) : null}
                {carretas0.map((_, i) => (
                  <div key={i} className="space-y-1">
                    <Label className="text-[11px] text-muted-foreground">Placa da carreta {i + 1}</Label>
                    <Input
                      value={f.carretaPlacas[i] ?? ""}
                      onChange={(e) => setCarreta(i, e.target.value.toUpperCase())}
                      disabled={isSaving}
                      className="h-8 text-sm"
                    />
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Salvar alterações
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
