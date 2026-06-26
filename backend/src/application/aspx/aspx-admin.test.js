import { describe, expect, it, vi } from "vitest";

const { mockCreateSupabaseAdminClient } = vi.hoisted(() => ({
  mockCreateSupabaseAdminClient: vi.fn(),
}));

vi.mock("../../infrastructure/supabase/admin-client.js", () => ({
  createSupabaseAdminClient: mockCreateSupabaseAdminClient,
}));

import { getAspxSyncHealth, normalizeSpxCookies } from "./aspx-admin.js";

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

describe("normalizeSpxCookies", () => {
  const future = Math.floor(Date.now() / 1000) + 100_000;

  it("normaliza array do Cookie-Editor para {nome: valor} filtrando domínio SPX", () => {
    const input = [
      { name: "spx_cid", value: "abc", domain: ".myagencyservice.com.br", expirationDate: future },
      { name: "SPC_F", value: "f1", domain: "logistics.myagencyservice.com.br" },
      { name: "ga_other", value: "x", domain: ".google.com" }, // domínio alheio — ignorado
    ];

    const { cookies, count } = normalizeSpxCookies(input);

    expect(cookies).toEqual({ spx_cid: "abc", SPC_F: "f1" });
    expect(count).toBe(2);
    expect(cookies.ga_other).toBeUndefined();
  });

  it("aceita string JSON e calcula expiresAt a partir do cookie auth-like", () => {
    const json = JSON.stringify([
      { name: "fms_user_skey", value: "k", domain: ".myagencyservice.com.br", expirationDate: future },
    ]);

    const { cookies, expiresAtIso } = normalizeSpxCookies(json);

    expect(cookies.fms_user_skey).toBe("k");
    expect(new Date(expiresAtIso).getTime()).toBe(future * 1000);
  });

  it("aceita objeto simples {nome: valor}", () => {
    const { cookies } = normalizeSpxCookies({ spx_cid: "z", SPC_T_ID: "t" });
    expect(cookies).toEqual({ spx_cid: "z", SPC_T_ID: "t" });
  });

  it("ignora cookies já expirados", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const { cookies } = normalizeSpxCookies([
      { name: "spx_cid", value: "ok", domain: ".myagencyservice.com.br", expirationDate: future },
      { name: "stale", value: "x", domain: ".myagencyservice.com.br", expirationDate: past },
    ]);
    expect(cookies.spx_cid).toBe("ok");
    expect(cookies.stale).toBeUndefined();
  });

  it("rejeita quando não há cookie de autenticação (ASPX_COOKIES_NO_AUTH)", () => {
    expect.assertions(2);
    try {
      normalizeSpxCookies([
        { name: "language", value: "pt", domain: ".myagencyservice.com.br" },
      ]);
    } catch (e) {
      expect(e.code).toBe("ASPX_COOKIES_NO_AUTH");
      expect(e.statusCode).toBe(422);
    }
  });

  it("rejeita JSON inválido (ASPX_COOKIES_INVALID_JSON)", () => {
    expect.assertions(1);
    try {
      normalizeSpxCookies("{nao eh json");
    } catch (e) {
      expect(e.code).toBe("ASPX_COOKIES_INVALID_JSON");
    }
  });
});
