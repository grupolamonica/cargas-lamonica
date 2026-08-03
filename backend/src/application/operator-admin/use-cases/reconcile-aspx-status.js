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
//     (E/F/G) + datas (col C/D) + origem/destino (col I/J). NÃO toca alloc_* — override
//     manual do operador é preservado e continua vencendo na exibição.
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
  parseAspTripRow,
  __TEST__ as ASPX_RULES,
} from "../../../domain/operator-admin/aspx-status-rules.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";

const DEFAULT_DAYS_BACK = 45;
const DEFAULT_DAYS_FWD = 30;

const trim = (v) => String(v ?? "").trim();

// Colunas lidas de cargas — as MESMAS em qualquer modo (só o WHERE muda).
const CARGO_COLUMNS = `id, sheet_lh, sheet_source, sheet_status,
                sheet_motorista, sheet_cavalo, sheet_carreta,
                alloc_motorista, alloc_cavalo, alloc_carreta`;

// Separador da chave composta "<lh><SEP><valor>" do pré-filtro. Vai como
// PARÂMETRO (não literal) porque o pg-mem dos testes não tem chr(); e é um
// caractere de controle (SOH) que não existe em LH/nome/placa vindos da planilha
// ou da Torre.
const KEY_SEP = "\u0001";

// Statuses que abrem o gate de DADOS (motorista/cavalo/carreta). Derivado da
// FONTE ÚNICA das regras (`shouldUpdateAspxData`) para o pré-filtro SQL não
// duplicar a decisão: se a regra mudar e um status deixar de abrir o gate, ele
// cai fora desta lista automaticamente.
const GATE_DADOS_STATUSES = ASPX_RULES.STATUS_GATE_DADOS.filter((s) => shouldUpdateAspxData(s).dados);

/**
 * Índice da aba ASP → arrays do pré-filtro SQL.
 *
 * Para cada campo comparado pelo use-case guardamos DOIS arrays:
 *  - `<campo>Lhs`: os LHs cujo registro ASP tem aquele campo NÃO-vazio (espelha
 *    os guards `if (!nw) return false` / `if (asp.motorista && ...)` do JS);
 *  - `<campo>SameKeys`: "<lh><SEP><valor do ASP>" — bater a chave significa que
 *    o espelho do sistema JÁ é igual ao ASP, logo nada mudaria naquele campo.
 */
function buildPrefilterKeys(index) {
  const keys = {
    statusLhs: [], statusSameKeys: [],
    motoristaLhs: [], motoristaSameKeys: [],
    cavaloLhs: [], cavaloSameKeys: [],
    carretaLhs: [], carretaSameKeys: [],
  };
  const push = (field, lh, value) => {
    keys[`${field}Lhs`].push(lh);
    keys[`${field}SameKeys`].push(`${lh}${KEY_SEP}${value}`);
  };
  for (const [lh, asp] of index) {
    // parseAspTripRow já devolve os campos trimados.
    if (asp.status) push("status", lh, asp.status);
    if (asp.motorista) push("motorista", lh, asp.motorista);
    if (asp.cavalo) push("cavalo", lh, asp.cavalo);
    if (asp.carreta) push("carreta", lh, asp.carreta);
  }
  return keys;
}

// Leitura ANTIGA (sem pré-filtro): TODAS as cargas casadas por LH. Mantida para o
// kill-switch ASPX_STATUS_RECONCILE_PREFILTER=false — rollback sem deploy.
const ALL_CARGOS_SQL = `SELECT ${CARGO_COLUMNS}
           FROM public.cargas
          WHERE sheet_lh = ANY($1::text[])`;

