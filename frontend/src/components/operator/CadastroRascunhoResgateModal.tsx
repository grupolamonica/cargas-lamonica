/**
 * CadastroRascunhoResgateModal
 *
 * Permite ao operador abrir o wizard de cadastro do motorista
 * para um rascunho em andamento (status=draft), completar as
 * etapas faltantes e submeter em nome do motorista.
 *
 * Usa o mesmo DriverRegistrationWizard que o motorista vê,
 * com restauração automática via draft (cpf + cargaId).
 */
import { useQuery } from "@tanstack/react-query";

import { DriverRegistrationWizard } from "@/components/driver/cadastro-v2/DriverRegistrationWizard";
import { getOperatorAccessToken } from "@/services/apiClient";
import type { DraftRegistrationItem } from "@/services/readModels";

interface CadastroRascunhoResgateModalProps {
  draft: DraftRegistrationItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitSuccess?: () => void;
}

function derivePlacas(draft: DraftRegistrationItem): {
  horsePlate: string;
  trailerPlates: string[];
} {
  // placa_cavalo vem da coluna extraída; placas de carretas não estão na
  // listagem — o wizard as carrega do draft ao restaurar.
  return {
    horsePlate: draft.placa_cavalo ?? "",
    trailerPlates: [],
  };
}

/**
 * CadastroRascunhoResgateModal — abre o DriverRegistrationWizard para um
 * draft de motorista, permitindo ao operador completar e submeter.
 */
export function CadastroRascunhoResgateModal({
  draft,
  open,
  onOpenChange,
  onSubmitSuccess,
}: CadastroRascunhoResgateModalProps) {
  // Token do operador para as chamadas autenticadas do wizard (antt-precheck,
  // uploads). O load/save/submit do draft usam o token internamente (readModels).
  const { data: operatorAccessToken } = useQuery({
    queryKey: ["operator-access-token"],
    queryFn: getOperatorAccessToken,
    enabled: open && !!draft,
    staleTime: 60_000,
  });

  if (!draft) return null;

  const { horsePlate, trailerPlates } = derivePlacas(draft);

  return (
    <DriverRegistrationWizard
      open={open}
      onOpenChange={onOpenChange}
      cargaId={draft.carga_id ?? undefined}
      cpf={draft.cpf ?? undefined}
      horsePlate={horsePlate || undefined}
      trailerPlates={trailerPlates}
      // Modo operador: carrega/salva o draft por ID e submete em nome do
      // motorista (reusa o pipeline do motorista no backend).
      operatorMode={{ cadastroId: draft.id, accessToken: operatorAccessToken ?? null }}
      // Operador não precisa do callback de pré-check — o wizard restaura
      // direto do draft (rascunho já passou pelo pré-check na sessão do motorista).
      onPreCheckPassed={() => {
        // no-op: o wizard continua normalmente após o pré-check.
      }}
    />
  );
}
