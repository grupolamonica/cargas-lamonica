import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Eye, Package, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import AdminPagination from "@/components/AdminPagination";
import DashboardHeader from "@/components/DashboardHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import PacoteFormModal from "@/components/operator/PacoteFormModal";

import {
  cancelPacote,
  fetchOperatorPacotes,
  translatePacoteError,
  type OperatorPacoteListItem,
  type PacoteStatus,
} from "@/services/operatorAdmin";
import { formatCurrency } from "@/lib/currency";
import { confirmAction } from "@/lib/confirm";
import {
  PACOTE_STATUS_BADGE,
  PACOTE_STATUS_LABELS,
} from "@/lib/pacoteConstants";

// Status terminais (nao podem ser cancelados — botao fica oculto).
// Alinhado com TERMINAL_STATUSES em PacoteDetails.tsx.
const TERMINAL_STATUSES: ReadonlyArray<PacoteStatus> = ["concluido", "cancelado"];

const PACOTES_QUERY_KEY = ["operator", "pacotes"] as const;
const PAGE_SIZE = 20;
const PACOTES_QUERY_OPTIONS = {
  staleTime: 30_000,
  gcTime: 5 * 60_000,
  refetchOnWindowFocus: false,
  placeholderData: keepPreviousData,
} as const;

const STATUS_OPTIONS: Array<{ value: "todos" | PacoteStatus; label: string }> = [
  { value: "todos", label: "Todos" },
  { value: "rascunho", label: "Rascunho" },
  { value: "publicado", label: "Publicado" },
  { value: "reservado", label: "Reservado" },
  { value: "em_andamento", label: "Em andamento" },
  { value: "concluido", label: "Concluído" },
  { value: "cancelado", label: "Cancelado" },
];

function formatShortId(id: string): string {
  return id.slice(0, 8);
}

function formatDateBr(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

interface StatusBadgeProps {
  status: PacoteStatus;
}

const StatusBadge = ({ status }: StatusBadgeProps) => {
  const cfg = PACOTE_STATUS_BADGE[status] ?? PACOTE_STATUS_BADGE.rascunho;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${cfg.bg}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      {PACOTE_STATUS_LABELS[status] ?? status}
    </span>
  );
};

