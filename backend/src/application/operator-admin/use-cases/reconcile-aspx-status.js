// backend/src/application/operator-admin/use-cases/reconcile-aspx-status.js
//
// Mantém as cargas do sistema sincronizadas com o ASPX e corrige a planilha —
// replicando no backend o script Apps Script `atualizarStatusEDados` (DC-316,
// aba ASP → aba SHOPEE). Fonte de tudo = Torre /api/spx/asp (DC-136).
//
// Fonte da verdade (pedido do operador):
//  - Da planilha lê-se só o LH (chave) e o STATUS quando for CTE EM EMISSÃO /
//    CTE ENVIADO (esses só existem na planilha — as regras do DC-316 os preservam).
//  - Todo o resto vem AUTOMÁTICO do ASPX: status (fora do CTE), motorista, cavalo,
//    carreta e datas de carregamento/descarga.
//
// Fluxo (roda periódico, ver main.js):
//  1. Busca a aba ASP (Torre) e monta lh → registro (parseAspTripRow).
//  2. Casa por LH == cargas.sheet_lh (só cargas Shopee têm sheet_lh).
//  3. STATUS: aplica shouldUpdateAspxStatus (regras DC-316) sobre o status ATUAL da
//     planilha (cargas.sheet_status).
//  4. DADOS: aplica os gates do DC-316 (shouldUpdateAspxData sobre o status atual):
//     motorista/cavalo/carreta só em AGUARDANDO CARREGAMENTO/CARREGADO; datas também
//     em AGUARDANDO CHEGAR NO CLIENTE.
//  5. Grava os espelhos no sistema (cargas.sheet_*) e escreve de volta na planilha
//     (write-back). NÃO toca alloc_* — override manual do operador é preservado e
//     continua vencendo na exibição do Monitor.
//
// FORA de escopo (consciente): origem/destino — sobrescrevê-los arriscaria o
// casamento de rota do catálogo; ficam como estão. E não empurra status ao portal
// Shopee (ShopeeOpsLib é da planilha).

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import {
  fetchSpxTrips,
  SpxAspNotConfigured,
} from "../../../infrastructure/torre/torre-spx-trips-client.js";
import { writeAllocationsToSheet, isSheetWritebackEnabled } from "../../google-sheets/sheet-writeback.js";
import {
  shouldUpdateAspxStatus,
  shouldUpdateAspxData,
  parseAspTripRow,
} from "../../../domain/operator-admin/aspx-status-rules.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";

const DEFAULT_DAYS_BACK = 45;
const DEFAULT_DAYS_FWD = 30;

const trim = (v) => String(v ?? "").trim();

/**
 * @param {{ correlationId?: string, deps?: {
 *   withPgClient?: Function,
 *   fetchSpxTrips?: typeof fetchSpxTrips,
 *   writeAllocationsToSheet?: typeof writeAllocationsToSheet,
 *   isSheetWritebackEnabled?: typeof isSheetWritebackEnabled,
 * } }} [args]
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reason?: string, checked: number, updated: number, sheetWrites: number }>}
 */
