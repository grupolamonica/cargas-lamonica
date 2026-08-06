// backend/src/scripts/backfill-trip-accepted-nestle.mjs
//
// Backfill do ACEITE das cargas lançadas NESTLÉ a partir da única fonte histórica
// REAL que existe no banco: `nestle_ofertas.dtahraceite`.
//
// ─── POR QUE ESTE SCRIPT EXISTE ───────────────────────────────────────────────
//
// A migration 20260805170000 criou `cargas.trip_accepted_at` e o Monitor passou a
// esconder a lançada com a coluna NULA. Só que o backfill daquela migration usou um
// proxy inválido ("o LH desta lançada existe como `sheet_lh` de outra carga") e o
// sinal verdadeiro praticamente não existe: medido em produção em 06/08/2026, das
// 92 lançadas vivas 82 têm `trip_accepted_at` NULL e 79 foram criadas ANTES da
// coluna existir. Ler esse silêncio como "ninguém aceitou" escondeu 39-50 linhas da
// fonte SISTEMA, 26 delas ABERTAS no portal /motorista.
//
// A correção de desenho (migration 20260806150000) separa as duas perguntas:
//   * `trip_accepted_at`           = observamos que a viagem ESTÁ aceita. Nunca é limpo.
//   * `trip_acceptance_checked_at` = quando olhamos e a resposta foi CONCLUSIVA.
// O Monitor só esconde com EVIDÊNCIA: checked_at preenchido E accepted_at nulo.
// Regra da casa: DADO AUSENTE OU DUVIDOSO NUNCA ESCONDE LINHA.
//
// Para a Shopee o sinal se auto-cura sozinho (o job re-observa o SPX ao vivo a cada
// 10 min). Para a NESTLÉ não existe job equivalente — mas existe algo melhor: o
// Projeto Galileu já grava o instante REAL do aceite em `nestle_ofertas.dtahraceite`
// (710 linhas preenchidas). É história de verdade, não estimativa. Este script a
// transporta para as duas colunas de uma vez: sabemos QUE foi aceita e sabemos
// QUANDO — logo, a observação também é conclusiva.
//
// ─── COMO O CASAMENTO FUNCIONA ────────────────────────────────────────────────
//
// O `lh_manual` da carga lançada Nestlé É o `grupos_id` da oferta (é o "código de
// viagem" que o operador digita no lançamento). Duas sutilezas medidas na fonte:
//
//   1. Viagem MULTI-GRUPO: o Galileu grava o próprio `grupos_id` como lista
//      ("B101472521, B101472905") e o operador digita a mesma lista. Casam
//      literalmente na maioria dos casos — mas NÃO em todos: existem pares gravados
//      em ordem trocada ("B101458151, B101458214" e "B101458214, B101458151"
//      convivem na tabela). Por isso a chave de casamento é CANÔNICA: tokens
//      separados, únicos, maiúsculos, ORDENADOS. Sem isso, "B101472768, B101473232"
//      (que na oferta está na ordem inversa) ficaria de fora — foi exatamente o que
//      aconteceu na primeira sondagem.
//
//   2. O MESMO grupo pode ter várias ofertas com aceite ao longo do tempo (5 chaves
//      em produção): tipicamente uma DECLINADA mais antiga e a EMBARQUE EMITIDO que
//      valeu. `escolherAceite` prefere as ofertas VIVAS (mesmo vocabulário de mortos
//      de `nestle-monitor-overlay.js`) e, dentro do grupo escolhido, o aceite mais
//      ANTIGO — a marca é "desde quando sabemos que está aceita". Com esse critério
//      as 704 chaves ficam sem nenhuma ambiguidade.
//
// CANCELADO com `dtahraceite` preenchido (5 cargas) NÃO é descartado: o aceite
// aconteceu de fato naquele instante, e `trip_accepted_at` é fato histórico que
// nunca se desfaz (a própria 20260805170000 diz: "relançar uma viagem já aceita não
// pode desfazer o aceite"). Cancelamento posterior é outro assunto, tratado pelas
// cascatas de status — e, de todo modo, marcar aceite só MANTÉM a linha visível.
//
// ─── POR QUE ELE NUNCA PODE ESCONDER UMA LINHA ────────────────────────────────
//
// É a garantia mais forte deste script, e vale a pena deixá-la explícita porque foi
// exatamente o oposto disso que causou o incidente de 06/08: o Monitor só esconde a
// lançada quando há EVIDÊNCIA de não-aceite (`checked_at` preenchido E `accepted_at`
// NULO). Aqui as duas colunas são gravadas SEMPRE JUNTAS, na mesma sentença, e só
// quando temos um carimbo real de aceite — ou seja, `accepted_at` nunca sai nulo numa
// escrita nossa. Logo nenhuma linha pode ficar na combinação que esconde. O pior caso
// concebível (casar a carga errada) deixa uma linha VISÍVEL a mais, nunca uma a menos.
// Há um teste que trava essa invariante.
//
// ─── NÚMEROS DA MEDIÇÃO (produção, sonda read-only de 06/08/2026) ─────────────
//
//   710 ofertas com `dtahraceite` → 704 grupos indexados (112 deles multi-grupo)
//   486 cargas lançadas (sheet_lh NULL, lh_manual preenchido)
//    46 casam com uma oferta Nestlé que tem `dtahraceite`
//    36 delas com `trip_accepted_at` NULL  → é o que este script grava
//         (28 OPEN + 8 RESERVED, 0 lápides; aceites de 28/07 a 05/08)
//    10 já marcadas → puladas (nunca sobrescrevemos)
//     8 das que casam são multi-grupo, e UMA ("B101472768, B101473232") só casa por
//       causa da chave canônica — na oferta o par está na ordem inversa.
//   440 lançadas ficam órfãs: 429 Shopee "LT…" + 11 LH de teste
//       (FAKE, FAKE 00, FAKE 1, FAKE 2, FEKE, FEKE 2, FK5, FK13, fila, fila 2, fila 67)
//     0 cargas "LT…" (Shopee) casam — o escopo se fecha sozinho: um LH Shopee nunca
//       é igual a um grupo Nestlé (os 824 tokens de `grupos_id` são "B" + 10 dígitos,
//       sem uma única exceção). Não vale endurecer isso num regex: a estrutura já
//       garante (só casamos com chave colhida da tabela Nestlé) e um regex fixo só
//       criaria um jeito novo de silenciosamente perder grupo de formato novo.
//     0 `dtahraceite` ilegíveis — o parse não descarta nada hoje.
//
// ─── FUSO ─────────────────────────────────────────────────────────────────────
//
// `nestle_ofertas.dtahraceite` é TEXT naive em wall-clock BRT (convenção declarada
// na 20260717190000 e respeitada por `parseGalileuDateTime`). `trip_accepted_at` é
// `timestamptz`. Então o carimbo é lido com offset FIXO -03:00 — America/Sao_Paulo
// não tem horário de verão desde 2019 — mesma conta de `get-programacao.js`.
// Interpretar como UTC atrasaria todo aceite em 3 horas.
//
// ─── COMO RODAR ───────────────────────────────────────────────────────────────
//
// PRÉ-REQUISITO: a migration 20260806150000 precisa estar aplicada — na sonda de
// 06/08/2026 ela AINDA NÃO ESTAVA em produção (`column cargas.trip_acceptance_checked_at
// does not exist`). O script detecta isso e morre com uma mensagem que diz o que fazer,
// em vez de despejar o erro cru do PostgREST.
//
// Lê e grava pelo client supabase-js de service-role (`createSupabaseAdminClient`),
// NÃO por conexão pg direta: no ambiente local `SUPABASE_DB_URL` está VAZIO, então
// `withPgClient` não sobe. Precisa de `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
// no `backend/.env` (é o que a VPS já tem).
//
//   cd backend
//   node src/scripts/backfill-trip-accepted-nestle.mjs                # DRY-RUN (default, 0 escritas)
//   node src/scripts/backfill-trip-accepted-nestle.mjs --limit=10     # relatório dos 10 primeiros
//   node src/scripts/backfill-trip-accepted-nestle.mjs --apply        # grava de verdade
//
// Rode SEMPRE o dry-run primeiro e confira a lista. Idempotente por construção: a
// segunda passada só encontra JA_MARCADA e não escreve nada.
//
// O UPDATE dispara o trigger `set_cargas_updated_at`, então as 36 linhas ganham
// `updated_at = now()`. É inevitável (e barato: é um tiro só, não um job de 10 min) —
// mas é o motivo de o script não ser algo pra rodar em laço.

