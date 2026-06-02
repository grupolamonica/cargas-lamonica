import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockFetchDriverLoadFacets,
  mockFetchDriverLoadsReadModel,
  mockGetHealthSnapshot,
  mockCreateSupabaseAdminClient,
  mockSyncGoogleSheetLoads,
} = vi.hoisted(() => ({
  mockFetchDriverLoadFacets: vi.fn(),
  mockFetchDriverLoadsReadModel: vi.fn(),
  mockGetHealthSnapshot: vi.fn(),
  mockCreateSupabaseAdminClient: vi.fn(),
  mockSyncGoogleSheetLoads: vi.fn(),
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
  resetDriverLoadsSheetRefreshStateForTests,
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

  it("sincroniza a planilha antes de responder quando a ultima atualizacao esta atrasada", async () => {
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
});
