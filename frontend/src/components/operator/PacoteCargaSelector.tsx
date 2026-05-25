import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { fetchOperatorCargas, type OperatorCargoListItem } from "@/services/readModels";
import { formatCurrency } from "@/lib/currency";
import { MAX_CARGAS_POR_PACOTE } from "@/lib/pacoteConstants";

interface Props {
  /** IDs já adicionados ao pacote em construção — não devem ser ofertados de novo. */
  selectedCargaIds: string[];
  /**
   * Quando o operador está editando um pacote existente, passar o pacoteId
   * permite incluir cargas que já pertencem a *este* pacote no resultset
   * (caso contrário o filtro `viagem_id IS NULL` as removeria). Não filtra
   * por pacote no servidor — apenas relaxa o filtro client-side.
   */
  currentPacoteId?: string | null;
  onAdd: (carga: OperatorCargoListItem) => void;
}

const PACOTE_SELECTOR_QUERY_OPTIONS = {
  staleTime: 60_000,
  gcTime: 5 * 60_000,
  refetchOnWindowFocus: false,
} as const;

/**
 * Seletor de cargas elegíveis para entrar em um pacote.
 *
 * Filtros server-side (via `/api/operator/cargas`):
 *  - status=OPEN
 *  - driverVisibility=PREMIUM
 *
 * Filtros client-side (read-model não expõe filtro `viagem_id IS NULL`):
 *  - viagem_id IS NULL (carga avulsa) OR viagem_id === currentPacoteId
 *  - id NOT IN selectedCargaIds (já adicionada à composição atual)
 *  - busca por origem/destino/cliente.nome
 *
 * Bloqueia o botão "Adicionar" quando selectedCargaIds.length >= MAX_CARGAS_POR_PACOTE.
 */
const PacoteCargaSelector = ({ selectedCargaIds, currentPacoteId = null, onAdd }: Props) => {
  const [search, setSearch] = useState("");

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["operator", "pacote", "elegiveis", "PREMIUM", "OPEN"],
    queryFn: () =>
      fetchOperatorCargas({
        status: "OPEN",
        driverVisibility: "PREMIUM",
        pageSize: "200",
      }),
    ...PACOTE_SELECTOR_QUERY_OPTIONS,
  });

  const elegiveis = useMemo<OperatorCargoListItem[]>(() => {
    const items = data?.items ?? [];
    const selected = new Set(selectedCargaIds);
    const term = search.trim().toLowerCase();
    return items.filter((c) => {
      const isAvulsa = !c.viagem_id || c.viagem_id === currentPacoteId;
      if (!isAvulsa) return false;
      if (selected.has(c.id)) return false;
      if (term === "") return true;
      const haystack = `${c.origem} ${c.destino} ${c.clientes?.nome ?? ""}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [data?.items, selectedCargaIds, currentPacoteId, search]);

  const atLimit = selectedCargaIds.length >= MAX_CARGAS_POR_PACOTE;

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Buscar por origem, destino ou cliente..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {atLimit ? (
        <div
          className="flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1"
          role="status"
        >
          <AlertTriangle className="h-3 w-3" />
          Limite atingido: {MAX_CARGAS_POR_PACOTE} cargas por pacote.
        </div>
      ) : null}

      {error ? (
        <div className="text-xs text-destructive">Erro ao carregar cargas elegíveis.</div>
      ) : null}

      <div
        className="max-h-64 overflow-y-auto space-y-1"
        data-testid="carga-selector-list"
        aria-busy={isFetching}
      >
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Carregando cargas elegíveis...</div>
        ) : elegiveis.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center">
            Nenhuma carga PREMIUM aberta disponível no momento.
          </div>
        ) : (
          elegiveis.map((c) => (
            <Card key={c.id} className="overflow-hidden">
              <CardContent className="p-2 flex items-center justify-between gap-2">
                <div className="min-w-0 text-sm">
                  <div className="font-medium truncate">
                    {c.origem} → {c.destino}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {c.clientes?.nome ?? "Sem cliente"} ·{" "}
                    {c.valor != null ? formatCurrency(c.valor) : "—"} · {c.perfil}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={atLimit}
                  onClick={() => onAdd(c)}
                  aria-label={`Adicionar carga ${c.origem} para ${c.destino}`}
                >
                  <Plus className="h-3 w-3 mr-1" /> Adicionar
                </Button>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
};

export default PacoteCargaSelector;
