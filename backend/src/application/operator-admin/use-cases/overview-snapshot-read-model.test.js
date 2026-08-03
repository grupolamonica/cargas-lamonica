/**
 * PROVA 2 de 2 da agregação server-side do Painel (/painel).
 *
 * Prova 1 (`frontend/src/lib/overviewMetrics.serverParity.test.ts`): o builder do
 * navegador == a montagem server-side sobre os agregados do ORÁCULO.
 * Prova 2 (aqui): o SQL real, rodando no pg-mem, == o mesmo ORÁCULO sobre a MESMA
 * fixture. Por transitividade, navegador == SQL.
 *
 * Mede também o custo REAL em consultas/linhas (proxy direto de egress): a tela
 * baixava 3x500 linhas cruas do PostgREST por aba; agora o servidor lê 3 linhas
 * escalares + as cargas ABERTAS, uma vez por TTL, para todas as abas.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedUser,
  withPgClient as harnessWithPgClient,
  withPgTransaction,
} from "../test-harness.js";
import { buildOverviewSnapshotFromAggregates, normalizeOpenLoadRow } from "./overview-snapshot-metrics.js";
import {
  OVERVIEW_PARITY_CARGOS,
  OVERVIEW_PARITY_CLAIMS,
  OVERVIEW_PARITY_LEADS,
  OVERVIEW_PARITY_NOW,
  aggregateOverviewRowsAsSql,
} from "./overview-snapshot-parity-oracle.js";

// Contador de consultas + linhas trafegadas (proxy de egress).
const dbStats = { queries: 0, rows: 0 };

function resetDbStats() {
  dbStats.queries = 0;
  dbStats.rows = 0;
}

// O pool do pg-mem REUTILIZA clients, então o wrapper precisa ser idempotente:
// envolver duas vezes o mesmo client contaria cada consulta em dobro.
const INSTRUMENTED = Symbol.for("egress.instrumented");

function instrumentClient(client) {
  if (client[INSTRUMENTED]) return client;
  const originalQuery = client.query.bind(client);
  client.query = async (...args) => {
    const result = await originalQuery(...args);
    dbStats.queries += 1;
    dbStats.rows += result?.rows?.length ?? result?.rowCount ?? 0;
    return result;
  };
  client[INSTRUMENTED] = true;
  return client;
}

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: (callback) => harnessWithPgClient((client) => callback(instrumentClient(client))),
  withPgTransaction,
}));

const readModel = await import("./overview-snapshot-read-model.js");

const NOW = new Date(OVERVIEW_PARITY_NOW);

// `cargas.id` é uuid; a fixture usa ids legíveis. Mapeia para uuids estáveis e
// reaplica o mapeamento no oráculo, para os dois lados falarem dos mesmos ids.
const ID_BY_LABEL = new Map(
  OVERVIEW_PARITY_CARGOS.map((cargo, index) => [
    cargo.id,
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  ]),
);

const cargos = OVERVIEW_PARITY_CARGOS.map((cargo) => ({ ...cargo, id: ID_BY_LABEL.get(cargo.id) }));
const leads = OVERVIEW_PARITY_LEADS.map((lead, index) => ({
  ...lead,
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  load_id: ID_BY_LABEL.get(lead.load_id),
}));
const claims = OVERVIEW_PARITY_CLAIMS.map((claim, index) => ({
  ...claim,
  id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  load_id: ID_BY_LABEL.get(claim.load_id),
}));

async function seedParityFixture() {
  // `data`/`horario` são NOT NULL no schema real; a fixture cobre os nulos porque
  // o front tratava esse caso (e o tratamento tem de sobreviver à porta).
  await query(`ALTER TABLE public.cargas ALTER COLUMN data DROP NOT NULL`);
  await query(`ALTER TABLE public.cargas ALTER COLUMN horario DROP NOT NULL`);
  // O harness é enxuto e não tem estas duas colunas de load_claims, que existem
  // em produção (supabase/bootstrap.sql) e entram na cadeia de "última atividade".
  await query(`ALTER TABLE public.load_claims ADD COLUMN promoted_at timestamptz`);
  await query(`ALTER TABLE public.load_claims ADD COLUMN confirmed_at timestamptz`);

  const driver = await seedUser();

  for (const cargo of cargos) {
    await query(
      `INSERT INTO public.cargas (
         id, data, horario, origem, destino, distancia_km, perfil, status, is_template,
         sheet_data_carregamento, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        cargo.id,
        cargo.data,
        cargo.horario,
        cargo.origem,
        cargo.destino,
        cargo.distancia_km,
        cargo.perfil,
        cargo.status,
        cargo.is_template,
        cargo.sheet_data_carregamento,
        cargo.created_at,
        cargo.updated_at,
      ],
    );
  }

  for (const lead of leads) {
    await query(
      `INSERT INTO public.load_public_leads (
         id, load_id, cpf, phone, horse_plate, trailer_plate, vehicle_type, status,
         queued_at, whatsapp_clicked_at, approved_at, created_at, updated_at
       ) VALUES ($1, $2, '12345678901', '71999999999', 'ABC1D23', 'DEF4G56', $3, $4, $5, $6, $7, $8, $8)`,
      [
        lead.id,
        lead.load_id,
        lead.vehicle_type,
        lead.status,
        lead.queued_at,
        lead.whatsapp_clicked_at,
        lead.approved_at,
        lead.created_at,
      ],
    );
  }

  for (const claim of claims) {
    await query(
      `INSERT INTO public.load_claims (
         id, load_id, driver_id, status, queue_position, claimed_at, promoted_at, confirmed_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        claim.id,
        claim.load_id,
        driver.id,
        claim.status,
        claim.queue_position,
        claim.claimed_at,
        claim.promoted_at,
        claim.confirmed_at,
        claim.created_at,
      ],
    );
  }
}

/** Compara agregados independentes de driver (pg devolve numeric string, pg-mem number). */
function normalizeAggregates(aggregates) {
  return {
    cargoCounts: aggregates.cargoCounts,
    leadCounts: aggregates.leadCounts,
    lastUpdatedAt: aggregates.lastUpdatedAt == null ? null : new Date(aggregates.lastUpdatedAt).toISOString(),
    openLoadRows: aggregates.openLoadRows.map((row) => {
      const normalized = normalizeOpenLoadRow(row);
      return { ...normalized, createdAt: normalized.createdAt.toISOString() };
    }),
  };
}

