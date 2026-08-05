// Mescla dos snapshots de planilha (sheet_monitor_snapshot) nas linhas do Monitor.
//
// Extraído do caminho READ do Monitor para ser reusado pelo caminho REFRESH
// ("Atualizar planilha"), que montava `baseRows` só com as linhas recém-parseadas
// da Shopee: TODA linha de outra fonte (Nestlé) desaparecia da resposta, e como o
// cliente substitui o cache com o que voltou, o Monitor ficava sem a Nestlé até o
// poll seguinte. A montagem multi-fonte existia só no READ — daí a divergência.
//
// A Shopee é a fonte histórica: `source` nulo ou 'shopee'. Ela NÃO recebe rótulo
// de cliente nem rowKey namespaced (o buildUnifiedMonitor aplica
// getSheetClientName(), byte-idêntico ao comportamento antigo). As demais fontes
// rotulam cada linha com o cliente (clientName gravado no summary_json) e ganham
// rowKey namespaced, para um LH repetido entre planilhas não colidir.

export const SHEET_SNAPSHOT_SHOPEE = "shopee";

/** Snapshot da Shopee = fonte histórica (source nulo ou 'shopee'). */
export function isShopeeSnapshot(snap) {
  const source = snap?.source;
  return !source || source === SHEET_SNAPSHOT_SHOPEE;
}

/**
 * Linhas de UM snapshot que não é da Shopee, rotuladas e namespaced. Linha que já
 * chega com rowKey passa intacta (idempotente). Pura/testável.
 */
export function labelNonShopeeSnapshotRows(snap) {
  const rows = snap?.rows_json ?? [];
  const label = snap?.summary_json?.clientName || snap?.source;
  return rows.map((r) =>
    r?.rowKey
      ? r
      : {
          ...r,
          cliente: r?.cliente ?? label,
          rowKey: `sheet:${snap?.source}:${r?.lh}`,
          source: "planilha",
          // Fonte da PLANILHA da linha (≠ `source`, que é o TIPO de linha:
          // planilha/sistema/reserva). O cliente devolve isto nas escritas do
          // Monitor para o backend resolver a carga no namespace de id certo
          // (createSheetLoadId(lh, source)) — sem isso a escrita numa linha Nestlé
          // dava 404. Ausente = Shopee (fonte histórica).
          sheetSource: snap?.source ?? null,
        },
  );
}

/** Linhas de TODOS os snapshots que não são da Shopee (usado pelo refresh, que já
 *  tem as linhas frescas da Shopee em memória e não deve relê-las do banco). */
export function collectNonShopeeSnapshotRows(snapshotRows) {
  const out = [];
  for (const snap of snapshotRows ?? []) {
    if (isShopeeSnapshot(snap)) continue; // cinto-e-suspensório: o filtro do SELECT já exclui
    out.push(...labelNonShopeeSnapshotRows(snap));
  }
  return out;
}

/**
 * Mescla TODOS os snapshots (Shopee ∪ demais fontes) no conjunto de linhas base do
 * Monitor. Devolve também o synced_at mais recente e se só havia Shopee (o caller
 * usa isso para preservar o summary byte-idêntico da Shopee). Pura/testável.
 */
export function mergeSnapshotRows(snapshotRows) {
  const baseRows = [];
  let latestSyncedAt = null;
  let onlyShopee = true;

  for (const snap of snapshotRows ?? []) {
    if (isShopeeSnapshot(snap)) {
      baseRows.push(...(snap?.rows_json ?? []));
    } else {
      onlyShopee = false;
      baseRows.push(...labelNonShopeeSnapshotRows(snap));
    }
    if (snap?.synced_at && (!latestSyncedAt || snap.synced_at > latestSyncedAt)) {
      latestSyncedAt = snap.synced_at;
    }
  }

  return { baseRows, latestSyncedAt, onlyShopee };
}
