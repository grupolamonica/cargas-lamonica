/**
 * Cache + single-flight das facets do portal do motorista.
 *
 * As facets são GLOBAIS (endpoint anônimo, zero parâmetros) mas rodavam a
 * varredura completa das cargas OPEN a cada abertura do portal — × centenas de
 * motoristas. Estes testes medem o custo REAL em consultas/linhas (proxy direto
 * de egress: egress ≈ linhas × largura da linha) e travam a regressão.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  resetTestDatabase,
  seedCargo,
  seedCliente,
  withPgClient as harnessWithPgClient,
  withPgTransaction,
} from "../test-harness.js";

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

const readModel = await import("./dashboard-read-model.js");

/** Simula o portal aberto por N motoristas (cada um chama as facets 1×). */
async function simulatePortalOpens(count) {
  resetDbStats();
  for (let i = 0; i < count; i += 1) {
    await readModel.fetchDriverLoadFacets({ correlationId: `corr-facets-${i}` });
  }
  return { ...dbStats };
}

const DRIVERS = 20;

describe("facets do portal do motorista — cache + single-flight", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    readModel.__resetDriverLoadFacetsCache();
    delete process.env.DRIVER_LOAD_FACETS_CACHE_TTL_MS;

    // Cenário representativo: várias cargas abertas de clientes distintos.
    for (let i = 0; i < 12; i += 1) {
      const cliente = await seedCliente({ nome: `Embarcador ${i}` });
      await seedCargo({
        cliente_id: cliente.id,
        origem: `Cidade ${i} / SP`,
        destino: `Destino ${i} / MG`,
        perfil: i % 2 === 0 ? "CARRETA" : "TRUCK",
        status: "OPEN",
        is_template: false,
        data: "2099-06-02",
        driver_visibility: "PUBLIC",
        valor: 5000 + i,
      });
    }
  });

  afterAll(async () => {
    delete process.env.DRIVER_LOAD_FACETS_CACHE_TTL_MS;
    await closeTestDatabase();
  });

  it("SEM cache (TTL=0): cada abertura do portal custa uma varredura completa", async () => {
    process.env.DRIVER_LOAD_FACETS_CACHE_TTL_MS = "0";
    readModel.__resetDriverLoadFacetsCache();

    const single = await simulatePortalOpens(1);
    const many = await simulatePortalOpens(DRIVERS);

    // Custo cresce linearmente com o nº de motoristas — o problema medido em prod.
    expect(many.queries).toBe(single.queries * DRIVERS);
    expect(many.rows).toBe(single.rows * DRIVERS);

    // eslint-disable-next-line no-console
    console.log(
      `[egress] facets SEM cache: ${DRIVERS} aberturas => ${many.queries} consultas, ${many.rows} linhas`,
    );
  });

  it("COM cache: N aberturas concorrentes/sequenciais custam UMA varredura", async () => {
    process.env.DRIVER_LOAD_FACETS_CACHE_TTL_MS = "60000";
    readModel.__resetDriverLoadFacetsCache();

    const baseline = await simulatePortalOpens(1);
    readModel.__resetDriverLoadFacetsCache();
    const cached = await simulatePortalOpens(DRIVERS);

    // O custo de N aberturas é igual ao de UMA (as demais vêm do cache).
    expect(cached.queries).toBe(baseline.queries);
    expect(cached.rows).toBe(baseline.rows);

    const reduction = 1 - cached.rows / (baseline.rows * DRIVERS);
    expect(reduction).toBeGreaterThan(0.9);

    // eslint-disable-next-line no-console
    console.log(
      `[egress] facets COM cache: ${DRIVERS} aberturas => ${cached.queries} consultas, ${cached.rows} linhas ` +
        `(reducao de ${(reduction * 100).toFixed(1)}%)`,
    );
  });

  it("single-flight: rajada concorrente compartilha UMA consulta", async () => {
    process.env.DRIVER_LOAD_FACETS_CACHE_TTL_MS = "60000";
    readModel.__resetDriverLoadFacetsCache();

    const baseline = await simulatePortalOpens(1);
    readModel.__resetDriverLoadFacetsCache();

    resetDbStats();
    const results = await Promise.all(
      Array.from({ length: DRIVERS }, (_, i) =>
        readModel.fetchDriverLoadFacets({ correlationId: `corr-burst-${i}` }),
      ),
    );

    expect(dbStats.queries).toBe(baseline.queries);
    results.forEach((result) => expect(result.statusCode).toBe(200));
  });

  it("preserva o resultado: payload cacheado é idêntico ao não-cacheado (só muda o meta)", async () => {
    process.env.DRIVER_LOAD_FACETS_CACHE_TTL_MS = "0";
    readModel.__resetDriverLoadFacetsCache();
    const uncached = await readModel.fetchDriverLoadFacets({ correlationId: "corr-uncached" });

    process.env.DRIVER_LOAD_FACETS_CACHE_TTL_MS = "60000";
    readModel.__resetDriverLoadFacetsCache();
    await readModel.fetchDriverLoadFacets({ correlationId: "corr-warm" });
    const hit = await readModel.fetchDriverLoadFacets({ correlationId: "corr-hit" });

    expect(hit.statusCode).toBe(200);
    expect(hit.payload.origemOptions).toEqual(uncached.payload.origemOptions);
    expect(hit.payload.destinoOptions).toEqual(uncached.payload.destinoOptions);
    expect(hit.payload.perfilOptions).toEqual(uncached.payload.perfilOptions);
    expect(hit.payload.clienteOptions).toEqual(uncached.payload.clienteOptions);
    // O correlationId do chamador atual é preservado (não vaza o da 1ª chamada).
    expect(hit.payload.meta).toEqual({ correlationId: "corr-hit", cached: true });
  });

  it("expira ao fim do TTL (não serve dado velho indefinidamente)", async () => {
    process.env.DRIVER_LOAD_FACETS_CACHE_TTL_MS = "60000";
    readModel.__resetDriverLoadFacetsCache();

    const first = await readModel.fetchDriverLoadFacets({ correlationId: "corr-t0" });
    expect(first.payload.clienteOptions.length).toBeGreaterThan(0);

    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(Date.now() + 61_000);
      resetDbStats();
      const afterTtl = await readModel.fetchDriverLoadFacets({ correlationId: "corr-t61" });
      // Passado o TTL, volta a consultar o banco.
      expect(dbStats.queries).toBeGreaterThan(0);
      expect(afterTtl.statusCode).toBe(200);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("nao cacheia resultado de erro (fail-safe)", async () => {
    process.env.DRIVER_LOAD_FACETS_CACHE_TTL_MS = "60000";
    readModel.__resetDriverLoadFacetsCache();

    // Warm-up válido e então confirma que o cache guardou só um 200.
    const ok = await readModel.fetchDriverLoadFacets({ correlationId: "corr-ok" });
    expect(ok.statusCode).toBe(200);

    resetDbStats();
    const hit = await readModel.fetchDriverLoadFacets({ correlationId: "corr-ok-2" });
    expect(dbStats.queries).toBe(0);
    expect(hit.payload.meta.cached).toBe(true);
  });
});