describe("Painel — snapshot agregado no SQL", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    readModel.__resetOverviewSnapshotCache();
    delete process.env.OPERATOR_OVERVIEW_SNAPSHOT_CACHE_TTL_MS;
    await seedParityFixture();
    resetDbStats();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("o SQL devolve os MESMOS agregados que o oráculo de paridade", async () => {
    const fromSql = await readModel.fetchOverviewSnapshotAggregates({ now: NOW });
    const fromOracle = aggregateOverviewRowsAsSql(cargos, leads, claims, { now: NOW });

    expect(normalizeAggregates(fromSql)).toEqual(normalizeAggregates(fromOracle));
    // Não-vácuo: a fixture tem cargas abertas e interesse de verdade.
    expect(normalizeAggregates(fromSql).openLoadRows.length).toBe(15);
    expect(fromSql.cargoCounts).toEqual({
      activeLoads: 15,
      draftCount: 1,
      bookedCount: 2,
      reservedCount: 1,
    });
    expect(fromSql.leadCounts).toEqual({
      queueActiveLeads: 4,
      pendingApprovals: 1,
      approvedToday: 2,
    });
  });

  it("o snapshot montado a partir do SQL é igual ao montado a partir do oráculo", async () => {
    const fromSql = await readModel.fetchOverviewSnapshotAggregates({ now: NOW });
    const fromOracle = aggregateOverviewRowsAsSql(cargos, leads, claims, { now: NOW });

    expect(buildOverviewSnapshotFromAggregates(fromSql, NOW)).toEqual(
      buildOverviewSnapshotFromAggregates(fromOracle, NOW),
    );
  });

  it("`data`/`horario` do Postgres viram o dia certo mesmo com o pg-mem devolvendo meia-noite UTC", async () => {
    const { openLoadRows } = await readModel.fetchOverviewSnapshotAggregates({ now: NOW });
    const byId = new Map(openLoadRows.map((row) => [row.id, normalizeOpenLoadRow(row)]));

    // Carga de 00:30 do dia 01/08: é exatamente ela que uma leitura ingênua de
    // DATE (ou de fuso) joga para 31/07.
    expect(byId.get(ID_BY_LABEL.get("c-open-0030")).dataIso).toBe("2026-08-01");
    expect(byId.get(ID_BY_LABEL.get("c-open-0030")).horario).toBe("00:30:00");
    expect(byId.get(ID_BY_LABEL.get("c-open-sem-data")).dataIso).toBeNull();
    expect(byId.get(ID_BY_LABEL.get("c-open-sem-horario")).horario).toBeNull();
  });

  it("troca 1500 linhas cruas por 4 consultas agregadas", async () => {
    resetDbStats();
    const response = await readModel.fetchOperatorOverviewSnapshot({ correlationId: "corr-1", now: NOW });

    expect(response.statusCode).toBe(200);
    // 3 escalares (contagens de cargas, contagens de leads, última atividade) +
    // 1 projeção das cargas abertas.
    expect(dbStats.queries).toBe(4);
    // 1 + 1 + 1 linha escalar + 15 cargas abertas. O front baixava
    // 3x500 (= até 1500) linhas COMPLETAS por aba.
    expect(dbStats.rows).toBe(3 + 15);

    // Tamanho do payload que chega ao navegador vs. as linhas cruas que ele
    // baixava antes (proxy direto de bytes de egress).
    const payloadBytes = JSON.stringify(response.payload).length;
    const rawRowsBytes = JSON.stringify({
      cargos: OVERVIEW_PARITY_CARGOS,
      leads: OVERVIEW_PARITY_LEADS,
      claims: OVERVIEW_PARITY_CLAIMS,
    }).length;
    // Medido com esta fixture (21 cargas / 7 leads / 3 disputas):
    // 1078 B contra 8539 B = 7,9x. Em produção a diferença é muito maior porque
    // o payload é LIMITADO por construção e as linhas cruas não: `hero` tem
    // tamanho fixo e `attentionLoads` é capado em 10, então nem 500 leads nem 500
    // disputas o fazem crescer — é essa invariância que as duas asserções
    // seguintes travam.
    expect(payloadBytes).toBeLessThan(rawRowsBytes / 4);
    expect(Object.keys(response.payload.snapshot).sort()).toEqual([
      "attentionLoads",
      "hero",
      "lastUpdatedAt",
    ]);
    expect(response.payload.snapshot.attentionLoads.length).toBeLessThanOrEqual(10);
  });

  it("cache + single-flight: N abas de operador pagam UMA leitura por TTL", async () => {
    process.env.OPERATOR_OVERVIEW_SNAPSHOT_CACHE_TTL_MS = "60000";
    readModel.__resetOverviewSnapshotCache();

    resetDbStats();
    const first = await readModel.fetchOperatorOverviewSnapshot({ correlationId: "corr-a", now: NOW });
    const afterFirst = dbStats.queries;

    const later = [];
    for (let i = 0; i < 9; i += 1) {
      later.push(await readModel.fetchOperatorOverviewSnapshot({ correlationId: `corr-${i}`, now: NOW }));
    }

    expect(afterFirst).toBe(4);
    expect(dbStats.queries).toBe(4); // as 9 seguintes não tocaram o banco
    expect(later.every((response) => response.payload.meta.cached === true)).toBe(true);
    expect(first.payload.meta.cached).toBeUndefined();
    // Mesmo conteúdo, correlationId próprio de cada requisição.
    expect(later[0].payload.snapshot).toEqual(first.payload.snapshot);
    expect(later[0].payload.meta.correlationId).toBe("corr-0");
  });

  it("single-flight: rajada concorrente não multiplica as consultas", async () => {
    process.env.OPERATOR_OVERVIEW_SNAPSHOT_CACHE_TTL_MS = "60000";
    readModel.__resetOverviewSnapshotCache();

    resetDbStats();
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        readModel.fetchOperatorOverviewSnapshot({ correlationId: `burst-${index}`, now: NOW }),
      ),
    );

    expect(dbStats.queries).toBe(4);
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(new Set(responses.map((response) => JSON.stringify(response.payload.snapshot))).size).toBe(1);
  });

  it("erro NÃO gruda no cache", async () => {
    process.env.OPERATOR_OVERVIEW_SNAPSHOT_CACHE_TTL_MS = "60000";
    readModel.__resetOverviewSnapshotCache();

    // Quebra a consulta de "última atividade" derrubando uma coluna que ela lê.
    await query(`ALTER TABLE public.load_claims DROP COLUMN confirmed_at`);
    await expect(
      readModel.fetchOperatorOverviewSnapshot({ correlationId: "corr-erro", now: NOW }),
    ).rejects.toBeTruthy();

    await query(`ALTER TABLE public.load_claims ADD COLUMN confirmed_at timestamptz`);
    const recovered = await readModel.fetchOperatorOverviewSnapshot({ correlationId: "corr-ok", now: NOW });

    expect(recovered.statusCode).toBe(200);
    expect(recovered.payload.meta.cached).toBeUndefined(); // leitura nova, não cache do erro
    expect(recovered.payload.snapshot.hero.activeLoads).toBe(15);
  });

  it("TTL default é 0 sob VITEST, e o override explícito por env vence o guard", async () => {
    delete process.env.OPERATOR_OVERVIEW_SNAPSHOT_CACHE_TTL_MS;
    readModel.__resetOverviewSnapshotCache();

    resetDbStats();
    await readModel.fetchOperatorOverviewSnapshot({ correlationId: "corr-x", now: NOW });
    await readModel.fetchOperatorOverviewSnapshot({ correlationId: "corr-y", now: NOW });
    expect(dbStats.queries).toBe(8); // sem cache: 2x4

    process.env.OPERATOR_OVERVIEW_SNAPSHOT_CACHE_TTL_MS = "60000";
    readModel.__resetOverviewSnapshotCache();
    resetDbStats();
    await readModel.fetchOperatorOverviewSnapshot({ correlationId: "corr-z", now: NOW });
    await readModel.fetchOperatorOverviewSnapshot({ correlationId: "corr-w", now: NOW });
    expect(dbStats.queries).toBe(4);
  });

  it("a janela de 500 linhas por tabela é preservada (os números do Painel não mudam de base)", async () => {
    // 501ª carga OPEN mais ANTIGA que as da fixture: fica FORA da janela, então
    // não pode entrar em activeLoads (era assim no front, com .limit(500)).
    //
    // Semeadas em LOTE (um único INSERT). O VOLUME não pode encolher — a prova é
    // justamente passar de OVERVIEW_WINDOW_ROWS (500), então com 50 linhas não
    // haveria janela para exercitar. O que encolhe é o CUSTO: uma query por linha
    // fazia 500 round-trips no pg-mem e deixava este o teste mais caro da suíte,
    // com duração muito sensível à contenção (medido sozinho: 1,5s; com só mais um
    // arquivo em paralelo: 4,2s, contra o timeout default de 5s). As asserções
    // abaixo são exatamente as mesmas.
    const extras = [];
    const tuples = [];
    const params = [];
    for (let i = 0; i < 500; i += 1) {
      const id = `30000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
      extras.push(id);
      const base = i * 2;
      tuples.push(
        `($${base + 1}::uuid, '2026-08-01'::date, '08:00:00'::time, 'A', 'B', 100, 'CARRETA', 'OPEN',` +
          ` false, $${base + 2}::timestamptz, $${base + 2}::timestamptz)`,
      );
      params.push(id, new Date(Date.parse("2026-07-01T00:00:00.000Z") + i * 1000).toISOString());
    }
    await query(
      `INSERT INTO public.cargas (id, data, horario, origem, destino, distancia_km, perfil, status,
         is_template, created_at, updated_at)
       VALUES ${tuples.join(", ")}`,
      params,
    );

    const { cargoCounts, openLoadRows } = await readModel.fetchOverviewSnapshotAggregates({ now: NOW });
    // 21 da fixture + 500 extras = 521 linhas. Os extras são de 01/07 (mais
    // antigos que toda a fixture), então a janela das 500 mais novas fica com as
    // 21 da fixture + 479 extras → 15 + 479 = 494 cargas ativas. Sem a janela
    // seriam 515: é a prova de que o LIMIT continua valendo.
    expect(cargoCounts.activeLoads).toBe(494);
    expect(openLoadRows.length).toBe(494);
    expect(extras.length).toBe(500);

    // Confere contra o oráculo, que aplica a mesma janela.
    const allCargos = [
      ...cargos,
      ...extras.map((id, index) => ({
        id,
        data: "2026-08-01",
        horario: "08:00:00",
        origem: "A",
        destino: "B",
        distancia_km: 100,
        perfil: "CARRETA",
        status: "OPEN",
        is_template: false,
        sheet_data_carregamento: null,
        created_at: new Date(Date.parse("2026-07-01T00:00:00.000Z") + index * 1000).toISOString(),
        updated_at: new Date(Date.parse("2026-07-01T00:00:00.000Z") + index * 1000).toISOString(),
      })),
    ];
    const fromOracle = aggregateOverviewRowsAsSql(allCargos, leads, claims, { now: NOW });
    expect(cargoCounts).toEqual(fromOracle.cargoCounts);
    // Timeout EXPLÍCITO (mesmo padrão dos testes A/B de reconcile-aspx-status): o
    // custo deste caso é irredutível — 521 linhas em 4 agregações no pg-mem, porque
    // a prova exige passar da janela de 500. Sob o default de 5s ele estourava ao
    // rodar a suíte inteira em paralelo, e o estouro é pior que a lentidão: o
    // vitest segue para o teste seguinte enquanto a semeadura órfã continua e
    // escreve no banco que o `beforeEach` seguinte já recriou, contaminando-o.
  }, 30_000);
});
