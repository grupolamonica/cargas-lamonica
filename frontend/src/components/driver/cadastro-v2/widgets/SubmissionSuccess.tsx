import { memo } from "react";
import { PartyPopper } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface SubmissionSuccessProps {
  protocolo: string;
  /** Últimos dígitos do telefone do motorista, ex. "99" → "**99". */
  phoneMasked?: string;
  onClose: () => void;
}

/**
 * Tela final do wizard v2 após POST /api/candidatura/submit retornar 201.
 *
 * - PartyPopper icon + heading bloqueado pela UI-SPEC.
 * - Protocolo destacado (formato `CAD-YYYY-NNNNN` vindo do backend).
 * - Botão único "Voltar ao portal" — fecha o wizard (caller limpa draft via
 *   useDriverRegistrationDraft.clearAndReset antes de chegar aqui).
 */
function SubmissionSuccessImpl({ protocolo, phoneMasked, onClose }: SubmissionSuccessProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="driver-theme flex flex-col items-center gap-4 px-4 py-12 text-center"
    >
      <PartyPopper className="h-12 w-12 text-accent" aria-hidden="true" />
      <h2 className="text-2xl font-semibold tracking-tight">Cadastro enviado!</h2>
      <p className="max-w-md text-base text-muted-foreground">
        Protocolo <strong>{protocolo}</strong>. Você receberá o resultado por WhatsApp em até 2 dias úteis.
      </p>
      {phoneMasked ? (
        <p className="text-sm text-muted-foreground">
          Notificaremos no telefone terminado em {phoneMasked}.
        </p>
      ) : null}
      <Button
        type="button"
        variant="cta"
        onClick={onClose}
        className="mt-4 w-full py-3.5 sm:w-auto sm:py-2.5"
      >
        Voltar ao portal
      </Button>
    </div>
  );
}

export const SubmissionSuccess = memo(SubmissionSuccessImpl);
