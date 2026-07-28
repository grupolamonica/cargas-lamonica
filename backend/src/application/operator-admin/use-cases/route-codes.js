import { selectAllParallel } from "../../../infrastructure/supabase/paginate.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { normalizeRouteCodeLocation } from "../../../domain/operator-admin/route-utils.js";

// Chave estável da rota p/ o CÓDIGO exibido: origem→destino canonicalizados por
// GRAFIA (normalizeRouteCodeLocation) — dobra acento/caixa/espaço, sufixo de UF
// ("/BA" vs " / BA") e sufixo operacional ("-03"). Antes usava só
// trim+minúsculo+colapsa-espaço, então a MESMA rota gravada em formatos
// diferentes (planilha "Simoes Filho / BA" vs sistema "Simoes Filho/BA") gerava
// CÓDIGOS diferentes (rota 1 vs 188) — a origem das rotas "duplicadas". Sub-locais
// distintos (Salvador Pirajá vs Retiro) permanecem separados (não usa apelidos).
const norm = (s) => normalizeRouteCodeLocation(s);
const keyOf = (origem, destino) => `${norm(origem)}|${norm(destino)}`;

/**
 * Atribui (sob demanda) e anexa o CÓDIGO sequencial da rota a cada linha do
 * Monitor. Código estável por origem→destino (tabela monitor_route_codes,
 * codigo = IDENTITY). Usado só na leitura do Monitor (operator-only) — o portal
 * do motorista não passa por aqui. Best-effort: nunca quebra a leitura.
 */
export async function attachRouteCodes(supabaseClient, items, correlationId = null) {
  try {
    const distinct = new Map();
    for (const it of items) {
      const ok = norm(it.origem);
      const dk = norm(it.destino);
      if (!ok && !dk) continue;
      distinct.set(`${ok}|${dk}`, { origin_key: ok, destination_key: dk });
    }
    if (distinct.size === 0) return items;

    const readAll = () =>
      selectAllParallel(supabaseClient, "monitor_route_codes", {
        columns: "origin_key, destination_key, codigo",
        orderColumn: "codigo",
        correlationId,
      });

    let rows = await readAll();
    const codeByKey = new Map(rows.map((r) => [`${r.origin_key}|${r.destination_key}`, r.codigo]));

    // Rotas ainda sem código → cria (codigo IDENTITY auto-atribui). Idempotente.
    const missing = [...distinct.values()].filter((r) => !codeByKey.has(`${r.origin_key}|${r.destination_key}`));
    if (missing.length > 0) {
      await supabaseClient
        .from("monitor_route_codes")
        .upsert(missing, { onConflict: "origin_key,destination_key", ignoreDuplicates: true });
      rows = await readAll();
      for (const r of rows) codeByKey.set(`${r.origin_key}|${r.destination_key}`, r.codigo);
    }

    for (const it of items) {
      const c = codeByKey.get(keyOf(it.origem, it.destino));
      if (c != null) it.routeCodigo = c;
    }
    return items;
  } catch (err) {
    logStructuredEvent("warn", "monitor.route-codes-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return items;
  }
}
