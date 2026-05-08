// Painel de gestão N:M cliente ↔ rotas. Componente standalone — pode ser
// usado dentro do ClienteModal/ManageClientes ou em página própria.
// Backend: GET/POST /api/operator/clientes/:id/rotas, DELETE :rotaId.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  attachClienteRota,
  detachClienteRota,
  fetchClienteRotas,
} from "@/services/operatorAdmin";
import { fetchOperatorRoutes } from "@/services/readModels";

interface Props {
  clienteId: string;
  clienteNome?: string | null;
  readOnly?: boolean;
}

const formatKm = (value: number | null) =>
  value !== null && Number.isFinite(value)
    ? `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`
    : null;

const formatBRL = (value: number | null) =>
  value !== null && Number.isFinite(value)
    ? value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
    : null;

export default function ClienteRotasManager({
  clienteId,
  clienteNome,
  readOnly = false,
}: Props) {
  const qc = useQueryClient();
  const [selectedRotaId, setSelectedRotaId] = useState("");

  const rotasAtreladasQuery = useQuery({
    queryKey: ["cliente-rotas", clienteId],
    queryFn: () => fetchClienteRotas(clienteId),
    enabled: Boolean(clienteId),
  });

  const todasRotasQuery = useQuery({
    queryKey: ["operator-routes-pickable"],
    queryFn: () => fetchOperatorRoutes({ pageSize: "200" }),
  });

  const attachMutation = useMutation({
    mutationFn: (rotaId: string) => attachClienteRota(clienteId, rotaId),
    onSuccess: (data) => {
      toast.success(
        data.already_existed ? "Rota ja estava atrelada." : "Rota atrelada com sucesso.",
      );
      setSelectedRotaId("");
      qc.invalidateQueries({ queryKey: ["cliente-rotas", clienteId] });
      qc.invalidateQueries({ queryKey: ["operator-clientes"] });
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao atrelar rota."),
  });

  const detachMutation = useMutation({
    mutationFn: (rotaId: string) => detachClienteRota(clienteId, rotaId),
    onSuccess: () => {
      toast.success("Rota desatrelada.");
      qc.invalidateQueries({ queryKey: ["cliente-rotas", clienteId] });
      qc.invalidateQueries({ queryKey: ["operator-clientes"] });
    },
    onError: (err: Error) => toast.error(err.message || "Erro ao desatrelar rota."),
  });

  if (rotasAtreladasQuery.isLoading) {
    return <Skeleton className="h-32 w-full rounded-xl" />;
  }

  if (rotasAtreladasQuery.error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        Falha ao carregar rotas atreladas. Recarregue a pagina.
      </div>
    );
  }

  const rotasAtreladas = rotasAtreladasQuery.data?.rotas ?? [];
  const todasRotas = (todasRotasQuery.data?.items ?? []).filter((r) => r.ativa);
  const idsAtreladas = new Set(rotasAtreladas.map((r) => r.rota_id));
  const rotasDisponiveis = todasRotas.filter((r) => !idsAtreladas.has(r.id));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
          Rotas atreladas{clienteNome ? ` a ${clienteNome}` : ""}
        </p>
        <span className="text-xs text-muted-foreground">
          {rotasAtreladas.length} rota{rotasAtreladas.length === 1 ? "" : "s"}
        </span>
      </div>

      {rotasAtreladas.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground">
          Nenhuma rota atrelada ainda.
        </div>
      ) : (
        <ul className="space-y-2">
          {rotasAtreladas.map((rota) => {
            const km = formatKm(rota.distancia_km);
            return (
              <li
                key={rota.rota_id}
                className="flex items-start justify-between gap-3 rounded-xl border border-border/60 bg-muted/30 p-3"
              >
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {rota.origem} <span className="text-muted-foreground">{"→"}</span>{" "}
                      {rota.destino}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {km ? (
                        <Badge variant="outline" className="text-[10px]">
                          {km}
                        </Badge>
                      ) : null}
                      {rota.tarifas.map((t) => {
                        const valor = formatBRL(t.valor_frete);
                        return (
                          <Badge
                            key={t.tipo_veiculo}
                            variant="secondary"
                            className="text-[10px] font-medium"
                          >
                            {t.tipo_veiculo}
                            {valor ? ` · ${valor}` : ""}
                          </Badge>
                        );
                      })}
                    </div>
                  </div>
                </div>
                {!readOnly ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 shrink-0 text-destructive hover:bg-destructive/10"
                    onClick={() => detachMutation.mutate(rota.rota_id)}
                    disabled={detachMutation.isPending}
                    title="Desatrelar rota"
                    aria-label={`Desatrelar rota ${rota.origem} para ${rota.destino}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {!readOnly ? (
        <div className="flex items-center gap-2 rounded-xl border border-border/40 bg-background p-2">
          <Select value={selectedRotaId} onValueChange={setSelectedRotaId}>
            <SelectTrigger className="h-9 flex-1" aria-label="Selecionar rota para atrelar">
              <SelectValue placeholder="Selecionar rota..." />
            </SelectTrigger>
            <SelectContent>
              {rotasDisponiveis.length === 0 ? (
                <div className="px-3 py-2 text-center text-xs text-muted-foreground">
                  Sem rotas disponiveis para atrelar.
                </div>
              ) : (
                rotasDisponiveis.map((rota) => (
                  <SelectItem key={rota.id} value={rota.id}>
                    {rota.origem} {"→"} {rota.destino}
                    {rota.distancia_km
                      ? ` (${rota.distancia_km.toLocaleString("pt-BR", { maximumFractionDigits: 0 })} km)`
                      : ""}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            onClick={() => selectedRotaId && attachMutation.mutate(selectedRotaId)}
            disabled={!selectedRotaId || attachMutation.isPending}
          >
            <Plus className="h-3.5 w-3.5" />
            Atrelar
          </Button>
        </div>
      ) : null}
    </div>
  );
}
