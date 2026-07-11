import { useQuery } from "@tanstack/react-query";
import { ServerCrash } from "lucide-react";

import { fetchCadastroBotsHealth } from "@/services/readModels";

/**
 * B3 (DC-222 AC6): avisa o operador quando um robô de cadastro externo
 * (Angellira/SPX/Dossiê) está fora do ar — assim ele entende por que os
 * cadastros estão falhando, em vez de tentar às cegas. Read-only, poll leve
 * (60s). Não renderiza nada quando está tudo no ar.
 */
export function CadastroBotsHealthBanner() {
  const { data } = useQuery({
    queryKey: ["operator", "cadastro-bots-health"],
    queryFn: fetchCadastroBotsHealth,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  if (!data?.anyOffline) return null;

  const labels = data.offline.map((b) => b.label).join(", ");

  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-800">
      <ServerCrash className="mt-0.5 h-5 w-5 shrink-0 text-rose-600" />
      <div className="min-w-0">
        <p className="font-semibold">
          {data.offline.length === 1
            ? `Robô de cadastro fora do ar: ${data.offline[0].label}`
            : `${data.offline.length} robôs de cadastro fora do ar (${labels})`}
        </p>
        <p className="mt-0.5 text-xs text-rose-700">
          Cadastros no {labels} podem falhar até o serviço voltar. Se persistir, avise a equipe técnica.
        </p>
      </div>
    </div>
  );
}
