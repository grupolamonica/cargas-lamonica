/**
 * Consulta "esta LH já virou carga?" da Programação (defaultListLaunchedLhs).
 *
 * Medida em produção (delta de 1091s do pg_stat_statements, queryid
 * 2750483060730118830): 208 linhas por chamada, 14 chamadas em 18 min,
 * ~231 mil linhas/dia — 5º maior produtor de linhas do banco. O chamador só faz
 * `launched.has(lh)`, então a diferença de conjuntos passou a ser feita NO SERVIDOR:
 * uma coluna em vez de duas e UNION (dedupe) em vez de uma linha por carga casada.
 *
 * Este teste roda o SQL DE VERDADE no pg-mem (a `cargas` do harness tem as duas
 * colunas) e compara, na MESMA fixture, o que a forma antiga devolvia. A fixture
 * cobre os dois lados do OR — casamento só por `sheet_lh` e só por `lh_manual` — mais
 * o par de carga gêmea (mesma LH nas duas colunas, em cargas diferentes), porque é
 * ele que faz a contagem de linhas divergir.
 *
 * NÃO há cache aqui, de propósito: `jaLancada` governa o botão "Lançar", e um TTL
 * mostraria "Lançar" numa carga já lançada por toda a janela — convite ao duplo
 * lançamento. A redução é por linha/coluna, sem envelhecer nada.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  withPgClient as rawWithPgClient,
  withPgTransaction,
} from "../test-harness.js";

const LAUNCHED_SELECT = /FROM public\.cargas WHERE sheet_lh = ANY/;
const LEGACY_LAUNCHED_SQL =
  "SELECT sheet_lh, lh_manual FROM public.cargas WHERE sheet_lh = ANY($1::text[]) OR lh_manual = ANY($1::text[])";

// ── Instrumentação: conta o SQL executado E as linhas devolvidas ─────────────
// O pool do pg-mem REUSA clients, então o wrapper precisa ser idempotente
// (Symbol) senão a contagem dobra.
const sqlLog = []; // { sql, rows }
const INSTRUMENTED = Symbol("instrumented");

function instrument(client) {
  if (client[INSTRUMENTED]) return client;
  const original = client.query.bind(client);
  client.query = async (...args) => {
    const first = args[0];
    const sql = typeof first === "string" ? first : String(first?.text ?? "");
    const entry = { sql, rows: 0 };
    sqlLog.push(entry);
    const res = await original(...args);
    entry.rows = res?.rows?.length ?? 0;
    return res;
  };
  client[INSTRUMENTED] = true;
  return client;
}

const withPgClient = async (fn) => rawWithPgClient((client) => fn(instrument(client)));

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));

const { getProgramacao } = await import("./get-programacao.js");

const countSql = (re) => sqlLog.filter((e) => re.test(e.sql)).length;
const rowsOf = (re) => sqlLog.filter((e) => re.test(e.sql)).reduce((n, e) => n + e.rows, 0);

// Viagem SPX crua (shape do sidecar), sempre na aba Aceito — que não sofre o filtro
// de atraso, então o LH chega inteiro até a consulta de "já lançada".
const FUTURO_TS = Math.floor(Date.UTC(2027, 0, 10, 12, 0) / 1000);
const trip = (lh) => ({
  trip_number: lh,
  trip_name: "X-Y",
  trip_status_name: "Loading",
  acceptance_status: 1,
  driver_name: "MOTORISTA TESTE",
  vehicle_type: "CARRETA",
  cavalo: "ABC1D23",
  carreta: "",
  origem: "LM Hub_CE_Juazeiro do Norte",
  destino: "SoC_CE_Itaitinga",
  carregamento_ts: FUTURO_TS,
  descarga_ts: FUTURO_TS,
});

/** Um ciclo de poll da tela (aba Aceito), com a fonte Nestlé desligada. */
const poll = (trips = []) =>
  getProgramacao({
    tabs: ["aceito"],
    deps: {
      fetchTripsByTab: async () => ({ trips, truncated: false, total: trips.length }),
      nestleEnabled: false,
      today: "2026-07-01",
      nowTime: "00:00:00",
      nowMs: Date.UTC(2026, 6, 1),
    },
  });

async function seedLh({ sheetLh = null, lhManual = null }) {
  const { id } = await seedCargo({ sheet_lh: sheetLh });
  if (lhManual) await query(`UPDATE public.cargas SET lh_manual = $1 WHERE id = $2`, [lhManual, id]);
}

