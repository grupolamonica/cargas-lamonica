import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { writeAllocationsToSheet, isSheetWritebackEnabled, formatSheetDateLabel } from "./sheet-writeback.js";

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
 * mas cuja linha na planilha está EM BRANCO (coluna motorista vazia). Cobre duas
 * classes:
 *   1) Carga da PLANILHA (sheet_lh): a linha já existe no snapshot mas está em
 *      branco → preenche motorista/veículo (update-only).
 *   2) Carga do SISTEMA (lh_manual, sheet_lh NULL) com motorista alocado no Monitor
 *      mas SEM linha na planilha — a "linha-casca" só é criada no lançamento quando
 *      a viagem está ACEITA, então spots lançados-não-aceitos (auto-lançamento
 *      DC-201) e depois alocados nunca apareciam na planilha. Aqui a linha é
 *      CRIADA-ou-preenchida (createIfMissing) com rota + agenda + motorista.
 *
 * Segurança:
 * - **Só preenche vazios**: o candidato precisa estar em branco na planilha
 *   (snapshot). NUNCA sobrescreve um motorista já presente (respeita o dado da
 *   fonte/Shopee). Para a carga do sistema, `sheet_has_driver` exclui os LHs que já
 *   foram escritos (o re-sync os traz de volta ao snapshot com motorista) — assim a
 *   linha não é re-gravada a cada ciclo.
 * - Escreve só motorista/cavalo/carreta (NÃO manda `status`, para não re-rotular
 *   a coluna de status da planilha).
 * - Cap de {@link RECONCILE_BATCH_LIMIT} por classe/ciclo.
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
          ),
          sheet_has_driver AS (
            SELECT DISTINCT (e->>'lh') AS lh
            FROM public.sheet_monitor_snapshot s, jsonb_array_elements(s.rows_json) e
            WHERE COALESCE(TRIM(e->>'motoristas'), '') <> ''
              AND COALESCE(TRIM(e->>'lh'), '') <> ''
          )
          (
            -- (1) Carga da PLANILHA (sheet_lh) tomada, com a linha em branco → preenche.
            SELECT c.sheet_lh AS lh, c.sheet_source, false AS create_row,
                   c.alloc_motorista, c.alloc_cavalo, c.alloc_carreta,
                   NULL::text AS origem, NULL::text AS destino,
                   NULL::text AS carreg, NULL::text AS descarga,
                   l.horse_plate, l.trailer_plate, l.validation_summary_json
            FROM public.cargas c
            JOIN blank_sheet b ON b.lh = c.sheet_lh
            LEFT JOIN public.load_public_leads l ON l.id = c.reserved_public_lead_id
            WHERE c.sheet_lh IS NOT NULL AND c.sheet_lh <> ''
              AND (c.status = 'RESERVED' OR COALESCE(TRIM(c.alloc_motorista), '') <> '')
            LIMIT ${RECONCILE_BATCH_LIMIT}
          )
          UNION ALL
          (
            -- (2) Carga do SISTEMA (lh_manual, sem sheet_lh) com motorista alocado mas
            -- SEM linha na planilha (viagem não-aceita no lançamento) → cria-ou-preenche.
            -- sheet_has_driver exclui as já escritas (voltam ao snapshot com motorista).
            SELECT c.lh_manual AS lh, c.sheet_source, true AS create_row,
                   c.alloc_motorista, c.alloc_cavalo, c.alloc_carreta,
                   c.origem, c.destino,
                   c.sheet_data_carregamento AS carreg, c.sheet_data_descarga AS descarga,
                   NULL::text AS horse_plate, NULL::text AS trailer_plate,
                   NULL::jsonb AS validation_summary_json
            FROM public.cargas c
            LEFT JOIN sheet_has_driver d ON d.lh = c.lh_manual
            WHERE c.sheet_lh IS NULL
              AND COALESCE(TRIM(c.lh_manual), '') <> ''
              AND COALESCE(TRIM(c.alloc_motorista), '') <> ''
              AND d.lh IS NULL
              -- Só linehaul SPX (LT…) → planilha Shopee. Carga lançada não persiste
              -- sheet_source (fica NULL → roteia p/ shopee); o gate LT evita criar um
              -- LH de outra fonte (ex.: Nestlé) na planilha errada. Rever quando o
              -- write-back Nestlé for ligado (aí resolver a fonte de verdade).
              AND upper(TRIM(c.lh_manual)) LIKE 'LT%'
            LIMIT ${RECONCILE_BATCH_LIMIT}
          )
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
    const update = { lh: String(row.lh).trim(), source: row.sheet_source ?? null, motorista, cavalo, carreta };
    // Carga do sistema sem linha na planilha → cria-ou-preenche (createIfMissing)
    // com rota + agenda; as datas viram o formato da planilha (DD/MM/YYYY HH:MM).
    if (row.create_row) {
      update.createIfMissing = true;
      update.origem = (row.origem ?? "").toString();
      update.destino = (row.destino ?? "").toString();
      update.dataCarregamento = formatSheetDateLabel(row.carreg);
      update.dataDescarga = formatSheetDateLabel(row.descarga);
    }
    updates.push(update);
  }

  if (updates.length === 0) return { ok: true, reconciled: 0 };

  const res = await writeAllocationsToSheet(updates, { log }).catch((err) => ({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  }));

  // Registra os LHs cuja CRIAÇÃO foi pedida, para o próximo ciclo conferir se a
  // linha realmente nasceu (o Apps Script responde created:N mesmo quando não
  // grava — ver check-writeback-health.js). Best-effort: não afeta o resultado.
  // Só entram fontes com write-back LIGADO: sem URL o Apps Script nunca é chamado
  // (a linha some por configuração, não por falha) e o aviso seria falso todo dia.
  const criacoes = updates.filter((u) => u.createIfMissing && isSheetWritebackEnabled(u.source));
  if (res?.ok && criacoes.length > 0) {
    const { recordCreateAttempt } = await import("./check-writeback-health.js");
    await recordCreateAttempt(
      criacoes.map((u) => u.lh),
      { sources: criacoes.map((u) => u.source) },
    );
  }

  if (!res?.ok) {
    warn("writeback-failed", { attempted: updates.length, res });
    return { ok: false, attempted: updates.length, reconciled: 0 };
  }
  return { ok: true, reconciled: updates.length };
}
