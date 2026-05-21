import {
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2 } from "lucide-react";

import { cn } from "@/lib/utils";

export type WizardStepStatus = "pending" | "active" | "completed";

export interface WizardStepCardProps {
  /** Posição na ordem (1-based) — usada no badge numerado. */
  position: number;
  /** Total de etapas (para "1 de 4"). */
  total?: number;
  /** Título da seção (ex.: "CNH do motorista"). */
  title: string;
  /** Descrição curta visível quando active. */
  description?: string;
  /** Resumo mostrado quando completed (ex.: "GILSON ALTINO — 998.322.596-49"). */
  summary?: string;
  /** Status controlado pelo pai. */
  status: WizardStepStatus;
  /** Quando user clica na barra colapsada completed → re-abre essa seção. */
  onActivate: () => void;
  /** Conteúdo (form da sub-etapa). Sempre renderizado para preservar state. */
  children: ReactNode;
  className?: string;
}

/**
 * Detecta `prefers-reduced-motion` para desabilitar animações em motoristas que
 * optaram por menos movimento (a11y). Lê via matchMedia para refletir mudanças
 * em tempo real.
 */
function usePrefersReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (event: MediaQueryListEvent) => setPrefersReduced(event.matches);
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  return prefersReduced;
}

function WizardStepCardImpl({
  position,
  total,
  title,
  description,
  summary,
  status,
  onActivate,
  children,
  className,
}: WizardStepCardProps) {
  const headerId = useId();
  const contentId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  const isActive = status === "active";
  const isCompleted = status === "completed";
  const isPending = status === "pending";

  // max-height animation: mede o inner e seta como altura alvo enquanto aberto;
  // colapsa para 0 quando inactive. Usa requestAnimationFrame p/ evitar flash.
  const [maxHeight, setMaxHeight] = useState<number | "none">(isActive ? "none" : 0);

  useEffect(() => {
    if (prefersReducedMotion) {
      setMaxHeight(isActive ? "none" : 0);
      return;
    }
    const inner = innerRef.current;
    if (!inner) return;

    if (isActive) {
      // Abre: começa em 0 → mede → seta altura medida → após transição vira "none"
      const measured = inner.scrollHeight;
      setMaxHeight(measured);
      const transitionEnd = (ev: TransitionEvent) => {
        if (ev.propertyName === "max-height") {
          setMaxHeight("none");
        }
      };
      const node = contentRef.current;
      node?.addEventListener("transitionend", transitionEnd);
      return () => node?.removeEventListener("transitionend", transitionEnd);
    }
    // Fecha: se está em "none", primeiro fixa em scrollHeight para que a
    // transição saia de um número concreto.
    if (maxHeight === "none") {
      const measured = inner.scrollHeight;
      setMaxHeight(measured);
      // forçar reflow + agendar colapso
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setMaxHeight(0));
      });
    } else {
      setMaxHeight(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, prefersReducedMotion]);

  // Quando o conteúdo cresce/encolhe enquanto active (ex.: prefill chega via
  // OCR), reflete via ResizeObserver para evitar conteúdo cortado.
  useEffect(() => {
    if (!isActive || prefersReducedMotion) return;
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (maxHeight !== "none") {
        setMaxHeight(inner.scrollHeight);
      }
    });
    observer.observe(inner);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, prefersReducedMotion]);

  const badgeBase =
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums";
  const badgeColor = isCompleted
    ? "bg-emerald-100 text-emerald-700"
    : isActive
      ? "bg-primary text-primary-foreground"
      : "bg-muted text-muted-foreground";

  const cardClass = cn(
    "rounded-2xl border transition-colors",
    isActive && "border-primary/40 bg-card shadow-sm",
    isCompleted && "border-emerald-200 bg-emerald-50/40",
    isPending && "border-border bg-muted/10",
    className,
  );

  const headerCommonClass =
    "flex w-full items-start gap-3 rounded-2xl px-4 py-3 text-left sm:px-5 lg:px-6 lg:py-4";

  const headerInteractiveClass = cn(
    headerCommonClass,
    "min-h-[56px] cursor-pointer transition-colors hover:bg-foreground/[0.02] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
  );

  const headerStaticClass = cn(headerCommonClass, "min-h-[56px]");

  const headerLabel = isCompleted
    ? `Concluído: ${title}. Toque para editar.`
    : isPending
      ? `${title}. Toque para abrir.`
      : title;

  // Headers de cards inactive (completed OU pending) sao interativos para
  // permitir navegacao livre — motorista pode pular para qualquer secao
  // mesmo sem ter completado as anteriores (fix 18/05).
  const headerContent = (
    <>
      <span className={cn(badgeBase, badgeColor)} aria-hidden="true">
        {isCompleted ? <CheckCircle2 className="h-5 w-5" /> : position}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p
            id={headerId}
            className={cn(
              "text-base font-semibold text-foreground",
              isPending && "text-muted-foreground",
            )}
          >
            {title}
          </p>
          {total ? (
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {position} de {total}
            </span>
          ) : null}
        </div>
        {isCompleted && summary ? (
          <p className="mt-0.5 truncate text-sm text-emerald-700">{summary}</p>
        ) : null}
        {isActive && description ? (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </>
  );

  return (
    <section
      className={cardClass}
      aria-labelledby={headerId}
      data-status={status}
      data-wizard-step-card=""
    >
      {isActive ? (
        <div className={headerStaticClass}>{headerContent}</div>
      ) : (
        <button
          type="button"
          onClick={onActivate}
          className={headerInteractiveClass}
          aria-expanded={false}
          aria-controls={contentId}
          aria-label={headerLabel}
        >
          {headerContent}
        </button>
      )}

      <div
        id={contentId}
        ref={contentRef}
        role="region"
        aria-labelledby={headerId}
        aria-hidden={!isActive}
        style={{
          maxHeight: maxHeight === "none" ? "none" : `${maxHeight}px`,
          opacity: isActive ? 1 : 0,
          transition: prefersReducedMotion
            ? "none"
            : "max-height 250ms ease-out, opacity 200ms ease-out",
          overflow: maxHeight === "none" ? "visible" : "hidden",
          pointerEvents: isActive ? "auto" : "none",
        }}
      >
        <div ref={innerRef} className="border-t border-border/60 px-4 py-4 sm:px-5 lg:px-6 lg:py-5">
          {children}
        </div>
      </div>
    </section>
  );
}

export const WizardStepCard = memo(WizardStepCardImpl);
