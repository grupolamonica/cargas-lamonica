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
