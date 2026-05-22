import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface PacoteReorderItem {
  cargaId: string;
  ordem: number;
  label: string;
  /** Texto auxiliar abaixo do label (ex.: cliente, valor). Opcional. */
  meta?: string;
}

interface Props {
  /** Itens já ordenados ascendente por `ordem`. */
  items: PacoteReorderItem[];
  /** Callback com nova lista (ordem reatribuída 1..N). */
  onChange: (next: PacoteReorderItem[]) => void;
  /** Desabilita todas as ações de mutação (ex.: durante submit). */
  disabled?: boolean;
}

/**
 * Reordenador minimalista por setinhas ▲▼ + remoção (🗑).
 *
 * Decisão deliberada (plan 10-07): sem drag-and-drop lib externa para manter
 * footprint mínimo. Para 1..3 itens (limite do pacote), setinhas são UX
 * suficiente.
 *
 * Cada mutação reatribui ordens sequenciais (1..N) e dispara `onChange`.
 */
const PacoteCargasReorder = ({ items, onChange, disabled = false }: Props) => {
  const reindex = (arr: PacoteReorderItem[]): PacoteReorderItem[] =>
    arr.map((item, idx) => ({ ...item, ordem: idx + 1 }));

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(reindex(next));
  };

  const remove = (cargaId: string) => {
    onChange(reindex(items.filter((it) => it.cargaId !== cargaId)));
  };

  if (items.length === 0) {
    return (
      <div
        className="text-sm text-muted-foreground border border-dashed rounded-md px-3 py-4 text-center"
        data-testid="reorder-empty"
      >
        Nenhuma carga adicionada ao pacote ainda.
      </div>
    );
  }

  return (
    <ol
      role="list"
      className="space-y-1.5"
      data-testid="reorder-list"
    >
      {items.map((item, i) => (
        <li
          key={item.cargaId}
          data-testid="reorder-item"
          className="flex items-center gap-2 p-2 border rounded-md bg-background"
        >
          <span
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary"
            aria-label={`Posição ${item.ordem}`}
          >
            {item.ordem}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{item.label}</p>
            {item.meta ? (
              <p className="text-xs text-muted-foreground truncate">{item.meta}</p>
            ) : null}
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={disabled || i === 0}
            onClick={() => move(i, -1)}
            aria-label={`Mover ${item.label} para cima`}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={disabled || i === items.length - 1}
            onClick={() => move(i, 1)}
            aria-label={`Mover ${item.label} para baixo`}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={disabled}
            onClick={() => remove(item.cargaId)}
            aria-label={`Remover ${item.label} do pacote`}
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </li>
      ))}
    </ol>
  );
};

export default PacoteCargasReorder;
