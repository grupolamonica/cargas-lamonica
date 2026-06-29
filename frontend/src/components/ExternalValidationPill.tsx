import { BadgeCheck, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Selo de validação externa (Angellira / ASPX), reutilizado na tela de Motoristas
 * e no Monitor. A COR diz o status: azul = encontrado/vigente, vermelho = não
 * encontrado, cinza = não consultado. Sem texto de status — só o ícone + o nome
 * (compacto). Detalhe completo + escopo (motorista/cavalo/carreta) no tooltip.
 */
export function ExternalValidationPill({
  label,
  found,
  scope,
  compact = false,
}: {
  label: string;
  found: boolean | null | undefined;
  scope?: string;
  compact?: boolean;
}) {
  const state = found === null || found === undefined ? "unknown" : found ? "ok" : "no";
  const cls =
    state === "ok"
      ? "border-primary/15 bg-primary/8 text-primary"
      : state === "no"
        ? "border-red-300/60 bg-red-50 text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        : "border-border/50 bg-muted/30 text-muted-foreground/60";
  const Icon = state === "no" ? XCircle : BadgeCheck;
  const statusWord = state === "ok" ? "ok" : state === "no" ? "não encontrado" : "não consultado";
  const tip = `${label}${scope ? ` (${scope})` : ""}: ${statusWord}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex cursor-default items-center rounded-full border font-semibold leading-none",
            compact ? "gap-1 px-1.5 py-1 text-[0.6rem]" : "gap-1.5 px-2.5 py-1 text-xs",
            cls,
          )}
        >
          <Icon className={compact ? "h-3 w-3 shrink-0" : "h-3.5 w-3.5 shrink-0"} />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
