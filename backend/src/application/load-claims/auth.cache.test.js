import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock do GoTrue: createClient() devolve um auth.getUser() que contamos.
const { getUserMock } = vi.hoisted(() => ({ getUserMock: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { getUser: getUserMock } }),
}));

const { requireOperatorSession, __resetAuthTokenVerifyCache } = await import("./auth.js");

const operatorUser = { app_metadata: { role: "operator", access_level: "advanced" } };

// JWT de mentira (sem assinatura válida) só para o clamp de expiração ter um
// `exp` para ler — o getUser está mockado, então ninguém valida assinatura.
function fakeJwt({ expSeconds, marker = "m" }) {
  const payload = Buffer.from(JSON.stringify({ sub: marker, exp: expSeconds }), "utf8").toString("base64url");
  return `hdr.${payload}.sig`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Congela Date.now() para exercitar a borda do TTL sem sleep.
let nowSpy = null;

function freezeNow(value) {
  if (!nowSpy) nowSpy = vi.spyOn(Date, "now");
  nowSpy.mockReturnValue(value);
}

function restoreNow() {
  if (nowSpy) {
    nowSpy.mockRestore();
    nowSpy = null;
  }
}

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
    restoreNow();
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

  it("single-flight: rajada de 20 polls simultâneos ainda dá 1 getUser", async () => {
    let resolveGetUser;
    getUserMock.mockReturnValue(
      new Promise((resolve) => {
        resolveGetUser = resolve;
      }),
    );

    const burst = Array.from({ length: 20 }, () => requireOperatorSession("Bearer tok-burst-20"));
    resolveGetUser({ data: { user: operatorUser }, error: null });
    const sessions = await Promise.all(burst);

    expect(sessions).toHaveLength(20);
    sessions.forEach((session) => expect(session.user).toBe(operatorUser));
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

  it("fail-safe: user nulo sem error também não é cacheado", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });

    await expect(requireOperatorSession("Bearer tok-nulo")).rejects.toThrow();
    await expect(requireOperatorSession("Bearer tok-nulo")).rejects.toThrow();

    expect(getUserMock).toHaveBeenCalledTimes(2);
  });

  it("borda do TTL: serve do cache até TTL-1ms e re-verifica em TTL", async () => {
    getUserMock.mockResolvedValue({ data: { user: operatorUser }, error: null });
    const base = 1_700_000_000_000;

    freezeNow(base);
    await requireOperatorSession("Bearer tok-ttl"); // token opaco → só TTL
    expect(getUserMock).toHaveBeenCalledTimes(1);

    freezeNow(base + 59_999);
    await requireOperatorSession("Bearer tok-ttl");
    expect(getUserMock).toHaveBeenCalledTimes(1);

    freezeNow(base + 60_000);
    await requireOperatorSession("Bearer tok-ttl");
    expect(getUserMock).toHaveBeenCalledTimes(2);
  });

  it("clamp de expiração: token com exp futuro é servido do cache", async () => {
    getUserMock.mockResolvedValue({ data: { user: operatorUser }, error: null });
    const token = fakeJwt({ expSeconds: nowSeconds() + 3600, marker: "futuro" });

    await requireOperatorSession(`Bearer ${token}`);
    await requireOperatorSession(`Bearer ${token}`);

    expect(getUserMock).toHaveBeenCalledTimes(1);
  });

  it("clamp de expiração: token já vencido NÃO é servido do cache (re-verifica dentro do TTL)", async () => {
    getUserMock.mockResolvedValue({ data: { user: operatorUser }, error: null });
    const token = fakeJwt({ expSeconds: nowSeconds() - 10, marker: "vencido" });

    // 1ª chamada grava no cache (o getUser aceitou o token); a 2ª, ainda dentro
    // da janela de TTL, precisa ir ao GoTrue de novo por causa do `exp`.
    await requireOperatorSession(`Bearer ${token}`);
    await requireOperatorSession(`Bearer ${token}`);

    expect(getUserMock).toHaveBeenCalledTimes(2);
  });

  it("clamp de expiração: token vencendo dentro da folga de 5s já re-verifica", async () => {
    getUserMock.mockResolvedValue({ data: { user: operatorUser }, error: null });
    const token = fakeJwt({ expSeconds: nowSeconds() + 2, marker: "folga" });

    await requireOperatorSession(`Bearer ${token}`);
    await requireOperatorSession(`Bearer ${token}`);

    expect(getUserMock).toHaveBeenCalledTimes(2);
  });

  it("clamp fail-soft: token sem exp legível cai só no TTL (não vira erro)", async () => {
    getUserMock.mockResolvedValue({ data: { user: operatorUser }, error: null });

    // Payload base64url válido, mas o conteúdo não é JSON → readJwtExpMs = null.
    const naoJson = Buffer.from("isto nao e json", "utf8").toString("base64url");
    const token = `hdr.${naoJson}.sig`;

    const ok = await requireOperatorSession(`Bearer ${token}`);
    const cached = await requireOperatorSession(`Bearer ${token}`);

    expect(ok.user).toBe(operatorUser);
    expect(cached.user).toBe(operatorUser);
    expect(getUserMock).toHaveBeenCalledTimes(1);
  });
});

describe("auth: default do TTL de verificação de token", () => {
  const originalVitestFlag = process.env.VITEST;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.SUPABASE_URL = "http://localhost";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    delete process.env.AUTH_TOKEN_VERIFY_TTL_MS; // sem override: vale o default
    getUserMock.mockReset();
    __resetAuthTokenVerifyCache();
  });

  afterEach(() => {
    restoreNow();
    if (originalVitestFlag === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitestFlag;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    __resetAuthTokenVerifyCache();
  });

  it("sem override e sob teste o cache fica DESLIGADO (ordem das checagens)", async () => {
    getUserMock.mockResolvedValue({ data: { user: operatorUser }, error: null });

    await requireOperatorSession("Bearer tok-default-test");
    await requireOperatorSession("Bearer tok-default-test");

    // TTL 0 = verify por request (é o que isola os outros suites entre casos).
    expect(getUserMock).toHaveBeenCalledTimes(2);
  });

  it("default de produção é 120s", async () => {
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    getUserMock.mockResolvedValue({ data: { user: operatorUser }, error: null });
    const base = 1_700_000_000_000;

    freezeNow(base);
    await requireOperatorSession("Bearer tok-prod");
    expect(getUserMock).toHaveBeenCalledTimes(1);

    freezeNow(base + 119_000); // dentro da janela de 120s → cache
    await requireOperatorSession("Bearer tok-prod");
    expect(getUserMock).toHaveBeenCalledTimes(1);

    freezeNow(base + 121_000); // passou de 120s → re-verifica
    await requireOperatorSession("Bearer tok-prod");
    expect(getUserMock).toHaveBeenCalledTimes(2);
  });
});
