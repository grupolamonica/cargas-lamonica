import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { formatAuditValue } from "@/lib/auditDisplay";
import {
  fetchOperatorAllocationChanges,
  revertAllocationChanges,
  type AllocationChangeCargo,
  type AllocationChangeItem,
} from "@/services/readModels";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Chamado após reverter com sucesso — o Monitor invalida seus dados. */
  onReverted: () => void;
}

const ALLOCATION_CHANGES_QUERY_KEY = ["operator", "allocation-changes"] as const;

/** Chave estável de uma carga dentro de uma operação. */
const cargoKey = (auditLogId: string, c: AllocationChangeCargo) =>
  `${auditLogId}::${c.lh ?? c.cargoId ?? ""}`;

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Uma pílula antes/depois (reaproveita a humanização do log de auditoria). */
function ValuePill({ field, value, tone }: { field: string; value: unknown; tone: "before" | "after" }) {
  return (
    <span
      className={cn(
        "inline-block max-w-[16rem] truncate rounded px-1.5 py-0.5 text-[11px]",
        tone === "before"
          ? "bg-rose-500/10 text-rose-700 line-through dark:text-rose-300"
          : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      )}
    >
      {formatAuditValue(field, value)}
    </span>
  );
}

/** Linha antes → depois de uma carga (motorista/veículo/status). */
function CargoDiff({ cargo, touchesStatus }: { cargo: AllocationChangeCargo; touchesStatus: boolean }) {
  const fields: Array<{ key: keyof typeof cargo.before; label: string }> = [
    { key: "motorista", label: "Motorista" },
    { key: "cavalo", label: "Cavalo" },
    { key: "carreta", label: "Carreta" },
    ...(touchesStatus ? [{ key: "status" as const, label: "Status" }] : []),
  ];
  const rows = fields.filter(
    (f) => (cargo.before[f.key] ?? "") !== (cargo.after[f.key] ?? ""),
  );
  return (
    <div className="space-y-1">
      {rows.map((f) => (
        <div key={f.key as string} className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="w-16 shrink-0 text-muted-foreground">{f.label}</span>
          <ValuePill field={f.key as string} value={cargo.before[f.key]} tone="before" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          <ValuePill field={f.key as string} value={cargo.after[f.key]} tone="after" />
        </div>
      ))}
    </div>
  );
}

