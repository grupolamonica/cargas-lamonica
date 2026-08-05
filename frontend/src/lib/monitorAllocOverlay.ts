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
 * Motorista da linha para uso em campo EDITÁVEL.
 *
 * O Monitor injeta um motorista VIEW-ONLY nas linhas reservadas pela Fila (o rótulo
 * "Reservado (fila) · <telefone>", ou o nome do lead) só para a linha não parecer
 * vazia — isso NÃO é alocação gravada em `cargas.alloc_*`.
 *
 * Os modais pré-preenchem o campo de motorista a partir de `row.motoristas` e o save
 * SEMPRE reenvia o campo. Usar o valor cru fazia o rótulo ser PERSISTIDO como
 * motorista real quando o operador salvava qualquer outra coisa na carga (trocar o
 * destino, por exemplo). Para EXIBIR, use `row.motoristas` normalmente; para
 * pré-preencher/comparar campo editável, use esta função.
 */
export function editableDriver(
  row?: { motoristas?: string | null; motoristaViewOnly?: boolean } | null,
): string {
  if (!row || row.motoristaViewOnly) return "";
  return row.motoristas ?? "";
}

// Ordem do pipeline operacional. ESPELHA `STATUS_PIPELINE` de
// backend/src/domain/operator-admin/aspx-status-rules.js (fonte única da regra) —
// mudou lá, muda aqui. Estados de EXCEÇÃO (CANCELADO/DEVOLVIDO/NO SHOW) ficam
// FORA de propósito: não têm posição, então nunca são "ultrapassados".
const STATUS_PIPELINE = [
  "AGUARDANDO ACEITE",
  "AGUARDANDO CHEGAR NO CLIENTE",
  "AGUARDANDO CARREGAMENTO",
  "CARREGANDO",
  "CARREGADO",
  "CTE EM EMISSÃO",
  "CTE ENVIADO",
  "AGUARDANDO DESCARGA",
  "DESCARREGANDO",
  "DESCARREGADO",
];

const norm = (v: string | null | undefined) => String(v ?? "").trim().toUpperCase();

/**
 * O status AO VIVO do SPX pode sobrepor o `exibido`? MESMA regra do backend
 * (`shouldOverlayLiveSpxStatus`): só AVANÇA.
 *  - exibido vazio → qualquer rótulo do SPX é melhor que nada;
 *  - ambos no pipeline → só se o SPX estiver À FRENTE;
 *  - fora do pipeline (qualquer lado) → preserva o exibido.
 */
function spxAdvancesOver(exibido: string | null | undefined, spx: string | null | undefined): boolean {
  const cur = norm(exibido);
  const nw = norm(spx);
  if (!nw) return false;
  if (!cur) return true;
  if (cur === nw) return false;
  const a = STATUS_PIPELINE.indexOf(nw);
  const b = STATUS_PIPELINE.indexOf(cur);
  if (a < 0 || b < 0) return false;
  return a > b;
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
 *  - status → SPX ao vivo (`row.spxStatus`, anexado pelo backend) sobrepõe o alloc_status
 *    SÓ QUANDO AVANÇA no pipeline (spxAdvancesOver) — assim ele ainda desfaz o override
 *    "congelado" no instante da atribuição, mas não rebaixa um status deliberado que o
 *    SPX não conhece (CTE EM EMISSÃO / CTE ENVIADO). Sem avanço → `||`: alloc_status
 *    vence, senão o status da linha. Terminal local (cancelado/no-show) do operador é
 *    preservado mesmo sobre o SPX.
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
  // O override só cede quando o SPX AVANÇA (mesma regra do backend). Antes o
  // `spxStatus` vencia SEMPRE, e como ele viaja na LINHA (não no overlay), o valor
  // do fetch ANTERIOR sobrevivia ao save otimista: o operador salvava
  // `CTE EM EMISSÃO` (que o SPX não conhece) e a linha voltava na hora pro rótulo
  // do SPX — `CARREGADO` —, exatamente o "reverteu sozinho" relatado.
  const exibido = allocStatus || row.status;
  const status = !isLocalTerminal && spxAdvancesOver(exibido, row.spxStatus)
    ? (row.spxStatus as string)
    : (alloc.alloc_status || row.status);
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
