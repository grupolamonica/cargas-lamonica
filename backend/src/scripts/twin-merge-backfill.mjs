// backend/src/scripts/twin-merge-backfill.mjs
//
// Relatório + backfill da unificação da gêmea (TWIN_MERGE) para as cargas
// LANÇADAS já existentes hoje — o passivo que a passada do sync
// (promote-launched-twins.js) só resolve daqui pra frente, no ritmo de
// "LH tomado NESTE ciclo".
//
// Duas populações que o sync NÃO cobre sozinho:
//   1. Gêmea com canônica JÁ EXISTENTE (a maioria — 122 de 143 medido em
//      produção): só falta mergear; a passada do sync nunca revisita porque só
//      olha LH "tomado nesta rodada", e uma canônica antiga não é "tomada" de novo.
//   2. Gêmea RETIRED (aposentada) sem canônica nenhuma: a passada do sync exige
//      doador VIVO (retired_reason IS NULL) — uma lápide sem canônica nunca é
//      promovida por ela. Aqui tratamos a lápide como doadora legítima (mesma
//      regra de mergeLaunchedTwinAlloc), materializando a canônica a partir do
//      SNAPSHOT atual quando o LH ainda aparece nele.
//
// DEFAULT: `--dry` (nenhuma escrita). `--apply` grava de verdade. `--limit=N`
// processa só os N primeiros candidatos (por data de carregamento, mais recentes
// primeiro). Roda em NODE puro (não é workflow) — pode usar Date/timestamps
// livremente.
//
// Uso:
//   node src/scripts/twin-merge-backfill.mjs                 # relatório, 0 escritas
//   node src/scripts/twin-merge-backfill.mjs --limit=25      # relatório dos 25 primeiros
//   node src/scripts/twin-merge-backfill.mjs --apply --limit=25   # aplica de verdade
//
// Reaproveita o MESMO motor de decisão do sync (mergeLaunchedTwinAlloc) e a MESMA
// derivação de campos (buildAllocatedSheetLoadPayload) — nenhuma lógica de negócio
// paralela em SQL solto.

import { pathToFileURL } from "node:url";
import "../infrastructure/config/load-env.js";
import { withPgClient, withPgTransaction } from "../infrastructure/pg/postgres.js";
import { createSupabaseAdminClient } from "../infrastructure/supabase/admin-client.js";
import {
  getSheetSources,
  fetchRouteCatalogRows,
  fetchRouteTemplateRows,
  createRouteCatalogDefaultsMap,
  createRouteTemplateDefaultsMap,
  createKnownCatalogTrechoSet,
  resolveSheetClientId,
  buildAllocatedSheetLoadPayload,
} from "../application/google-sheets/google-sheet-loads.js";
import { mergeLaunchedTwinAlloc } from "../application/operator-admin/use-cases/merge-launched-twin.js";

const CANCEL_STATUS_RE = /cancel|devolv|no[\s-]*show/i;

export function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : Infinity;
  return { apply, limit: Number.isFinite(limit) && limit > 0 ? limit : Infinity };
}

/**
 * Classe do resultado de um `mergeLaunchedTwinAlloc` (ou da ausência de canônica),
 * pura — mesma nomenclatura usada nos logs/testes do motor.
 *
 * A checagem é sobre `merge` (foi TENTADO ou não), não sobre `canonicaExiste`: em
 * modo apply, uma canônica nova é criada e o merge É chamado na sequência — nesse
 * caso `canonicaExiste` descreve o estado ANTES da operação (false), mas o
 * resultado a reportar é o do merge de verdade que aconteceu. Só quando `merge` é
 * null (dry, sem canônica ainda — nada foi tentado, ver runTwinMergeBackfill) é que
 * "materializaria" é a classe correta.
 */
export function classifyMergeResult({ merge }) {
  if (!merge) return "MATERIALIZAR_E_MERGEAR";
  if (merge.skipped === "cancel_no_destino") return "BLOQUEADO_CANCEL_NO_DESTINO";
  if (merge.skipped === "sem_gemea") return "SEM_GEMEA"; // já mergeada/inexistente
  if (merge.skipped === "nada_a_migrar") return "NADA_A_MIGRAR";
  if (merge.skipped) return "BLOQUEADO";
  if ((merge.copiedFields?.length ?? 0) > 0) return "MERGE_PURO";
  return "NADA_A_MIGRAR";
}

/** Lê TODAS as gêmeas lançadas candidatas: ainda não mergeadas (a marcação tira do
 *  universo), vivas OU aposentadas — a lápide é doadora legítima, só não é alvo.
 *  Trim em JS, não em SQL: TRIM(text) de um argumento não existe no harness pg-mem
 *  dos testes (mesma limitação documentada em promote-launched-twins.js). */
