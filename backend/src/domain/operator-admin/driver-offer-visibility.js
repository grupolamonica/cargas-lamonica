// backend/src/domain/operator-admin/driver-offer-visibility.js
//
// "Esta carga está OFERTADA a algum motorista agora?" — regra pura, sem I/O.
//
// POR QUE ISTO EXISTE
// O read model do Monitor (fonte SISTEMA) acumulou SEIS regras de ocultação em 30
// dias, e TRÊS já precisaram de correção por esconderem demais. A última
// (`isUnacceptedLaunchedShopeeCargo`, PR #457) escondia 27 cargas que estavam ABERTAS
// no portal do motorista — 64% do frete ofertado invisível para quem opera. Consertar
// filtro por filtro é enxugar gelo: o sétimo repete o erro.
//
// A norma aprovada pelo dono do produto: **carga ofertada ao motorista NUNCA pode
// estar invisível ao operador**. Este predicado é a metade declarativa dessa norma; a
// outra metade é o PORTÃO FINAL em `listSystemCargasForMonitor`, que repõe qualquer
// linha aprovada aqui depois de TODAS as regras de ocultação. A lógica se inverte: em
// vez de cada filtro ter de lembrar de não esconder frete vivo, NENHUM consegue.
//
// FONTE DA VERDADE
// A regra espelhada é a do portal, `buildDriverLoadFilters` em
// `application/operator-admin/use-cases/_shared.js` (com a configuração de runtime do
// portal: visibilidade + pacote + guarda do ASPX + exceção "a confirmar"):
//
//   status = 'OPEN'
//   COALESCE(is_template, false) = false
//   COALESCE(alloc_motorista, sheet_motorista, '') = ''
//   aspx_missing_since IS NULL
//   (data IS NULL OR data > hoje OR (data = hoje AND (horario IS NULL OR horario >= agora))
//    OR COALESCE(agenda_a_confirmar, false) = true)          [relógio de São Paulo]
//   viagem_id IS NULL      -> COALESCE(driver_visibility, 'PUBLIC') = 'PUBLIC'
//   viagem_id IS NOT NULL  -> status do pacote em ('publicado','reservado','em_andamento')
//
// Espelho copiado à mão diverge com o tempo — por isso existe
// `use-cases/driver-offer-visibility.parity.test.js`, que roda o SQL REAL do
// `buildDriverLoadFilters` contra o harness pg-mem e compara conjunto de ids com o que
// este predicado aprova. Divergência quebra o teste.
//
// DIREÇÃO DO ERRO (a decisão de projeto que governa o arquivo inteiro)
// **Desconhecido NUNCA bloqueia.** Só um valor PRESENTE e explícito pode reprovar uma
// linha. Coluna ausente do SELECT, migration não aplicada, data ilegível, pacote fora
// do mapa — tudo isso resulta em "ofertada", e o portão então protege a linha. Errar
// exibindo custa uma linha a mais na tela do operador; errar escondendo custou 24
// cargas de frete vivo invisíveis. Os custos não são simétricos, a regra também não.
//
// Consequência aceita: em alguns pontos o predicado é DELIBERADAMENTE mais permissivo
// que o SQL (comparação de `status`/`driver_visibility` sem sensibilidade a caixa,
// pacote desconhecido, coluna ausente). Cada um está anotado abaixo, e o teste de
// paridade afirma a relação exata (JS ⊇ SQL) em vez de fingir igualdade.

/** Status de pacote (`cargas_casadas.status`) em que a perna é ofertada ao motorista.
 *  Mesma lista do `buildDriverLoadFilters`; o pacote em rascunho nunca foi ao portal. */
export const PACOTE_STATUS_OFERTADO = Object.freeze(["publicado", "reservado", "em_andamento"]);
const PACOTE_STATUS_OFERTADO_SET = new Set(PACOTE_STATUS_OFERTADO);

/** DATE do Postgres chega como '2026-06-25', ISO '2026-06-25T00:00:00.000Z' (PostgREST)
 *  ou objeto Date (driver `pg`). Devolve 'YYYY-MM-DD' ou null quando não dá para ler —
 *  e null aqui significa "não sei", que pela direção do erro NÃO bloqueia. */
function toDateStr(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
  }
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** TIME do Postgres chega como 'HH:MM:SS'. Normaliza para 8 chars porque comparação de
 *  string é lexicográfica e '08:00' < '08:00:00' — a forma curta faria a carga marcada
 *  exatamente para agora parecer vencida (esconderia frete vivo, direção proibida). */
function toTimeStr(value) {
  if (value == null || value === "") return null;
  const s = String(value);
  const m = s.match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? `${m[1]}:${m[2]}:${m[3] ?? "00"}` : null;
}

/**
 * A carga está ofertada a algum motorista NESTE instante?
 *
 * @param {object} carga linha crua de `public.cargas` (chave AUSENTE = desconhecido).
 * @param {{ todayIso?: string|null, nowTimeIso?: string|null,
 *          pacoteStatusById?: Map<string,string>|Record<string,string>|null }} [ctx]
 *   `todayIso` 'YYYY-MM-DD' e `nowTimeIso` 'HH:MM:SS' no relógio de SÃO PAULO
 *   (`getSaoPauloWallClock`) — o container roda em UTC e `data`/`horario` são horário
 *   local do Brasil. Sem relógio, a janela de carregamento não é avaliada (desconhecido
 *   não bloqueia). `pacoteStatusById` mapeia `viagem_id` → `cargas_casadas.status`.
 * @returns {boolean} true = ofertada; nenhuma regra de ocultação pode derrubá-la.
 */