export default function RevertChangesModal({ open, onClose, onReverted }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ALLOCATION_CHANGES_QUERY_KEY,
    queryFn: () => fetchOperatorAllocationChanges({ pageSize: 20 }),
    enabled: open,
    staleTime: 15_000,
  });

  const items: AllocationChangeItem[] = data?.items ?? [];

  // Só cargas efetivamente revertíveis (têm estado anterior e não foram mexidas depois).
  const revertableKeyOf = (ev: AllocationChangeItem) =>
    ev.cargos.filter((c) => c.currentMatchesAfter && c.cargoFound).map((c) => cargoKey(ev.auditLogId, c));

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleOperation = (ev: AllocationChangeItem) => {
    const keys = revertableKeyOf(ev);
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = keys.length > 0 && keys.every((k) => next.has(k));
      if (allOn) keys.forEach((k) => next.delete(k));
      else keys.forEach((k) => next.add(k));
      return next;
    });
  };

  const selectedCount = selected.size;

  const revertMut = useMutation({
    mutationFn: () => {
      // Reconstrói os pares (auditLogId, lh|cargoId) a partir das chaves marcadas.
      const payload: Array<{ auditLogId: string; lh?: string; cargoId?: string }> = [];
      for (const ev of items) {
        for (const c of ev.cargos) {
          if (!selected.has(cargoKey(ev.auditLogId, c))) continue;
          payload.push(
            c.lh ? { auditLogId: ev.auditLogId, lh: c.lh } : { auditLogId: ev.auditLogId, cargoId: c.cargoId! },
          );
        }
      }
      return revertAllocationChanges(payload);
    },
    onSuccess: (res) => {
      if (res.revertedCount > 0) {
        toast.success(
          `${res.revertedCount} alteração(ões) revertida(s)` +
            (res.skippedCount > 0 ? ` · ${res.skippedCount} ignorada(s)` : "") + ".",
        );
      } else {
        toast.error(
          res.skipped[0]?.reason || "Nada foi revertido (as cargas podem ter sido alteradas depois).",
        );
      }
      setSelected(new Set());
      onReverted();
      void refetch();
      if (res.skippedCount === 0) onClose();
    },
    onError: (e: Error) => toast.error(e.message || "Erro ao reverter."),
  });

  const anyReserva = items.some((ev) => ev.reserva && ev.revertible);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden rounded-3xl flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="h-5 w-5" /> Reverter últimas mudanças
          </DialogTitle>
          <DialogDescription>
            Suas alterações recentes de alocação no Monitor. Marque as cargas que quer voltar ao
            estado anterior. Só aparece marcável o que ainda não foi alterado depois.
          </DialogDescription>
        </DialogHeader>

        {anyReserva ? (
          <div className="flex shrink-0 items-start gap-2 rounded-2xl border border-amber-400/40 bg-amber-400/10 p-3 text-xs text-amber-800 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Alguma ação gerou/mexeu num <strong>standby (reserva)</strong>. Reverter volta a
              alocação das cargas, mas <strong>não</strong> desfaz a reserva — confira o painel de
              reservas depois, se necessário.
            </span>
          </div>
        ) : null}

        <div className="flex-1 min-h-0 space-y-3 overflow-y-auto pr-1">
          {isLoading ? (
            <p className="p-4 text-sm text-muted-foreground">Carregando suas mudanças…</p>
          ) : items.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              Nenhuma mudança recente de alocação sua para reverter.
            </p>
          ) : (
            items.map((ev) => {
              const revertableKeys = revertableKeyOf(ev);
              const allOn = revertableKeys.length > 0 && revertableKeys.every((k) => selected.has(k));
              return (
                <div key={ev.auditLogId} className="admin-soft-panel rounded-2xl border p-3">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{ev.eventLabel}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {formatWhen(ev.createdAt)}
                        {ev.route ? ` · ${ev.route}` : ""}
                      </p>
                    </div>
                    {ev.revertible ? (
                      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Checkbox checked={allOn} onCheckedChange={() => toggleOperation(ev)} />
                        selecionar tudo
                      </label>
                    ) : (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        não revertível
                      </span>
                    )}
                  </div>

                  {!ev.revertible ? (
                    <p className="text-[11px] italic text-muted-foreground">{ev.reason}</p>
                  ) : (
                    <ul className="space-y-2">
                      {ev.cargos.map((c) => {
                        const key = cargoKey(ev.auditLogId, c);
                        const disabled = !c.currentMatchesAfter || !c.cargoFound;
                        return (
                          <li key={key}>
                            <label
                              className={cn(
                                "flex items-start gap-2 rounded-lg px-2 py-1.5",
                                disabled ? "opacity-60" : "cursor-pointer hover:bg-muted/40",
                              )}
                            >
                              <Checkbox
                                className="mt-0.5"
                                checked={selected.has(key)}
                                disabled={disabled}
                                onCheckedChange={() => toggle(key)}
                              />
                              <div className="min-w-0 flex-1">
                                <p className="mb-0.5 text-[11px] font-medium text-muted-foreground">
                                  {c.lh ?? "carga do sistema"}
                                  {disabled ? (
                                    <span className="ml-1 italic">
                                      — {c.cargoFound ? "alterada depois" : "carga não existe mais"}
                                    </span>
                                  ) : null}
                                </p>
                                <CargoDiff cargo={c} touchesStatus={ev.touchesStatus} />
                              </div>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <span className="text-[11px] text-muted-foreground">
            {selectedCount} carga(s) selecionada(s)
            {isFetching ? " · atualizando…" : ""}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>Cancelar</Button>
            <Button
              onClick={() => revertMut.mutate()}
              disabled={selectedCount === 0 || revertMut.isPending}
              className="gap-1.5"
            >
              {revertMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Reverter selecionadas
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