async function loadCandidateTwins(client) {
  const { rows } = await client.query(`
    SELECT c.id, c.lh_manual, c.status, c.retired_reason, c.data, c.horario,
           c.agenda_a_confirmar, c.alloc_motorista, c.alloc_updated_at
      FROM public.cargas c
     WHERE c.sheet_lh IS NULL
       AND c.lh_manual IS NOT NULL
       AND c.alloc_merged_into_cargo_id IS NULL
     ORDER BY c.data DESC NULLS LAST, c.lh_manual ASC
  `);
  return rows
    .map((r) => ({ ...r, lh: String(r.lh_manual ?? "").trim() }))
    .filter((r) => r.lh !== "");
}

/** Índice lh → { source, row } a partir de TODAS as fontes do snapshot (o
 *  "existe hoje na planilha" que decide se dá pra materializar). Em empate entre
 *  fontes, a PRIMEIRA encontrada vence — mesma ambiguidade que resolveMonitorCargoByLh
 *  trata como conflito explícito na leitura; aqui é só para o relatório/backfill,
 *  então registramos e seguimos com a primeira. */
async function loadSnapshotIndex(client) {
  const { rows } = await client.query("SELECT source, rows_json FROM public.sheet_monitor_snapshot");
  const byLh = new Map();
  for (const snap of rows) {
    let list = snap?.rows_json ?? null;
    if (typeof list === "string") list = JSON.parse(list);
    if (!Array.isArray(list)) continue;
    for (const r of list) {
      const lh = String(r?.lh ?? "").trim();
      if (lh && !byLh.has(lh)) byLh.set(lh, { source: snap?.source ?? null, row: r });
    }
  }
  return byLh;
}

async function findCanonicaId(client, lh, source) {
  const { rows } = await client.query(
    "SELECT id FROM public.cargas WHERE sheet_lh = $1 AND COALESCE(sheet_source, '') = COALESCE($2, '') LIMIT 1",
    [lh, source ?? null],
  );
  return rows[0]?.id ?? null;
}

/**
 * Processa UM LH: decide (dry) ou aplica (apply). Sempre em transação própria —
 * um LH problemático nunca contamina os outros.
 *
 * @returns {Promise<object>} linha do relatório
 */
async function processOne({ doador, snapshotIndex, clientIdBySource, routeCatalogDefaultsByKey, routeTemplateDefaultsByKey, knownCatalogTrechos, apply, deps = {} }) {
  const withTx = deps.withPgTransaction || withPgTransaction;
  const lh = doador.lh;
  const linha = {
    lh,
    doadorId: doador.id,
    doadorStatus: doador.status,
    lapide: Boolean(doador.retired_reason),
    fonte: null,
    classe: null,
    winnerId: null,
    campos: [],
    naoMigrado: {},
  };

  const snap = snapshotIndex.get(lh);
  if (!snap) {
    linha.classe = "FORA_DO_SNAPSHOT"; // LH não está em nenhuma planilha hoje — nada a fazer aqui
    return linha;
  }
  linha.fonte = snap.source;
  if (CANCEL_STATUS_RE.test(String(snap.row.status ?? ""))) {
    linha.classe = "SNAPSHOT_CANCELADO"; // mesma proteção do sync: não materializa sobre cancelamento
    return linha;
  }

  const resultado = await withTx(async (client) => {
    const canonicaIdExistente = await findCanonicaId(client, lh, snap.source);
    if (canonicaIdExistente) {
      const merge = await mergeLaunchedTwinAlloc(client, { lh, winnerId: canonicaIdExistente, mode: apply ? "on" : "dry" });
      return { winnerId: canonicaIdExistente, canonicaExiste: true, merge };
    }
    if (!apply) {
      // Sem canônica ainda: em dry NÃO materializa (não há razão pra escrever e
      // descartar; ver mesma decisão em promote-launched-twins.js) — só sinaliza.
      return { winnerId: null, canonicaExiste: false, merge: null };
    }
    const payload = buildAllocatedSheetLoadPayload({
      row: snap.row,
      routeCatalogDefaultsByKey,
      routeTemplateDefaultsByKey,
      knownCatalogTrechos,
      fallbackSheetClientId: clientIdBySource.get(snap.source) ?? null,
      syncedAt: new Date().toISOString(),
      source: snap.source,
    });
    // `cargas.data`/`horario` são NOT NULL e a linha da planilha pode não ter agenda —
    // o INSERT estourava 23502 e o LH caía na classe ERRO (visto ao rodar em produção:
    // LT0Q8302CP7K1 e LT0Q8602CPLC1). Herda a agenda do doador, que sempre tem
    // (mesma regra de promote-launched-twins.js).
    if (payload.data == null) {
      payload.data = doador.data;
      payload.horario = payload.horario ?? doador.horario;
      if (doador.agenda_a_confirmar === true) payload.agenda_a_confirmar = true;
    }
    if (payload.data == null || payload.horario == null) {
      // Defensivo: inalcançável enquanto cargas.data/horario forem NOT NULL no doador.
      return { winnerId: null, canonicaExiste: false, merge: null, semAgenda: true };
    }
    const cols = Object.keys(payload);
    await client.query(
      `INSERT INTO public.cargas (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT (id) DO NOTHING`,
      cols.map((c) => payload[c]),
    );
    const merge = await mergeLaunchedTwinAlloc(client, { lh, winnerId: payload.id, mode: "on" });
    return { winnerId: payload.id, canonicaExiste: false, merge };
  });

  linha.winnerId = resultado.winnerId;
  linha.classe = resultado.semAgenda ? "SEM_AGENDA" : classifyMergeResult(resultado);
  linha.campos = resultado.merge?.copiedFields ?? [];
  linha.naoMigrado = resultado.merge?.naoMigrado ?? {};
  return linha;
}