import { pathToFileURL } from "node:url";
import "../infrastructure/config/load-env.js";
import { createSupabaseAdminClient } from "../infrastructure/supabase/admin-client.js";

/** Status de oferta que NÃO representam uma viagem viva. Espelha
 *  OFERTA_STATUS_MORTOS de `nestle-monitor-overlay.js` (que por sua vez espelha
 *  NESTLE_STATUS_MORTOS de `get-programacao.js`) — um vocabulário só para as três
 *  leituras concordarem sobre o que é oferta morta. */
const OFERTA_STATUS_MORTOS = new Set([
  "RECUSA LEILAO",
  "EXPIRADA",
  "CANCELADO",
  "CANCELADO PELA CENTRAL",
  "DECLINADA",
]);

/** Páginas da API REST do Supabase: 1000 linhas é o teto padrão do PostgREST. */
const PAGINA = 1000;

/**
 * Argumentos: `[--apply] [--limit=N]`. ESTRITO de propósito.
 *
 * A versão anterior era tolerante: qualquer `--limit` que não fosse número virava
 * `Infinity` silenciosamente. Num script que escreve em produção isso erra para o lado
 * PERIGOSO — `--apply --limit 5` (com espaço, que é como todo mundo digita por reflexo)
 * ou `--limit=1O` (letra O) viravam "escreve TUDO" sem um pio. Aqui um argumento que
 * não entendemos aborta antes de qualquer leitura: perder um comando é barato, gravar
 * 36 linhas quando você pediu 5 não é.
 *
 * @throws {Error} argumento desconhecido ou `--limit` que não seja inteiro > 0
 */
