import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import PacoteCargaSelector from "./PacoteCargaSelector";
import PacoteCargasReorder, { type PacoteReorderItem } from "./PacoteCargasReorder";

import {
  addCargaToPacote,
  cancelPacote,
  createPacote,
  removeCargaFromPacote,
  reorderCargasInPacote,
  translatePacoteError,
  updatePacote,
  type OperatorPacoteDetail,
} from "@/services/operatorAdmin";
import { formatCurrency } from "@/lib/currency";
import { MAX_CARGAS_POR_PACOTE } from "@/lib/pacoteConstants";
import type { OperatorCargoListItem } from "@/services/readModels";

interface Props {
  open: boolean;
  mode: "create" | "edit";
  /** Obrigatório quando mode === "edit". */
  pacote?: OperatorPacoteDetail | null;
  onClose: () => void;
  /** Chamado após sucesso (com pacoteId do criado/editado). */
  onSuccess?: (pacoteId: string) => void;
}

function buildItemFromCarga(c: OperatorCargoListItem, ordem: number): PacoteReorderItem {
  return {
    cargaId: c.id,
    ordem,
    label: `${c.origem} → ${c.destino}`,
    meta: `${c.clientes?.nome ?? "Sem cliente"} · ${c.valor != null ? formatCurrency(c.valor) : "—"}`,
  };
}

function buildItemFromDetail(
  c: OperatorPacoteDetail["cargas"][number],
  fallbackOrdem: number,
): PacoteReorderItem {
  return {
    cargaId: c.id,
    ordem: c.ordem_viagem ?? fallbackOrdem,
    label: `${c.origem} → ${c.destino}`,
    meta: `${c.cliente_nome ?? "Sem cliente"} · ${c.valor != null ? formatCurrency(c.valor) : "—"}`,
  };
}

/**
 * Modal de criação/edição de pacote.
 *
 * Create flow:
 *  1. createPacote({ valor_total }) → recebe pacoteId
 *  2. addCargaToPacote sequencial para cada item da composição
 *  3. Se qualquer step pós-create falhar, cancelPacote(pacoteId) para evitar
 *     rascunho órfão (best-effort; falhas no rollback são apenas logadas)
 *
 * Edit flow (mode='edit'):
 *  1. updatePacote(valor_total) se valor mudou
 *  2. removeCargaFromPacote para cargas que saíram
 *  3. addCargaToPacote para cargas novas
 *  4. reorderCargasInPacote para fixar ordem final
 *
 * Validações client-side mirror server-side:
 *  - valor_total > 0 obrigatório
 *  - composição.length entre 1 e MAX_CARGAS_POR_PACOTE
 *
 * Erros backend traduzidos via translatePacoteError → toast.error.
 */
