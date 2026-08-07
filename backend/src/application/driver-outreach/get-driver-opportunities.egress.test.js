/**
 * Egress do caminho de leitura das oportunidades (driver-outreach).
 *
 * `getDriverOpportunities` roda UMA VEZ POR MOTORISTA. A varredura automática
 * (scan-and-enqueue.js) a chama em RAJADA — até DRIVER_OUTREACH_SCAN_MAX_CANDIDATES
 * (60) vezes seguidas — e cada chamada relia duas coisas que NÃO dependem do
 * motorista: o `rows_json` INTEIRO do snapshot da planilha e TODAS as cargas OPEN
 * (inclusive as vencidas, descartadas em JS só depois de cruzarem a rede).
 *
 * Estes testes MEDEM consultas/linhas (proxy direto de egress) sob o ritmo REAL
 * de uma varredura (um candidato por vez, com intervalo entre eles) e travam:
 *   1. o custo linear de antes;
 *   2. a redução com o micro-cache;
 *   3. que um TTL MENOR que o intervalo entre candidatos não reduz nada
 *      (a lição do round 4: TTL < intervalo que dirige as chamadas = zero hits);
 *   4. que a lista de oportunidades produzida é IDÊNTICA com e sem cache.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedMotoristaHistorico,
  seedSheetSnapshot,
  withPgClient as harnessWithPgClient,
} from "../operator-admin/test-harness.js";
import { getSaoPauloWallClock } from "../../domain/sao-paulo-time.js";

// ── instrumentação do client pg ───────────────────────────────────────────────
const dbStats = { queries: 0, rows: 0, byTag: {}, snapshotElements: 0 };

function resetDbStats() {
  dbStats.queries = 0;
  dbStats.rows = 0;
  dbStats.byTag = {};
  dbStats.snapshotElements = 0;
}

function tagOf(sql) {
  if (sql.includes("sheet_monitor_snapshot")) return "snapshot";
  if (sql.includes("FROM public.cargas")) return "openLoads";
  if (sql.includes("motoristas_historico")) return "phone";
  if (sql.includes("pending_driver_registrations")) return "registration";
  if (sql.includes("driver_outreach_optout")) return "optout";
  if (sql.includes("load_public_leads")) return "leads";
  return "other";
}

// O pool do pg-mem REUTILIZA clients: sem a guarda de Symbol o mesmo client
// seria envolvido várias vezes e cada consulta contaria em dobro.
const INSTRUMENTED = Symbol.for("egress.instrumented.driver-outreach");

function instrumentClient(client) {
  if (client[INSTRUMENTED]) return client;
  const originalQuery = client.query.bind(client);
  client.query = async (...args) => {
    const result = await originalQuery(...args);
    const sql = typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "");
    const tag = tagOf(sql);
    const rows = result?.rows?.length ?? result?.rowCount ?? 0;
    dbStats.queries += 1;
    dbStats.rows += rows;
    const bucket = (dbStats.byTag[tag] ??= { queries: 0, rows: 0 });
    bucket.queries += 1;
    bucket.rows += rows;
    if (tag === "snapshot") {
      // O snapshot é 1 LINHA com um array jsonb dentro: o que trafega de fato é
      // o nº de elementos do array, não a contagem de linhas.
      dbStats.snapshotElements += result?.rows?.[0]?.rows_json?.length ?? 0;
    }
    return result;
  };
  client[INSTRUMENTED] = true;
  return client;
}

vi.mock("../../infrastructure/pg/postgres.js", () => ({
  withPgClient: (callback) => harnessWithPgClient((client) => callback(instrumentClient(client))),
}));

const { angMock } = vi.hoisted(() => ({ angMock: vi.fn() }));
vi.mock("./angellira-check.js", () => ({ checkAngelliraVigencia: angMock }));

const { getDriverOpportunities, __resetDriverOutreachSharedReadCache } = await import(
  "./get-driver-opportunities.js"
);

// ── fixture ──────────────────────────────────────────────────────────────────
const TTL_ENV = "DRIVER_OUTREACH_SHARED_READ_CACHE_TTL_MS";
const CANDIDATES = 60; // = DRIVER_OUTREACH_SCAN_MAX_CANDIDATES (default)
const SNAPSHOT_ROWS = CANDIDATES * 3 + 120; // 60 motoristas × 3 cargas + ruído
const OPEN_FUTURE = 6;
const OPEN_EXPIRED = 24; // passivo de cargas OPEN vencidas (o que sobrava na rede)

// Offsets ancorados no relógio de SÃO PAULO, não em UTC.
//
// `getDriverOpportunities` corta as cargas por `getSaoPauloWallClock()`, mas este
// helper gerava as datas com `Date.now()` em UTC. Das 00:00Z às 03:00Z — ou seja,
// das 21:00 à meia-noite BRT — as duas datas divergem: o "hoje" do teste vira o
// amanhã do app e o "ontem" do teste vira o hoje do app. A asserção "carga de
// ONTEM não entra" então falhava, porque a carga era legitimamente de hoje.
//
// Reproduzido em 06/08/2026 às 21:30 BRT: o gate de teste do deploy quebrou em
// `expected [ …(2) ] to not include '<id de ontem>'`, com a árvore limpa e sem
// nenhuma mudança em driver-outreach. Na prática era um blackout de deploy de
// 3 horas por dia, justamente na janela de operação da noite.
//
// Meio-dia UTC como âncora: somar dias a partir do meio-dia nunca atravessa uma
// fronteira de horário de verão, então o offset é exato em qualquer época do ano.
const dayOffsetIso = (n) => {
  const { dateIso } = getSaoPauloWallClock();
  const d = new Date(`${dateIso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const cpfOf = (i) => String(90000000000 + i);
const nameOf = (i) => `Motorista Rajada ${i}`;

async function seedFixture() {
  const snapshot = [];
  for (let i = 0; i < CANDIDATES; i += 1) {
    await seedMotoristaHistorico({ cpf: cpfOf(i), nome: nameOf(i), telefone: `7198888${1000 + i}` });
    for (const back of [60, 75, 90]) {
      snapshot.push({
        motoristas: nameOf(i),
        data: dayOffsetIso(-back),
        origem: `Simoes Filho / BA`,
        destino: `Recife / PE`,
        // Colunas extras da planilha do Monitor (peso real do payload).
        lh: `LT${i}${back}`,
        veiculo: "CARRETA",
        cavalo: `ABC${1000 + i}`,
        carreta1: `XYZ${2000 + i}`,
        status: "EM VIAGEM",
        observacao: "linha de exemplo do monitor",
      });
    }
  }
  for (let i = 0; i < 120; i += 1) {
    snapshot.push({ motoristas: `Ruido ${i}`, data: dayOffsetIso(-5), origem: "X / SP", destino: "Y / SP" });
  }
  await seedSheetSnapshot(snapshot);

  for (let i = 0; i < OPEN_FUTURE; i += 1) {
    await seedCargo({ status: "OPEN", origem: "Recife / PE", destino: "Simoes Filho / BA", data: dayOffsetIso(3 + i) });
  }
  for (let i = 0; i < OPEN_EXPIRED; i += 1) {
    await seedCargo({ status: "OPEN", origem: "Recife / PE", destino: "Simoes Filho / BA", data: dayOffsetIso(-10 - i) });
  }
}

/** Uma varredura: `count` candidatos, um por vez, com `gapMs` entre eles. */
async function simulateScan(count, gapMs) {
  resetDbStats();
  const t0 = Date.now();
  const nowSpy = vi.spyOn(Date, "now");
  const results = [];
  try {
    for (let i = 0; i < count; i += 1) {
      nowSpy.mockReturnValue(t0 + i * gapMs);
      results.push(await getDriverOpportunities({ cpf: cpfOf(i), nome: nameOf(i) }));
    }
  } finally {
    nowSpy.mockRestore();
  }
  return { stats: { ...dbStats, byTag: { ...dbStats.byTag } }, results };
}

