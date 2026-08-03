/**
 * Cache das ofertas Nestlé do read model da Programação (defaultFetchNestleOfertas).
 *
 * Mede a única coisa que importa aqui: QUANTAS vezes a varredura da nestle_ofertas
 * (~2.9k linhas após o DISTINCT ON, com LEFT JOIN em nestle_embarques) roda por
 * minuto de tela aberta, e quantas LINHAS isso devolve (proxy direto do egress do
 * pooler).
 *
 * ⚠ A contagem é feita na CADÊNCIA REAL DO POLL (relógio falso avançado entre as
 * chamadas). Duas chamadas coladas cabem em qualquer TTL > 0 e passariam até com o
 * TTL quebrado — foi assim que o cache do sino foi para produção com TTL de 15s
 * contra um poll de 30s e mediu ZERO hit (35 execuções em 1091s). Aqui o par antigo
 * era ainda mais inútil: TTL 90s contra poll de 90s (idade == TTL no instante do
 * poll → sempre miss).
 *
 * Por que não pg-mem: a query real faz LEFT JOIN em `nestle_embarques` (tabela que
 * o harness não cria) e usa `<> ALL($1::text[])`, que o pg-mem não suporta — ela
 * cairia no fallback de tabela ausente e o teste mediria nada. O client falso abaixo
 * devolve linhas no shape do Galileo e conta chamadas/linhas; a semântica do SQL não
 * é o objeto deste teste (os testes de comportamento em get-programacao.test.js
 * injetam deps.fetchNestleOfertas).
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Client de pg falso, instrumentado ────────────────────────────────────────
// O wrapper é idempotente (Symbol): o client é REUSADO entre chamadas (como o pool
// real reusa), então sem a guarda a contagem dobraria.
const INSTRUMENTED = Symbol("instrumented");
const pgCalls = []; // { sql, rowCount }
let nestleRowsInDb = [];

const NESTLE_SQL = /FROM public\.nestle_ofertas/;

const rawClient = {
  query: async (sql) => {
    const text = typeof sql === "string" ? sql : String(sql?.text ?? "");
    if (NESTLE_SQL.test(text)) return { rows: nestleRowsInDb };
    return { rows: [] };
  },
};

function instrument(client) {
  if (client[INSTRUMENTED]) return client;
  const original = client.query.bind(client);
  client.query = async (...args) => {
    const first = args[0];
    const sql = typeof first === "string" ? first : String(first?.text ?? "");
    const result = await original(...args);
    pgCalls.push({ sql, rowCount: result.rows.length });
    return result;
  };
  client[INSTRUMENTED] = true;
  return client;
}

const withPgClient = async (fn) => fn(instrument(rawClient));

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient,
  withPgTransaction: withPgClient,
}));

// ── Relógio controlável ─────────────────────────────────────────────────────
// O cache só olha Date.now(); avançar o offset simula o tempo real entre polls.
let clockSkewMs = 0;
const realDateNow = Date.now.bind(Date);
vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + clockSkewMs);
const advanceClock = (ms) => {
  clockSkewMs += ms;
};

const { __nestleOfertasCacheTiming, __resetNestleOfertasCache, getProgramacao } = await import(
  "./get-programacao.js"
);

const TTL = String(__nestleOfertasCacheTiming.ttlMs);
const POLL = __nestleOfertasCacheTiming.pollMs;

const nestleCalls = () => pgCalls.filter((c) => NESTLE_SQL.test(c.sql));
const nestleRowsRead = () => nestleCalls().reduce((acc, c) => acc + c.rowCount, 0);

// Volume medido em produção após o DISTINCT ON — cada execução devolve isto.
const PROD_ROWS = 2897;

function makeNestleRow(i) {
  return {
    codprogcoleta: `P${i}`,
    codembarque: `E${i}`,
    grupos_id: `B${1000000 + i}`,
    descrstatprogcoleta: "ACEITA", // aba "aceito" → não é filtrada por atraso
    emporig_nomecid: "Feira de Santana",
    emporig_uf: "BA",
    emporig_nomeciduf: "Feira de Santana/BA",
    empdest_nomecid: "Recife",
    empdest_uf: "PE",
    empdest_nomeciduf: "Recife/PE",
    tpveic_nome: "CARRETA",
    tipo: "CONTRATO",
    dtahrprevatual: "2026-08-20T08:00:00",
    dtahrpreventrega: "2026-08-21T18:00:00",
    emb_motorista: "JOAO SILVA",
    emb_placa: "ABC1D23",
    emb_status: "EM VIAGEM",
    emb_entrega_fim: null,
  };
}

// SPX vazio e sem lookup de lançadas: o objeto deste teste é só a fonte Nestlé.
const spxDeps = {
  fetchTripsByTab: async () => ({ trips: [], truncated: false, total: 0 }),
  listLaunchedLhs: async () => new Set(),
  today: "2026-08-01",
  nowTime: "00:00:00",
  nowMs: Date.UTC(2026, 7, 1),
};

const poll = (extra = {}) => getProgramacao({ deps: spxDeps, ...extra });

/**
 * `refetchInterval` da tela (primeira query da Programação). Guarda anti-deriva: o
 * TTL só é útil enquanto for maior que o poll. Pulado quando o front não está no
 * checkout (imagem Docker só com backend/).
 */
