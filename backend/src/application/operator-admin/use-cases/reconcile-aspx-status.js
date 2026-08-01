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
//  4. DADOS: aplica os gates do DC-316 (shouldUpdateAspxData) sobre o status atual —
//     motorista/cavalo/carreta e origem/destino em AGUARDANDO CARREGAMENTO/CARREGADO;
//     datas também em AGUARDANDO CHEGAR NO CLIENTE.
//  5. Sistema: grava os espelhos cargas.sheet_status/sheet_motorista/sheet_cavalo/
//     sheet_carreta. Planilha (write-back): status (col L) + motorista/cavalo/carreta
//     (E/F/G) + datas (col C/D) + origem/destino (col I/J).
//  6. OVERRIDE: solta `cargas.alloc_status` (→ NULL) quando ele ficou para trás da
//     planilha e as regras do DC-316 permitem que ceda — ver
//     `shouldReleaseAllocStatusOverride`. Motivo: o modal do Monitor grava o status
//     EXIBIDO como override sem o operador ter escolhido nada (race do prefill) e
//     nada automático limpa esse valor, então ele congela para sempre. NÃO toca
//     alloc_motorista/cavalo/carreta — a alocação do operador segue soberana, e
//     overrides deliberados (CTE EM EMISSÃO/ENVIADO, NO SHOW, CANCELADO) são
//     preservados pelas mesmas regras.
//
// Por que datas + origem/destino vão SÓ para a planilha (não para colunas do sistema):
//  - datas: o sync RE-LÊ e normaliza a data da planilha (formatBrazilianDateTimeLabel)
//    para cargas.sheet_data_*; gravar direto brigaria com esse formato. O Monitor já
//    mostra as datas do ASPX ao vivo (applySpxSchedule).
//  - origem/destino: o sync NÃO copia Origem/Destino da planilha para cargas.origem/
//    destino (só atualiza colunas sheet_*), então a rota do catálogo fica intacta.
//
// PRECISA reimplantar o Apps Script (PR #322 só grava datas/origem/destino no CREATE;
// no update grava status + E/F/G). Sem push ao portal Shopee (ShopeeOpsLib é da planilha).

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import {
  fetchSpxTrips,
  SpxAspNotConfigured,
} from "../../../infrastructure/torre/torre-spx-trips-client.js";
import { writeAllocationsToSheet, isSheetWritebackEnabled } from "../../google-sheets/sheet-writeback.js";
import {
  shouldUpdateAspxStatus,
  shouldUpdateAspxData,
  shouldReleaseAllocStatusOverride,
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
                alloc_motorista, alloc_cavalo, alloc_carreta, alloc_status
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

        // STATUS (regras DC-316 Bloco 1). O âncora é o `sheet_status` — NUNCA o
        // efetivo (`alloc_status ?? sheet_status`): a proteção de CTE EM EMISSÃO /
        // CTE ENVIADO mora aqui, e um override velho faria o job apagar o CTE da
        // coluna L da planilha.
        let statusChanged = false;
        let novoSheetStatus = statusAtual;
        if (shouldUpdateAspxStatus(statusAtual, asp.status)) {
          novoSheetStatus = trim(asp.status);
          setCol("sheet_status", asp.status);
          statusChanged = true;
        }

        // DADOS (Bloco 2): motorista/cavalo/carreta só sob o gate `dados`.
        if (gate.dados) {
          if (asp.motorista && asp.motorista !== trim(row.sheet_motorista)) setCol("sheet_motorista", asp.motorista);
          if (asp.cavalo && asp.cavalo !== trim(row.sheet_cavalo)) setCol("sheet_cavalo", asp.cavalo);
          if (asp.carreta && asp.carreta !== trim(row.sheet_carreta)) setCol("sheet_carreta", asp.carreta);
        }

        // Colunas espelhadas na PLANILHA que mudaram até aqui — o write-back só
        // faz sentido se alguma delas mudou (soltar o override é só de banco).
        const sheetColsChanged = sets.length;

        // OVERRIDE do operador (`alloc_status`): decisão SEPARADA da acima e que
        // não vai para a planilha. O modal do Monitor grava o status EXIBIDO como
        // override sem o operador ter escolhido nada (race do prefill) e nada
        // automático limpa esse valor — então o sync solta o override quando as
        // MESMAS regras do DC-316 permitirem que ele ceda para a planilha.
        // NULL (e não o status novo) porque é o valor que o resto do código trata
        // como "sem decisão" → a carga volta a acompanhar a planilha sozinha.
        if (shouldReleaseAllocStatusOverride(row.alloc_status, novoSheetStatus)) {
          setCol("alloc_status", null);
        }

        if (sets.length === 0) continue; // nada mudou nesta carga

        await client.query(
          `UPDATE public.cargas SET ${sets.join(", ")}, updated_at = now() WHERE id = $${sets.length + 1}`,
          [...vals, row.id],
        );
        changedCount += 1;

        // Só soltou o override → nada a espelhar na planilha (evita write-back
        // desnecessário na leva de saneamento dos overrides congelados).
        if (sheetColsChanged === 0) continue;

        // Write-back da planilha. Motorista/cavalo/carreta vão SEMPRE (valor EFETIVO)
        // porque o Apps Script reescreve E/F/G — mandar vazio limparia a célula. Sob o
        // gate `dados` usa o valor do ASPX; senão mantém o efetivo atual.
        const item = {
          lh,
          source: row.sheet_source ?? null,
          // Sinaliza ao write-back que este é um update de sync ASPX → encaminha
          // datas/origem/destino (col C/D/I/J) numa linha EXISTENTE (sem criar/tocar tipo).
          syncExtras: true,
          motorista: (gate.dados && asp.motorista ? asp.motorista : (row.alloc_motorista || row.sheet_motorista || "")).toString(),
          cavalo: (gate.dados && asp.cavalo ? asp.cavalo : (row.alloc_cavalo || row.sheet_cavalo || "")).toString(),
          carreta: (gate.dados && asp.carreta ? asp.carreta : (row.alloc_carreta || row.sheet_carreta || "")).toString(),
        };
        // status é condicional: o Apps Script (PR #322) só grava col L quando a chave vem.
        if (statusChanged) item.status = asp.status;
        // Datas (col C/D) sob o gate `datas`; origem/destino (col I/J) sob o gate `dados`.
        // Vão SÓ para a PLANILHA (write-back) — NÃO gravamos sheet_data_*/cargas.origem no
        // sistema: o sync normaliza a data ao reler a planilha e as colunas de rota
        // (cargas.origem/destino) não são tocadas pelo sync (fica seguro p/ o catálogo).
        // Piggyback: só entram quando algo já mudou (status/motorista/placas) nesta carga.
        if (gate.datas && asp.dataCarregamento) item.dataCarregamento = asp.dataCarregamento;
        if (gate.datas && asp.dataDescarga) item.dataDescarga = asp.dataDescarga;
        if (gate.dados && asp.origem) item.origem = asp.origem;
        if (gate.dados && asp.destino) item.destino = asp.destino;
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
