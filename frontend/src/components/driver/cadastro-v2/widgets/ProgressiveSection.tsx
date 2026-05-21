import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * ProgressiveSection — disclosure controlado para campos secundários do wizard.
 *
 * Pensado para o cadastro v2: por padrão, campos não essenciais ficam ocultos
 * atrás de um botão "Mostrar tudo / Dados complementares". Diferente do
 * `MoreOptionsToggle` (mais genérico), esta variante recebe sinais externos
 * do step pai:
 *
 * - `forceExpanded`: quando o pai aciona um toggle global "Ver todos os campos"
 *   ou quando a tentativa de submit detecta erro em algum campo escondido,
 *   o pai força a expansão.
 * - `hasError`: dica visual no header quando há erro de validação dentro da
 *   seção (acompanha o auto-expand).
 *
 * Comportamento de estado:
 * - Estado interno (`open`) reage a `forceExpanded` (sobe para `true` quando
 *   o pai pedir) mas continua respeitando o clique do usuário se decidir
 *   colapsar (efeito puramente local).
 * - `defaultExpanded` controla apenas a primeira renderização (ex.: já há
 *   dados preenchidos vindos do localStorage).
 *
 * Acessibilidade:
 * - `aria-expanded` + `aria-controls` no botão
 * - `role="region"` + `aria-labelledby` no conteúdo
 * - Toque min 44px para mobile
 *
 * @example
 *   const [showAll, setShowAll] = useState(false);
 *   ...
 *   <ProgressiveSection
 *     title="Dados complementares"
 *     description="Banco, PIS, telefone e endereço do dono."
 *     forceExpanded={showAll}
 *     hasError={Boolean(errors.pis)}
 *   >
 *     <PisField />
 *     <CorRacaField />
 *   </ProgressiveSection>
 */
export interface ProgressiveSectionProps {
  /** Texto exibido no botão de disclosure quando colapsado. */
  title: string;
  /** Texto curto opcional embaixo do título (helper). */
  description?: string;
  /** Texto alternativo quando expandido. Default: "Ocultar". */
  collapseLabel?: string;
  /** Inicia expandido na primeira renderização (default false). */
  defaultExpanded?: boolean;
  /**
   * Quando muda de false→true, força expansão. Quando true→false NÃO colapsa
   * automaticamente — usuário pode ter editado e queremos preservar contexto.
   */
  forceExpanded?: boolean;
  /** Mostra ícone/indicador de erro ao lado do título. */
  hasError?: boolean;
  /** Conteúdo escondido. */
  children: React.ReactNode;
  /** Callback opcional para analytics futuro. */
  onToggle?: (open: boolean) => void;
  /** Classes adicionais no wrapper. */
  className?: string;
}

export function ProgressiveSection({
  title,
  description,
  collapseLabel,
  defaultExpanded = false,
  forceExpanded,
  hasError = false,
  children,
  onToggle,
  className,
}: ProgressiveSectionProps) {
  const [open, setOpen] = useState<boolean>(
    defaultExpanded || Boolean(forceExpanded),
  );
  const contentId = useId();
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Pai pede para abrir: expande. Não fecha automaticamente quando volta a false.
  useEffect(() => {
    if (forceExpanded && !open) {
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceExpanded]);

  // Erro detectado em campo escondido: abre automaticamente + foca primeiro
  // campo inválido para SR anunciar (A-02 P1 fix).
  useEffect(() => {
    if (hasError && !open) {
      setOpen(true);
      if (typeof window !== "undefined") {
        requestAnimationFrame(() => {
          const invalid =
            contentRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
          invalid?.focus();
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasError]);

  const handleToggle = () => {
    setOpen((current) => {
      const next = !current;
      onToggle?.(next);
      return next;
    });
  };

  const buttonLabel = open
    ? collapseLabel ?? `Ocultar ${title.toLowerCase()}`
    : title;

  return (
    <div className={cn("space-y-3", className)}>
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        aria-controls={contentId}
        className={cn(
          "inline-flex w-full min-h-[44px] items-center justify-between gap-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm font-medium transition hover:bg-muted/60 sm:w-auto",
          hasError
            ? "border-destructive text-destructive"
            : "border-border text-foreground",
        )}
      >
        <span className="flex flex-col items-start text-left">
          <span>{buttonLabel}</span>
          {description && !open ? (
            <span className="text-sm font-normal text-foreground/70">
              {description}
            </span>
          ) : null}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 transition-transform duration-200",
            open ? "rotate-180" : "rotate-0",
          )}
          aria-hidden="true"
        />
      </button>

      <div
        ref={contentRef}
        id={contentId}
        role="region"
        aria-label={title}
        aria-live="polite"
        hidden={!open}
        aria-hidden={!open}
        className={cn("space-y-3", open ? "block" : "hidden")}
      >
        {children}
      </div>
    </div>
  );
}