const ManagePacotes = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"todos" | PacoteStatus>("todos");
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);

  // Reset paginação ao mudar filtro
  useEffect(() => {
    setPage(1);
  }, [statusFilter]);

  const queryParams = useMemo(
    () => ({
      ...(statusFilter !== "todos" ? { status: statusFilter } : {}),
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    [statusFilter, page],
  );

  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: [...PACOTES_QUERY_KEY, statusFilter, page],
    queryFn: () => fetchOperatorPacotes(queryParams),
    ...PACOTES_QUERY_OPTIONS,
  });

  // Mutation de cancelamento usada pelo botao da coluna AÇÕES.
  // Invalida a listagem + o detalhe do pacote (caso o operador abra apos cancelar).
  const cancelMutation = useMutation({
    mutationFn: (pacoteId: string) => cancelPacote(pacoteId),
    onSuccess: (_, pacoteId) => {
      toast.success("Pacote cancelado.");
      queryClient.invalidateQueries({ queryKey: PACOTES_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["operator", "pacote", pacoteId] });
    },
    onError: (err) => {
      toast.error(translatePacoteError(err, "Erro ao cancelar pacote."));
    },
  });

  useEffect(() => {
    if (error) toast.error("Erro ao carregar pacotes.");
  }, [error]);

  const items: OperatorPacoteListItem[] = data?.items ?? [];
  const totalCount = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const handleRowClick = (id: string) => {
    navigate(`/pacotes/${id}`);
  };

  const handleViewClick = (event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    navigate(`/pacotes/${id}`);
  };

  const handleCancelClick = (event: React.MouseEvent, pacote: OperatorPacoteListItem) => {
    event.stopPropagation();
    if (cancelMutation.isPending) return;
    if (
      !confirmAction(
        `Cancelar o pacote ${formatShortId(pacote.id)}?`,
        "A acao e permanente e rejeita reservas pendentes.",
      )
    ) {
      return;
    }
    cancelMutation.mutate(pacote.id);
  };

  const handleCreateSuccess = (pacoteId: string) => {
    navigate(`/pacotes/${pacoteId}`);
  };

  return (
    <div className="flex flex-col">
      <DashboardHeader title="Pacotes de Cargas" subtitle="Cargas casadas e viagens multi-parada" />

      <div className="px-6 py-6 lg:px-8">
        {/* Toolbar */}
        <div className="admin-card-surface mb-5 flex flex-col gap-3 rounded-[28px] border px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground">Status:</span>
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
              >
                <SelectTrigger className="h-9 w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="rounded-full"
              aria-label="Atualizar lista"
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => setModalOpen(true)}
              className="rounded-full"
            >
              <Plus className="h-4 w-4 mr-1.5" /> Novo pacote
            </Button>
          </div>
        </div>

        {/* Table */}
        <div className="admin-card-surface overflow-hidden rounded-[28px] border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Valor total</th>
                <th className="px-4 py-3">Cargas</th>
                <th className="px-4 py-3">Versão</th>
                <th className="px-4 py-3">Criado em</th>
                <th className="px-4 py-3 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={7} className="px-4 py-4">
                      <div className="h-5 w-full animate-pulse rounded bg-muted" />
                    </td>
                  </tr>
                ))
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <Package className="h-8 w-8" />
                      <p className="text-sm font-medium">Nenhum pacote encontrado</p>
                      <p className="text-xs">
                        {statusFilter === "todos"
                          ? "Crie o primeiro pacote para começar."
                          : "Tente ajustar o filtro de status."}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                items.map((pacote) => {
                  const canCancel = !TERMINAL_STATUSES.includes(pacote.status);
                  const isCancelingThisRow =
                    cancelMutation.isPending && cancelMutation.variables === pacote.id;
                  return (
                    <tr
                      key={pacote.id}
                      className="cursor-pointer transition-colors hover:bg-muted/30"
                      onClick={() => handleRowClick(pacote.id)}
                    >
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {formatShortId(pacote.id)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={pacote.status} />
                      </td>
                      <td className="px-4 py-3 font-medium">
                        {pacote.valor_total != null ? formatCurrency(pacote.valor_total) : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="font-mono">
                          {pacote.cargas?.length ?? 0}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">v{pacote.version}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {formatDateBr(pacote.created_at)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {/*
                          Coluna AÇÕES: botoes Ver/Cancelar. O click-row continua
                          funcionando como atalho (navega para detalhe), mas os
                          botoes explicitos resolvem a queixa do operador que nao
                          identificava que a linha era clicavel.
                          stopPropagation evita disparar handleRowClick em conjunto.
                        */}
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={(event) => handleViewClick(event, pacote.id)}
                            title="Ver detalhes do pacote"
                            aria-label={`Ver pacote ${formatShortId(pacote.id)}`}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/10 bg-primary/5 text-primary transition-all duration-150 hover:bg-primary/12 hover:scale-105 cursor-pointer"
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </button>
                          {canCancel && (
                            <button
                              type="button"
                              onClick={(event) => handleCancelClick(event, pacote)}
                              disabled={isCancelingThisRow}
                              title="Cancelar pacote (rejeita reservas pendentes)"
                              aria-label={`Cancelar pacote ${formatShortId(pacote.id)}`}
                              className="flex h-8 w-8 items-center justify-center rounded-lg border border-destructive/15 bg-destructive/5 text-destructive transition-all duration-150 hover:bg-destructive/10 hover:scale-105 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {isCancelingThisRow ? (
                                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Ban className="h-3.5 w-3.5" />
                              )}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <AdminPagination
          page={page}
          totalPages={totalPages}
          totalCount={totalCount}
          pageSize={PAGE_SIZE}
          itemLabel="pacotes"
          isFetching={isFetching}
          onPrevious={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
        />
      </div>

      <PacoteFormModal
        open={modalOpen}
        mode="create"
        onClose={() => setModalOpen(false)}
        onSuccess={handleCreateSuccess}
      />
    </div>
  );
};

export default ManagePacotes;
