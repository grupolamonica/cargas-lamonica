import { logStructuredEvent } from "../security-log.js";

// Lê TODAS as linhas de um SELECT paginando em blocos. O PostgREST capa a
// resposta em 1000 linhas server-side (.limit é clampado em silêncio), então
// leituras de tabela cheia precisam paginar com .range. `buildQuery(from, to)`
// deve devolver a query supabase-js JÁ com select/filtros/order + .range(from,to).
//
// Em falha de página: 1 retry. Se persistir:
//   - partialOnError=false (padrão): LANÇA — o chamador não deve servir dado
//     parcial como se fosse completo (ex.: mapa de selos do Monitor).
//   - partialOnError=true: loga e devolve o que já leu (best-effort, p/ overlays
//     e caminhos onde processar a mais é inofensivo).
// Variante PARALELA: faz 1 count (head) e busca todas as páginas em paralelo
// (Promise.all) em vez de sequencial. ~5x mais rápido em tabelas grandes
// (sheet_monitor_enriched ~5k linhas: 2.6s sequencial → ~0.5s paralelo).
// ATÔMICO: lança se o count ou qualquer página falhar (não devolve parcial).
export async function selectAllParallel(
  supabaseClient,
  table,
  { columns = "*", orderColumn = null, pageSize = 1000, maxPages = 60, correlationId = null } = {},
) {
  const { count, error: countError } = await supabaseClient
    .from(table)
    .select(orderColumn || "*", { count: "exact", head: true });
  if (countError) {
    logStructuredEvent("error", "supabase.parallel-count-failed", {
      correlationId,
      table,
      message: countError.message || String(countError),
    });
    throw new Error(`PARALLEL_COUNT_FAILED:${table}:${countError.code || countError.message || "unknown"}`);
  }
  const total = count ?? 0;
  if (total === 0) return [];
  const pageCount = Math.min(maxPages, Math.max(1, Math.ceil(total / pageSize)));
  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, i) => {
      let query = supabaseClient.from(table).select(columns);
      if (orderColumn) query = query.order(orderColumn, { ascending: true });
      return query.range(i * pageSize, i * pageSize + pageSize - 1);
    }),
  );
  const all = [];
  for (const res of pages) {
    if (res?.error) {
      logStructuredEvent("error", "supabase.parallel-page-failed", {
        correlationId,
        table,
        message: res.error.message || String(res.error),
      });
      throw new Error(`PARALLEL_PAGE_FAILED:${table}:${res.error.code || res.error.message || "unknown"}`);
    }
    all.push(...(res?.data || []));
  }
  return all;
}

export async function selectAllPaginated(
  buildQuery,
  { pageSize = 1000, label = "rows", partialOnError = false, correlationId = null } = {},
) {
  const all = [];
  for (let from = 0; ; from += pageSize) {
    let res = await buildQuery(from, from + pageSize - 1);
    if (res?.error) {
      res = await buildQuery(from, from + pageSize - 1); // retry simples
    }
    if (res?.error) {
      logStructuredEvent("error", "supabase.paginated-read-failed", {
        correlationId,
        label,
        offset: from,
        code: res.error.code || null,
        message: res.error.message || String(res.error),
        partial: partialOnError,
      });
      if (partialOnError) break;
      throw new Error(`PAGINATED_READ_FAILED:${label}:${res.error.code || res.error.message || "unknown"}`);
    }
    const batch = res?.data || [];
    all.push(...batch);
    if (batch.length < pageSize) break;
  }
  return all;
}
