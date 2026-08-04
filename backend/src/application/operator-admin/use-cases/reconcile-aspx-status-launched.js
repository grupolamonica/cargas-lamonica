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
// ─── ESCOPO: LH QUE JÁ ESTÁ NA PLANILHA FICA FORA (correção pós-#414) ──────────
//
// A âncora desta passada é o status EFETIVO da PRÓPRIA carga lançada, e o
// comentário original justificava isso com "carga lançada não tem verdade da
// planilha separada — o que está na célula foi escrito por nós a partir daqui".
// Isso vale para a lançada que só existe no sistema. NÃO vale para a GÊMEA: uma
// viagem lançada cujo LH também está na planilha tem uma célula STATUS real, com
// dono (o Apps Script da planilha, aba ASP → SHOPEE, que aplica as mesmas regras do
// DC-316). Nessa carga o espelho `sheet_status` nasce NULL, então a âncora vinha
// VAZIA e `shouldUpdateAspxStatus("", <ASP>)` aceitava qualquer estado do pipeline —
// a REGRA 1 (intocáveis: `CTE EM EMISSÃO` / `NO SHOW`) e a anti-regressão nunca eram
// consultadas, porque elas olham o status ATUAL e o atual, ali, é o da célula.
//
// Medido em produção (03/08/2026, leitura pura, gate em dry): das 104 candidatas a
// gravar, 104 tinham linha na planilha e 13 teriam a célula REGREDIDA de
// `CTE ENVIADO` para `CARREGADO` — o CTE só existe na planilha (o SPX não conhece
// esse estado), é o que o DC-316 protege, e é a referência que o release na leitura
// do Monitor usa (`monitor-stale-alloc-status.js`, que compara o override com o
// status do snapshot). Escrever ali destruiria as duas coisas.
//
// Então o LH presente na planilha (snapshot de qualquer fonte OU outra carga com
// `sheet_lh` = LH) é EXCLUÍDO: aquela célula já tem dono e a linha exibida no Monitor
// é a da planilha. Consequência honesta, também medida: HOJE sobram ZERO alvos — a
// passada só volta a ter trabalho quando existir carga lançada que de fato não está
// na planilha. O problema dos "266 com status vazio" que motivou o #414 é, na
// verdade, o problema da GÊMEA (uma viagem virando duas linhas), e ele se resolve
// adotando a linha da planilha na carga lançada — não escrevendo por cima da célula.
//
// GATE: `ASPX_STATUS_LAUNCHED` = "off" (default) | "dry" | "on".
//   - off: no-op;
//   - dry: mede e loga o que MUDARIA, sem gravar nada (banco ou planilha);
//   - on: grava o espelho `sheet_status`, solta o override atrasado (com auditoria) e
//     escreve a coluna STATUS da planilha via write-back.

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
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";

const DEFAULT_DAYS_BACK = 45;
const DEFAULT_DAYS_FWD = 15;
const BATCH_LIMIT = 300;

// Destinos que esta passada NÃO grava (ver o comentário no laço): cancelamento e
// NO SHOW têm efeito colateral de cascata/fila e são decisão de operação.
const EXCECOES_FORA = ["CANCELADO", "DEVOLVIDO", "NO SHOW"];

const trim = (v) => String(v ?? "").trim();

/**
 * LHs (dos `candidatos`) que PERTENCEM À PLANILHA — e por isso ficam fora desta
 * passada: a célula STATUS deles tem outro dono (o Apps Script da planilha) e a
 * linha exibida no Monitor é a da planilha, não a da carga lançada.
 *
 * Duas fontes de "pertence à planilha":
 *   1. o LH aparece no SNAPSHOT de qualquer fonte (shopee/nestle) — é o que o
 *      operador vê no Monitor;
 *   2. existe carga com `sheet_lh` = LH (linha da planilha já materializada).
 *
 * Lê `rows_json` e filtra em JS (sem jsonb_array_elements) para rodar tanto no
 * Postgres quanto no harness pg-mem dos testes.
 *
 * FAIL-CLOSED: erro ao ler o snapshot devolve `null` — o caller ABORTA a passada em
 * vez de seguir sem saber. Seguir às cegas é exatamente o defeito que esta correção
 * remove (gravar por cima de uma célula com dono), e o custo de abortar é só perder
 * um ciclo de 3min.
 *
 * @param {import("pg").PoolClient} client
 * @param {string[]} candidatos
 * @returns {Promise<Set<string>|null>}
 */