const PacoteFormModal = ({ open, mode, pacote = null, onClose, onSuccess }: Props) => {
  const queryClient = useQueryClient();
  const [valorTotalRaw, setValorTotalRaw] = useState("");
  const [items, setItems] = useState<PacoteReorderItem[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Reset state quando modal abre ou pacote em edição muda
  useEffect(() => {
    if (!open) return;
    if (mode === "edit" && pacote) {
      setValorTotalRaw(
        pacote.pacote.valor_total != null ? String(pacote.pacote.valor_total) : "",
      );
      setItems(pacote.cargas.map((c, i) => buildItemFromDetail(c, i + 1)));
    } else {
      setValorTotalRaw("");
      setItems([]);
    }
  }, [open, mode, pacote]);

  const handleAddCarga = (c: OperatorCargoListItem) => {
    if (items.length >= MAX_CARGAS_POR_PACOTE) {
      toast.error(`Limite atingido: ${MAX_CARGAS_POR_PACOTE} cargas por pacote.`);
      return;
    }
    if (items.some((it) => it.cargaId === c.id)) return;
    setItems((prev) => [...prev, buildItemFromCarga(c, prev.length + 1)]);
  };

  const selectedIds = useMemo(() => items.map((it) => it.cargaId), [items]);

  const handleSubmit = async () => {
    const valor = Number.parseFloat(valorTotalRaw.replace(",", "."));
    if (!Number.isFinite(valor) || valor <= 0) {
      toast.error("Informe o valor total (maior que zero).");
      return;
    }
    if (items.length === 0) {
      toast.error("Adicione pelo menos 1 carga ao pacote.");
      return;
    }
    if (items.length > MAX_CARGAS_POR_PACOTE) {
      toast.error(`Máximo de ${MAX_CARGAS_POR_PACOTE} cargas por pacote.`);
      return;
    }

    setSubmitting(true);
    try {
      if (mode === "create") {
        const created = await createPacote({ valor_total: valor });
        const pacoteId = created.pacote.id;

        // Best-effort: add cargas sequencialmente. Se algum add falha, cancela o pacote.
        try {
          for (const item of items) {
            await addCargaToPacote(pacoteId, { cargaId: item.cargaId, ordem: item.ordem });
          }
        } catch (innerErr) {
          // Rollback: cancela rascunho órfão (não bloqueia se cancel falhar)
          try {
            await cancelPacote(pacoteId);
          } catch (rollbackErr) {
            if (import.meta.env.DEV) {
              console.warn("[PacoteFormModal] Falha ao cancelar rascunho órfão", rollbackErr);
            }
          }
          throw innerErr;
        }

        toast.success("Pacote criado em rascunho.");
        await queryClient.invalidateQueries({ queryKey: ["operator", "pacotes"] });
        onSuccess?.(pacoteId);
        onClose();
        return;
      }

      // mode === "edit"
      if (!pacote) {
        throw new Error("Pacote não encontrado para edição.");
      }
      const pacoteId = pacote.pacote.id;

      if (pacote.pacote.valor_total !== valor) {
        await updatePacote(pacoteId, { valor_total: valor });
      }

      const existingIds = new Set(pacote.cargas.map((c) => c.id));
      const newIds = new Set(items.map((it) => it.cargaId));

      // Remove cargas que saíram
      for (const existingId of existingIds) {
        if (!newIds.has(existingId)) {
          await removeCargaFromPacote(pacoteId, existingId);
        }
      }

      // Adiciona cargas novas
      for (const item of items) {
        if (!existingIds.has(item.cargaId)) {
          await addCargaToPacote(pacoteId, { cargaId: item.cargaId, ordem: item.ordem });
        }
      }

      // Garante ordem final
      await reorderCargasInPacote(
        pacoteId,
        items.map((it) => ({ cargaId: it.cargaId, ordem: it.ordem })),
      );

      toast.success("Pacote atualizado.");
      await queryClient.invalidateQueries({ queryKey: ["operator", "pacotes"] });
      await queryClient.invalidateQueries({ queryKey: ["operator", "pacote", pacoteId] });
      onSuccess?.(pacoteId);
      onClose();
    } catch (err) {
      toast.error(translatePacoteError(err, "Erro ao salvar pacote."));
      if (import.meta.env.DEV) console.error("[PacoteFormModal] submit failed", err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !submitting && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Novo pacote de cargas" : "Editar pacote"}
          </DialogTitle>
          <DialogDescription>
            Selecione até {MAX_CARGAS_POR_PACOTE} cargas PREMIUM abertas para montar a viagem
            casada. O valor total é definido manualmente pelo operador.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pacote-valor-total">Valor total (R$)</Label>
            <Input
              id="pacote-valor-total"
              type="number"
              min="0"
              step="0.01"
              value={valorTotalRaw}
              onChange={(e) => setValorTotalRaw(e.target.value)}
              placeholder="0,00"
              disabled={submitting}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Cargas selecionadas ({items.length}/{MAX_CARGAS_POR_PACOTE})</Label>
            <PacoteCargasReorder
              items={items}
              onChange={setItems}
              disabled={submitting}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Adicionar carga elegível</Label>
            <p className="text-xs text-muted-foreground">
              Apenas cargas com visibilidade PREMIUM, status aberta e sem outro pacote ativo
              aparecem aqui.
            </p>
            <PacoteCargaSelector
              selectedCargaIds={selectedIds}
              currentPacoteId={mode === "edit" && pacote ? pacote.pacote.id : null}
              onAdd={handleAddCarga}
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={
              submitting || items.length === 0 || items.length > MAX_CARGAS_POR_PACOTE
            }
          >
            {submitting
              ? "Salvando..."
              : mode === "create"
                ? "Criar pacote"
                : "Salvar alterações"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PacoteFormModal;
