/**
 * Vínculo do motorista (aba "Vinculo" da planilha Lamonica Shopee), exibido como
 * badge ao lado do nome na fila do operador. Os 4 valores conhecidos têm cores
 * dedicadas; qualquer valor novo cai num estilo neutro (slate) sem quebrar a UI.
 */
export interface VinculoStyle {
  label: string;
  /** Classe Tailwind do badge (bg + text, light + dark). */
  className: string;
}

const VINCULO_STYLES: Record<string, VinculoStyle> = {
  "AGREGADO DEDICADO": {
    label: "Agregado dedicado",
    className: "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-200",
  },
  PME: {
    label: "PME",
    className: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200",
  },
  FROTA: {
    label: "Frota",
    className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200",
  },
  PX: {
    label: "PX",
    className: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200",
  },
};

const NEUTRAL_STYLE: VinculoStyle = {
  label: "",
  className: "bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-200",
};

/**
 * Motorista sem vínculo na planilha = TERCEIRO (frota de terceiros). Cor neutra
 * com contorno para ler como "externo", distinta dos 4 vínculos da base.
 */
const TERCEIRO_STYLE: VinculoStyle = {
  label: "Terceiro",
  className:
    "bg-zinc-100 text-zinc-600 ring-1 ring-inset ring-zinc-300 dark:bg-zinc-500/15 dark:text-zinc-300 dark:ring-zinc-600",
};

/**
 * Resolve o estilo do badge de vínculo. Quando o motorista não consta na aba
 * "Vinculo" (sem vínculo), é tratado como TERCEIRO — sempre há badge.
 */
export function resolveVinculoStyle(vinculo: string | null | undefined): VinculoStyle {
  if (!vinculo || !vinculo.trim()) {
    return TERCEIRO_STYLE;
  }

  const key = vinculo.trim().toUpperCase();
  const known = VINCULO_STYLES[key];
  if (known) {
    return known;
  }

  // Valor desconhecido (vínculo fora dos 4 da base): usa o texto original com cor neutra.
  const label = key.charAt(0) + key.slice(1).toLowerCase();
  return { ...NEUTRAL_STYLE, label };
}