const stripVolatile = (result) => ({
  driver: result.driver,
  optedOut: result.optedOut,
  opportunities: result.opportunities,
});

describe("driver-outreach — egress do caminho de oportunidades", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
    angMock.mockResolvedValue({ checked: true, vigente: false, status: "NOT_FOUND", found: false, validUntil: null });
    __resetDriverOutreachSharedReadCache();
    delete process.env[TTL_ENV];
    await seedFixture();
  });

  afterEach(() => {
    delete process.env[TTL_ENV];
  });

  afterAll(async () => {
    delete process.env[TTL_ENV];
    await closeTestDatabase();
  });

  it("a rajada realmente produz oportunidades (o cenário medido é válido)", async () => {
    process.env[TTL_ENV] = "0";
    __resetDriverOutreachSharedReadCache();
    const one = await getDriverOpportunities({ cpf: cpfOf(0), nome: nameOf(0) });
    const triggers = one.opportunities.map((o) => o.trigger);
    expect(triggers).toContain("churn");
    expect(triggers).toContain("return_load");
    expect(triggers).toContain("preferences");
    expect(one.driver.phone).toBe(`7198888${1000}`);
  });

  it(
    "SEM cache (TTL=0): cada candidato relê a planilha INTEIRA e as cargas OPEN",
    async () => {
      process.env[TTL_ENV] = "0";
      __resetDriverOutreachSharedReadCache();

      const { stats } = await simulateScan(CANDIDATES, 1_000);

      expect(stats.byTag.snapshot.queries).toBe(CANDIDATES);
      expect(stats.byTag.openLoads.queries).toBe(CANDIDATES);
      expect(stats.snapshotElements).toBe(CANDIDATES * SNAPSHOT_ROWS);

       
      console.log(
        `[egress] varredura SEM cache: ${CANDIDATES} candidatos => ${stats.queries} consultas, ` +
          `${stats.rows} linhas, ${stats.snapshotElements} elementos de planilha ` +
          `(cargas OPEN: ${stats.byTag.openLoads.rows} linhas)`,
      );
    },
    30_000,
  );

  it(
    "COM cache (TTL 60s > intervalo entre candidatos): a rajada custa UMA leitura de cada",
    async () => {
      process.env[TTL_ENV] = "0";
      __resetDriverOutreachSharedReadCache();
      const before = (await simulateScan(CANDIDATES, 1_000)).stats;

      process.env[TTL_ENV] = "60000";
      __resetDriverOutreachSharedReadCache();
      const after = (await simulateScan(CANDIDATES, 1_000)).stats; // 59s de rajada < TTL

      expect(after.byTag.snapshot.queries).toBe(1);
      expect(after.byTag.openLoads.queries).toBe(1);
      expect(after.snapshotElements).toBe(SNAPSHOT_ROWS);

      const elementReduction = 1 - after.snapshotElements / before.snapshotElements;
      const openLoadReduction = 1 - after.byTag.openLoads.rows / before.byTag.openLoads.rows;
      expect(elementReduction).toBeGreaterThan(0.98);
      expect(openLoadReduction).toBeGreaterThan(0.98);

       
      console.log(
        `[egress] varredura COM cache: ${before.queries} -> ${after.queries} consultas, ` +
          `${before.rows} -> ${after.rows} linhas, ` +
          `${before.snapshotElements} -> ${after.snapshotElements} elementos de planilha ` +
          `(-${(elementReduction * 100).toFixed(1)}%), cargas OPEN ` +
          `${before.byTag.openLoads.rows} -> ${after.byTag.openLoads.rows} linhas ` +
          `(-${(openLoadReduction * 100).toFixed(1)}%)`,
      );
    },
    60_000,
  );

  it(
    "TTL MENOR que o intervalo entre candidatos não reduz NADA (lição do round 4)",
    async () => {
      process.env[TTL_ENV] = "500"; // 500ms de TTL contra 1s entre candidatos
      __resetDriverOutreachSharedReadCache();

      const { stats } = await simulateScan(CANDIDATES, 1_000);

      // Zero acertos: exatamente o que aconteceu com o sino (TTL 15s / poll 30s).
      expect(stats.byTag.snapshot.queries).toBe(CANDIDATES);
      expect(stats.byTag.openLoads.queries).toBe(CANDIDATES);
    },
    30_000,
  );

  it(
    "varredura LENTA (2s por candidato, 120s no total): TTL de 60s ainda corta 60 leituras para ~2",
    async () => {
      process.env[TTL_ENV] = "60000";
      __resetDriverOutreachSharedReadCache();

      const { stats } = await simulateScan(CANDIDATES, 2_000);

      expect(stats.byTag.snapshot.queries).toBeGreaterThanOrEqual(2);
      expect(stats.byTag.snapshot.queries).toBeLessThanOrEqual(3);
      expect(stats.byTag.openLoads.queries).toBeLessThanOrEqual(3);
    },
    30_000,
  );

  it("expira ao fim do TTL: a varredura seguinte parte de dado fresco", async () => {
    process.env[TTL_ENV] = "60000";
    __resetDriverOutreachSharedReadCache();

    await getDriverOpportunities({ cpf: cpfOf(0), nome: nameOf(0) });

    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(Date.now() + 61_000);
      resetDbStats();
      await getDriverOpportunities({ cpf: cpfOf(0), nome: nameOf(0) });
      expect(dbStats.byTag.snapshot.queries).toBe(1);
      expect(dbStats.byTag.openLoads.queries).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("dados por motorista NUNCA vêm do cache (cadastro/lead/opt-out/telefone por CPF)", async () => {
    process.env[TTL_ENV] = "60000";
    __resetDriverOutreachSharedReadCache();

    const { stats } = await simulateScan(10, 1_000);

    expect(stats.byTag.snapshot.queries).toBe(1);
    // Uma leitura por motorista em cada fonte pessoal — nenhuma compartilhada.
    expect(stats.byTag.phone.queries).toBe(10);
    expect(stats.byTag.registration.queries).toBe(10);
    expect(stats.byTag.optout.queries).toBe(10);
    // `load_public_leads` é lida DUAS vezes por motorista (última candidatura +
    // rotas em que se candidatou) — ambas por CPF, nenhuma cacheada.
    expect(stats.byTag.leads.queries).toBe(20);
  });

  it(
    "PRESERVA o comportamento: a lista de oportunidades é idêntica com e sem cache",
    async () => {
      process.env[TTL_ENV] = "0";
      __resetDriverOutreachSharedReadCache();
      const uncached = (await simulateScan(CANDIDATES, 1_000)).results.map(stripVolatile);

      process.env[TTL_ENV] = "60000";
      __resetDriverOutreachSharedReadCache();
      const cached = (await simulateScan(CANDIDATES, 1_000)).results.map(stripVolatile);

      expect(cached).toEqual(uncached);
    },
    60_000,
  );

  it("filtro de data no SQL: as cargas OPEN vencidas param de cruzar a rede", async () => {
    // Consulta ANTIGA (sem limite inferior) contra a MESMA fixture.
    const oldSql = await query(
      `SELECT id, origem, destino, perfil, data FROM public.cargas WHERE status = 'OPEN'`,
    );
    expect(oldSql.rows.length).toBe(OPEN_FUTURE + OPEN_EXPIRED);

    process.env[TTL_ENV] = "0";
    __resetDriverOutreachSharedReadCache();
    resetDbStats();
    await getDriverOpportunities({ cpf: cpfOf(0), nome: nameOf(0) });

    // A consulta nova traz só o que pode ser usado (hoje/futuro + a folga de 1 dia).
    expect(dbStats.byTag.openLoads.rows).toBe(OPEN_FUTURE);
     
    console.log(
      `[egress] cargas OPEN por chamada: ${oldSql.rows.length} -> ${dbStats.byTag.openLoads.rows} linhas; ` +
        `compondo com o cache, uma varredura de ${CANDIDATES} candidatos passa de ` +
        `${oldSql.rows.length * CANDIDATES} para ${dbStats.byTag.openLoads.rows} linhas`,
    );
  });

  it("o corte exato continua em JS: carga de HOJE entra, de ONTEM não", async () => {
    await resetTestDatabase();
    await seedMotoristaHistorico({ cpf: cpfOf(0), nome: nameOf(0), telefone: "71988881000" });
    await seedSheetSnapshot([
      { motoristas: nameOf(0), data: dayOffsetIso(-60), origem: "Simoes Filho / BA", destino: "Recife / PE" },
      { motoristas: nameOf(0), data: dayOffsetIso(-75), origem: "Simoes Filho / BA", destino: "Recife / PE" },
    ]);
    const { id: hoje } = await seedCargo({
      status: "OPEN",
      origem: "Recife / PE",
      destino: "Simoes Filho / BA",
      data: dayOffsetIso(0),
    });
    const { id: ontem } = await seedCargo({
      status: "OPEN",
      origem: "Recife / PE",
      destino: "Simoes Filho / BA",
      data: dayOffsetIso(-1),
    });

    process.env[TTL_ENV] = "0";
    __resetDriverOutreachSharedReadCache();
    resetDbStats();
    const result = await getDriverOpportunities({ cpf: cpfOf(0), nome: nameOf(0) });

    // O SQL é folgado (traz ontem também) — o corte exato de "hoje" segue em JS.
    expect(dbStats.byTag.openLoads.rows).toBe(2);
    const suggested = result.opportunities
      .find((o) => o.trigger === "return_load")
      .data.suggestions.map((s) => s.id);
    expect(suggested).toContain(hoje);
    expect(suggested).not.toContain(ontem);
  });
});
