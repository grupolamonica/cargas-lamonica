import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { writeAllocationsToSheet, isSheetWritebackEnabled } from "./sheet-writeback.js";

const RECONCILE_BATCH_LIMIT = 100;

// Nome do motorista a partir do validation_summary_json do lead (Angellira
// displayName) — mesma fonte usada pelo write-back de reserva (reflectReservationOnSheet).
function angelliraDisplayName(validationSummaryJson) {
  let summary = validationSummaryJson;
  if (typeof summary === "string") {
    try {
      summary = JSON.parse(summary);
    } catch {
      summary = null;
    }
  }
  const name = summary?.driver?.angelira?.displayName;
  return typeof name === "string" && name.trim() ? name.trim() : "";
}

/**
 * Auto-cura do write-back para a planilha (reconciliador).
 *
 * Grava na planilha as cargas que estão TOMADAS no sistema — reservadas por lead
 * (status RESERVED) OU com motorista alocado pelo operador (alloc_motorista) —
 * mas cuja linha na planilha está EM BRANCO (coluna motorista vazia).
 *
 * Segurança:
 * - **Só preenche vazios**: o candidato precisa estar em branco na planilha
 *   (snapshot). NUNCA sobrescreve um motorista já presente (respeita o dado da
 *   fonte/Shopee).
 * - Escreve só motorista/cavalo/carreta (NÃO manda `status`, para não re-rotular
 *   a coluna de status da planilha).
 * - Cap de {@link RECONCILE_BATCH_LIMIT} por ciclo.
 * - Best-effort: nunca lança. Roda ao fim de cada sync, com o snapshot já fresco.
 *
 * Cobre o gap histórico (cargas tomadas antes do write-back existir/estar ligado
 * ou cujo POST falhou na hora, sem retry).
 */
export async function reconcileTakenCargosToSheet({ log } = {}) {
  if (!isSheetWritebackEnabled()) return { ok: true, skipped: true, reconciled: 0 };

  const warn = (event, data) =>
    log ? log("warn", event, data) : console.warn(`[reconcile-sheet] ${event}`, data);

  let rows = [];
  try {
    rows = await withPgClient(async (client) => {
      const result = await client.query(
        `
          WITH blank_sheet AS (
            SELECT DISTINCT (e->>'lh') AS lh
            FROM public.sheet_monitor_snapshot s, jsonb_array_elements(s.rows_json) e
            WHERE COALESCE(TRIM(e->>'motoristas'), '') = ''
              AND COALESCE(TRIM(e->>'lh'), '') <> ''
          )
          SELECT c.sheet_lh AS lh,
                 c.alloc_motorista, c.alloc_cavalo, c.alloc_carreta,
                 l.horse_plate, l.trailer_plate, l.validation_summary_json
          FROM public.cargas c
          JOIN blank_sheet b ON b.lh = c.sheet_lh
          LEFT JOIN public.load_public_leads l ON l.id = c.reserved_public_lead_id
          WHERE c.sheet_lh IS NOT NULL AND c.sheet_lh <> ''
            AND (c.status = 'RESERVED' OR COALESCE(TRIM(c.alloc_motorista), '') <> '')
          LIMIT ${RECONCILE_BATCH_LIMIT}
        `,
      );
      return result.rows;
    });
  } catch (err) {
    warn("query-failed", { message: err instanceof Error ? err.message : String(err) });
    return { ok: false, reconciled: 0 };
  }

  const updates = [];
  for (const row of rows) {
    const allocMotorista = (row.alloc_motorista ?? "").toString().trim();
    const motorista = allocMotorista || angelliraDisplayName(row.validation_summary_json);
    const cavalo = (row.alloc_cavalo ?? row.horse_plate ?? "").toString().trim();
    const carreta = (row.alloc_carreta ?? row.trailer_plate ?? "").toString().trim();
    // Nada resolvido para gravar → pula (não faz POST inútil).
    if (!motorista && !cavalo && !carreta) continue;
    updates.push({ lh: String(row.lh).trim(), motorista, cavalo, carreta });
  }

  if (updates.length === 0) return { ok: true, reconciled: 0 };

  const res = await writeAllocationsToSheet(updates, { log }).catch((err) => ({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  }));

  if (!res?.ok) {
    warn("writeback-failed", { attempted: updates.length, res });
    return { ok: false, attempted: updates.length, reconciled: 0 };
  }
  return { ok: true, reconciled: updates.length };
}
