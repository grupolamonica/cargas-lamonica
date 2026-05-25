import { describe, expect, it, vi } from "vitest";

const { mockCreateSupabaseAdminClient } = vi.hoisted(() => ({
  mockCreateSupabaseAdminClient: vi.fn(),
}));

vi.mock("../google-sheets/google-sheet-loads.js", () => ({
  createSupabaseAdminClient: mockCreateSupabaseAdminClient,
}));

import { getAspxSyncHealth } from "./aspx-admin.js";

/**
 * Builds a minimal supabase double covering only the calls that
 * getAspxSyncHealth() performs: count head + last-sync maybeSingle.
 */
function buildSupabaseDouble({ totalDrivers = 0, lastSyncAt = null, error = null } = {}) {
  return {
    from() {
      return {
        select(_columns, opts = {}) {
          if (opts.head) {
            // count head request
            if (error) return Promise.resolve({ count: null, error });
            return Promise.resolve({ count: totalDrivers, error: null });
          }
          // last-sync ordering chain
          return {
            order() {
              return {
                limit() {
                  return {
                    maybeSingle() {
                      if (error) return Promise.resolve({ data: null, error });
                      return Promise.resolve({
                        data: lastSyncAt ? { synced_at: lastSyncAt } : null,
                        error: null,
                      });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("getAspxSyncHealth", () => {
  it("retorna severity=ok quando o ultimo sync foi ha menos de 6h", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    mockCreateSupabaseAdminClient.mockReturnValueOnce(
      buildSupabaseDouble({ totalDrivers: 400, lastSyncAt: oneHourAgo }),
    );

    const result = await getAspxSyncHealth();

    expect(result.statusCode).toBe(200);
    expect(result.payload).toMatchObject({
      ok: true,
      totalDrivers: 400,
      severity: "ok",
      isStale: false,
    });
    expect(result.payload.secondsSinceSync).toBeGreaterThan(0);
    expect(result.payload.secondsSinceSync).toBeLessThan(6 * 60 * 60);
  });

  it("retorna severity=warning quando ultimo sync entre 6h e 24h", async () => {
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    mockCreateSupabaseAdminClient.mockReturnValueOnce(
      buildSupabaseDouble({ totalDrivers: 400, lastSyncAt: tenHoursAgo }),
    );

    const result = await getAspxSyncHealth();

    expect(result.payload.severity).toBe("warning");
    expect(result.payload.isStale).toBe(true);
    expect(result.payload.hoursSinceSync).toBeGreaterThanOrEqual(10);
  });

  it("retorna severity=critical quando ultimo sync passa de 24h (caso real: 5 dias parado)", async () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    mockCreateSupabaseAdminClient.mockReturnValueOnce(
      buildSupabaseDouble({ totalDrivers: 400, lastSyncAt: fiveDaysAgo }),
    );

    const result = await getAspxSyncHealth();

    expect(result.payload.severity).toBe("critical");
    expect(result.payload.isStale).toBe(true);
    expect(result.payload.hoursSinceSync).toBeGreaterThanOrEqual(120);
  });

  it("retorna severity=critical quando aspx_drivers esta vazia (nunca sincronizou)", async () => {
    mockCreateSupabaseAdminClient.mockReturnValueOnce(
      buildSupabaseDouble({ totalDrivers: 0, lastSyncAt: null }),
    );

    const result = await getAspxSyncHealth();

    expect(result.payload).toMatchObject({
      totalDrivers: 0,
      lastSyncAt: null,
      secondsSinceSync: null,
      hoursSinceSync: null,
      severity: "critical",
      isStale: true,
    });
  });

  it("propaga erro do Supabase com prefixo ASPX_HEALTH_*", async () => {
    mockCreateSupabaseAdminClient.mockReturnValueOnce(
      buildSupabaseDouble({ error: { message: "connection refused" } }),
    );

    await expect(getAspxSyncHealth()).rejects.toThrow(/ASPX_HEALTH_/);
  });
});
