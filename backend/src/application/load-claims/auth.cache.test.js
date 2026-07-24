import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock do GoTrue: createClient() devolve um auth.getUser() que contamos.
const { getUserMock } = vi.hoisted(() => ({ getUserMock: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: getUserMock } }),
}));

const { requireOperatorSession, __resetAuthTokenVerifyCache } = await import("./auth.js");

const operatorUser = { app_metadata: { role: "operator", access_level: "advanced" } };

describe("auth: cache curto de verificação de token (corta getUser por request)", () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = "http://localhost";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    // Habilita o cache SÓ neste teste (o default sob VITEST é 0/desligado).
    process.env.AUTH_TOKEN_VERIFY_TTL_MS = "60000";
    getUserMock.mockReset();
    __resetAuthTokenVerifyCache();
  });

  afterEach(() => {
    delete process.env.AUTH_TOKEN_VERIFY_TTL_MS;
  });

  it("colapsa polls com o mesmo token num único getUser (cache hit)", async () => {
    getUserMock.mockResolvedValue({ data: { user: operatorUser }, error: null });

    const a = await requireOperatorSession("Bearer tok-1");
    const b = await requireOperatorSession("Bearer tok-1");

    expect(a.user).toBe(operatorUser);
    expect(b.user).toBe(operatorUser);
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("tokens diferentes re-verificam (cache é por token)", async () => {
    getUserMock.mockResolvedValue({ data: { user: operatorUser }, error: null });

    await requireOperatorSession("Bearer tok-1");
    await requireOperatorSession("Bearer tok-2");

    expect(getUserMock).toHaveBeenCalledTimes(2);
  });

  it("single-flight: rajada concorrente do mesmo token compartilha 1 getUser", async () => {
    let resolveGetUser;
    getUserMock.mockReturnValue(
      new Promise((resolve) => {
        resolveGetUser = resolve;
      }),
    );

    const p1 = requireOperatorSession("Bearer tok-burst");
    const p2 = requireOperatorSession("Bearer tok-burst");
    resolveGetUser({ data: { user: operatorUser }, error: null });
    await Promise.all([p1, p2]);

    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("fail-safe: verificação com erro NÃO é cacheada (próxima tentativa re-verifica)", async () => {
    getUserMock.mockResolvedValueOnce({ data: { user: null }, error: { message: "invalid" } });
    await expect(requireOperatorSession("Bearer ruim")).rejects.toThrow();

    // O erro não ficou no cache: a próxima chamada bate no getUser de novo.
    getUserMock.mockResolvedValueOnce({ data: { user: operatorUser }, error: null });
    const ok = await requireOperatorSession("Bearer ruim");

    expect(ok.user).toBe(operatorUser);
    expect(getUserMock).toHaveBeenCalledTimes(2);
  });
});
