import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFetchDriverLoadFacets,
  mockFetchDriverLoadsReadModel,
  mockGetHealthSnapshot,
  mockCreateSupabaseAdminClient,
  mockSyncGoogleSheetLoads,
  mockWithPgClient,
} = vi.hoisted(() => ({
  mockFetchDriverLoadFacets: vi.fn(),
  mockFetchDriverLoadsReadModel: vi.fn(),
  mockGetHealthSnapshot: vi.fn(),
  mockCreateSupabaseAdminClient: vi.fn(),
  mockSyncGoogleSheetLoads: vi.fn(),
  mockWithPgClient: vi.fn(),
}));

// handlers.js importa APENAS withPgClient deste módulo (conferido), então o mock
// parcial não esconde nada que o arquivo use.
vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: mockWithPgClient,
}));

vi.mock("../../../application/operator-admin/service.js", () => ({
  fetchDriverLoadFacets: mockFetchDriverLoadFacets,
  fetchDriverLoadsReadModel: mockFetchDriverLoadsReadModel,
  getHealthSnapshot: mockGetHealthSnapshot,
}));

vi.mock("../../../infrastructure/supabase/admin-client.js", () => ({
  createSupabaseAdminClient: mockCreateSupabaseAdminClient,
}));

vi.mock("../../../application/google-sheets/google-sheet-loads.js", () => ({
  syncGoogleSheetLoads: mockSyncGoogleSheetLoads,
}));

import {
  resetDriverLoadsDigestCacheForTests,
  resetDriverLoadsSheetRefreshStateForTests,
  resolveDriverLoadsDigestResponse,
  resolveDriverLoadsReadModelResponse,
} from "./handlers.js";

function createLatestSheetSyncQueryResult(sheetSyncedAt) {
  const builder = {
    select: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({
      data: sheetSyncedAt ? [{ sheet_synced_at: sheetSyncedAt }] : [],
      error: null,
    }),
  };

  return {
    from: vi.fn().mockReturnValue(builder),
  };
}

