import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";

/**
 * Set com TODOS os LHs presentes no snapshot da planilha (todas as fontes:
 * Shopee, Nestlé, etc.). Usado p/ validar a UNICIDADE do código de viagem ao
 * criar/editar uma carga do SISTEMA — uma viagem já ALOCADA na planilha vive só
 * no snapshot (nunca virou linha em `cargas`), então uma checagem só contra
 * `cargas` não a pegaria e a mesma viagem apareceria duplicada no Monitor.
 *
 * Extrai os LHs no próprio Postgres (jsonb) — devolve só as strings de LH, bem
 * mais leve que baixar o `rows_json` inteiro. Best-effort: em qualquer falha
 * devolve um Set vazio (a checagem contra `cargas` no use-case continua valendo).
 */
export async function readSheetSnapshotLhSet(correlationId = null) {
  try {
    const rows = await withPgClient((client) =>
      client
        .query(
          `SELECT DISTINCT e->>'lh' AS lh
             FROM public.sheet_monitor_snapshot s,
                  LATERAL jsonb_array_elements(s.rows_json) e
            WHERE COALESCE(e->>'lh', '') <> ''`,
        )
        .then((r) => r.rows),
    );
    return new Set(rows.map((r) => String(r.lh).trim()).filter(Boolean));
  } catch (err) {
    logStructuredEvent("warn", "trip-code.snapshot-lhs-read-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return new Set();
  }
}
