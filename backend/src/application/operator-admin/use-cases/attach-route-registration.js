import { selectAllParallel } from "../../../infrastructure/supabase/paginate.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { createRouteLookupKeys } from "../../../domain/operator-admin/route-utils.js";

/**
 * Marca, em cada linha do Monitor, se o trajeto (origem→destino) tem rota
 * CADASTRADA no catálogo (route_metrics_cache). Casa por chaves canônicas, igual
 * ao matching de métricas de rota das cargas. Best-effort: nunca quebra a leitura
 * (operator-only, mesma fase do attachRouteCodes).
 *
 * Resultado em cada item: it.routeRegistered = true | false (linhas sem
 * origem/destino ficam sem o campo).
 */
export async function attachRouteRegistration(supabaseClient, items, correlationId = null) {
  try {
    const hasRows = items.some((it) => it.origem || it.destino);
    if (!hasRows) return items;

    const rows = await selectAllParallel(supabaseClient, "route_metrics_cache", {
      columns: "origin_key, destination_key",
      orderColumn: "origin_key",
      correlationId,
    });
    const registered = new Set(rows.map((r) => `${r.origin_key}|${r.destination_key}`));

    for (const it of items) {
      if (!it.origem && !it.destino) continue;
      it.routeRegistered = createRouteLookupKeys(it.origem, it.destino).some((key) => registered.has(key));
    }
    return items;
  } catch (err) {
    logStructuredEvent("warn", "monitor.route-registration-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return items;
  }
}
