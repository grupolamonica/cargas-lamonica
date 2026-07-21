import { selectAllParallel } from "../../../infrastructure/supabase/paginate.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";

/**
 * Marca, em cada linha do Monitor, o Check Rodopar (DC-260) por LH:
 *   0 = não lançado (vermelho) · 1 = lançado (preto) · 2 = lançado incorreto (azul).
 * Lê monitor_rodopar_status (por LH, independente de existir carga — o Monitor é a
 * visão da planilha). Best-effort: nunca quebra a leitura; linha sem registro fica
 * rodoparStatus = 0. Reservas ficam sem o campo. Mesma fase de attachRouteRegistration.
 *
 * Resultado em cada item: it.rodoparStatus = 0 | 1 | 2.
 */
export async function attachRodoparStatus(supabaseClient, items, correlationId = null) {
  try {
    const rows = await selectAllParallel(supabaseClient, "monitor_rodopar_status", {
      columns: "lh, status",
      orderColumn: "lh",
      correlationId,
    });
    const byLh = new Map(rows.map((r) => [r.lh, Number(r.status) || 0]));
    for (const it of items) {
      if (it.reserva) continue;
      it.rodoparStatus = byLh.get(it.lh) ?? 0;
    }
    return items;
  } catch (err) {
    logStructuredEvent("warn", "monitor.rodopar-status-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return items;
  }
}
