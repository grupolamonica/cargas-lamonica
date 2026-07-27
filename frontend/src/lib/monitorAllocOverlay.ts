import type { SheetMonitorAllocation, SheetMonitorRow } from "@/services/readModels";

/**
 * Valor EFETIVO de um campo de alocação (motorista/cavalo/carreta) p/ exibição/edição
 * no Monitor. `??` (nullish), IGUAL ao backend (COALESCE):
 *  - null/undefined = "sem decisão" (modal "limpar" / sem override) → valor da planilha.
 *  - ""             = vazio EXPLÍCITO (operador esvaziou num arrasto/troca) → fica vazio.
 *  - valor          = define.
 * NUNCA `||`: com `||`, um "" caía pro valor da planilha e a carga de ORIGEM de uma
 * troca voltava a mostrar o motorista antigo ("sobrescrito"). Fonte única p/ a linha
 * (mergeAllocIntoRow) e o modal de edição (RowDetailModal).
 */
export function effectiveAllocField(
  allocValue: string | null | undefined,
  sheetValue: string | null | undefined,
): string {
  return allocValue ?? sheetValue ?? "";
}

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
 *  - status → SPX autoritativo: se o backend anexou `row.spxStatus` (carga com motorista +
 *    LH SPX ao vivo), ele VENCE o alloc_status (que "congelava" no instante da atribuição).
 *    Sem spxStatus → `||`: alloc_status vence, senão o status vivo da linha. Terminal local
 *    (cancelado/no-show) do operador é preservado mesmo sobre o SPX.
 *  - tipo → `||`: NÃO entra no swap; vazio cai pro valor da linha ("SISTEMA" nas lançadas).
 *
 * Puro/testável. `alloc` ausente → devolve a linha inalterada.
 */
export function mergeAllocIntoRow(
  row: SheetMonitorRow,
  alloc: SheetMonitorAllocation | undefined,
): SheetMonitorRow {
  if (!alloc) return row;
  const motoristas = effectiveAllocField(alloc.alloc_motorista, row.motoristas);
  // Status operacional: quando o backend anexou o status AO VIVO do SPX (`spxStatus`,
  // só em cargas com motorista + LH que casa uma viagem SPX), ele é AUTORITATIVO. O
  // override do operador (alloc_status) NÃO pode remascará-lo: era exatamente o bug —
  // ao alocar/editar, um `alloc_status` era gravado com o SPX daquele instante ("AGUARDANDO
  // CHEGAR NO CLIENTE") e depois "congelava", escondendo o avanço real do SPX (CARREGADO,
  // DESCARGA…). Isso alinha o front à decisão que o backend JÁ toma (status = spxStatus).
  // Exceção: um status terminal LOCAL do operador (cancelado/no-show/desistiu) é preservado
  // — decisão explícita que o SPX não reflete. Sem `spxStatus` (não-SPX, sem motorista, ou
  // sidecar fora do ar) → o override alloc_status volta a valer (comportamento antigo).
  const allocStatus = (alloc.alloc_status || "").trim();
  const isLocalTerminal = /cancel|desist|no[\s-]*show/i.test(allocStatus);
  const status = row.spxStatus && !isLocalTerminal ? row.spxStatus : (alloc.alloc_status || row.status);
  return {
    ...row,
    motoristas,
    cavalo: effectiveAllocField(alloc.alloc_cavalo, row.cavalo),
    carreta: effectiveAllocField(alloc.alloc_carreta, row.carreta),
    status,
    tipo: alloc.alloc_tipo || row.tipo,
    pinned: alloc.alloc_pinned ?? false,
    rodoparStatus: row.rodoparStatus ?? 0,
    hasDriver: Boolean(motoristas),
    isAvailable: !motoristas && !status,
  };
}
