/**
 * CadastroRapidoModal — modal para o operador criar uma conta de motorista
 * sem passar pelo wizard público. Pede CPF, nome e telefone (mínimo obrigatório).
 * Placa do cavalo é opcional para já associar o perfil ao tipo "cavalo".
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, UserRound, X } from "lucide-react";
import { toast } from "sonner";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cadastrarMotoristaRapido } from "@/services/readModels";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Invalidar queries de motoristas após criação */
  onSuccess?: (driverId: string, nome: string) => void;
};

function formatCpf(value: string) {
  const d = value.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function formatTelefone(value: string) {
  const d = value.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

function validateCpf(cpf: string) {
  const d = cpf.replace(/\D/g, "");
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(d[i]) * (10 - i);
  let r = (sum * 10) % 11;
  if (r === 10 || r === 11) r = 0;
  if (r !== parseInt(d[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(d[i]) * (11 - i);
  r = (sum * 10) % 11;
  if (r === 10 || r === 11) r = 0;
  return r === parseInt(d[10]);
}

export default function CadastroRapidoModal({ open, onOpenChange, onSuccess }: Props) {
  const queryClient = useQueryClient();
  const nomeRef = useRef<HTMLInputElement>(null);

  const [cpf, setCpf] = useState("");
  const [nome, setNome] = useState("");
  const [telefone, setTelefone] = useState("");
  const [placaCavalo, setPlacaCavalo] = useState("");
  const [created, setCreated] = useState<{ driverId: string; nome: string; email: string } | null>(null);

  // Limpa ao fechar
  useEffect(() => {
    if (!open) {
      setTimeout(() => {
        setCpf(""); setNome(""); setTelefone(""); setPlacaCavalo(""); setCreated(null);
      }, 300);
    }
  }, [open]);

  const cpfDigits = cpf.replace(/\D/g, "");
  const cpfValid = validateCpf(cpf);
  const cpfError = cpfDigits.length === 11 && !cpfValid ? "CPF inválido." : "";
  const nomeValid = nome.trim().length >= 3;
  const canSubmit = cpfValid && nomeValid;

  const mutation = useMutation({
    mutationFn: () =>
      cadastrarMotoristaRapido({
        cpf: cpfDigits,
        nome: nome.trim(),
        telefone: telefone.replace(/\D/g, "") || undefined,
        placa_cavalo: placaCavalo.trim().toUpperCase() || undefined,
      }),
    onSuccess: (result) => {
      setCreated({ driverId: result.driverId, nome: result.nome, email: result.email });
      toast.success(`Motorista ${result.nome} cadastrado com sucesso.`);
      queryClient.invalidateQueries({ queryKey: ["operator-drivers"] });
      onSuccess?.(result.driverId, result.nome);
    },
    onError: (err: Error) => {
      toast.error(err.message || "Falha ao cadastrar motorista.");
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserRound className="h-5 w-5 text-primary" />
            Cadastrar motorista
          </DialogTitle>
        </DialogHeader>

        {created ? (
          /* Tela de sucesso */
          <div className="space-y-4 py-2">
            <div className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div>
                <p className="font-semibold text-emerald-900">{created.nome}</p>
                <p className="text-sm text-emerald-700">Conta criada com sucesso.</p>
                <p className="mt-1 text-[11px] text-emerald-600">
                  Login: <span className="font-mono">{created.email}</span>
                </p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              O motorista pode acessar o portal com o CPF e a senha que será definida no primeiro acesso.
              Para cadastrar no Angellira/SPX, localize-o na aba <strong>Pendentes</strong> ou <strong>Motoristas</strong>.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setCpf(""); setNome(""); setTelefone(""); setPlacaCavalo(""); setCreated(null); }}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                Cadastrar outro
              </button>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Fechar
              </button>
            </div>
          </div>
        ) : (
          /* Formulário */
          <form
            onSubmit={(e) => { e.preventDefault(); if (canSubmit) mutation.mutate(); }}
            className="space-y-4 py-1"
          >
            {/* CPF */}
            <div className="space-y-1.5">
              <Label htmlFor="cad-cpf">
                CPF <span className="text-destructive">*</span>
              </Label>
              <Input
                id="cad-cpf"
                inputMode="numeric"
                placeholder="000.000.000-00"
                value={cpf}
                onChange={(e) => setCpf(formatCpf(e.target.value))}
                aria-invalid={!!cpfError}
                autoFocus
              />
              {cpfError ? <p className="text-xs text-destructive">{cpfError}</p> : null}
            </div>

            {/* Nome */}
            <div className="space-y-1.5">
              <Label htmlFor="cad-nome">
                Nome completo <span className="text-destructive">*</span>
              </Label>
              <Input
                id="cad-nome"
                ref={nomeRef}
                placeholder="Nome do motorista"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                autoComplete="name"
              />
            </div>

            {/* Telefone */}
            <div className="space-y-1.5">
              <Label htmlFor="cad-tel">Telefone</Label>
              <Input
                id="cad-tel"
                type="tel"
                inputMode="tel"
                placeholder="(00) 00000-0000"
                value={telefone}
                onChange={(e) => setTelefone(formatTelefone(e.target.value))}
              />
            </div>

            {/* Placa cavalo (opcional) */}
            <div className="space-y-1.5">
              <Label htmlFor="cad-placa">Placa do cavalo <span className="text-[11px] text-muted-foreground">(opcional)</span></Label>
              <Input
                id="cad-placa"
                placeholder="ABC1D23"
                value={placaCavalo}
                onChange={(e) => setPlacaCavalo(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 7))}
                className="font-mono"
              />
            </div>

            <p className="text-[11px] text-muted-foreground">
              Será criada uma conta de acesso ao portal do motorista. Para enviar ao Angellira ou SPX, use o painel de Cadastro Externo após criar.
            </p>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={!canSubmit || mutation.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
              >
                {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserRound className="h-4 w-4" />}
                {mutation.isPending ? "Cadastrando…" : "Cadastrar"}
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
