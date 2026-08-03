// backend/src/application/operator-admin/use-cases/reconcile-aspx-status-launched.js
//
// Passada de STATUS para a carga LANÇADA (cargas.lh_manual, sheet_lh NULL).
//
// POR QUE existe: o sync do DC-316 (`reconcile-aspx-status.js`) casa por
// `cargas.sheet_lh` — só carga vinda da planilha. Carga lançada pela Programação
// nunca recebia status do portal. Medido em produção 03/08/2026, contra a aba ASP
// ao vivo (1.162 LHs):
//   - carga da PLANILHA: 835 casadas, espelho defasado = 0 (o sync funciona);
//   - carga LANÇADA: 304 casadas, só 6 iguais — 266 com status VAZIO no sistema e
//     32 paradas num estado anterior (ex.: "AGUARDANDO CHEGAR NO CLIENTE" enquanto
//     o ASP já dizia "DESCARREGADO").
//
// Por que uma passada SEPARADA em vez de estender a query do DC-316: aquela query é
// afinada para egress (pré-filtro por chaves compostas, medido em pg_stat_statements)
// e roda a cada 3min sobre ~845 linhas. Trocar `sheet_lh` por uma expressão
// COALESCE em ~10 predicados mataria o uso de índice e o raciocínio do pré-filtro.
// Aqui o conjunto é pequeno (algumas centenas), então uma leitura direta basta.
//
// REGRAS: exatamente as mesmas do DC-316 (`shouldUpdateAspxStatus` +
// `shouldReleaseAllocStatusOverride`), com `hasDriver` — carga lançada com motorista
// e célula vazia aceita o pipeline inteiro; cancelamento/NO SHOW seguem fora, para
// não disparar a cascata de rota retroativa.
//
// GATE: `ASPX_STATUS_LAUNCHED` = "off" (default) | "dry" | "on".
//   - off: no-op;
//   - dry: mede e loga o que MUDARIA, sem gravar nada (banco ou planilha);
//   - on: grava o espelho `sheet_status`, solta o override atrasado e escreve a
//     coluna STATUS da planilha via write-back.

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { fetchSpxTrips, SpxAspNotConfigured } from "../../../infrastructure/torre/torre-spx-trips-client.js";
import { writeAllocationsToSheet, isSheetWritebackEnabled } from "../../google-sheets/sheet-writeback.js";
import {
  normalizeAspxStatus,
  parseAspTripRow,
  shouldReleaseAllocStatusOverride,
  shouldUpdateAspxStatus,
} from "../../../domain/operator-admin/aspx-status-rules.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";

const DEFAULT_DAYS_BACK = 45;
const DEFAULT_DAYS_FWD = 15;
const BATCH_LIMIT = 300;

// Destinos que esta passada NÃO grava (ver o comentário no laço): cancelamento e
// NO SHOW têm efeito colateral de cascata/fila e são decisão de operação.
const EXCECOES_FORA = ["CANCELADO", "DEVOLVIDO", "NO SHOW"];

const trim = (v) => String(v ?? "").trim();

/** "off" (default) | "dry" | "on" */
export function launchedStatusMode() {
  const raw = String(process.env.ASPX_STATUS_LAUNCHED ?? "").trim().toLowerCase();
  return raw === "on" || raw === "dry" ? raw : "off";
}

/**
 * @param {{ correlationId?: string|null, deps?: {
 *   withPgClient?: typeof withPgClient,
 *   fetchSpxTrips?: typeof fetchSpxTrips,
 *   writeAllocationsToSheet?: typeof writeAllocationsToSheet,
 *   isSheetWritebackEnabled?: typeof isSheetWritebackEnabled,
 * } }} [opts]
 */
