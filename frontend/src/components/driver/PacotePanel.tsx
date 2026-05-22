import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Package } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { fetchPacote, type PacoteCarga } from "@/services/readModels";

interface PacotePanelProps {
  pacoteId: string;
  /** ID da carga atualmente aberta — fica destacada no panel. */
  currentCargaId: string;
}

/** Labels pt-BR para o badge de status de cada carga dentro do pacote. */
const STATUS_CARGA_LABEL: Record<string, string> = {
  OPEN: "Disponível",
  RESERVED: "Reservada",
  BOOKED: "Confirmada",
  CANCELLED: "Cancelada",
  COMPLETED: "Concluída",
  EXPIRED: "Expirada",
  DRAFT: "Rascunho",
};

/** Variant do shadcn Badge para cada status. */
function getStatusVariant(
  status: string,
  isCurrent: boolean,
): "default" | "secondary" | "outline" | "destructive" {
  if (isCurrent) return "default";
  const normalized = status?.toUpperCase();
  if (normalized === "OPEN") return "secondary";
  if (normalized === "CANCELLED" || normalized === "EXPIRED") return "destructive";
  return "outline";
}

function formatStatus(status: string): string {
  const normalized = status?.toUpperCase();
  return STATUS_CARGA_LABEL[normalized] ?? status;
}

/**
 * Painel "Viagem casada" exibido no topo de `DriverCargoDetails` quando a
 * carga aberta pertence a um pacote (cargo.viagem_id NOT NULL). Mostra:
 *  - Header com ícone Package + "N paradas" + valor_total
 *  - Lista vertical de TODAS as cargas do pacote em ordem (`ordem_viagem`)
 *  - Carga atual destacada (border + bg + label "Você está aqui")
 *  - Cargas != atual com link para a tela de detalhes correspondente
 *
 * Estados:
 *  - loading → skeleton dentro do Card (NÃO bloqueia a página inteira; os
 *    detalhes específicos da carga continuam renderizando abaixo)
 *  - error  → fallback acionável com botão "Tentar novamente" (refetch)
 *
 * Plan 10-06 / CARGAS-CASADAS-04, CARGAS-CASADAS-06.
 */
const PacotePanel = ({ pacoteId, currentCargaId }: PacotePanelProps) => {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["pacote", pacoteId],
    queryFn: () => fetchPacote(pacoteId),
    staleTime: 30_000,
    enabled: Boolean(pacoteId),
  });

  if (isLoading) {
    return (
      <Card
        className="mb-6 rounded-[28px] border border-border/70 shadow-[0_20px_44px_-32px_hsl(223_56%_12%/0.24)]"
        data-testid="pacote-panel-loading"
      >
        <CardHeader>
          <Skeleton className="h-6 w-2/3" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card
        className="mb-6 rounded-[28px] border border-destructive/30 bg-destructive/5"
        data-testid="pacote-panel-error"
      >
        <CardContent className="py-6 text-sm text-muted-foreground">
          Não foi possível carregar a viagem completa.
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="ml-2 font-semibold text-primary underline underline-offset-2 disabled:opacity-50"
          >
            Tentar novamente
          </button>
        </CardContent>
      </Card>
    );
  }

  const cargasOrdenadas: PacoteCarga[] = [...data.cargas].sort(
    (a, b) => a.ordem_viagem - b.ordem_viagem,
  );

  return (
    <Card
      className="mb-6 rounded-[28px] border border-border/70 shadow-[0_20px_44px_-32px_hsl(223_56%_12%/0.24)]"
      data-testid="pacote-panel"
    >
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <Package className="h-5 w-5 text-primary" aria-hidden="true" />
            <span className="text-base font-semibold sm:text-lg">
              Viagem casada — {cargasOrdenadas.length}{" "}
              {cargasOrdenadas.length === 1 ? "parada" : "paradas"}
            </span>
          </span>
          <span
            className="text-lg font-extrabold tracking-tight text-foreground sm:text-xl"
            aria-label={`Valor total ${formatCurrency(data.valor_total)}`}
          >
            {formatCurrency(data.valor_total)}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol
          role="list"
          aria-label={`Viagem com ${cargasOrdenadas.length} cargas`}
          className="space-y-2"
          data-testid="pacote-panel-list"
        >
          {cargasOrdenadas.map((c) => {
            const isCurrent = c.id === currentCargaId;
            return (
              <li
                key={c.id}
                role="listitem"
                className={cn(
                  "rounded-2xl border p-3 transition-colors",
                  isCurrent
                    ? "border-primary bg-primary/5"
                    : "border-border bg-card hover:bg-muted/40",
                )}
                data-testid={isCurrent ? "pacote-carga-current" : "pacote-carga-other"}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground">
                      Parada {c.ordem_viagem}
                    </div>
                    <div className="mt-1 flex items-center gap-1 text-sm text-foreground">
                      <MapPin
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="truncate">
                        {c.origem} {"→"} {c.destino}
                      </span>
                    </div>
                    {c.cliente ? (
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {c.cliente.nome}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge variant={getStatusVariant(c.status, isCurrent)}>
                      {formatStatus(c.status)}
                    </Badge>
                    {isCurrent ? (
                      <span className="text-xs font-semibold text-primary">
                        Você está aqui
                      </span>
                    ) : (
                      <Link
                        to={`/motorista/cargas/${c.id}`}
                        className="text-xs font-semibold text-primary underline underline-offset-2"
                      >
                        Ver detalhes
                      </Link>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
};

export default PacotePanel;
