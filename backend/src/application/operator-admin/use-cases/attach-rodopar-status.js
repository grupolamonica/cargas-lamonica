import { selectAllParallel } from "../../../infrastructure/supabase/paginate.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { resolveOperatorDirectory } from "./audit-logs-read-model.js";

/**
 * Marca, em cada linha do Monitor, o Check Rodopar (DC-260) por LH:
 *   0 = não lançado (vermelho) · 1 = lançado (preto) · 2 = lançado incorreto (azul).
 * Lê monitor_rodopar_status (por LH, independente de existir carga — o Monitor é a
 * visão da planilha). Best-effort: nunca quebra a leitura; linha sem registro fica
 * rodoparStatus = 0. Reservas ficam sem o campo. Mesma fase de attachRouteRegistration.
 *
 * Também resolve QUEM alterou por último (updated_by → nome do operador, via diretório
 * de auth) e QUANDO (updated_at), p/ o modal da carga mostrar "alterado por … em …".
 *
 * Resultado em cada item: it.rodoparStatus = 0|1|2, it.rodoparUpdatedBy (nome|null),
 * it.rodoparUpdatedAt (ISO|null).
 */
export async function attachRodoparStatus(supabaseClient, items, correlationId = null) {
  try {
    const rows = await selectAllParallel(supabaseClient, "monitor_rodopar_status", {
      columns: "lh, status, updated_at, updated_by",
      orderColumn: "lh",
      correlationId,
    });
    // Diretório de operadores (id → nome) só quando houver alguém p/ resolver.
    // Best-effort: se o diretório de auth falhar, o "quem" fica null (não quebra).
    let directory = new Map();
    if (rows.some((r) => r.updated_by)) {
      try {
        directory = await resolveOperatorDirectory();
      } catch {
        directory = new Map();
      }
    }
    const byLh = new Map(
      rows.map((r) => {
        const info = r.updated_by ? directory.get(r.updated_by) : null;
        return [
          r.lh,
          {
            status: Number(r.status) || 0,
            by: info?.displayName || info?.email || null,
            at: r.updated_at || null,
          },
        ];
      }),
    );
    for (const it of items) {
      if (it.reserva) continue;
      const rec = byLh.get(it.lh);
      it.rodoparStatus = rec?.status ?? 0;
      it.rodoparUpdatedBy = rec?.by ?? null;
      it.rodoparUpdatedAt = rec?.at ?? null;
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