// Leitura NOVA: só as cargas em que ESTE ciclo pode escrever algo.
//
// Medição em produção (delta de 1091s do pg_stat_statements): 845 linhas por
// chamada, ~335.000 linhas/dia, a cada 3min — e na esmagadora maioria delas nada
// mudava (o job converge e depois relê o mesmo estado). O predicado abaixo é um
// SUPERCONJUNTO da condição `sets.length > 0` do laço, ou seja: toda carga que o
// JS ATUAL atualizaria continua vindo. As excluídas satisfazem provadamente
// ¬(A) ∧ ¬(B) e, portanto, cairiam no `continue`.
//
//  (A) NECESSÁRIA para shouldUpdateAspxStatus() == true: o ASP precisa ter status
//      (`if (!nw) return false`) e o status atual precisa DIFERIR dele
//      (`if (cur === nw) return false`). Não é suficiente — intocáveis (NO SHOW /
//      CTE EM EMISSÃO), anti-regressão e a trava de descarga são reavaliadas no JS,
//      que continua sendo a única fonte das regras. Superconjunto de propósito.
//      A comparação aqui é byte-a-byte (case-SENSITIVE) sobre o valor trimado:
//      desigualdade case-sensitive acontece MAIS vezes que a case-insensitive do
//      normalizeAspxStatus(), então só pode incluir linhas a mais, nunca a menos.
//
//  (B) EXATA para o bloco de DADOS: o gate abre (upper(trim(status atual)) na lista
//      derivada de shouldUpdateAspxData) E algum de motorista/cavalo/carreta do ASP
//      é não-vazio e difere do espelho — as mesmas comparações do JS.
const FILTERED_CARGOS_SQL = `SELECT ${CARGO_COLUMNS}
           FROM public.cargas
          WHERE sheet_lh = ANY($1::text[])
            AND (
              (
                sheet_lh = ANY($3::text[])
                AND NOT ((sheet_lh || $2::text || btrim(coalesce(sheet_status, ''))) = ANY($4::text[]))
              )
              OR (
                upper(btrim(coalesce(sheet_status, ''))) = ANY($11::text[])
                AND (
                     (sheet_lh = ANY($5::text[])
                       AND NOT ((sheet_lh || $2::text || btrim(coalesce(sheet_motorista, ''))) = ANY($6::text[])))
                  OR (sheet_lh = ANY($7::text[])
                       AND NOT ((sheet_lh || $2::text || btrim(coalesce(sheet_cavalo, ''))) = ANY($8::text[])))
                  OR (sheet_lh = ANY($9::text[])
                       AND NOT ((sheet_lh || $2::text || btrim(coalesce(sheet_carreta, ''))) = ANY($10::text[])))
                )
              )
            )`;

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
  // Pré-filtro de LINHAS (egress). Kill-switch: ASPX_STATUS_RECONCILE_PREFILTER=false
  // volta a ler todas as cargas casadas, sem deploy.
  const prefilterEnabled = process.env.ASPX_STATUS_RECONCILE_PREFILTER !== "false";
  const prefilter = prefilterEnabled ? buildPrefilterKeys(index) : null;

  // 2..5. Lê as cargas casadas, aplica as regras e grava os espelhos — num só client.
  let outcome;
  try {
    outcome = await run(async (client) => {
      // `checked` (observabilidade: quantas cargas do sistema casaram com a aba
      // ASP) segue EXATO — vem de um COUNT, não do tamanho do lote lido. Sem isso
      // o pré-filtro abaixo faria o número despencar e o log mentiria.
      const countResult = await client.query(
        `SELECT count(*)::int AS total FROM public.cargas WHERE sheet_lh = ANY($1::text[])`,
        [lhs],
      );
      const checked = Number(countResult.rows?.[0]?.total ?? 0);

      const { rows } = prefilterEnabled
        ? await client.query(FILTERED_CARGOS_SQL, [
            lhs,
            KEY_SEP,
            prefilter.statusLhs,
            prefilter.statusSameKeys,
            prefilter.motoristaLhs,
            prefilter.motoristaSameKeys,
            prefilter.cavaloLhs,
            prefilter.cavaloSameKeys,
            prefilter.carretaLhs,
            prefilter.carretaSameKeys,
            GATE_DADOS_STATUSES,
          ])
        : await client.query(ALL_CARGOS_SQL, [lhs]);

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

      return { checked, updated: changedCount, sheetUpdates };
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