async function loadSheetOwnedLhs(client, candidatos) {
  const alvo = new Set(candidatos.map((l) => String(l ?? "").trim()).filter(Boolean));
  const owned = new Set();
  try {
    const { rows } = await client.query("SELECT rows_json FROM public.sheet_monitor_snapshot");
    for (const snap of rows) {
      let list = snap?.rows_json ?? null;
      if (typeof list === "string") list = JSON.parse(list);
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        const lh = String(r?.lh ?? "").trim();
        if (lh && alvo.has(lh)) owned.add(lh);
      }
    }
  } catch {
    return null;
  }
  try {
    const { rows } = await client.query(
      "SELECT sheet_lh FROM public.cargas WHERE sheet_lh = ANY($1::text[])",
      [[...alvo]],
    );
    for (const r of rows) {
      const lh = String(r?.sheet_lh ?? "").trim();
      if (lh) owned.add(lh);
    }
  } catch {
    return null;
  }
  return owned;
}

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
      // LHs que JÁ ESTÃO NA PLANILHA — ficam fora (ver o bloco ESCOPO no topo): a
      // célula STATUS deles tem outro dono e a linha exibida é a da planilha.
      // Escopado aos LHs deste ciclo (não varre planilha inteira).
      const naPlanilha = await loadSheetOwnedLhs(client, lhs);
      // Fail-closed: sem saber quem é da planilha, não escreve (ver o helper).
      if (naPlanilha === null) return { abortado: "no-sheet-index" };

      // Só carga LANÇADA (sem sheet_lh) COM motorista efetivo e LH de linehaul SPX.
      // Ciclo de vida: gêmea APOSENTADA (retired_reason) e carga que não é operável
      // (CANCELLED/DRAFT/EXPIRED) ficam fora — a EXPIRED nem aparece no Monitor
      // (list-system-cargas-monitor não lista expirada), então gravar status nela é
      // ruído. ORDER BY determinístico: sem ele, o corte do LIMIT escolhia linhas
      // diferentes a cada ciclo e parte da população podia nunca ser visitada.
      const { rows } = await client.query(
        `SELECT id, TRIM(lh_manual) AS lh, sheet_status, alloc_status,
                alloc_motorista, sheet_motorista,
                COALESCE(NULLIF(TRIM(alloc_motorista), ''), NULLIF(TRIM(sheet_motorista), '')) AS motorista,
                COALESCE(NULLIF(TRIM(alloc_cavalo), ''), NULLIF(TRIM(sheet_cavalo), '')) AS cavalo,
                COALESCE(NULLIF(TRIM(alloc_carreta), ''), NULLIF(TRIM(sheet_carreta), '')) AS carreta
           FROM public.cargas
          WHERE sheet_lh IS NULL
            AND TRIM(lh_manual) = ANY($1::text[])
            AND COALESCE(NULLIF(TRIM(alloc_motorista), ''), NULLIF(TRIM(sheet_motorista), '')) IS NOT NULL
            AND retired_reason IS NULL
            AND COALESCE(UPPER(status), '') NOT IN ('CANCELLED', 'DRAFT', 'EXPIRED')
          ORDER BY data DESC NULLS LAST, lh_manual ASC
          LIMIT ${BATCH_LIMIT}`,
        [lhs],
      );

      const sheetUpdates = [];
      const exemplos = [];
      const overridesParaSoltar = [];
      let updated = 0;
      let overridesSoltos = 0;
      let excecoesIgnoradas = 0;
      let ignoradasNaPlanilha = 0;

      for (const row of rows) {
        const lh = trim(row.lh);
        const asp = index.get(lh);
        if (!lh || !asp?.status) continue;

        // LH da planilha: fora (a célula tem dono; escrever ali regride o CTE).
        if (naPlanilha.has(lh)) {
          ignoradasNaPlanilha++;
          continue;
        }

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

        // Âncora: o status EFETIVO desta carga. Só é legítima porque o LH da planilha
        // já saiu acima — aqui a célula (quando existe) foi escrita a partir daqui.
        const efetivo = trim(row.alloc_status) || trim(row.sheet_status);
        // hasDriver com semântica `??` (COALESCE), a MESMA de
        // shouldReleaseAllocStatusOverride e do que a linha EXIBE (mergeAllocIntoRow):
        // um override "" é vazio EXPLÍCITO e vence a planilha. O `||` do SQL acima
        // serve para o write-back (não apagar a célula), não para esta decisão —
        // usá-lo aqui afirmaria "tem motorista" numa carga que a tela mostra vazia.
        const hasDriver =
          trim(row.alloc_motorista != null ? row.alloc_motorista : row.sheet_motorista) !== "";
        if (!shouldUpdateAspxStatus(efetivo, asp.status, { hasDriver })) continue;

        const solta = shouldReleaseAllocStatusOverride(row.alloc_status, asp.status, { hasDriver });
        updated++;
        if (solta) overridesSoltos++;
        if (exemplos.length < 8) {
          exemplos.push(`${lh}: "${efetivo || "(vazio)"}" → "${asp.status}"${solta ? " (solta override)" : ""}`);
        }

        if (mode === "on") {
          const sets = ["sheet_status = $2", "updated_at = now()"];
          const vals = [row.id, asp.status];
          if (solta) sets.push("alloc_status = NULL");
          await client.query(`UPDATE public.cargas SET ${sets.join(", ")} WHERE id = $1`, vals);
          // Soltar o override é mexer numa decisão do OPERADOR: vai para a auditoria,
          // senão ele perde o rastro (o Monitor mostra "quem alterou por último" e o
          // histórico da carga sai do audit).
          if (solta) {
            overridesParaSoltar.push({ cargoId: row.id, lh, de: trim(row.alloc_status), para: asp.status });
          }
          sheetUpdates.push({
            lh,
            status: asp.status,
            motorista: trim(row.motorista),
            cavalo: trim(row.cavalo),
            carreta: trim(row.carreta),
          });
        }
      }

      // Auditoria dos overrides soltos (mesma transação/cliente da escrita).
      for (const ev of overridesParaSoltar) {
        await insertSecurityAuditEvent(client, {
          eventType: "system.cargo.alloc_status_released",
          actorRole: "system",
          resourceType: "cargo",
          resourceId: ev.cargoId,
          action: "update",
          outcome: "success",
          correlationId,
          metadata: {
            lh: ev.lh,
            motivo: "aspx_status_launched",
            changes: [
              { field: "status", label: "Status", before: ev.de === "" ? "(vazio)" : ev.de, after: ev.para },
            ],
          },
        }).catch(() => {});
      }

      return {
        checked: rows.length,
        truncado: rows.length >= BATCH_LIMIT,
        updated,
        overridesSoltos,
        excecoesIgnoradas,
        ignoradasNaPlanilha,
        exemplos,
        sheetUpdates,
      };
    });
  } catch (err) {
    logStructuredEvent("warn", "aspx-status-launched.query-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, mode, checked: 0, updated: 0, sheetWrites: 0 };
  }

  // Snapshot ilegível → abortou sem escrever (fail-closed, ver loadSheetOwnedLhs).
  if (resultado.abortado) {
    logStructuredEvent("warn", "aspx-status-launched.sheet-index-unavailable", {
      correlationId,
      mode,
      motivo: resultado.abortado,
    });
    return { ok: true, skipped: resultado.abortado, mode, checked: 0, updated: 0, sheetWrites: 0 };
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

  // Loga quando houve trabalho OU quando algo foi DEIXADO DE FORA (planilha / corte
  // do LIMIT): silenciar a exclusão faria "0 mudanças" parecer "nada a fazer" quando
  // na verdade a passada tinha alvos e os descartou de propósito.
  if (resultado.updated > 0 || resultado.ignoradasNaPlanilha > 0 || resultado.truncado) {
    logStructuredEvent(mode === "dry" ? "warn" : "info", `aspx-status-launched.${mode === "dry" ? "dry-run" : "aplicado"}`, {
      correlationId,
      checked: resultado.checked,
      mudariam: resultado.updated,
      overridesSoltos: resultado.overridesSoltos,
      excecoesIgnoradas: resultado.excecoesIgnoradas,
      // LH que pertence à planilha (célula com dono) — fora desta passada.
      ignoradasNaPlanilha: resultado.ignoradasNaPlanilha,
      // true = a leitura bateu no LIMIT; há população além do lote deste ciclo.
      truncado: resultado.truncado,
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
    ignoradasNaPlanilha: resultado.ignoradasNaPlanilha,
    truncado: resultado.truncado,
    sheetWrites,
    exemplos: resultado.exemplos,
  };
}
