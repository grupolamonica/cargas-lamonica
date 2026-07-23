import { useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, Loader2, Truck } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  isValidCpf,
  isValidPlate,
  normalizePlateValue,
  onlyDigits,
} from "@/lib/brazilianValidators";
import {
  requestCandidaturaPreCheck,
  type PreCheckResponse,
} from "@/api/candidaturaApi";

export interface StandaloneCadastroProceedArgs {
  cpf: string;
  phone: string;
  horsePlate: string;
  trailerPlates: string[];
  preCheckResponse: PreCheckResponse;
}

interface StandaloneCadastroDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Disparado quando o pre-check encontra pendências — entrega CPF + placas +
   * resposta para o DriverPortal abrir o DriverRegistrationWizard SEM carga.
   */
  onProceed: (args: StandaloneCadastroProceedArgs) => void;
}

/**
 * Entrada do cadastro avulso (sem carga). Acionada pelo botão "Cadastro" do
 * /motorista. Coleta CPF + placa do cavalo + até 2 carretas, roda o pre-check
 * público (mesmo do fluxo de candidatura) e, havendo pendências, abre o wizard
 * completo. Quando o motorista já está em dia, informa em vez de abrir o wizard.
 *
 * O wizard exige as placas adiantado (Step D processa lista fixa de carretas),
 * por isso esta mini-tela existe — é "como começar uma candidatura nova", só que
 * sem carga associada (submit persiste carga_id=NULL).
 */
export function StandaloneCadastroDialog({
  open,
  onOpenChange,
  onProceed,
}: StandaloneCadastroDialogProps) {
  const [cpf, setCpf] = useState("");
  const [phone, setPhone] = useState("");
  const [horsePlate, setHorsePlate] = useState("");
  const [trailer1, setTrailer1] = useState("");
  const [trailer2, setTrailer2] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyOk, setAlreadyOk] = useState(false);

  const resetState = () => {
    setCpf("");
    setPhone("");
    setHorsePlate("");
    setTrailer1("");
    setTrailer2("");
    setLoading(false);
    setError(null);
    setAlreadyOk(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) resetState();
    onOpenChange(next);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const cpfDigits = onlyDigits(cpf);
    if (!isValidCpf(cpfDigits)) {
      setError("CPF inválido. Confira os 11 dígitos.");
      return;
    }

    const phoneDigits = onlyDigits(phone);
    if (phoneDigits.length < 10 || phoneDigits.length > 11) {
      setError("Telefone inválido. Informe o DDD + número (ex.: (71) 99999-8888).");
      return;
    }

    const horse = normalizePlateValue(horsePlate);
    if (!isValidPlate(horse)) {
      setError("Placa do cavalo inválida. Use o padrão ABC1D23 ou ABC1234.");
      return;
    }

    const trailers = [trailer1, trailer2]
      .map((value) => normalizePlateValue(value))
      .filter((value) => value.length > 0);
    for (const trailer of trailers) {
      if (!isValidPlate(trailer)) {
        setError("Placa de carreta inválida. Use o padrão ABC1D23 ou ABC1234.");
        return;
      }
    }

    setLoading(true);
    try {
      const response = await requestCandidaturaPreCheck({
        cpf: cpfDigits,
        horsePlate: horse,
        trailerPlates: trailers,
      });

      if (!response.pendencias || response.pendencias.length === 0) {
        // Motorista + veículos já cadastrados e em dia — nada a cadastrar.
        setAlreadyOk(true);
        setLoading(false);
        return;
      }

      onProceed({
        cpf: cpfDigits,
        phone: phoneDigits,
        horsePlate: horse,
        trailerPlates: trailers,
        preCheckResponse: response,
      });
      resetState();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Não conseguimos iniciar o cadastro agora. Tente novamente.",
      );
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        overlayClassName="bg-[hsl(223_56%_10%/0.76)] backdrop-blur-[2px]"
        className="driver-theme admin-dialog-surface w-[min(100%-1.5rem,30rem)] rounded-[28px] border p-0 shadow-[0_32px_60px_-36px_hsl(223_56%_10%/0.42)]"
      >
        <DialogHeader className="border-b border-border/50 px-5 pb-4 pt-5 text-left sm:px-6">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-primary/60 sm:text-[11px]">
            Portal do motorista
          </p>
          <DialogTitle className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
            Fazer cadastro
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Informe seu CPF e as placas para começar. A gente verifica o que falta
            e abre só as etapas necessárias.
          </DialogDescription>
        </DialogHeader>

        {alreadyOk ? (
          <div className="space-y-4 px-5 pb-6 pt-5 sm:px-6">
            <div className="flex items-start gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div className="text-sm text-foreground">
                <p className="font-semibold">Tudo certo por aqui!</p>
                <p className="text-muted-foreground">
                  Seu cadastro e seus documentos já estão em dia. Não precisa
                  cadastrar de novo.
                </p>
              </div>
            </div>
            <Button
              type="button"
              className="min-h-[48px] w-full"
              onClick={() => handleOpenChange(false)}
            >
              Entendi
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4 px-5 pb-6 pt-5 sm:px-6">
            <div className="space-y-1.5">
              <Label htmlFor="standalone-cpf">CPF do motorista</Label>
              <Input
                id="standalone-cpf"
                inputMode="numeric"
                autoComplete="off"
                placeholder="000.000.000-00"
                value={cpf}
                onChange={(e) => setCpf(e.target.value)}
                disabled={loading}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="standalone-phone">Telefone (WhatsApp)</Label>
              <Input
                id="standalone-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="(00) 00000-0000"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={loading}
              />
              <p className="text-[11px] text-muted-foreground">
                Se o cadastro ficar pela metade, a gente te avisa por aqui quando tiver carga.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="standalone-horse">Placa do cavalo</Label>
              <Input
                id="standalone-horse"
                autoCapitalize="characters"
                autoComplete="off"
                placeholder="ABC1D23"
                value={horsePlate}
                onChange={(e) => setHorsePlate(e.target.value.toUpperCase())}
                disabled={loading}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="standalone-trailer1">Carreta 1 (opcional)</Label>
                <Input
                  id="standalone-trailer1"
                  autoCapitalize="characters"
                  autoComplete="off"
                  placeholder="ABC1D23"
                  value={trailer1}
                  onChange={(e) => setTrailer1(e.target.value.toUpperCase())}
                  disabled={loading}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="standalone-trailer2">Carreta 2 (opcional)</Label>
                <Input
                  id="standalone-trailer2"
                  autoCapitalize="characters"
                  autoComplete="off"
                  placeholder="ABC1D23"
                  value={trailer2}
                  onChange={(e) => setTrailer2(e.target.value.toUpperCase())}
                  disabled={loading}
                />
              </div>
            </div>

            {error ? (
              <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}

            <Button type="submit" className="min-h-[48px] w-full" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Verificando…
                </>
              ) : (
                <>
                  <Truck className="mr-2 h-4 w-4" />
                  Continuar
                </>
              )}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
