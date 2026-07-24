/**
 * Dedup da visão unificada do Monitor (planilha ∪ sistema) por LH.
 *
 * Se uma carga do SISTEMA (lh_manual) tem o MESMO LH de uma linha da PLANILHA,
 * é a MESMA viagem aparecendo duas vezes (ex.: viagem lançada no sistema que
 * depois entrou na planilha pelo sync). A planilha/SPX é a fonte de verdade do
 * status operacional → mantém-se a linha da PLANILHA e esconde-se a duplicata do
 * sistema. A unicidade é garantida na criação/edição (código de viagem único),
 * mas este dedup cobre a janela de corrida (lançou antes de o sync trazer a
 * viagem) e as duplicatas que já existiam.
 *
 * Puro/testável. Não muta os arrays de entrada.
 *
 * @param {Array<{lh?: string}>} sheetRows linhas da planilha (fonte de verdade)
 * @param {Array<{lh?: string}>} systemRows cargas do sistema (lh_manual)
 * @returns {{ rows: Array, dropped: number }} systemRows sem as duplicatas + quantas caíram
 */
export function dedupeSystemRowsByLh(sheetRows, systemRows) {
  const norm = (v) => (v ?? "").toString().trim();
  const sheetLhs = new Set();
  for (const r of sheetRows || []) {
    const k = norm(r?.lh);
    if (k) sheetLhs.add(k);
  }
  let dropped = 0;
  const rows = (systemRows || []).filter((r) => {
    const k = norm(r?.lh);
    if (k && sheetLhs.has(k)) {
      dropped += 1;
      return false;
    }
    return true;
  });
  return { rows, dropped };
}

/**
 * Reconcilia a visão unificada do Monitor (planilha ∪ sistema) por LH, decidindo
 * QUAL linha vence quando o MESMO LH existe nos dois lados:
 *
 *  - Planilha COM motorista → a planilha VENCE (fonte de verdade do SPX em
 *    execução); a duplicata do sistema é escondida (dedup normal).
 *  - Planilha SEM motorista + carga LANÇADA no sistema (lifecycle OPEN) → a carga
 *    do sistema VENCE e a linha VAZIA da planilha é escondida — seja um spot ainda
 *    sem motorista (Disponível) ou uma carga lançada que o operador já alocou.
 *    Sem isso, uma carga que o operador lançou some do Monitor (mascarada por uma
 *    linha de planejamento vazia da planilha Shopee, ex.: status "AGUARDANDO
 *    CHEGAR NO CLIENTE"/"NO SHOW" sem motorista na planilha).
 *
 * Puro/testável. Não muta os arrays de entrada.
 *
 * @param {Array<{lh?: string, motoristas?: string}>} sheetRows
 * @param {Array<{lh?: string, motoristas?: string, lifecycleStatus?: string}>} systemRows
 * @returns {{ sheetRows: Array, systemRows: Array, dropped: number }}
 *   sheetRows visíveis (sem as linhas vazias mascaradoras) + systemRows sem duplicatas.
 */
export function reconcileMonitorDuplicates(sheetRows, systemRows) {
  const norm = (v) => (v ?? "").toString().trim();
  const hasDriver = (r) => norm(r?.motoristas) !== "";

  // LHs de cargas LANÇADAS no sistema (lifecycle OPEN) — o operador lançou pra
  // oferecer ao motorista; devem aparecer no Monitor (spot Disponível OU já com o
  // motorista alocado). Inclui as com motorista: uma carga lançada+alocada também
  // era mascarada por uma linha vazia da planilha (ex.: sheet "NO SHOW").
  const launchedOpenLhs = new Set(
    (systemRows || [])
      .filter((r) => norm(r?.lh) && String(r?.lifecycleStatus || "").toUpperCase() === "OPEN")
      .map((r) => norm(r.lh)),
  );

  // Esconde a linha VAZIA da planilha (sem motorista) quando há carga lançada p/ o
  // mesmo LH — assim o dedup abaixo deixa a carga do sistema sobreviver. A planilha
  // COM motorista (execução real no SPX) permanece e o dedup esconde a duplicata.
  const visibleSheetRows = (sheetRows || []).filter((r) => {
    const lh = norm(r?.lh);
    return !(lh && !hasDriver(r) && launchedOpenLhs.has(lh));
  });

  const { rows: dedupedSystemRows, dropped } = dedupeSystemRowsByLh(visibleSheetRows, systemRows);
  return { sheetRows: visibleSheetRows, systemRows: dedupedSystemRows, dropped };
}
