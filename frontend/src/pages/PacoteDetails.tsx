import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Calendar,
  CheckCircle2,
  Edit,
  Loader2,
  Truck,
} from "lucide-react";
import { toast } from "sonner";

import DashboardHeader from "@/components/DashboardHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import PacoteFormModal from "@/components/operator/PacoteFormModal";

import {
  cancelPacote,
  fetchOperatorPacote,
  publishPacote,
  translatePacoteError,
  type OperatorPacoteDetail,
  type PacoteStatus,
} from "@/services/operatorAdmin";
import { formatCurrency } from "@/lib/currency";
import { confirmAction } from "@/lib/confirm";
import {
  MAX_CARGAS_POR_PACOTE,
  PACOTE_STATUS_BADGE,
  PACOTE_STATUS_LABELS,
} from "@/lib/pacoteConstants";

const PACOTE_QUERY_OPTIONS = {
  staleTime: 15_000,
  gcTime: 5 * 60_000,
  refetchOnWindowFocus: false,
} as const;

const TERMINAL_STATUSES: ReadonlyArray<PacoteStatus> = ["concluido", "cancelado"];
const NON_EDITABLE_STATUSES: ReadonlyArray<PacoteStatus> = [
  "reservado",
  "em_andamento",
  "concluido",
  "cancelado",
];

function formatDateTimeBr(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface StatusBadgeProps {
  status: PacoteStatus;
}

const StatusBadge = ({ status }: StatusBadgeProps) => {
  const cfg = PACOTE_STATUS_BADGE[status] ?? PACOTE_STATUS_BADGE.rascunho;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${cfg.bg}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      {PACOTE_STATUS_LABELS[status] ?? status}
    </span>
  );
};

/**
 * Validação client-side de pré-publicação. Roda antes do POST para dar
 * feedback imediato; backend valida novamente (defense-in-depth).
 */
function validatePublish(pacote: OperatorPacoteDetail): string | null {
  if ((pacote.pacote.valor_total ?? 0) <= 0) {
    return "Informe o valor total (maior que zero) antes de publicar.";
  }
  if (pacote.cargas.length === 0) {
    return "Pacote precisa de pelo menos 1 carga para publicar.";
  }
  if (pacote.cargas.length > MAX_CARGAS_POR_PACOTE) {
    return `Pacote pode ter no máximo ${MAX_CARGAS_POR_PACOTE} cargas.`;
  }
  const naoPremium = pacote.cargas.find((c) => c.driver_visibility !== "PREMIUM");
  if (naoPremium) {
    return "Todas as cargas precisam ser PREMIUM antes de publicar.";
  }
  const naoAberta = pacote.cargas.find((c) => c.status !== "OPEN");
  if (naoAberta) {
    return "Todas as cargas precisam estar em status OPEN antes de publicar.";
  }
  return null;
}

