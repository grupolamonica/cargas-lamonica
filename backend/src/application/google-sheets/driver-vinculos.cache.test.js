// Egress do mapa de vínculos (medido em produção: ~40.000 linhas/dia na query
// `SELECT nome_normalizado, vinculo FROM public.driver_vinculos`, que lê a tabela
// INTEIRA em todo refresh do read model da fila /leads).
//
// Estes testes contam QUERIES e LINHAS de verdade (pg-mem + wrapper no client) sob
// o TIMING REAL do poll da tela — não com duas chamadas coladas, que passariam com
// qualquer TTL. A lição da rodada 4 (TTL de 15s contra poll de 30s = zero acertos)
// tem um teste dedicado abaixo.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  resetTestDatabase,
  seedDriverVinculo,
  withPgClient,
} from "../load-claims/test-harness.js";
import {
  invalidateDriverVinculoMapCache,
  loadDriverVinculoMap,
  syncDriverVinculos,
} from "./driver-vinculos.js";

// Poll REAL que dispara estas chamadas: frontend/src/pages/Leads.tsx
// `refetchInterval: (query) => (query.state.data ? 60_000 : 30_000)`.
const LEADS_POLL_MS = 60_000;
// TTL default do cache (driver-vinculos.js) — deliberadamente > LEADS_POLL_MS.
const DEFAULT_TTL_MS = 300_000;
const VINCULO_COUNT = 120;

// O pool do pg-mem REUSA clients; sem esta marca o wrapper seria aplicado várias
// vezes ao mesmo client e cada query contaria em dobro.
const INSTRUMENTED = Symbol("driver-vinculos.instrumented");

function instrument(client, stats) {
  if (client[INSTRUMENTED]) return client;
  const original = client.query.bind(client);
  client.query = async (...args) => {
    const result = await original(...args);
    const sql = typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "");
    if (/from\s+public\.driver_vinculos/i.test(sql)) {
      stats.calls += 1;
      stats.rows += result.rows?.length ?? 0;
    }
    return result;
  };
  client[INSTRUMENTED] = true;
  return client;
}

/**
 * Roda `pollCount` leituras espaçadas por `pollIntervalMs` (relógio injetado,
 * sem timers reais) e devolve {calls, rows} medidos no client.
 */
async function simulatePolling({ pollCount, pollIntervalMs, startAt = 0 }) {
  const stats = { calls: 0, rows: 0 };
  const maps = [];

  await withPgClient(async (rawClient) => {
    const client = instrument(rawClient, stats);
    for (let index = 0; index < pollCount; index += 1) {
      const now = startAt + index * pollIntervalMs;
      maps.push(await loadDriverVinculoMap(client, { now }));
    }
  });

  return { ...stats, maps };
}

