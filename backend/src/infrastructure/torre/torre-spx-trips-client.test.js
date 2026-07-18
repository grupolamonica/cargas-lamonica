import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchSpxTrips,
  isSpxAspConfigured,
  resetSpxAspClientStateForTests,
  SpxAspNotConfigured,
  SpxAspUnauthorized,
  SpxAspUnavailable,
} from "./torre-spx-trips-client.js";

function setEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function jsonResponse(status, body) {
  return { status, json: async () => body };
}

const BODY = {
  ok: true,
  columns: ["LH Trip Number", "Status"],
  total: 1,
  byTab: { planejado: 1, aceito: 0, concluido: 0 },
  errors: [],
  rows: [{ "LH Trip Number": "LT1", Status: "Assigning" }],
};

describe("torre-spx-trips-client.fetchSpxTrips", () => {
  const original = {
    key: process.env.TORRE_SPX_ASP_API_KEY,
    torreKey: process.env.TORRE_API_KEY,
    base: process.env.TORRE_API_BASE_URL,
    threshold: process.env.TORRE_SPX_ASP_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  };

  beforeEach(() => {
    resetSpxAspClientStateForTests();
    setEnv("TORRE_SPX_ASP_API_KEY", "test-key");
    setEnv("TORRE_API_KEY", undefined);
    setEnv("TORRE_API_BASE_URL", "https://torre.test");
    setEnv("TORRE_SPX_ASP_CIRCUIT_BREAKER_FAILURE_THRESHOLD", undefined);
  });

  afterEach(() => {
    setEnv("TORRE_SPX_ASP_API_KEY", original.key);
    setEnv("TORRE_API_KEY", original.torreKey);
    setEnv("TORRE_API_BASE_URL", original.base);
    setEnv("TORRE_SPX_ASP_CIRCUIT_BREAKER_FAILURE_THRESHOLD", original.threshold);
    vi.restoreAllMocks();
  });

  it("200 devolve o payload e envia x-api-key + querystring", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, BODY));
    const res = await fetchSpxTrips({ daysBack: 30, daysFwd: 15, queryType: 1 }, { fetchImpl });

    expect(res).toEqual(BODY);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://torre.test/api/spx/asp?days_back=30&days_fwd=15&query_type=1",
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "test-key" }) }),
    );
  });

  it("cacheia por querystring (mesmos params não refazem fetch; params diferentes sim)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, BODY));
    await fetchSpxTrips({ queryType: 1 }, { fetchImpl });
    await fetchSpxTrips({ queryType: 1 }, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await fetchSpxTrips({ queryType: 2 }, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("sem chave (nem dedicada nem TORRE_API_KEY) → SpxAspNotConfigured e não faz fetch", async () => {
    setEnv("TORRE_SPX_ASP_API_KEY", undefined);
    const fetchImpl = vi.fn();
    expect(isSpxAspConfigured()).toBe(false);
    await expect(fetchSpxTrips({}, { fetchImpl })).rejects.toBeInstanceOf(SpxAspNotConfigured);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cai em TORRE_API_KEY quando a dedicada não está setada", async () => {
    setEnv("TORRE_SPX_ASP_API_KEY", undefined);
    setEnv("TORRE_API_KEY", "fallback-key");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, BODY));
    await fetchSpxTrips({}, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://torre.test/api/spx/asp",
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "fallback-key" }) }),
    );
  });

  it("401 → SpxAspUnauthorized (não conta pro circuit breaker)", async () => {
    setEnv("TORRE_SPX_ASP_CIRCUIT_BREAKER_FAILURE_THRESHOLD", "1");
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: "bad key" }));
    await expect(fetchSpxTrips({ queryType: 1 }, { fetchImpl })).rejects.toBeInstanceOf(SpxAspUnauthorized);
    await expect(fetchSpxTrips({ queryType: 2 }, { fetchImpl })).rejects.toBeInstanceOf(SpxAspUnauthorized);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // breaker não abriu
  });

  it("5xx → SpxAspUnavailable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(502, {}));
    await expect(fetchSpxTrips({ queryType: 1 }, { fetchImpl })).rejects.toBeInstanceOf(SpxAspUnavailable);
  });

  it("erro de rede → SpxAspUnavailable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("aborted"));
    await expect(fetchSpxTrips({ queryType: 1 }, { fetchImpl })).rejects.toBeInstanceOf(SpxAspUnavailable);
  });

  it("circuit breaker abre após N falhas e responde sem fetch", async () => {
    setEnv("TORRE_SPX_ASP_CIRCUIT_BREAKER_FAILURE_THRESHOLD", "2");
    const fetchImpl = vi.fn().mockRejectedValue(new Error("aborted"));
    await expect(fetchSpxTrips({ queryType: 1 }, { fetchImpl })).rejects.toBeInstanceOf(SpxAspUnavailable);
    await expect(fetchSpxTrips({ queryType: 2 }, { fetchImpl })).rejects.toBeInstanceOf(SpxAspUnavailable);
    // Circuito aberto: terceira chamada (querystring nova) nem chega ao fetch.
    await expect(fetchSpxTrips({ queryType: 3 }, { fetchImpl })).rejects.toBeInstanceOf(SpxAspUnavailable);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