const PacoteDetails = () => {
  const { pacoteId } = useParams<{ pacoteId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);

  const { data: pacote, error, isLoading, refetch } = useQuery({
    queryKey: ["operator", "pacote", pacoteId],
    queryFn: () => fetchOperatorPacote(pacoteId!),
    enabled: Boolean(pacoteId),
    ...PACOTE_QUERY_OPTIONS,
  });

  useEffect(() => {
    if (error) toast.error(translatePacoteError(error, "Erro ao carregar pacote."));
  }, [error]);

  const publishMutation = useMutation({
    mutationFn: () => publishPacote(pacoteId!),
    onSuccess: async () => {
      toast.success("Pacote publicado.");
      await queryClient.invalidateQueries({ queryKey: ["operator", "pacotes"] });
      await queryClient.invalidateQueries({ queryKey: ["operator", "pacote", pacoteId] });
    },
    onError: (err) => {
      toast.error(translatePacoteError(err, "Erro ao publicar pacote."));
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelPacote(pacoteId!),
    onSuccess: async (res) => {
      toast.success(
        `Pacote cancelado. ${res.cargas_afetadas} carga(s) liberada(s)${
          res.claims_rejeitados > 0 ? `, ${res.claims_rejeitados} candidatura(s) rejeitada(s)` : ""
        }.`,
      );
      await queryClient.invalidateQueries({ queryKey: ["operator", "pacotes"] });
      await queryClient.invalidateQueries({ queryKey: ["operator", "pacote", pacoteId] });
    },
    onError: (err) => {
      toast.error(translatePacoteError(err, "Erro ao cancelar pacote."));
    },
  });

  const status = pacote?.pacote.status;
  const canEdit = useMemo(
    () => status != null && !NON_EDITABLE_STATUSES.includes(status),
    [status],
  );
  const canPublish = status === "rascunho";
  const canCancel = useMemo(
    () => status != null && !TERMINAL_STATUSES.includes(status),
    [status],
  );

  const handlePublish = () => {
    if (!pacote) return;
    const localError = validatePublish(pacote);
    if (localError) {
      toast.error(localError);
      return;
    }
    const ok = confirmAction(
      "Publicar pacote?",
      `Valor: ${formatCurrency(pacote.pacote.valor_total ?? 0)} · ${pacote.cargas.length} carga(s).\n\nIsto torna o pacote visível para motoristas premium.`,
    );
    if (!ok) return;
    publishMutation.mutate();
  };

  const handleCancel = () => {
    if (!pacote) return;
    const ok = confirmAction(
      "Cancelar pacote?",
      `Esta ação cancelará o pacote e suas ${pacote.cargas.length} carga(s), invalidando candidaturas pendentes. NÃO é reversível.`,
    );
    if (!ok) return;
    cancelMutation.mutate();
  };

  const handleEditSuccess = () => {
    refetch();
  };

  if (!pacoteId) {
    return (
      <div className="px-6 py-12 text-center text-muted-foreground">Pacote inválido.</div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <DashboardHeader title="Pacote" subtitle="Carregando..." />
        <div className="flex items-center justify-center px-6 py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!pacote) {
    return (
      <div className="flex flex-col">
        <DashboardHeader title="Pacote não encontrado" />
        <div className="px-6 py-12">
          <Button onClick={() => navigate("/pacotes")} variant="outline">
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Voltar
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <DashboardHeader
        title={`Pacote ${pacote.pacote.id.slice(0, 8)}`}
        subtitle={`Versão ${pacote.pacote.version} · ${pacote.cargas.length} carga(s)`}
      />

      <div className="px-6 py-6 lg:px-8">
        {/* Back + header card */}
        <div className="mb-4 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => navigate("/pacotes")}>
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Voltar
          </Button>
        </div>

        <div className="admin-card-surface mb-6 rounded-[28px] border p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <StatusBadge status={pacote.pacote.status} />
                <span className="text-xs text-muted-foreground">v{pacote.pacote.version}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold tracking-tight">
                  {pacote.pacote.valor_total != null
                    ? formatCurrency(pacote.pacote.valor_total)
                    : "Sem valor"}
                </span>
                <span className="text-xs text-muted-foreground">valor total do pacote</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> Criado em{" "}
                  {formatDateTimeBr(pacote.pacote.created_at)}
                </span>
                {pacote.pacote.published_at && (
                  <span className="inline-flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Publicado em{" "}
                    {formatDateTimeBr(pacote.pacote.published_at)}
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {canEdit && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setEditOpen(true)}
                  className="rounded-full"
                >
                  <Edit className="h-4 w-4 mr-1.5" /> Editar
                </Button>
              )}
              {canPublish && (
                <Button
                  type="button"
                  size="sm"
                  onClick={handlePublish}
                  disabled={publishMutation.isPending}
                  className="rounded-full"
                >
                  {publishMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 mr-1.5" />
                  )}
                  Publicar
                </Button>
              )}
              {canCancel && (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={handleCancel}
                  disabled={cancelMutation.isPending}
                  className="rounded-full"
                >
                  {cancelMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  ) : (
                    <Ban className="h-4 w-4 mr-1.5" />
                  )}
                  Cancelar
                </Button>
              )}
            </div>
          </div>

          {status === "publicado" && (
            <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                Pacote já publicado — alterações invalidarão candidaturas pendentes e
                incrementarão a versão.
              </span>
            </div>
          )}

          {status === "reservado" && (
            <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                Pacote reservado por motorista. Edição desabilitada — cancele a reserva para
                editar.
              </span>
            </div>
          )}
        </div>

        {/* Cargas */}
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Cargas no pacote ({pacote.cargas.length})
        </h2>

        {pacote.cargas.length === 0 ? (
          <div className="admin-card-surface rounded-[28px] border px-6 py-10 text-center text-sm text-muted-foreground">
            Nenhuma carga adicionada ao pacote ainda.
          </div>
        ) : (
          <ol className="space-y-2" data-testid="pacote-cargas-list">
            {pacote.cargas.map((c) => (
              <li
                key={c.id}
                className="admin-card-surface flex items-center gap-3 rounded-2xl border p-4"
              >
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                  {c.ordem_viagem ?? "?"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Truck className="h-3.5 w-3.5 text-muted-foreground" />
                    <p className="truncate text-sm font-semibold">
                      {c.origem} → {c.destino}
                    </p>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {c.cliente_nome ?? "Sem cliente"} ·{" "}
                    {c.valor != null ? formatCurrency(c.valor) : "—"} · {c.perfil ?? "—"}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge
                    variant={c.driver_visibility === "PREMIUM" ? "default" : "secondary"}
                    className="text-[0.6rem]"
                  >
                    {c.driver_visibility}
                  </Badge>
                  <span className="font-mono text-[0.6rem] text-muted-foreground">
                    {c.status}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      {canEdit && (
        <PacoteFormModal
          open={editOpen}
          mode="edit"
          pacote={pacote}
          onClose={() => setEditOpen(false)}
          onSuccess={handleEditSuccess}
        />
      )}
    </div>
  );
};

export default PacoteDetails;