/** Fixture com os dois lados do OR + par gêmeo + coluna irmã que ninguém pediu. */
async function seedLaunchedFixture() {
  await seedLh({ sheetLh: "LT-SHEET", lhManual: "LT-EXTRA" }); // casa por sheet_lh
  await seedLh({ lhManual: "LT-MANUAL" });                    // casa por lh_manual
  await seedLh({ sheetLh: "LT-TWIN" });                       // gêmea (metade 1)
  await seedLh({ lhManual: "LT-TWIN" });                      // gêmea (metade 2)
  await seedLh({ sheetLh: "LT-OUTRA" });                      // ninguém perguntou
}
const PEDIDOS = ["LT-SHEET", "LT-MANUAL", "LT-TWIN", "LT-NOVA"];

describe("Programação — consulta de 'já lançada' (integração pg-mem)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    sqlLog.length = 0;
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("marca como lançada exatamente quem casa por sheet_lh OU por lh_manual", async () => {
    await seedLaunchedFixture();
    sqlLog.length = 0;

    const res = await poll(PEDIDOS.map(trip));

    expect(Object.fromEntries(res.payload.rows.map((r) => [r.lh, r.jaLancada]))).toEqual({
      "LT-SHEET": true,  // só em sheet_lh
      "LT-MANUAL": true, // só em lh_manual
      "LT-TWIN": true,   // nas duas colunas, em cargas diferentes
      "LT-NOVA": false,  // não existe → o botão "Lançar" continua aparecendo
    });
    expect(res.payload.summary.jaLancadas).toBe(3);
    expect(countSql(LAUNCHED_SELECT)).toBe(1); // uma consulta por ciclo, como antes
  });

  it("devolve MENOS linhas e METADE das colunas da forma antiga, com a mesma pertinência", async () => {
    await seedLaunchedFixture();
    sqlLog.length = 0;

    await poll(PEDIDOS.map(trip));
    const linhasNovas = rowsOf(LAUNCHED_SELECT);

    // A forma antiga, na MESMA fixture: uma linha por carga casada, duas colunas.
    const legacy = await query(LEGACY_LAUNCHED_SQL, [PEDIDOS]);
    expect(Object.keys(legacy.rows[0])).toEqual(["sheet_lh", "lh_manual"]);
    expect(legacy.rows).toHaveLength(4); // 4 cargas casam (o par gêmeo conta duas vezes)
    expect(linhasNovas).toBe(3);         // 3 LHs distintos entre os PEDIDOS
    expect(linhasNovas).toBeLessThan(legacy.rows.length);

    // A forma antiga trazia LH que ninguém pediu (a coluna irmã da carga casada) — bytes
    // atravessando o pooler para nada.
    const legacySet = new Set();
    for (const r of legacy.rows) {
      if (r.sheet_lh) legacySet.add(r.sheet_lh);
      if (r.lh_manual) legacySet.add(r.lh_manual);
    }
    expect(legacySet.has("LT-EXTRA")).toBe(true);

    // Pertinência preservada onde importa: para TODO LH pedido, mesma resposta que antes.
    for (const lh of PEDIDOS) {
      const agora = (await poll([trip(lh)])).payload.rows[0].jaLancada;
      expect(agora).toBe(legacySet.has(lh));
    }
  });

  it("LH repetida na tela vira um único parâmetro (dedupe na entrada)", async () => {
    await seedLaunchedFixture();
    sqlLog.length = 0;

    // Mesma LH em duas linhas da tela (acontece entre abas) → uma linha de resposta.
    await poll([trip("LT-TWIN"), trip("LT-TWIN"), trip("LT-SHEET")]);

    expect(countSql(LAUNCHED_SELECT)).toBe(1);
    expect(rowsOf(LAUNCHED_SELECT)).toBe(2); // LT-TWIN + LT-SHEET, sem repetição
  });

  it("nenhum LH na tela → nenhuma consulta ao banco", async () => {
    await seedLaunchedFixture();
    sqlLog.length = 0;

    await poll([]);

    expect(countSql(LAUNCHED_SELECT)).toBe(0);
  });

  it("banco sem nenhuma carga: ninguém é marcado como lançado", async () => {
    const res = await poll(PEDIDOS.map(trip));

    expect(res.payload.rows.every((r) => r.jaLancada === false)).toBe(true);
    expect(res.payload.summary.jaLancadas).toBe(0);
    expect(rowsOf(LAUNCHED_SELECT)).toBe(0);
  });
});
