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

const ZERO_MERGE_EXISTENTE = Object.freeze({
  mode: "off",
  candidatos: 0,
  candidatosBrutos: 0,
  mergeados: 0,
  bloqueados: 0,
  nadaAMigrar: 0,
  mergeadosLhs: [],
});

/**
 * Migra a decisão do operador das gêmeas cujos LHs vão ser aposentados pelos ramos
 * (2) `twin_open_duplicate` e (3) `twin_superseded_on_create` do CTE — ANTES de eles
 * rodarem.
 *
 * POR QUE (medido em produção): esses dois ramos aposentam a gêmea sem migrar `alloc_*`.
 * O ramo (2) só checa `status = 'OPEN'`, reserva e lead — NÃO checa alocação nenhuma.
 * O ramo (3) checa apenas `alloc_motorista` e `alloc_status`, deixando passar
 * `alloc_tratativas`, `alloc_checklist_cavalo/carreta`, `alloc_tipo`, `alloc_vinculo`,
 * `alloc_descricao` e `alloc_pinned`. Resultado: LT0Q8702D3541 e LT0Q8602CP8A1 têm
 * canônica, mas a lápide NUNCA foi mergeada — a decisão do operador simplesmente
 * desapareceu da tela, sem erro e sem rastro visível.
 *
 * Diferente da promoção acima, aqui a canônica JÁ EXISTE por definição (os dois ramos
 * exigem `EXISTS (... s.sheet_lh = c.lh_manual ...)`), então não há nada a materializar
 * — só a migração. `mergeLaunchedTwinAlloc` faz todo o trabalho e já traz as guardas
 * (cancelamento no destino, reserva/lead na perdedora, não sobrescrever decisão mais
 * nova da vencedora).
 *
 * Pré-filtro pela EXISTÊNCIA de gêmea não-mergeada, mesma razão do starvation
 * corrigido na passada de cima: `openSheetLhs` é o conjunto de TODAS as linhas
 * disponíveis da planilha (milhares), e quase nenhuma tem gêmea.
 *
 * @param {{ source: string, lhs: string[], correlationId?: string|null, limit?: number,
 *           deps?: { withPgTransaction?: Function, withPgClient?: Function, mergeLaunchedTwinAlloc?: Function } }} args
 */
export async function mergeTwinsWithCanonicalBeforeRetirement({ source, lhs, correlationId = null, limit = DEFAULT_BATCH_LIMIT, deps = {} }) {
  const mode = twinMergeMode();
  if (mode === "off") return ZERO_MERGE_EXISTENTE;

  const run = deps.withPgTransaction || withPgTransaction;
  const readClient = deps.withPgClient || withPgClient;
  const doMerge = deps.mergeLaunchedTwinAlloc || mergeLaunchedTwinAlloc;

  const brutos = Array.from(new Set((lhs || []).map((l) => String(l ?? "").trim()).filter(Boolean)));
  if (brutos.length === 0) return { ...ZERO_MERGE_EXISTENTE, mode };

  // Só LHs que TÊM gêmea lançada ainda não mergeada E canônica na mesma fonte —
  // qualquer outro não tem trabalho a fazer e não deve gastar slot do lote.
  //
  // DUAS consultas simples + interseção em JS, em vez de um EXISTS correlacionado com
  // COALESCE sobre parâmetro: essa forma não roda no harness pg-mem dos testes (mesma
  // família de limitações já documentada aqui e em find-allocation-conflicts.js). As
  // duas são indexadas e o custo é o mesmo na prática.
  let candidatos = [];
  try {
    const [gemeas, canonicas] = await Promise.all([
      readClient((client) =>
        client.query(
          `SELECT DISTINCT lh_manual AS lh FROM public.cargas
            WHERE lh_manual = ANY($1::text[])
              AND sheet_lh IS NULL
              AND alloc_merged_into_cargo_id IS NULL`,
          [brutos],
        ),
      ),
      readClient((client) =>
        client.query(
          `SELECT DISTINCT sheet_lh AS lh, sheet_source FROM public.cargas
            WHERE sheet_lh = ANY($1::text[])`,
          [brutos],
        ),
      ),
    ]);
    const fonte = source ?? null;
    const comCanonica = new Set(
      canonicas.rows
        .filter((r) => (r.sheet_source ?? null) === fonte)
        .map((r) => String(r.lh ?? "").trim()),
    );
    const comGemea = new Set(gemeas.rows.map((r) => String(r.lh_manual ?? r.lh ?? "").trim()));
    candidatos = brutos.filter((lh) => comGemea.has(lh) && comCanonica.has(lh));
  } catch (err) {
    logStructuredEvent("warn", "merge-twins-existentes.prefiltro-falhou", {
      correlationId,
      source,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ...ZERO_MERGE_EXISTENTE, mode, candidatosBrutos: brutos.length };
  }

  if (candidatos.length === 0) return { ...ZERO_MERGE_EXISTENTE, mode, candidatosBrutos: brutos.length };

  let mergeados = 0;
  let bloqueados = 0;
  let nadaAMigrar = 0;
  const mergeadosLhs = [];
  const truncado = candidatos.length > limit;

  for (const lh of candidatos.slice(0, limit)) {
    try {
      const merge = await run(async (client) => {
        const { rows: can } = await client.query(
          "SELECT id FROM public.cargas WHERE sheet_lh = $1 AND COALESCE(sheet_source, '') = COALESCE($2, '') LIMIT 1",
          [lh, source ?? null],
        );
        if (can.length === 0) return { skipped: "sem_canonica" };
        return doMerge(client, { lh, winnerId: can[0].id, mode, correlationId });
      });

      if (merge?.merged || (mode === "dry" && !merge?.skipped && (merge?.copiedFields?.length ?? 0) > 0)) {
        mergeados += 1;
        mergeadosLhs.push(lh);
      } else if (merge?.skipped === "nada_a_migrar" || merge?.skipped === "sem_gemea") {
        nadaAMigrar += 1;
      } else if (merge?.skipped) {
        bloqueados += 1;
      }
    } catch (err) {
      // Isolado por LH: uma falha nunca derruba o sync nem o resto do lote.
      logStructuredEvent("warn", "merge-twins-existentes.lh-failed", {
        correlationId,
        source,
        lh,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const stats = { mode, candidatos: candidatos.length, candidatosBrutos: brutos.length, mergeados, bloqueados, nadaAMigrar, mergeadosLhs, truncado };
  if (mergeados > 0 || bloqueados > 0 || truncado) {
    logStructuredEvent(mode === "dry" ? "warn" : "info", `merge-twins-existentes.${mode === "dry" ? "dry-run" : "aplicado"}`, {
      correlationId,
      source,
      ...stats,
      mergeadosLhs: mergeadosLhs.slice(0, 15),
    });
  }
  return stats;
}