describe("loadDriverVinculoMap — egress sob o poll real da fila", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    invalidateDriverVinculoMapCache();
    vi.unstubAllEnvs();

    for (let index = 0; index < VINCULO_COUNT; index += 1) {
      await seedDriverVinculo({
        nomeOriginal: `MOTORISTA ${index}`,
        nomeNormalizado: `motorista ${index}`,
        vinculo: index % 2 === 0 ? "FROTA" : "AGREGADO DEDICADO",
      });
    }
  });

  afterAll(async () => {
    invalidateDriverVinculoMapCache();
    await closeTestDatabase();
  });

  it("BASELINE (cache desligado): 30 polls de 60s = 30 queries e 30x a tabela", async () => {
    vi.stubEnv("DRIVER_VINCULO_CACHE_TTL_MS", "0");

    const measured = await simulatePolling({ pollCount: 30, pollIntervalMs: LEADS_POLL_MS });

    expect(measured.calls).toBe(30);
    expect(measured.rows).toBe(30 * VINCULO_COUNT); // 3.600 linhas em 30 min
  });

  it("com o TTL default (300s > poll de 60s): as mesmas 30 polls fazem 6 queries", async () => {
    // TTL default (sem env) — 300s.
    const measured = await simulatePolling({ pollCount: 30, pollIntervalMs: LEADS_POLL_MS });

    // 30 polls cobrem 0..1740s. O cache é reabastecido só em 0/300/600/900/1200/1500.
    expect(measured.calls).toBe(6);
    expect(measured.rows).toBe(6 * VINCULO_COUNT); // 720 em vez de 3.600 → -80%
  });

  it("o mapa entregue no acerto de cache é igual ao da leitura fria (nada de comportamento novo)", async () => {
    const measured = await simulatePolling({ pollCount: 3, pollIntervalMs: LEADS_POLL_MS });

    expect(measured.calls).toBe(1); // 0s, 60s, 120s cabem no TTL de 300s
    for (const map of measured.maps) {
      expect(map.size).toBe(VINCULO_COUNT);
      expect(map.get("motorista 0")).toBe("FROTA");
      expect(map.get("motorista 1")).toBe("AGREGADO DEDICADO");
    }
  });

  // ── A LIÇÃO DA RODADA 4, cravada ───────────────────────────────────────────
  it("REGRESSÃO: TTL <= intervalo do poll = ZERO acertos (cache decorativo)", async () => {
    // Exatamente o erro da rodada 4: TTL de 15s contra um poll de 60s.
    vi.stubEnv("DRIVER_VINCULO_CACHE_TTL_MS", "15000");

    const measured = await simulatePolling({ pollCount: 30, pollIntervalMs: LEADS_POLL_MS });

    expect(measured.calls).toBe(30); // nenhuma economia
    expect(measured.rows).toBe(30 * VINCULO_COUNT);
  });

  it("o TTL default é MAIOR que o poll da tela /leads (senão o cache não serve para nada)", () => {
    expect(DEFAULT_TTL_MS).toBeGreaterThan(LEADS_POLL_MS);
  });

  it("sync de vínculos invalida o cache: o poll seguinte relê a tabela", async () => {
    const stats = { calls: 0, rows: 0 };

    await withPgClient(async (rawClient) => {
      const client = instrument(rawClient, stats);

      await loadDriverVinculoMap(client, { now: 0 });
      await loadDriverVinculoMap(client, { now: LEADS_POLL_MS });
      expect(stats.calls).toBe(1);

      // Sync bem-sucedido (supabase falso) → tabela pode ter mudado → invalida.
      const supabaseClient = {
        from: () => ({
          upsert: async () => ({ error: null }),
          delete: () => ({ not: async () => ({ error: null, count: 0 }) }),
        }),
      };
      const csv = ['"Motoristas","Vinculo"', '"FABIO SOUZA DA SILVA","FROTA"'].join("\n");
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(csv).buffer,
      });
      const result = await syncDriverVinculos({
        fetchImpl,
        csvUrl: "https://example.test/vinculo.csv",
        supabaseClient,
      });
      expect(result.skipped).toBe(false);

      // 2 * LEADS_POLL_MS ainda está DENTRO do TTL de 300s: sem a invalidação
      // esta chamada seria um acerto de cache.
      await loadDriverVinculoMap(client, { now: 2 * LEADS_POLL_MS });
      expect(stats.calls).toBe(2);
    });
  });

  it("erro na leitura NÃO é cacheado (42P01 continua degradando a cada chamada)", async () => {
    let attempts = 0;
    const failingClient = {
      query: async () => {
        attempts += 1;
        const err = new Error('relation "public.driver_vinculos" does not exist');
        err.code = "42P01";
        throw err;
      },
    };

    await expect(loadDriverVinculoMap(failingClient, { now: 0 })).rejects.toThrow(/does not exist/);
    await expect(loadDriverVinculoMap(failingClient, { now: 1_000 })).rejects.toThrow(/does not exist/);
    expect(attempts).toBe(2);
  });
});