export async function runTwinMergeBackfill({ apply, limit, deps = {} } = {}) {
  const withClient = deps.withPgClient || withPgClient;
  const withTx = deps.withPgTransaction || withPgTransaction;
  const supabaseClient = deps.supabaseClient || createSupabaseAdminClient();

  const sources = getSheetSources();
  const [routeCatalogRows, routeTemplateRows] = await Promise.all([
    fetchRouteCatalogRows(supabaseClient),
    fetchRouteTemplateRows(supabaseClient),
  ]);
  const routeCatalogDefaultsByKey = createRouteCatalogDefaultsMap(routeCatalogRows);
  const routeTemplateDefaultsByKey = createRouteTemplateDefaultsMap(routeTemplateRows);
  const knownCatalogTrechos = createKnownCatalogTrechoSet(routeCatalogRows);
  const clientIdBySource = new Map();
  for (const s of sources) {
    clientIdBySource.set(s.source, await resolveSheetClientId(supabaseClient, s.clientName));
  }

  const [candidatos, snapshotIndex] = await Promise.all([
    withClient((client) => loadCandidateTwins(client)),
    withClient((client) => loadSnapshotIndex(client)),
  ]);

  const relatorio = [];
  const alvo = candidatos.slice(0, limit);
  for (const doador of alvo) {
    try {
      const linha = await processOne({
        doador,
        snapshotIndex,
        clientIdBySource,
        routeCatalogDefaultsByKey,
        routeTemplateDefaultsByKey,
        knownCatalogTrechos,
        apply,
        deps: { withPgTransaction: withTx },
      });
      relatorio.push(linha);
    } catch (err) {
      relatorio.push({ lh: doador.lh, doadorId: doador.id, classe: "ERRO", erro: err instanceof Error ? err.message : String(err) });
    }
  }

  const agregado = relatorio.reduce((acc, l) => {
    acc[l.classe] = (acc[l.classe] ?? 0) + 1;
    return acc;
  }, {});

  return {
    apply,
    totalCandidatos: candidatos.length,
    processados: relatorio.length,
    truncado: candidatos.length > limit,
    agregado,
    relatorio,
  };
}

function imprimirRelatorio(resultado) {
  console.log(`\n=== Backfill da unificação da gêmea — modo ${resultado.apply ? "APPLY (escreveu)" : "DRY (nada escrito)"} ===`);
  console.log(`Candidatos totais: ${resultado.totalCandidatos} | processados: ${resultado.processados}${resultado.truncado ? " (TRUNCADO pelo --limit)" : ""}`);
  console.log("\nPor classe:");
  for (const [classe, n] of Object.entries(resultado.agregado)) console.log(`  ${String(n).padStart(4)}  ${classe}`);
  console.log("\nLH | fonte | classe | doador | vencedora | campos");
  for (const l of resultado.relatorio) {
    console.log(
      `${l.lh} | ${l.fonte ?? "-"} | ${l.classe} | ${l.doadorId}${l.lapide ? " (lápide)" : ""} | ${l.winnerId ?? "-"} | ${(l.campos ?? []).join(",") || "-"}`,
    );
  }
}

async function main() {
  const { apply, limit } = parseArgs(process.argv.slice(2));
  if (apply) {
    console.warn("[twin-merge-backfill] MODO APPLY — vai escrever em produção. Ctrl+C nos próximos 5s pra abortar.");
    await new Promise((r) => setTimeout(r, 5000));
  }
  const resultado = await runTwinMergeBackfill({ apply, limit });
  imprimirRelatorio(resultado);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error("[twin-merge-backfill] Failed", error);
    process.exitCode = 1;
  });
}