function readProgramacaoRefetchInterval() {
  try {
    const src = readFileSync(new URL("../../../../../frontend/src/pages/Programacao.tsx", import.meta.url), "utf8");
    const m = src.match(/refetchInterval:\s*([\d_]+)/);
    return m ? Number(m[1].replace(/_/g, "")) : null;
  } catch {
    return undefined;
  }
}

describe("Programação — cache das ofertas Nestlé (TTL × cadência do poll)", () => {
  beforeEach(() => {
    pgCalls.length = 0;
    clockSkewMs = 0;
    nestleRowsInDb = Array.from({ length: PROD_ROWS }, (_, i) => makeNestleRow(i));
    delete process.env.PROGRAMACAO_NESTLE_CACHE_TTL_MS;
    __resetNestleOfertasCache();
  });

  it("TTL > poll da tela e não passa do ciclo do coletor Galileu", () => {
    const { ttlMs, pollMs, coletorMs } = __nestleOfertasCacheTiming;
    // TTL == poll (o valor antigo, 90s × 90s) não serve nada: no instante do poll
    // seguinte a idade é exatamente o TTL e o `< ttl` é falso.
    expect(ttlMs).toBeGreaterThan(pollMs);
    // Teto: o dado só muda quando o coletor faz upsert (NESTLE_COLETA_INTERVAL_SEC=120
    // no docker-compose), então o TTL não devolve nada mais velho que UM ciclo.
    expect(ttlMs).toBeLessThanOrEqual(coletorMs);

    const front = readProgramacaoRefetchInterval();
    if (front === undefined) return; // front fora do checkout
    expect(front).toBe(pollMs);
    expect(ttlMs).toBeGreaterThan(front);
  });

  it("sem o knob o cache fica DESLIGADO em teste (cada chamada varre a tabela)", async () => {
    await poll();
    await poll();
    expect(nestleCalls()).toHaveLength(2);
  });

  it("o poll seguinte (90s depois) vem do cache — mesmas linhas, zero varredura nova", async () => {
    process.env.PROGRAMACAO_NESTLE_CACHE_TTL_MS = TTL;

    const first = await poll();
    expect(nestleCalls()).toHaveLength(1);
    expect(nestleRowsRead()).toBe(PROD_ROWS);

    advanceClock(POLL); // 90s depois — cadência real da tela, não chamada colada
    const second = await poll();

    expect(nestleCalls()).toHaveLength(1); // NÃO foi ao banco de novo
    expect(nestleRowsRead()).toBe(PROD_ROWS); // 2.897 linhas no lugar de 5.794
    // Comportamento preservado: payload idêntico (só o fetchedAt do request muda).
    expect(second.statusCode).toBe(200);
    expect(second.payload.rows).toEqual(first.payload.rows);
    expect(second.payload.summary).toEqual(first.payload.summary);
    expect(second.payload.clientes).toEqual(first.payload.clientes);

    // E não gruda para sempre: passado o TTL (t = 180s > 120s), relê.
    advanceClock(POLL);
    await poll();
    expect(nestleCalls()).toHaveLength(2);
  });

  it("os 2 fetches do MESMO ciclo (abas principais + Concluído) custam uma varredura só", async () => {
    process.env.PROGRAMACAO_NESTLE_CACHE_TTL_MS = TTL;

    // A tela dispara duas queries por ciclo, sequenciais (não concorrentes → o
    // single-flight não pega): quem colapsa as duas é o TTL.
    await poll({ tabs: ["planejado", "aceito"] });
    await poll({ tabs: ["concluido"] });

    expect(nestleCalls()).toHaveLength(1);
    expect(nestleRowsRead()).toBe(PROD_ROWS);
  });

  it("6 polls de 90s (9 min de tela aberta) = 3 varreduras, não 6", async () => {
    process.env.PROGRAMACAO_NESTLE_CACHE_TTL_MS = TTL;

    const seen = [];
    for (let i = 0; i < 6; i += 1) {
      if (i > 0) advanceClock(POLL);
      seen.push(await poll());
    }

    // TTL 120s × poll 90s → miss/hit alternados: uma varredura a cada 180s.
    expect(nestleCalls()).toHaveLength(3);
    expect(nestleRowsRead()).toBe(PROD_ROWS * 3); // 8.691 no lugar de 17.382
    for (const res of seen) expect(res.payload.rows).toEqual(seen[0].payload.rows);
  });

  it("TTL IGUAL ao poll (90s × 90s, o par antigo) dá ZERO hit", async () => {
    // Guarda de regressão: com TTL == poll, os 6 ciclos custam 6 varreduras
    // completas (17.382 linhas) — o cache não serve NADA.
    process.env.PROGRAMACAO_NESTLE_CACHE_TTL_MS = "90000";

    for (let i = 0; i < 6; i += 1) {
      if (i > 0) advanceClock(POLL);
      await poll();
    }

    expect(nestleCalls()).toHaveLength(6);
    expect(nestleRowsRead()).toBe(PROD_ROWS * 6);
  });

  it('o botão "Atualizar" (force) ignora o cache e repovoa a janela', async () => {
    process.env.PROGRAMACAO_NESTLE_CACHE_TTL_MS = TTL;

    await poll();
    expect(nestleCalls()).toHaveLength(1);

    // Dentro do TTL, mas o operador pediu explicitamente dados novos: vai ao banco.
    advanceClock(10_000);
    nestleRowsInDb = [makeNestleRow(9999)]; // coletor rodou nesse meio tempo
    const forced = await poll({ force: true });
    expect(nestleCalls()).toHaveLength(2);
    expect(forced.payload.rows.map((r) => r.lh)).toEqual([`B${1000000 + 9999}`]);

    // O refresh repovoou o cache: o poll seguinte (90s depois) vem dele e já com o
    // dado novo — não com o antigo.
    advanceClock(POLL);
    const after = await poll();
    expect(nestleCalls()).toHaveLength(2);
    expect(after.payload.rows.map((r) => r.lh)).toEqual([`B${1000000 + 9999}`]);
  });

  it("cache desligado (knob 0) mantém o comportamento antigo: uma varredura por chamada", async () => {
    process.env.PROGRAMACAO_NESTLE_CACHE_TTL_MS = "0";

    await poll();
    advanceClock(POLL);
    await poll();

    expect(nestleCalls()).toHaveLength(2);
  });
});
