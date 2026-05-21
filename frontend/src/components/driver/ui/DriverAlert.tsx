import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * DriverAlert — componente de alerta isolado para o fluxo do motorista.
 *
 * Diferente do `Alert` shadcn (genérico), este componente é otimizado para o
 * motorista médio:
 * - Ícone GRANDE (40px) à esquerda — leitura rápida sem ler texto
 * - Título curto e bold (≤6 palavras recomendado)
 * - Descrição curta (≤14 palavras recomendado)
 * - CTAs visíveis e amigáveis ao toque (mobile-first)
 * - 3 níveis com cores intuitivas: info (azul), warning (âmbar), danger (vermelho), success (verde)
 *
 * NÃO substitui o `Alert` shadcn — coexiste. Use este SÓ no fluxo motorista
 * (cadastro-v2, DriverClaimPanel, DriverPortal CTAs).
 *
 * @example
 * <DriverAlert
 *   variant="warning"
 *   title="Documento vence logo"
 *   description="Seu CRLV vence em 15 dias. Renove em breve."
 *   primaryAction={{ label: "Atualizar agora", onClick: () => navigate("/cadastro") }}
 *   secondaryAction={{ label: "Agora não", onClick: dismiss }}
 * />
 */

const driverAlertVariants = cva(
  "rounded-2xl border-2 p-4 sm:p-5 flex gap-3 sm:gap-4 items-start shadow-sm transition-colors",
  {
    variants: {
      variant: {
        info: "bg-sky-50 border-sky-200 text-sky-950 dark:bg-sky-950 dark:border-sky-800 dark:text-sky-100",
        warning:
          "bg-amber-50 border-amber-300 text-amber-950 dark:bg-amber-950 dark:border-amber-800 dark:text-amber-100",
        danger:
          "bg-red-50 border-red-300 text-red-950 dark:bg-red-950 dark:border-red-800 dark:text-red-100",
        success:
          "bg-emerald-50 border-emerald-300 text-emerald-950 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-100",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  },
);

const iconWrapperVariants = cva(
  "flex-shrink-0 flex items-center justify-center rounded-full w-10 h-10 sm:w-12 sm:h-12",
  {
    variants: {
      variant: {
        info: "bg-sky-100 text-sky-700 dark:bg-sky-900 dark:text-sky-200",
        warning:
          "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200",
        danger: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-200",
        success:
          "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  },
);

const defaultIcons: Record<DriverAlertVariant, LucideIcon> = {
  info: Info,
  warning: AlertTriangle,
  danger: XCircle,
  success: CheckCircle2,
};

export type DriverAlertVariant = "info" | "warning" | "danger" | "success";

export interface DriverAlertAction {
  /** Texto curto do botão. ≤3 palavras recomendado. */
  label: string;
  onClick: () => void;
  /** Desabilita botão (ex: requisição em curso). */
  disabled?: boolean;
  /** Mostra spinner. */
  loading?: boolean;
}

export interface DriverAlertProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof driverAlertVariants> {
  /** Título curto. Bold automaticamente. ≤6 palavras recomendado. */
  title: string;
  /** Descrição em 1 frase. ≤14 palavras recomendado. */
  description?: React.ReactNode;
  /** Ícone customizado. Default depende da variant. */
  icon?: LucideIcon;
  /** Esconde o ícone (útil para densidades altas). */
  hideIcon?: boolean;
  /** CTA principal. Botão sólido na cor da variant. */
  primaryAction?: DriverAlertAction;
  /** CTA secundário. Botão outline/ghost. */
  secondaryAction?: DriverAlertAction;
  /** Renderiza children abaixo da descrição (ex: lista de pendências). */
  children?: React.ReactNode;
}

const primaryButtonClassByVariant: Record<DriverAlertVariant, string> = {
  info: "bg-sky-600 hover:bg-sky-700 text-white",
  warning: "bg-amber-600 hover:bg-amber-700 text-white",
  danger: "bg-red-600 hover:bg-red-700 text-white",
  success: "bg-emerald-600 hover:bg-emerald-700 text-white",
};

const secondaryButtonClassByVariant: Record<DriverAlertVariant, string> = {
  info: "border-sky-300 text-sky-800 hover:bg-sky-100 dark:border-sky-700 dark:text-sky-200 dark:hover:bg-sky-900",
  warning:
    "border-amber-400 text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900",
  danger:
    "border-red-400 text-red-900 hover:bg-red-100 dark:border-red-700 dark:text-red-200 dark:hover:bg-red-900",
  success:
    "border-emerald-400 text-emerald-900 hover:bg-emerald-100 dark:border-emerald-700 dark:text-emerald-200 dark:hover:bg-emerald-900",
};

export const DriverAlert = React.forwardRef<HTMLDivElement, DriverAlertProps>(
  function DriverAlert(
    {
      variant = "info",
      className,
      title,
      description,
      icon,
      hideIcon = false,
      primaryAction,
      secondaryAction,
      children,
      ...rest
    },
    ref,
  ) {
    const resolvedVariant: DriverAlertVariant = variant ?? "info";
    const IconComponent = icon ?? defaultIcons[resolvedVariant];

    return (
      <div
        ref={ref}
        role="alert"
        aria-live={resolvedVariant === "danger" ? "assertive" : "polite"}
        className={cn(driverAlertVariants({ variant: resolvedVariant }), className)}
        {...rest}
      >
        {!hideIcon && (
          <div
            className={iconWrapperVariants({ variant: resolvedVariant })}
            aria-hidden="true"
          >
            <IconComponent className="w-5 h-5 sm:w-6 sm:h-6" />
          </div>
        )}

        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-base sm:text-lg leading-tight">
            {title}
          </h3>

          {description && (
            <p className="mt-1 text-sm sm:text-base leading-snug opacity-90">
              {description}
            </p>
          )}

          {children && <div className="mt-2">{children}</div>}

          {(primaryAction || secondaryAction) && (
            <div className="mt-3 sm:mt-4 flex flex-col sm:flex-row gap-2">
              {primaryAction && (
                <Button
                  type="button"
                  size="lg"
                  onClick={primaryAction.onClick}
                  disabled={primaryAction.disabled || primaryAction.loading}
                  className={cn(
                    "min-h-[44px] font-semibold border-0",
                    primaryButtonClassByVariant[resolvedVariant],
                  )}
                >
                  {primaryAction.loading ? "Aguarde..." : primaryAction.label}
                </Button>
              )}

              {secondaryAction && (
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={secondaryAction.onClick}
                  disabled={secondaryAction.disabled || secondaryAction.loading}
                  className={cn(
                    "min-h-[44px] font-semibold bg-transparent",
                    secondaryButtonClassByVariant[resolvedVariant],
                  )}
                >
                  {secondaryAction.loading ? "Aguarde..." : secondaryAction.label}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  },
);
