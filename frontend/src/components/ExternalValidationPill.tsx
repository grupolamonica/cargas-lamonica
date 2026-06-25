import { BadgeCheck, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Selo de validação externa (Angellira / ASPX), reutilizado na tela de Motoristas
 * e no Monitor. Azul (primary) = encontrado/vigente; vermelho = não encontrado;
 * cinza = não consultado. `scope` indica a quem se refere (motorista / cavalo /
 * carreta) — útil quando o mesmo selo aparece para o motorista e para o veículo.
 */
export function ExternalValidationPill({
  label,
  found,
  noText,
  scope,
  compact = false,
}: {
  label: string;
  found: boolean | null | undefined;
  /** Texto mostrado quando NÃO encontrado (ex.: "Não encontrado", "Não cadastrado"). */
  noText: string;
  scope?: string;
  compact?: boolean;
}) {
  const state = found === null || found === undefined ? "unknown" : found ? "ok" : "no";
  const cls =
    state === "ok"
      ? "border-primary/15 bg-primary/8 text-primary"
      : state === "no"
        ? "border-red-300/60 bg-red-50 text-red-600 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
        : "border-border/60 bg-muted/40 text-muted-foreground/70";
  const Icon = state === "no" ? XCircle : BadgeCheck;
  // Verificado (ok): só o selo + o nome (Angellira/ASPX) — sem texto de status.
  const text = state === "ok" ? label : state === "no" ? `${label}: ${noText}` : `${label}: não consultado`;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border font-semibold",
        compact ? "gap-1 px-2 py-0.5 text-[0.62rem]" : "gap-2 px-3 py-1.5 text-xs",
        cls,
      )}
      title={scope ? `${text} (${scope})` : text}
    >
      <Icon className={compact ? "h-3 w-3 shrink-0" : "h-3.5 w-3.5 shrink-0"} />
      <span>
        {text}
        {scope ? <span className="opacity-70"> · {scope}</span> : null}
      </span>
    </span>
  );
}