export async function reconcileAspxStatusForLaunched({ correlationId = null, deps = {} } = {}) {
  const mode = launchedStatusMode();
  if (mode === "off") return { ok: true, skipped: "disabled", mode, checked: 0, updated: 0, sheetWrites: 0 };

  const run = deps.withPgClient || withPgClient;
  const fetchTrips = deps.fetchSpxTrips || fetchSpxTrips;
  const writeSheet = deps.writeAllocationsToSheet || writeAllocationsToSheet;
  const writebackEnabled = deps.isSheetWritebackEnabled || isSheetWritebackEnabled;

  // 1. Aba ASP (Torre) → índice lh → registro.
  let payload;
  try {
    payload = await fetchTrips({ daysBack: DEFAULT_DAYS_BACK, daysFwd: DEFAULT_DAYS_FWD }, { correlationId });
  } catch (err) {
    if (!(err instanceof SpxAspNotConfigured)) {
      logStructuredEvent("warn", "aspx-status-launched.fetch-failed", {
        correlationId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return { ok: true, skipped: "no-index", mode, checked: 0, updated: 0, sheetWrites: 0 };
  }
  const index = new Map();
  for (const raw of Array.isArray(payload?.rows) ? payload.rows : []) {
    const p = parseAspTripRow(raw);
    if (p.lh) index.set(p.lh, p);
  }
  if (index.size === 0) return { ok: true, skipped: "empty-index", mode, checked: 0, updated: 0, sheetWrites: 0 };
  const lhs = [...index.keys()];

  let resultado;
  try {
    resultado = await run(async (client) => {
      // Só carga LANÇADA (sem sheet_lh) COM motorista efetivo e LH de linehaul SPX.
      const { rows } = await client.query(
        `SELECT id, TRIM(lh_manual) AS lh, sheet_status, alloc_status,
                COALESCE(NULLIF(TRIM(alloc_motorista), ''), NULLIF(TRIM(sheet_motorista), '')) AS motorista,
                COALESCE(NULLIF(TRIM(alloc_cavalo), ''), NULLIF(TRIM(sheet_cavalo), '')) AS cavalo,
                COALESCE(NULLIF(TRIM(alloc_carreta), ''), NULLIF(TRIM(sheet_carreta), '')) AS carreta
           FROM public.cargas
          WHERE sheet_lh IS NULL
            AND TRIM(lh_manual) = ANY($1::text[])
            AND COALESCE(NULLIF(TRIM(alloc_motorista), ''), NULLIF(TRIM(sheet_motorista), '')) IS NOT NULL
          LIMIT ${BATCH_LIMIT}`,
        [lhs],
      );

      const sheetUpdates = [];
      const exemplos = [];
      let updated = 0;
      let overridesSoltos = 0;
      let excecoesIgnoradas = 0;

      for (const row of rows) {
        const lh = trim(row.lh);
        const asp = index.get(lh);
        if (!lh || !asp?.status) continue;

        // CANCELADO/DEVOLVIDO/NO SHOW ficam FORA desta passada, mesmo quando a regra
        // 2 do DC-316 permitiria. Gravar cancelamento faz `sweepCancelledCascades`
        // (casa COALESCE(alloc_status, sheet_status) LIKE '%cancel%') disparar a
        // cascata de rota RETROATIVA — motorista descendo da fila muito depois do
        // fato (já aconteceu com 39). Desmascarar cancelamento é decisão de operação;
        // aqui só contamos e logamos.
        if (EXCECOES_FORA.includes(normalizeAspxStatus(asp.status))) {
          excecoesIgnoradas++;
          continue;
        }

        // Âncora: o status EFETIVO. Carga lançada não tem "verdade da planilha"
        // separada — o que está na célula foi escrito por nós a partir daqui.
        const efetivo = trim(row.alloc_status) || trim(row.sheet_status);
        if (!shouldUpdateAspxStatus(efetivo, asp.status, { hasDriver: true })) continue;

        const solta = shouldReleaseAllocStatusOverride(row.alloc_status, asp.status, { hasDriver: true });
        updated++;
        if (solta) overridesSoltos++;
        if (exemplos.length < 8) {
          exemplos.push(`${lh}: "${efetivo || "(vazio)"}" → "${asp.status}"${solta ? " (solta override)" : ""}`);
        }

        if (mode === "on") {
          const sets = ["sheet_status = $2"];
          const vals = [row.id, asp.status];
          if (solta) sets.push("alloc_status = NULL");
          await client.query(`UPDATE public.cargas SET ${sets.join(", ")} WHERE id = $1`, vals);
          sheetUpdates.push({
            lh,
            status: asp.status,
            motorista: trim(row.motorista),
            cavalo: trim(row.cavalo),
            carreta: trim(row.carreta),
          });
        }
      }

      return { checked: rows.length, updated, overridesSoltos, excecoesIgnoradas, exemplos, sheetUpdates };
    });
  } catch (err) {
    logStructuredEvent("warn", "aspx-status-launched.query-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, mode, checked: 0, updated: 0, sheetWrites: 0 };
  }

  // Write-back da coluna STATUS (só no modo "on"; nunca lança).
  let sheetWrites = 0;
  if (resultado.sheetUpdates.length > 0 && writebackEnabled()) {
    const res = await writeSheet(resultado.sheetUpdates).catch((e) => ({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }));
    if (res?.ok) sheetWrites = res.updated ?? resultado.sheetUpdates.length;
    else {
      logStructuredEvent("warn", "aspx-status-launched.writeback-failed", {
        correlationId,
        attempted: resultado.sheetUpdates.length,
        error: res?.error ?? null,
      });
    }
  }

  if (resultado.updated > 0) {
    logStructuredEvent(mode === "dry" ? "warn" : "info", `aspx-status-launched.${mode === "dry" ? "dry-run" : "aplicado"}`, {
      correlationId,
      checked: resultado.checked,
      mudariam: resultado.updated,
      overridesSoltos: resultado.overridesSoltos,
      excecoesIgnoradas: resultado.excecoesIgnoradas,
      sheetWrites,
      exemplos: resultado.exemplos,
    });
  }

  return {
    ok: true,
    mode,
    checked: resultado.checked,
    updated: resultado.updated,
    overridesSoltos: resultado.overridesSoltos,
    excecoesIgnoradas: resultado.excecoesIgnoradas,
    sheetWrites,
    exemplos: resultado.exemplos,
  };
}
