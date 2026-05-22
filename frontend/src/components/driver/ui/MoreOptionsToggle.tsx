import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * MoreOptionsToggle — progressive disclosure isolado do fluxo do motorista.
 *
 * Componente reutilizável usado em cadastro-v2 para esconder campos opcionais
 * ou auto-preenchidos atrás de um botão "Mostrar mais campos". Reduz
 * sobrecarga cognitiva no formulário sem remover funcionalidade.
 *
 * Comportamento:
 * - Botão min-h 44px (touch-friendly), chevron com rotação animada
 * - `children` esconde quando colapsado (aria-hidden + display:none)
 * - `defaultOpen` controla estado inicial (default `false`)
 * - `forceOpen` reabre programaticamente (ex: OCR falhou no CRLV — abrir
 *   manualmente). Quando muda de false→true, expande; quando true→false
 *   não fecha (usuário pode ainda ter editado).
 *
 * @example
 *   <MoreOptionsToggle label="Mais campos opcionais">
 *     <TelefoneAlternativo />
 *     <Pancary />
 *   </MoreOptionsToggle>
 */
export interface MoreOptionsToggleProps {
  /** Texto do botão quando colapsado. */
  label?: string;
  /** Texto do botão quando expandido. Default: "Mostrar menos". */
  collapseLabel?: string;
  /** Inicia expandido? */
  defaultOpen?: boolean;
  /**
   * Quando muda de `false` para `true`, força a expansão (ex: OCR falhou,
   * precisa revelar formulário manual). Não fecha automaticamente.
   */
  forceOpen?: boolean;
  /**
   * Sinaliza erro/incompletude no conteúdo escondido. Quando vira `true`,
   * auto-expande (defense in depth p/ Bug 3 — campos obrigatórios escondidos
   * que travam o "Continuar" sem mensagem). Também aplica estilo destacado
   * (borda destructive) e exibe ícone de alerta no header quando colapsado.
   */
  hasError?: boolean;
  /**
   * Quantidade de campos obrigatórios pendentes dentro da seção. Quando >0
   * e colapsado, renderiza badge "(N obrigatórios)" ao lado do label para
   * o motorista entender por que o Continuar está disabled.
   */
  errorCount?: number;
  /** Conteúdo escondido. */
  children: React.ReactNode;
  /** Classes adicionais no wrapper. */
  className?: string;
  /** Callback opcional para analytics futuro. */
  onToggle?: (open: boolean) => void;
}

export function MoreOptionsToggle({
  label = "Mostrar mais campos",
  collapseLabel = "Mostrar menos",
  defaultOpen = false,
  forceOpen,
  hasError = false,
  errorCount,
  children,
  className,
  onToggle,
}: MoreOptionsToggleProps) {
  const [open, setOpen] = useState<boolean>(defaultOpen || Boolean(forceOpen));
  const contentId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Quando forceOpen vira true, expande. Não fecha se voltar a false.
  useEffect(() => {
    if (forceOpen && !open) {
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceOpen]);

  // Defense in depth (Bug 3): erro em campo escondido auto-expande.
  // A-02 P1: além de scroll, foca primeiro campo inválido para SR anunciar.
  useEffect(() => {
    if (hasError && !open) {
      setOpen(true);
      if (typeof window !== "undefined") {
        // requestAnimationFrame garante que o conteúdo já está expandido.
        requestAnimationFrame(() => {
          containerRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
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

  const showErrorBadge = !open && typeof errorCount === "number" && errorCount > 0;

  return (
    <div ref={containerRef} className={cn("space-y-3", className)}>
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        aria-controls={contentId}
        className={cn(
          "inline-flex w-full min-h-[44px] items-center justify-between gap-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm font-medium transition hover:bg-muted/60 sm:w-auto",
          hasError
            ? "border-destructive text-destructive bg-destructive/5 hover:bg-destructive/10"
            : "border-border text-foreground",
        )}
      >
        <span className="flex items-center gap-2 text-left">
          {hasError && !open ? (
            <AlertCircle
              className="h-4 w-4 shrink-0 text-destructive"
              aria-hidden="true"
            />
          ) : null}
          <span>{open ? collapseLabel : label}</span>
          {showErrorBadge ? (
            <span
              className="inline-flex items-center rounded-full bg-destructive px-2 py-0.5 text-xs font-semibold text-destructive-foreground"
              aria-label={`${errorCount} ${
                errorCount === 1 ? "campo obrigatório" : "campos obrigatórios"
              } pendentes`}
            >
              {errorCount} {errorCount === 1 ? "obrigatório" : "obrigatórios"}
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
