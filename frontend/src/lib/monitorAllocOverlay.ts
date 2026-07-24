import type { SheetMonitorAllocation, SheetMonitorRow } from "@/services/readModels";

/**
 * Sobrepõe a alocação do operador (override `alloc_*`) sobre a linha da planilha no
 * Monitor. Semântica IGUAL à do backend (COALESCE):
 *
 *  - motorista/cavalo/carreta → `??` (nullish):
 *      • null  = "sem decisão" (modal "limpar") → cai pro valor da planilha.
 *      • ""    = vazio EXPLÍCITO (arrasto/troca/cascata esvaziou) → fica SEM valor,
 *                sobrepondo a planilha.
 *      • valor = define.
 *    NUNCA `||`: com `||`, um "" (vazio explícito) caía pro valor da planilha — então
 *    ao ARRASTAR o motorista de uma carga p/ outra (troca), a carga de ORIGEM
 *    (esvaziada, alloc="") voltava a mostrar o motorista antigo da planilha
 *    ("sobrescrito, não altera o que foi arrastado"). Este helper trava o `??`.
 *
 *  - status/tipo → `||`: NÃO entram no swap; vazio cai pro valor da linha (status vivo
 *    do SPX; tipo "SISTEMA" nas cargas lançadas).
 *
 * Puro/testável. `alloc` ausente → devolve a linha inalterada.
 */
export function mergeAllocIntoRow(
  row: SheetMonitorRow,
  alloc: SheetMonitorAllocation | undefined,
): SheetMonitorRow {
  if (!alloc) return row;
  const motoristas = alloc.alloc_motorista ?? row.motoristas;
  const status = alloc.alloc_status || row.status;
  return {
    ...row,
    motoristas,
    cavalo: alloc.alloc_cavalo ?? row.cavalo,
    carreta: alloc.alloc_carreta ?? row.carreta,
    status,
    tipo: alloc.alloc_tipo || row.tipo,
    pinned: alloc.alloc_pinned ?? false,
    rodoparStatus: row.rodoparStatus ?? 0,
    hasDriver: Boolean(motoristas),
    isAvailable: !motoristas && !status,
  };
}
