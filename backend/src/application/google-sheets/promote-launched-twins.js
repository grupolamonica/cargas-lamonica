// backend/src/application/google-sheets/promote-launched-twins.js
//
// Materializa a CANÔNICA (linha da planilha) para uma gêmea LANÇADA que a Shopee
// (ou outra fonte) já mostra com motorista ("tomada") — e migra a decisão do
// operador para ela (mergeLaunchedTwinAlloc) — ANTES de google-sheet-loads.js
// aposentar essa gêmea no CTE de reconciliação.
//
// POR QUE ISTO É NECESSÁRIO (achado, não suposição): o CTE de aposentadoria
// (google-sheet-loads.js, bloco "twins") aposenta a gêmea "tomada" (caso 1) só com
// `c.lh_manual = ANY($1::text[])` — SEM exigir que uma canônica exista.
// `canonica_id` (o rastro de "quem passou a valer") é uma subquery que pode
// devolver NULL. Medido em produção: 65 de 66 `twin_taken` têm `canonica_id` NULL.
// Isso acontece porque o UPSERT do sync (mais acima no mesmo arquivo) só cria carga
// para linha DISPONÍVEL (sem motorista) — uma viagem que a planilha já mostra com
// motorista NUNCA ganha canônica pelo caminho normal. A lançada é aposentada para
// um id que não aponta a lugar nenhum, e a decisão do operador (motorista, veículo,
// status) fica numa lápide inalcançável — nem o resolvedor a encontra mais (o antigo
// `resolveMonitorCargoByLh`, sem filtro de `retired_reason`, ainda a devolvia; mas
// a partir do momento em que TWIN_MERGE liga o resolvedor canônico, uma lápide
// nunca é devolvida como alvo — e sem canônica não sobra NADA para editar).
//
// Roda ANTES do CTE de aposentadoria (mesmo ciclo, mesma leitura de `takenSheetLhs`):
// para cada LH tomado que ainda NÃO tem canônica, se existe uma gêmea lançada ainda não
// mergeada — VIVA ou LÁPIDE (a aposentada é doadora legítima; ver o SELECT do doador
// abaixo) —, materializa a canônica herdando dela (via
// `buildAllocatedSheetLoadPayload`, a MESMA derivação de perfil/valor/bonus/distância
// usada para "puxar tudo da planilha") e chama `mergeLaunchedTwinAlloc` na MESMA
// transação — identidade e dado nascem juntos, sem janela de estado misto.
//
// GATE `TWIN_MERGE` = "off" (default, nenhum efeito) | "dry" | "on" (aplica).
//
// "dry" NÃO insere a canônica quando ela ainda não existe: fazer isso e depois
// desfazer exigiria um ROLLBACK real, e o harness pg-mem dos testes NÃO desfaz um
// BEGIN/ROLLBACK emitido por SQL cru (confirmado empiricamente — limitação do
// harness, não de Postgres de verdade). Por isso "dry" aqui é CONSERVADOR por
// construção, não por escolha de design: quando não há canônica ainda, só CONTA
// (materializaria) sem tentar prever se o merge seria bloqueado — prever isso sem
// escrever exigiria duplicar a lógica de bloqueio de mergeLaunchedTwinAlloc contra
// uma vencedora hipotética. Quando a canônica JÁ existe (corrida com outro ciclo, ou
// com a materialização lazy de ensureMonitorSheetCargo), "dry" chama
// `mergeLaunchedTwinAlloc` de verdade em modo dry — esse caminho SÓ LÊ, sem
// depender de rollback nenhum, e o resultado é exato.
//
// Best-effort e ISOLADO por LH: uma falha (inclusive lock não obtido — outro
// processo editando a mesma gêmea nesse instante) pula o LH; o próximo ciclo tenta
// de novo. Nunca derruba o sync.

import { withPgClient, withPgTransaction } from "../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../infrastructure/security-log.js";
import { buildAllocatedSheetLoadPayload } from "./google-sheet-loads.js";
import { mergeLaunchedTwinAlloc, twinMergeMode } from "../operator-admin/use-cases/merge-launched-twin.js";

const DEFAULT_BATCH_LIMIT = 50;
// Mesmo padrão de reconcile-aspx-status-launched.js / merge-launched-twin.js: nunca
// migra/materializa por cima de um destino cancelado (arma sweepCancelledCascades,
// que não tem janela de data e roda no fim do mesmo ciclo de sync).
const CANCEL_STATUS_RE = /cancel|devolv|no[\s-]*show/i;

