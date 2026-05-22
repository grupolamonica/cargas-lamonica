import { memo } from "react";
import { CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CandidaturaCompleto } from "@/api/candidaturaApi";

export interface AlreadyRegisteredScreenProps {
  completos: CandidaturaCompleto[];
  /** Label amigavel da carga (origem → destino) — opcional. */
  cargaLabel?: string;
  /**
   * Acionado pelo CTA primario "Ver minhas candidaturas". Caller faz handoff
   * para o fluxo existente (DriverPortal / candidatura ja registrada).
   */
  onConfirm: () => void;
  /** Botão "Fechar" — apenas dispensa a tela sem handoff. */
  onClose: () => void;
}

/**
 * Tela exibida quando o pre-check retorna ZERO pendencias — todos os documentos
 * (motorista + cavalo + carretas) ja estao cadastrados e vigentes. Antes o
 * wizard fechava silenciosamente nesse cenario; agora exibimos confirmacao
 * explicita "atualizamos sua candidatura" para o motorista saber que o
 * sistema processou seu interesse.
 *
 * Visual: `CheckCircle2` azul-primary (diferencia de SubmissionSuccess que usa
 * `PartyPopper` accent-green pra novo cadastro enviado).
 */
function AlreadyRegisteredScreenImpl({
  completos,
  cargaLabel,
  onConfirm,
  onClose,
}: AlreadyRegisteredScreenProps) {
  const plates = completos.map((c) => c.plate).filter(Boolean).join(", ");

  return (
    <div
      role="status"
      aria-live="polite"
      className="driver-theme flex flex-col items-center gap-4 px-4 py-12 text-center"
    >
      <CheckCircle2 className="h-12 w-12 text-primary" aria-hidden="true" />
      <h2 className="text-2xl font-semibold tracking-tight">
        Seus dados já estão cadastrados!
      </h2>
      <p className="max-w-md text-base text-muted-foreground">
        Tudo certo{plates ? ` com ${plates}` : ""}. Sua candidatura
        {cargaLabel ? ` para ${cargaLabel}` : ""} foi atualizada — a Lamônica
        avisa quando analisar.
      </p>
      <div className="mt-4 flex w-full flex-col gap-2 sm:flex-row sm:w-auto">
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          className="sm:w-auto"
        >
          Fechar
        </Button>
        <Button
          type="button"
          variant="cta"
          onClick={onConfirm}
          className="py-3.5 sm:w-auto sm:py-2.5"
        >
          Ver minhas candidaturas
        </Button>
      </div>
    </div>
  );
}

export const AlreadyRegisteredScreen = memo(AlreadyRegisteredScreenImpl);