export function isOfferedToDriver(carga, { todayIso = null, nowTimeIso = null, pacoteStatusById = null } = {}) {
  if (!carga || typeof carga !== "object") return false;

  // ── ciclo de vida ─────────────────────────────────────────────────────────────
  // SQL: `cargas.status = 'OPEN'` (comparação exata). Aqui normalizamos caixa/espaço:
  // divergência deliberada e SEMPRE na direção permissiva (um 'open' minúsculo, que
  // nada no codebase grava, seria ofertado aqui e não no SQL). `undefined` = coluna
  // fora do SELECT = desconhecido → não bloqueia.
  if (carga.status !== undefined && String(carga.status).trim().toUpperCase() !== "OPEN") return false;

  // ── template ──────────────────────────────────────────────────────────────────
  // SQL: `COALESCE(is_template, false) = false`. Só o `true` explícito bloqueia.
  if (carga.is_template === true) return false;

  // ── motorista efetivo ─────────────────────────────────────────────────────────
  // SQL: `COALESCE(alloc_motorista, sheet_motorista, '') = ''` — o override do operador
  // vence a planilha. Sem `.trim()` DE PROPÓSITO: no Postgres '   ' <> '', então uma
  // alocação em brancos bloqueia lá e tem de bloquear aqui (trim divergiria).
  const motoristaEfetivo = carga.alloc_motorista ?? carga.sheet_motorista ?? "";
  if (String(motoristaEfetivo) !== "") return false;

  // ── viagem fora do ASPX ───────────────────────────────────────────────────────
  // SQL: `aspx_missing_since IS NULL`. A viagem sumiu do portal da Shopee: candidatura
  // aqui vira frete que ninguém opera. `undefined` (coluna não selecionada, ou banco
  // sem a migration — e aí o portal também solta a guarda) → não bloqueia.
  if (carga.aspx_missing_since != null) return false;

  // ── janela de carregamento (relógio de São Paulo) ─────────────────────────────
  // SQL: data IS NULL OR data > hoje OR (data = hoje AND (horario IS NULL OR horario >= agora))
  //      OR COALESCE(agenda_a_confirmar, false) = true
  //
  // `agenda_a_confirmar` merece cuidado: a exceção só pode tornar a carga MAIS
  // ofertada, então `false` é a direção PERIGOSA e `undefined` não pode cair nela. Um
  // 42703 na cadeia de fallbacks do read model tira a coluna do SELECT sem que o banco
  // a tenha perdido — o portal continua aplicando a exceção e o portão passaria a
  // reprovar exatamente as cargas "A confirmar" que ele existe para proteger. Por isso
  // `undefined` (não sei) entra como "a exceção pode valer" e a janela nem é avaliada;
  // só `false`/`null` (COALESCE explícito) mantêm o corte por data/hora.
  const agendaIndefinida = carga.agenda_a_confirmar === true || carga.agenda_a_confirmar === undefined;
  if (!agendaIndefinida && todayIso) {
    const dataStr = toDateStr(carga.data);
    if (dataStr && dataStr < todayIso) return false;
    if (dataStr && dataStr === todayIso) {
      const horaStr = toTimeStr(carga.horario);
      if (horaStr && nowTimeIso && horaStr < toTimeStr(nowTimeIso)) return false;
    }
  }

  // ── visibilidade: avulsa (driver_visibility) vs. perna de pacote (status do pacote) ─
  // `undefined` em `viagem_id` não permite escolher o ramo → desconhecido → não bloqueia.
  if (carga.viagem_id === undefined) return true;

  if (carga.viagem_id === null) {
    // SQL: `COALESCE(driver_visibility, 'PUBLIC') = 'PUBLIC'`. Caixa normalizada pelo
    // mesmo motivo (e na mesma direção) do `status`.
    const visibilidade = carga.driver_visibility ?? "PUBLIC";
    return String(visibilidade).trim().toUpperCase() === "PUBLIC";
  }

  // Perna de pacote: quem decide é o status do pacote — `driver_visibility` é ignorado
  // (todas as cargas de um pacote são PREMIUM por desenho).
  //
  // Pacote DESCONHECIDO (mapa não fornecido, ou `viagem_id` sem linha em
  // `cargas_casadas`) → OFERTADA. É a única divergência estrutural contra o SQL, que
  // usa LEFT JOIN e reprova por `NULL IN (...)`. Assumida de propósito: o read model do
  // Monitor não lê `cargas_casadas`, e inventar "não ofertada" a partir de um dado que
  // não fomos buscar é exatamente o erro que originou a norma.
  const status = pacoteStatusById instanceof Map
    ? pacoteStatusById.get(carga.viagem_id)
    : (pacoteStatusById ? pacoteStatusById[carga.viagem_id] : undefined);
  if (status == null) return true;
  return PACOTE_STATUS_OFERTADO_SET.has(String(status).trim().toLowerCase());
}