export function parseArgs(argv) {
  let apply = false;
  let limit = Infinity;
  for (const bruto of argv ?? []) {
    const arg = String(bruto);
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const cru = arg.slice("--limit=".length);
      const n = Number(cru);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--limit precisa ser inteiro > 0 (recebido: "${cru}"). Uso: [--apply] [--limit=N]`);
      }
      limit = n;
      continue;
    }
    throw new Error(`Argumento desconhecido: "${arg}". Uso: [--apply] [--limit=N] (note o "=" em --limit).`);
  }
  return { apply, limit };
}

/**
 * Chave CANÔNICA de um código de viagem Nestlé — o que faz `lh_manual` e
 * `grupos_id` se encontrarem mesmo quando o texto difere.
 *
 * Normaliza: separadores (vírgula, ponto-e-vírgula, barra, espaço) viram fronteira
 * de token; tokens vazios somem; maiúsculas; duplicados removidos; ORDENADO.
 * A ordenação é o ponto: o Galileu grava o mesmo par nas duas ordens
 * ("B101458151, B101458214" e "B101458214, B101458151") e o operador digita a que
 * viu na tela. Sem canonizar, metade das multi-grupo não casaria.
 *
 * @param {string|null|undefined} raw
 * @returns {string|null} chave canônica, ou null se não sobra nada
 */
export function chaveDeGrupo(raw) {
  const tokens = String(raw ?? "")
    .toUpperCase()
    .split(/[,;/]+|\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return [...new Set(tokens)].sort().join(",");
}

/**
 * Instante (epoch ms) de um `dtahraceite` do Galileu — TEXT naive em wall-clock BRT.
 *
 * Aceita 'YYYY-MM-DDTHH:MM[:SS]' e 'YYYY-MM-DD HH:MM[:SS]' (as duas formas que o
 * coletor produz, igual a `parseGalileuDateTime`). Offset FIXO -03:00: o fuso da
 * operação não tem horário de verão desde 2019. Ilegível/ausente → null.
 *
 * @param {string|null|undefined} raw
 * @returns {number|null} epoch ms, ou null
 */
function instanteDeAceite(raw) {
  const m = String(raw ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}-03:00`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * O mesmo instante, já em ISO 8601 UTC — a forma que vai para `timestamptz`.
 * Ilegível/ausente → null (a carga cai na classe CARIMBO_INVALIDO e NÃO é escrita —
 * nunca inventamos data).
 *
 * @param {string|null|undefined} raw
 * @returns {string|null} ISO 8601 em UTC, ou null
 */
export function carimboDeAceite(raw) {
  const ms = instanteDeAceite(raw);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Epoch ms de um timestamptz já lido do banco (`trip_acceptance_checked_at`). O
 * PostgREST devolve string ISO, o driver pg devolveria Date, o harness de teste pode
 * devolver qualquer um dos dois. Ilegível → null (tratado como "nunca checado").
 *
 * @param {string|Date|null|undefined} v
 * @returns {number|null}
 */
function instanteDeTimestamp(v) {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Entre as ofertas de UM mesmo grupo, qual aceite vale.
 *
 * Duas regras, nesta ordem:
 *   1. Oferta VIVA ganha de oferta morta. Em produção o padrão é uma DECLINADA
 *      antiga convivendo com a EMBARQUE EMITIDO que de fato valeu; pegar a viva
 *      elimina as 5 divergências medidas.
 *   2. Se só há mortas (o caso das 5 cargas CANCELADO), elas ainda valem — o aceite
 *      aconteceu. Não descartar é deliberado: `trip_accepted_at` é fato histórico.
 *   3. Dentro do grupo escolhido, o aceite mais ANTIGO ("desde quando sabemos"),
 *      desempatado por `codprogcoleta` para a saída ser sempre a mesma.
 *
 * A ordenação é pelo INSTANTE JÁ PARSEADO, nunca pelo texto cru — e isso é uma
 * correção, não um detalhe de estilo. O próprio `carimboDeAceite` existe porque o
 * Galileu produz duas formas ('2026-08-01T08:00' e '2026-08-01 09:00:00'); num
 * `localeCompare` elas divergem já na posição 10 (o 'T' vem depois do espaço na tabela
 * ASCII), então o texto ordenaria a das 09:00 como "mais antiga" e este script gravaria
 * em produção uma hora que nunca existiu. Na sonda de 06/08 as 710 ofertas estavam
 * todas na forma com 'T' e os 36 alvos vinham todos de grupo com oferta ÚNICA — ou
 * seja, o bug estava latente, não ativo. Latente é pior: ele acordaria numa rodada
 * futura, sem nada mudando neste arquivo. O parse já era pago no filtro; agora é
 * aproveitado (decora-ordena-desdecora) em vez de jogado fora.
 *
 * Oferta com `dtahraceite` ilegível não participa de nada: não entra no pool, não
 * empata, não pode ser escolhida. É o mesmo critério de "não inventamos data", só que
 * aplicado antes da ordenação em vez de depois.
 *
 * @param {Array<{codprogcoleta?: string, dtahraceite?: string, descrstatprogcoleta?: string}>} ofertas
 * @returns {object|null} a oferta escolhida, ou null se nenhuma tem aceite legível
 */
export function escolherAceite(ofertas) {
  const comAceite = [];
  for (const oferta of ofertas ?? []) {
    const instante = instanteDeAceite(oferta?.dtahraceite);
    if (instante === null) continue;
    comAceite.push({ oferta, instante });
  }
  if (comAceite.length === 0) return null;
  const vivas = comAceite.filter(
    ({ oferta }) => !OFERTA_STATUS_MORTOS.has(String(oferta?.descrstatprogcoleta ?? "").trim().toUpperCase()),
  );
  const pool = vivas.length > 0 ? vivas : comAceite;
  return pool.sort(
    (a, b) =>
      a.instante - b.instante ||
      String(a.oferta.codprogcoleta ?? "").localeCompare(String(b.oferta.codprogcoleta ?? "")),
  )[0].oferta;
}

/**
 * Índice chave canônica → oferta escolhida, a partir da lista crua de ofertas.
 * @param {Array<object>} ofertas
 * @returns {Map<string, object>}
 */
export function indexarOfertasPorGrupo(ofertas) {
  const agrupado = new Map();
  for (const o of ofertas ?? []) {
    const k = chaveDeGrupo(o?.grupos_id);
    if (!k) continue;
    if (!agrupado.has(k)) agrupado.set(k, []);
    agrupado.get(k).push(o);
  }
  const out = new Map();
  for (const [k, lista] of agrupado) {
    const escolhida = escolherAceite(lista);
    if (escolhida) out.set(k, escolhida);
  }
  return out;
}

/**
 * Decide o que fazer com UMA carga lançada. Pura — nenhum I/O, é o coração testável.
 *
 * Classes:
 *   SEM_LH             — `lh_manual` em branco (defensivo; o SELECT já filtra)
 *   JA_MARCADA         — `trip_accepted_at` preenchido: NUNCA sobrescrevemos.
 *                        É o que torna a segunda passada um no-op.
 *   SEM_OFERTA_NESTLE  — o LH não casa com nenhum grupo com aceite. Inclui, de
 *                        graça, TODA carga Shopee ("LT…") e os LH de teste — é assim
 *                        que o escopo "só Nestlé" se fecha sem lista de exceção.
 *   MARCAR             — grava `trip_accepted_at` E `trip_acceptance_checked_at` com
 *                        o carimbo real do aceite (NUNCA `now()`: o instante honesto é
 *                        quando a viagem foi aceita, não quando rodamos o script). As
 *                        duas juntas porque a fonte responde às duas perguntas de uma
 *                        vez: houve aceite (accepted) e a resposta é conclusiva (checked).
 *
 * A única sutileza é o `checked_at` de quem JÁ TEM um: ele significa "última observação
 * conclusiva", então não pode ANDAR PARA TRÁS. Se o banco já guarda uma observação mais
 * recente que o nosso carimbo histórico, mantemos a dela — nosso carimbo é mais antigo
 * por natureza (é de julho/agosto) e sobrescrever transformaria uma evidência fresca em
 * evidência vencida. Em produção hoje isso nunca acontece (o job ao vivo só varre "LT…",
 * e a sonda de 06/08 achou 0 lançadas com `checked_at` preenchido), mas a regra custa
 * três linhas e evita que este script vire uma máquina de envelhecer observação no dia
 * em que existir um job Nestlé.
 *
 * @param {{carga: object, ofertaPorChave: Map<string, object>}} args
 * @returns {{classe: string, chave: string|null, carimbo: string|null, carimboChecked: string|null, oferta: object|null}}
 */
export function decidirCarga({ carga, ofertaPorChave }) {
  const nada = { carimbo: null, carimboChecked: null, oferta: null };
  const chave = chaveDeGrupo(carga?.lh_manual);
  if (!chave) return { classe: "SEM_LH", chave: null, ...nada };
  if (carga?.trip_accepted_at != null) return { classe: "JA_MARCADA", chave, ...nada };
  const oferta = ofertaPorChave?.get(chave) ?? null;
  if (!oferta) return { classe: "SEM_OFERTA_NESTLE", chave, ...nada };

  const carimbo = carimboDeAceite(oferta.dtahraceite);
  const jaObservado = instanteDeTimestamp(carga?.trip_acceptance_checked_at);
  const carimboChecked =
    carimbo !== null && jaObservado !== null && jaObservado > Date.parse(carimbo)
      ? new Date(jaObservado).toISOString()
      : carimbo;
  return { classe: "MARCAR", chave, carimbo, carimboChecked, oferta };
}

// ─── I/O ──────────────────────────────────────────────────────────────────────

/** Lê tudo paginado — o PostgREST corta em 1000 e um `.limit()` maior é ignorado
 *  silenciosamente, que é justamente o tipo de truncamento que faria o backfill
 *  "não achar" metade da população sem reclamar. */
async function lerPaginado(supabaseClient, tabela, colunas, ordenarPor, aplicarFiltros = (q) => q) {
  const acc = [];
  for (let pagina = 0; ; pagina += 1) {
    const inicio = pagina * PAGINA;
    const { data, error } = await aplicarFiltros(supabaseClient.from(tabela).select(colunas))
      .order(ordenarPor)
      .range(inicio, inicio + PAGINA - 1);
    if (error) throw new Error(`Falha lendo ${tabela}: ${error.message}${dicaDeMigration(error)}`);
    acc.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGINA) return acc;
  }
}

/** O erro cru do PostgREST para coluna ausente ("column X does not exist") não diz o
 *  que fazer. Ele é o modo de falha MAIS PROVÁVEL deste script: na sonda de 06/08/2026
 *  a 20260806150000 ainda não estava aplicada em produção. Traduzir o erro custa nada e
 *  evita a leitura errada de "o backfill está quebrado". */
function dicaDeMigration(error) {
  const msg = String(error?.message ?? "");
  if (/trip_acceptance_checked_at/i.test(msg)) {
    return " — aplique a migration 20260806150000_add_trip_acceptance_checked_to_cargas.sql antes de rodar o backfill.";
  }
  if (/trip_accepted_at/i.test(msg)) {
    return " — aplique a migration 20260805170000 (cria trip_accepted_at) antes de rodar o backfill.";
  }
  return "";
}

async function lerOfertasComAceite(supabaseClient) {
  return lerPaginado(
    supabaseClient,
    "nestle_ofertas",
    "codprogcoleta, grupos_id, dtahraceite, descrstatprogcoleta",
    "codprogcoleta",
    (q) => q.not("dtahraceite", "is", null),
  );
}

/** Cargas LANÇADAS: `sheet_lh` NULL + `lh_manual` preenchido. Vivas e aposentadas —
 *  a lápide também é história e marcar o aceite nela não muda nada de visível, mas
 *  mantém o fato coerente se ela voltar a ser consultada. */
async function lerCargasLancadas(supabaseClient) {
  return lerPaginado(
    supabaseClient,
    "cargas",
    "id, lh_manual, status, retired_reason, data, trip_accepted_at, trip_acceptance_checked_at",
    "id",
    (q) => q.is("sheet_lh", null).not("lh_manual", "is", null),
  );
}

/**
 * Grava o carimbo numa carga. O `.is("trip_accepted_at", null)` no UPDATE não é
 * decoração: é compare-and-set. Entre a leitura e a escrita o job ao vivo pode ter
 * marcado a mesma carga; se marcou, o UPDATE não casa nenhuma linha e a observação
 * dele (mais fresca) prevalece. Nunca sobrescrevemos, nem por corrida.
 */
async function marcarAceite(supabaseClient, { id, carimbo, carimboChecked }) {
  const { data, error } = await supabaseClient
    .from("cargas")
    .update({ trip_accepted_at: carimbo, trip_acceptance_checked_at: carimboChecked ?? carimbo })
    .eq("id", id)
    .is("trip_accepted_at", null)
    .select("id");
  if (error) throw new Error(`Falha gravando carga ${id}: ${error.message}${dicaDeMigration(error)}`);
  return (data?.length ?? 0) > 0;
}

export async function runBackfillTripAcceptedNestle({ apply, limit, deps = {} } = {}) {
  const supabaseClient = deps.supabaseClient || createSupabaseAdminClient();

  const [ofertas, cargas] = await Promise.all([
    lerOfertasComAceite(supabaseClient),
    lerCargasLancadas(supabaseClient),
  ]);
  const ofertaPorChave = indexarOfertasPorGrupo(ofertas);

  // Decide TUDO primeiro (puro), depois escreve só os candidatos. `--limit` corta os
  // candidatos a MARCAR, não a varredura — limitar a varredura daria um relatório
  // enviesado ("0 a marcar" só porque as 10 primeiras eram Shopee).
  const decisoes = cargas.map((carga) => ({ carga, ...decidirCarga({ carga, ofertaPorChave }) }));
  const candidatos = decisoes.filter((d) => d.classe === "MARCAR");
  const alvo = candidatos.slice(0, limit);
  const alvoIds = new Set(alvo.map((d) => d.carga.id));

  const relatorio = [];
  for (const d of decisoes) {
    const linha = {
      id: d.carga.id,
      lh: String(d.carga.lh_manual ?? "").trim(),
      chave: d.chave,
      status: d.carga.status,
      dataCarga: d.carga.data ?? null,
      lapide: Boolean(d.carga.retired_reason),
      classe: d.classe,
      carimbo: d.carimbo,
      carimboChecked: d.carimboChecked,
      ofertaStatus: d.oferta?.descrstatprogcoleta ?? null,
      codprogcoleta: d.oferta?.codprogcoleta ?? null,
      gravado: false,
    };
    if (d.classe === "MARCAR" && !alvoIds.has(d.carga.id)) linha.classe = "FORA_DO_LIMIT";
    if (d.classe === "MARCAR" && alvoIds.has(d.carga.id)) {
      if (!d.carimbo) {
        // Inalcançável: `escolherAceite` só devolve oferta cujo carimbo já parseou.
        // Fica como rede porque é o único caminho pelo qual este script conseguiria
        // gravar `checked_at` com `accepted_at` NULO — a combinação exata que ESCONDE
        // a linha no Monitor. Uma classe explícita no relatório é infinitamente melhor
        // do que um NULL escapando para a coluna que decide visibilidade.
        linha.classe = "CARIMBO_INVALIDO";
      } else if (apply) {
        try {
          linha.gravado = await marcarAceite(supabaseClient, {
            id: d.carga.id,
            carimbo: d.carimbo,
            carimboChecked: d.carimboChecked,
          });
          if (!linha.gravado) linha.classe = "PERDEU_A_CORRIDA"; // já marcada entre a leitura e o UPDATE
        } catch (err) {
          linha.classe = "ERRO";
          linha.erro = err instanceof Error ? err.message : String(err);
        }
      }
    }
    relatorio.push(linha);
  }

  const agregado = relatorio.reduce((acc, l) => {
    acc[l.classe] = (acc[l.classe] ?? 0) + 1;
    return acc;
  }, {});

  return {
    apply,
    totalOfertasComAceite: ofertas.length,
    totalGruposIndexados: ofertaPorChave.size,
    totalLancadas: cargas.length,
    candidatos: candidatos.length,
    processados: alvo.length,
    truncado: candidatos.length > alvo.length,
    gravados: relatorio.filter((l) => l.gravado).length,
    agregado,
    relatorio,
  };
}

function imprimirRelatorio(r) {
  console.log(`\n=== Backfill do aceite Nestlé — modo ${r.apply ? "APPLY (escreveu)" : "DRY (nada escrito)"} ===`);
  console.log(`Ofertas com dtahraceite: ${r.totalOfertasComAceite} → ${r.totalGruposIndexados} grupos indexados`);
  console.log(
    `Cargas lançadas varridas: ${r.totalLancadas} | candidatos a marcar: ${r.candidatos}` +
      ` | processados: ${r.processados}${r.truncado ? " (TRUNCADO pelo --limit)" : ""} | gravados: ${r.gravados}`,
  );
  console.log("\nPor classe:");
  for (const [classe, n] of Object.entries(r.agregado).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${classe}`);
  }

  // Linha a linha só do que interessa: as classes de "não fez nada" somam centenas
  // (toda a Shopee cai em SEM_OFERTA_NESTLE) e afogariam a lista.
  const interessantes = r.relatorio.filter(
    (l) => !["SEM_OFERTA_NESTLE", "JA_MARCADA"].includes(l.classe),
  );
  console.log("\nLH | classe | status carga | data | carimbo (aceite real) | oferta");
  for (const l of interessantes) {
    // `checked_at` só aparece quando DIVERGE do aceite (o banco já tinha observação
    // mais recente e a preservamos). Nos 36 casos de hoje ele é sempre igual — imprimir
    // sempre seria uma coluna de ruído.
    const checked = l.carimboChecked && l.carimboChecked !== l.carimbo ? ` (checked mantido: ${l.carimboChecked})` : "";
    console.log(
      `${l.lh.padEnd(26)} | ${l.classe} | ${l.status ?? "-"}${l.lapide ? " (lápide)" : ""}` +
        ` | ${l.dataCarga ?? "-"} | ${l.carimbo ?? "-"}${checked}` +
        ` | ${l.codprogcoleta ?? "-"} ${l.ofertaStatus ?? ""}${l.erro ? ` | ERRO: ${l.erro}` : ""}`,
    );
  }
  if (!r.apply && r.candidatos > 0) {
    console.log(`\n[backfill-trip-accepted-nestle] DRY-RUN — rode com --apply para gravar as ${r.processados} marcas.`);
  }
}

async function main() {
  let opcoes;
  try {
    opcoes = parseArgs(process.argv.slice(2));
  } catch (err) {
    // Erro de uso não é crash: sai limpo, sem stack trace, sem ter tocado o banco.
    console.error(`[backfill-trip-accepted-nestle] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
    return;
  }
  const { apply, limit } = opcoes;
  if (apply) {
    console.warn("[backfill-trip-accepted-nestle] MODO APPLY — vai escrever em produção. Ctrl+C nos próximos 5s pra abortar.");
    await new Promise((r) => setTimeout(r, 5000));
  }
  const resultado = await runBackfillTripAcceptedNestle({ apply, limit });
  imprimirRelatorio(resultado);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error("[backfill-trip-accepted-nestle] Failed", error);
    process.exitCode = 1;
  });
}