describe("public driver loads handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
    resetDriverLoadsSheetRefreshStateForTests();
    resetDriverLoadsDigestCacheForTests();

    mockFetchDriverLoadsReadModel.mockResolvedValue({
      statusCode: 200,
      payload: {
        items: [],
        summary: {
          totalCount: 0,
          uniqueStateCount: 0,
          uniqueProfileCount: 0,
        },
        meta: {
          page: 1,
          pageSize: 12,
          totalCount: 0,
          totalPages: 1,
          hasNextPage: false,
          maxPageSize: 12,
          correlationId: "corr-driver-loads",
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // GUARDA DE REGRESSÃO: o refresh oportunista NÃO pode bloquear a resposta.
  //
  // Havia um `await syncPromise` aqui: a request que disparasse o refresh esperava o
  // sync INTEIRO da planilha. Medido em produção 07/08/2026 pelos logs do
  // `sheet-sync-periodic`: 9.775 ms e 12.068 ms. Como só dispara quando o snapshot passa
  // de 7 min, o efeito era intermitente — o "às vezes demora bastante" do operador.
  //
  // Este teste falha por TIMEOUT (não por assert) se alguém reintroduzir o await: o
  // sync mockado só resolve DEPOIS de a resposta ser conferida.
  it("NAO espera o sync terminar — dispara e responde na hora (stale-while-revalidate)", async () => {
    mockCreateSupabaseAdminClient.mockReturnValue(
      createLatestSheetSyncQueryResult("2020-01-01T00:00:00.000Z"),
    );
    let liberarSync;
    mockSyncGoogleSheetLoads.mockReturnValue(
      new Promise((resolve) => {
        liberarSync = resolve;
      }),
    );

    const response = await resolveDriverLoadsReadModelResponse({
      headers: {},
      query: { page: "1", pageSize: "12" },
    });

    // Respondeu com o sync ainda EM VOO.
    expect(response.statusCode).toBe(200);
    expect(mockSyncGoogleSheetLoads).toHaveBeenCalledTimes(1);
    expect(mockFetchDriverLoadsReadModel).toHaveBeenCalledTimes(1);

    liberarSync({ availableLoadsCount: 0, unlinkedLoadsCount: 0 });
  });

  it("dispara o sync da planilha antes de responder quando a ultima atualizacao esta atrasada", async () => {
    mockCreateSupabaseAdminClient.mockReturnValue(
      createLatestSheetSyncQueryResult("2020-01-01T00:00:00.000Z"),
    );
    mockSyncGoogleSheetLoads.mockResolvedValue({
      availableLoadsCount: 2,
      unlinkedLoadsCount: 0,
      sheetUrl: "https://docs.google.com/spreadsheets/d/example/export?format=csv",
    });

    const response = await resolveDriverLoadsReadModelResponse({
      headers: {},
      query: {
        page: "1",
        pageSize: "12",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockSyncGoogleSheetLoads).toHaveBeenCalledTimes(1);
    expect(mockFetchDriverLoadsReadModel).toHaveBeenCalledTimes(1);
    expect(mockSyncGoogleSheetLoads.mock.invocationCallOrder[0]).toBeLessThan(
      mockFetchDriverLoadsReadModel.mock.invocationCallOrder[0],
    );
  });

  it("mantem a resposta rapida quando a planilha ja foi sincronizada recentemente", async () => {
    mockCreateSupabaseAdminClient.mockReturnValue(
      createLatestSheetSyncQueryResult(new Date().toISOString()),
    );

    const response = await resolveDriverLoadsReadModelResponse({
      headers: {},
      query: {
        page: "1",
        pageSize: "12",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockSyncGoogleSheetLoads).not.toHaveBeenCalled();
    expect(mockFetchDriverLoadsReadModel).toHaveBeenCalledTimes(1);
  });

  // O portal sonda o digest a cada 30 s (antes 5 min) para a carga marcada como
  // "Disponível" aparecer em segundos. Estas duas guardas são o que torna esse
  // intervalo barato: sem elas, 10x mais sondagens = 10x mais queries por motorista
  // simultâneo, e o read model do motorista já foi o maior consumidor de egress do
  // pooler num incidente anterior.
  describe("digest do portal — cache e single-flight", () => {
    /** Simula o banco devolvendo um digest, contando quantas queries de fato saíram. */
    function stubDigest({ ts = 1_700_000_000, cnt = 7, delayMs = 0 } = {}) {
      const client = {
        query: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) =>
              delayMs > 0
                ? setTimeout(() => resolve({ rows: [{ ts, cnt }] }), delayMs)
                : resolve({ rows: [{ ts, cnt }] }),
            ),
        ),
      };
      mockWithPgClient.mockImplementation(async (cb) => cb(client));
      return client;
    }

    it("chamadas em sequência dentro da janela reusam o digest (1 query só)", async () => {
      const client = stubDigest({ ts: 111, cnt: 3 });

      const a = await resolveDriverLoadsDigestResponse({ headers: {} });
      const b = await resolveDriverLoadsDigestResponse({ headers: {} });

      expect(a.payload.digest).toBe("111:3");
      expect(b.payload.digest).toBe("111:3");
      expect(b.payload.meta.cached).toBe(true);
      expect(client.query).toHaveBeenCalledTimes(1);
    });

    it("rajada CONCORRENTE colapsa numa única query (single-flight)", async () => {
      const client = stubDigest({ ts: 222, cnt: 5, delayMs: 20 });

      const respostas = await Promise.all(
        Array.from({ length: 6 }, () => resolveDriverLoadsDigestResponse({ headers: {} })),
      );

      expect(respostas.map((r) => r.payload.digest)).toEqual(Array(6).fill("222:5"));
      expect(client.query).toHaveBeenCalledTimes(1);
    });

    it("erro no banco vira 503 e NÃO gruda no cache (a sondagem seguinte tenta de novo)", async () => {
      mockWithPgClient.mockRejectedValueOnce(new Error("pooler fora"));
      const falha = await resolveDriverLoadsDigestResponse({ headers: {} });
      expect(falha.statusCode).toBe(503);

      const client = stubDigest({ ts: 333, cnt: 1 });
      const ok = await resolveDriverLoadsDigestResponse({ headers: {} });
      expect(ok.statusCode).toBe(200);
      expect(ok.payload.digest).toBe("333:1");
      expect(client.query).toHaveBeenCalledTimes(1);
    });
  });
});