const ZERO_RESULT = Object.freeze({
  mode: "off",
  candidatos: 0,
  candidatosBrutos: 0,
  materializados: 0,
  mergeados: 0,
  bloqueados: 0,
  ignoradosCancelamento: 0,
  ignoradosSemAgenda: 0,
  promovidos: [],
});

/**
 * @param {{
 *   source: string,
 *   takenSheetLhs: string[],
 *   existingLoadsBySheetLh: Map<string, object>,
 *   currentSheetKeys: Set<string>,
 *   allSheetRowsByLh: Map<string, object>,
 *   routeCatalogDefaultsByKey: Map<string, object>,
 *   routeTemplateDefaultsByKey: Map<string, object>,
 *   knownCatalogTrechos: Set<string>,
 *   fallbackSheetClientId: string|null,
 *   syncedAt: string,
 *   correlationId?: string|null,
 *   limit?: number,
 *   deps?: { withPgTransaction?: Function, withPgClient?: Function, mergeLaunchedTwinAlloc?: Function },
 * }} args
 * @returns {Promise<{ mode: string, candidatos: number, materializados: number,
 *   mergeados: number, bloqueados: number, ignoradosCancelamento: number, promovidos: string[] }>}
 */
export async function promoteLaunchedTwinsBeforeRetirement({
  source,
  takenSheetLhs,
  existingLoadsBySheetLh,
  currentSheetKeys,
  allSheetRowsByLh,
  routeCatalogDefaultsByKey,
  routeTemplateDefaultsByKey,
  knownCatalogTrechos,
  fallbackSheetClientId,
  syncedAt,
  correlationId = null,
  limit = DEFAULT_BATCH_LIMIT,
  deps = {},
}) {
  const mode = twinMergeMode();
  if (mode === "off") return ZERO_RESULT;

  const run = deps.withPgTransaction || withPgTransaction;
  const doMerge = deps.mergeLaunchedTwinAlloc || mergeLaunchedTwinAlloc;

  // Candidatos: LH tomado nesta rodada e SEM canônica (nem pré-existente, nem
  // criada agora como disponível — este 2º caso não deveria coincidir com "tomado",
  // mas o filtro é defensivo e barato).
  const candidatosBrutos = (takenSheetLhs || []).filter(
    (lh) => !existingLoadsBySheetLh.has(lh) && !currentSheetKeys.has(lh),
  );
  if (candidatosBrutos.length === 0) return { ...ZERO_RESULT, mode };

  // PRÉ-FILTRO por "tem gêmea lançada" — UMA query indexada, antes do lote.
  //
  // Sem isto a passada era INEFETIVA em produção. Medido no ciclo seguinte ao deploy:
  // `candidatos: 4475, materializados: 0, truncado: true`. A esmagadora maioria dos LHs
  // tomados na planilha NUNCA foi lançada pela Programação (viagem Shopee que já entra
  // atribuída), então não tem gêmea — cada um desses consumia um dos 50 slots do lote,
  // devolvia `sem_gemea` e reaparecia idêntico no ciclo seguinte. O teto era gasto
  // inteiro nos mesmos 50 LHs sem gêmea, para sempre, e nenhum LH COM gêmea era
  // alcançado (starvation).
  //
  // Aumentar `DEFAULT_BATCH_LIMIT` seria a correção errada: abriria uma transação com
  // FOR UPDATE por candidato — 4475 transações a cada ciclo de sync (5 min). O pré-filtro
  // resolve com uma consulta só, e o lote passa a valer para o que realmente dá trabalho.
  let candidatos = candidatosBrutos;
  try {
    const comGemea = await (deps.withPgClient || withPgClient)((client) =>
      client.query(
        `SELECT DISTINCT lh_manual FROM public.cargas
          WHERE lh_manual = ANY($1::text[])
            AND sheet_lh IS NULL
            AND alloc_merged_into_cargo_id IS NULL`,
        [candidatosBrutos],
      ),
    );
    const vivos = new Set(comGemea.rows.map((r) => String(r.lh_manual ?? "").trim()));
    candidatos = candidatosBrutos.filter((lh) => vivos.has(lh));
  } catch (err) {
    // Falha no pré-filtro NUNCA piora o comportamento: cai no conjunto bruto (que é o
    // que a versão anterior usava) e o lote/limite seguem protegendo o ciclo.
    logStructuredEvent("warn", "promote-launched-twins.prefiltro-falhou", {
      correlationId,
      source,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (candidatos.length === 0) {
    return { ...ZERO_RESULT, mode, candidatos: 0, candidatosBrutos: candidatosBrutos.length };
  }

  let materializados = 0;
  let mergeados = 0;
  let bloqueados = 0;
  let ignoradosCancelamento = 0;
  let ignoradosSemAgenda = 0;
  const promovidos = [];
  const truncado = candidatos.length > limit;

  for (const lh of candidatos.slice(0, limit)) {
    const row = allSheetRowsByLh.get(lh);
    if (!row) continue;
    if (CANCEL_STATUS_RE.test(String(row.status ?? ""))) {
      ignoradosCancelamento += 1;
      continue;
    }

    let resultado;
    try {
      resultado = await run(async (client) => {
        // Doador: gêmea LANÇADA ainda não mergeada (VIVA ou lápide — ver abaixo). Lock
        // WAIT padrão (sem NOWAIT) — mesma decisão já tomada em atomic-claim.js
        // (F-2) e pelo mesmo motivo: NOWAIT exigiria capturar/remapear 55P03 do
        // Postgres (que o harness pg-mem dos testes nem consegue PARSEAR — "AST
        // .skip.type nowait não suportado") por uma contenção que é curta e rara
        // (o operador editando essa MESMA gêmea no exato instante do ciclo do
        // sync) — o lote é pequeno (≤50 LHs/ciclo) e cada LH é sua própria
        // transação, então esperar não trava o restante do lote.
        // A LÁPIDE (gêmea já aposentada) é doadora LEGÍTIMA — nunca alvo. É a mesma
        // regra que `mergeLaunchedTwinAlloc` e `scripts/twin-merge-backfill.mjs` já
        // assumem, e sem ela qualquer pulo desta passada era DEFINITIVO: o CTE de
        // aposentadoria roda em bloco separado e incondicional, então depois que ele
        // grava retired_reason + status='EXPIRED', exigir doador VIVO fazia este LH
        // devolver "sem_gemea" para sempre (e `c.status NOT IN ('EXPIRED', ...)` impede
        // o CTE revisitar). Porta de mão única: a canônica nunca mais nascia pelo sync
        // — para a Shopee não há outro criador (o upsert só cria linha DISPONÍVEL e a
        // importação de linhas alocadas é só pullAllRows/Nestlé).
        //
        // Com esta linha, a lápide órfã volta a ser materializada + mergeada pelo
        // próprio ciclo do sync, sem script manual, desde que o LH ainda apareça no
        // snapshot. A ordenação de `mergeLaunchedTwinAlloc` continua preferindo a gêmea
        // VIVA quando as duas existem.
        const { rows: doadorRows } = await client.query(
          `SELECT id, data, horario, agenda_a_confirmar FROM public.cargas
            WHERE lh_manual = $1 AND sheet_lh IS NULL
              AND alloc_merged_into_cargo_id IS NULL
            ORDER BY (retired_reason IS NULL) DESC, alloc_updated_at DESC NULLS LAST
            LIMIT 1 FOR UPDATE`,
          [lh],
        );
        if (doadorRows.length === 0) return { skipped: "sem_gemea" };
        const doador = doadorRows[0];

        // Pré-check por (fonte, LH): corrida concorrente (dois ciclos de sync, ou
        // a materialização lazy de ensureMonitorSheetCargo) pode ter criado a
        // canônica entre a leitura de `existingLoadsBySheetLh` e agora.
        const { rows: dup } = await client.query(
          "SELECT id FROM public.cargas WHERE COALESCE(sheet_source, '') = COALESCE($1, '') AND sheet_lh = $2 LIMIT 1",
          [source ?? null, lh],
        );

        if (dup.length > 0) {
          // Canônica JÁ EXISTE de verdade — mergeLaunchedTwinAlloc só LÊ em modo
          // dry, então este ramo é exato em qualquer modo, sem precisar escrever.
          const merge = await doMerge(client, { lh, winnerId: dup[0].id, mode, correlationId });
          return { winnerId: dup[0].id, merge };
        }

        if (mode === "dry") {
          // Sem canônica ainda: "dry" não insere (ver nota no topo do arquivo —
          // o harness de teste não sustenta rollback de verdade, e inserir de
          // propósito para depois descartar em produção seria escrita real
          // disfarçada). Só sinaliza que esta LH SERIA materializada.
          return { wouldMaterialize: true };
        }

        const payload = buildAllocatedSheetLoadPayload({
          row,
          routeCatalogDefaultsByKey,
          routeTemplateDefaultsByKey,
          knownCatalogTrechos,
          fallbackSheetClientId,
          syncedAt,
          source,
        });
        // `cargas.data`/`horario` são NOT NULL, e a linha da planilha pode não ter agenda
        // (medido em produção: 3 linhas Shopee sem data, 2 delas com motorista). O
        // consumidor original de buildAllocatedSheetLoadPayload PULA essas linhas
        // (google-sheet-loads.js, `allocatedSkippedNoDate`); aqui pular seria PIOR que
        // inútil: o INSERT estourava 23502, o catch por LH engolia, e o CTE aposentava a
        // gêmea de qualquer forma — a decisão do operador ficava presa numa lápide
        // (LT0Q8302CP7K1, motorista CLOVIS BRITO FILHO).
        //
        // Herdar do doador é melhor que pular: a gêmea LANÇADA sempre tem agenda (NOT
        // NULL) e é justamente a agenda que o operador já vê no Monitor — quando a
        // planilha não datou a viagem, essa é a ÚNICA data existente. `agenda_a_confirmar`
        // vai junto para não promover um placeholder a agenda confirmada.
        if (payload.data == null) {
          payload.data = doador.data;
          payload.horario = payload.horario ?? doador.horario;
          if (doador.agenda_a_confirmar === true) payload.agenda_a_confirmar = true;
        }
        if (payload.data == null || payload.horario == null) {
          // Defensivo: inalcançável enquanto cargas.data/horario forem NOT NULL na
          // gêmea. Conta e segue — nunca deixa o INSERT estourar 23502.
          return { skipped: "sem_agenda" };
        }
        const cols = Object.keys(payload);
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        await client.query(
          `INSERT INTO public.cargas (${cols.join(", ")}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
          cols.map((c) => payload[c]),
        );
        const merge = await doMerge(client, { lh, winnerId: payload.id, mode, correlationId });
        return { winnerId: payload.id, merge };
      });
    } catch (err) {
      logStructuredEvent("warn", "promote-launched-twins.lh-failed", {
        correlationId,
        source,
        lh,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (resultado.skipped === "sem_agenda") {
      ignoradosSemAgenda += 1;
      continue;
    }
    if (resultado.skipped) continue;
    materializados += 1;
    promovidos.push(lh);
    // `currentSheetKeys` só ganha a chave quando algo foi REALMENTE persistido
    // (mode "on", ou "dry" batendo no ramo "canônica já existia" — nesse caso a
    // chave já era real de qualquer forma, não é um efeito desta função).
    if (mode === "on" || resultado.winnerId) currentSheetKeys.add(lh);
    // `mergeLaunchedTwinAlloc` devolve `merged:false` SEMPRE em modo dry (por
    // desenho — é o contrato dele: "dry" nunca afirma ter mergeado, só decide).
    // "Mergearia" em dry é: não foi bloqueado E haveria algo a copiar.
    const merge = resultado.merge;
    if (merge?.merged || (mode === "dry" && !merge?.skipped && (merge?.copiedFields?.length ?? 0) > 0)) {
      mergeados += 1;
    } else if (merge?.skipped && !["nada_a_migrar", "sem_gemea"].includes(merge.skipped)) {
      bloqueados += 1;
    }
  }

  // `candidatosBrutos` (antes do pré-filtro) fica no log: é o número que revelou o
  // starvation, e a razão entre os dois é o sinal de saúde da passada.
  const stats = { mode, candidatos: candidatos.length, candidatosBrutos: candidatosBrutos.length, materializados, mergeados, bloqueados, ignoradosCancelamento, ignoradosSemAgenda, promovidos, truncado };
  if (materializados > 0 || ignoradosCancelamento > 0 || ignoradosSemAgenda > 0 || truncado) {
    logStructuredEvent(mode === "dry" ? "warn" : "info", `promote-launched-twins.${mode === "dry" ? "dry-run" : "aplicado"}`, {
      correlationId,
      source,
      ...stats,
      promovidos: promovidos.slice(0, 15),
    });
  }
  return stats;
}