export async function reconcileAspxStatus({ correlationId = null, deps = {} } = {}) {
  const run = deps.withPgClient || withPgClient;
  const fetchTrips = deps.fetchSpxTrips || fetchSpxTrips;
  const writeSheet = deps.writeAllocationsToSheet || writeAllocationsToSheet;
  const writebackEnabled = deps.isSheetWritebackEnabled || isSheetWritebackEnabled;

  // 1. Aba ASP (Torre) → índice lh → registro. Best-effort: sem chave/Torre fora → no-op.
  let payload;
  try {
    payload = await fetchTrips({ daysBack: DEFAULT_DAYS_BACK, daysFwd: DEFAULT_DAYS_FWD }, { correlationId });
  } catch (err) {
    if (!(err instanceof SpxAspNotConfigured)) {
      logStructuredEvent("warn", "reconcile-aspx-status.fetch-failed", {
        correlationId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return { ok: true, skipped: true, reason: "no-index", checked: 0, updated: 0, sheetWrites: 0 };
  }
  const index = new Map();
  for (const rawRow of Array.isArray(payload?.rows) ? payload.rows : []) {
    const p = parseAspTripRow(rawRow);
    if (p.lh) index.set(p.lh, p);
  }
  if (index.size === 0) {
    return { ok: true, skipped: true, reason: "empty-index", checked: 0, updated: 0, sheetWrites: 0 };
  }
  const lhs = [...index.keys()];

  // 2..5. Lê as cargas casadas, aplica as regras e grava os espelhos — num só client.
  let outcome;
  try {
    outcome = await run(async (client) => {
      const { rows } = await client.query(
        `SELECT id, sheet_lh, sheet_source, sheet_status,
                sheet_motorista, sheet_cavalo, sheet_carreta,
                sheet_data_carregamento, sheet_data_descarga,
                alloc_motorista, alloc_cavalo, alloc_carreta
           FROM public.cargas
          WHERE sheet_lh = ANY($1::text[])`,
        [lhs],
      );

      const sheetUpdates = [];
      let changedCount = 0;

      for (const row of rows) {
        const lh = trim(row.sheet_lh);
        if (!lh) continue;
        const asp = index.get(lh);
        if (!asp) continue;

        const statusAtual = trim(row.sheet_status);
        const gate = shouldUpdateAspxData(statusAtual);

        // Colunas-espelho do sistema a atualizar (só as que mudam).
        const sets = [];
        const vals = [];
        const setCol = (col, value) => {
          sets.push(`${col} = $${sets.length + 1}`);
          vals.push(value);
        };

        // STATUS (regras DC-316 Bloco 1).
        let statusChanged = false;
        if (shouldUpdateAspxStatus(statusAtual, asp.status)) {
          setCol("sheet_status", asp.status);
          statusChanged = true;
        }

        // DADOS (Bloco 2): motorista/cavalo/carreta só sob o gate `dados`.
        if (gate.dados) {
          if (asp.motorista && asp.motorista !== trim(row.sheet_motorista)) setCol("sheet_motorista", asp.motorista);
          if (asp.cavalo && asp.cavalo !== trim(row.sheet_cavalo)) setCol("sheet_cavalo", asp.cavalo);
          if (asp.carreta && asp.carreta !== trim(row.sheet_carreta)) setCol("sheet_carreta", asp.carreta);
        }
        // DATAS: sob o gate `datas` (inclui AGUARDANDO CHEGAR NO CLIENTE).
        if (gate.datas) {
          if (asp.dataCarregamento && asp.dataCarregamento !== trim(row.sheet_data_carregamento)) {
            setCol("sheet_data_carregamento", asp.dataCarregamento);
          }
          if (asp.dataDescarga && asp.dataDescarga !== trim(row.sheet_data_descarga)) {
            setCol("sheet_data_descarga", asp.dataDescarga);
          }
        }

        if (sets.length === 0) continue; // nada mudou nesta carga

        await client.query(
          `UPDATE public.cargas SET ${sets.join(", ")}, updated_at = now() WHERE id = $${sets.length + 1}`,
          [...vals, row.id],
        );
        changedCount += 1;

        // Write-back da planilha. Motorista/cavalo/carreta vão SEMPRE (valor EFETIVO)
        // porque o Apps Script reescreve E/F/G — mandar vazio limparia a célula. Sob o
        // gate `dados` usa o valor do ASPX; senão mantém o efetivo atual.
        const item = {
          lh,
          source: row.sheet_source ?? null,
          motorista: (gate.dados && asp.motorista ? asp.motorista : (row.alloc_motorista || row.sheet_motorista || "")).toString(),
          cavalo: (gate.dados && asp.cavalo ? asp.cavalo : (row.alloc_cavalo || row.sheet_cavalo || "")).toString(),
          carreta: (gate.dados && asp.carreta ? asp.carreta : (row.alloc_carreta || row.sheet_carreta || "")).toString(),
        };
        // status/datas são condicionais: o doPost só grava a coluna quando a chave vem.
        if (statusChanged) item.status = asp.status;
        if (gate.datas && asp.dataCarregamento) item.dataCarregamento = asp.dataCarregamento;
        if (gate.datas && asp.dataDescarga) item.dataDescarga = asp.dataDescarga;
        sheetUpdates.push(item);
      }

      return { checked: rows.length, updated: changedCount, sheetUpdates };
    });
  } catch (err) {
    logStructuredEvent("warn", "reconcile-aspx-status.query-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, checked: 0, updated: 0, sheetWrites: 0 };
  }

  // 6. Write-back best-effort (só se ligado). NUNCA lança — o banco já foi gravado.
  let sheetWrites = 0;
  if (outcome.sheetUpdates.length > 0 && writebackEnabled()) {
    const res = await writeSheet(outcome.sheetUpdates).catch((e) => ({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }));
    if (res?.ok) {
      sheetWrites = res.updated ?? outcome.sheetUpdates.length;
    } else {
      logStructuredEvent("warn", "reconcile-aspx-status.writeback-failed", {
        correlationId,
        attempted: outcome.sheetUpdates.length,
        error: res?.error ?? null,
      });
    }
  }

  return { ok: true, checked: outcome.checked, updated: outcome.updated, sheetWrites };
}
