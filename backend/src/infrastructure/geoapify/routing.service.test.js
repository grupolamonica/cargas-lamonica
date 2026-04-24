// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

function createJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function createAbortablePendingFetch() {
  return vi.fn((url, options = {}) => {
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => {
          const abortError = new Error("Request aborted");
          abortError.name = "AbortError";
          reject(abortError);
        },
        { once: true },
      );
    });
  });
}

describe("getRouteInfo", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("throws ValidationError when origin is empty", async () => {
    process.env.GEOAPIFY_API_KEY = "test-key";
    const { getRouteInfo } = await import("./routing.service.js");
    const { ValidationError } = await import("./errors.js");

    await expect(getRouteInfo("", "São Paulo, SP")).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ConfigurationError when GEOAPIFY_API_KEY is missing", async () => {
    delete process.env.GEOAPIFY_API_KEY;
    vi.stubGlobal("fetch", vi.fn());

    const { getRouteInfo } = await import("./routing.service.js");
    const { ConfigurationError } = await import("./errors.js");

    await expect(getRouteInfo("Fortaleza, CE", "São Paulo, SP")).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("returns rounded kilometers and hours from Geoapify responses", async () => {
    process.env.GEOAPIFY_API_KEY = "test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          results: [{ lat: -3.7319, lon: -38.5267, formatted: "Fortaleza, CE" }],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          results: [{ lat: -23.5505, lon: -46.6333, formatted: "São Paulo, SP" }],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          features: [{ properties: { distance: 3123456, time: 14418 } }],
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const { getRouteInfo } = await import("./routing.service.js");

    await expect(getRouteInfo("Fortaleza, CE", "São Paulo, SP")).resolves.toEqual({
      distance_km: 3123.46,
      duration_hours: 4.01,
    });
  });

  it("throws RouteResolutionError when a location cannot be geocoded", async () => {
    process.env.GEOAPIFY_API_KEY = "test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse({ results: [] }))
      .mockResolvedValueOnce(
        createJsonResponse({
          results: [{ lat: -23.5505, lon: -46.6333, formatted: "São Paulo, SP" }],
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const { getRouteInfo } = await import("./routing.service.js");
    const { RouteResolutionError } = await import("./errors.js");

    await expect(getRouteInfo("Fortaleza, CE", "São Paulo, SP")).rejects.toBeInstanceOf(RouteResolutionError);
  });

  it("throws UpstreamApiError on non-2xx Geoapify responses", async () => {
    process.env.GEOAPIFY_API_KEY = "test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          results: [{ lat: -3.7319, lon: -38.5267, formatted: "Fortaleza, CE" }],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          results: [{ lat: -23.5505, lon: -46.6333, formatted: "São Paulo, SP" }],
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({ error: "bad request" }, 400));

    vi.stubGlobal("fetch", fetchMock);

    const { getRouteInfo } = await import("./routing.service.js");
    const { UpstreamApiError } = await import("./errors.js");

    await expect(getRouteInfo("Fortaleza, CE", "São Paulo, SP")).rejects.toBeInstanceOf(UpstreamApiError);
  });

  it("throws TimeoutError when Geoapify exceeds the timeout", async () => {
    vi.useFakeTimers();
    process.env.GEOAPIFY_API_KEY = "test-key";
    vi.stubGlobal("fetch", createAbortablePendingFetch());

    const { getRouteInfo } = await import("./routing.service.js");
    const { TimeoutError } = await import("./errors.js");

    const routePromise = getRouteInfo("Fortaleza, CE", "São Paulo, SP");
    const assertion = expect(routePromise).rejects.toBeInstanceOf(TimeoutError);
    // Advance past timeout (5s) and retry delays (300ms * 2^attempt)
    for (let tick = 0; tick < 10; tick += 1) {
      await vi.advanceTimersByTimeAsync(2000);
    }

    await assertion;
    vi.useRealTimers();
  }, 15_000);

  it("reuses the cached result for duplicate requests", async () => {
    process.env.GEOAPIFY_API_KEY = "test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          results: [{ lat: -3.7319, lon: -38.5267, formatted: "Fortaleza, CE" }],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          results: [{ lat: -23.5505, lon: -46.6333, formatted: "São Paulo, SP" }],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          features: [{ properties: { distance: 3123456, time: 14418 } }],
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const { getRouteInfo } = await import("./routing.service.js");

    const firstResult = await getRouteInfo("Fortaleza, CE", "São Paulo, SP");
    const secondResult = await getRouteInfo("Fortaleza, CE", "São Paulo, SP");

    expect(secondResult).toEqual(firstResult);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reuses geocoding results across routes that share the same location", async () => {
    process.env.GEOAPIFY_API_KEY = "test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          results: [{ lat: -3.7319, lon: -38.5267, formatted: "Fortaleza, CE" }],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          results: [{ lat: -23.5505, lon: -46.6333, formatted: "Sao Paulo, SP" }],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          features: [{ properties: { distance: 3123456, time: 14418 } }],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          results: [{ lat: -12.9714, lon: -38.5014, formatted: "Salvador, BA" }],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          features: [{ properties: { distance: 1389000, time: 17940 } }],
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const { getRouteInfo } = await import("./routing.service.js");

    await expect(getRouteInfo("Fortaleza, CE", "Sao Paulo, SP")).resolves.toEqual({
      distance_km: 3123.46,
      duration_hours: 4.01,
    });
    await expect(getRouteInfo("Fortaleza, CE", "Salvador, BA")).resolves.toEqual({
      distance_km: 1389,
      duration_hours: 4.98,
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("shares the same in-flight request for concurrent duplicates", { timeout: 15_000 }, async () => {
    process.env.GEOAPIFY_API_KEY = "test-key";

    let routingResolved = false;
    const fetchMock = vi.fn((url) => {
      const targetUrl = String(url);

      if (targetUrl.includes("/v1/geocode/search") && targetUrl.includes("Fortaleza")) {
        return Promise.resolve(
          createJsonResponse({
            results: [{ lat: -3.7319, lon: -38.5267, formatted: "Fortaleza, CE" }],
          }),
        );
      }

      if (targetUrl.includes("/v1/geocode/search") && targetUrl.includes("S%C3%A3o+Paulo")) {
        return Promise.resolve(
          createJsonResponse({
            results: [{ lat: -23.5505, lon: -46.6333, formatted: "São Paulo, SP" }],
          }),
        );
      }

      return new Promise((resolve) => {
        setTimeout(() => {
          routingResolved = true;
          resolve(
            createJsonResponse({
              features: [{ properties: { distance: 3123456, time: 14418 } }],
            }),
          );
        }, 5);
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const { getRouteInfo } = await import("./routing.service.js");

    const [firstResult, secondResult] = await Promise.all([
      getRouteInfo("Fortaleza, CE", "São Paulo, SP"),
      getRouteInfo("Fortaleza, CE", "São Paulo, SP"),
    ]);

    expect(routingResolved).toBe(true);
    expect(firstResult).toEqual(secondResult);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not cache failed upstream requests", { timeout: 15_000 }, async () => {
    process.env.GEOAPIFY_API_KEY = "test-key";
    const fetchMock = vi
      .fn()
      // 1st getRouteInfo call — geocode succeeds, routing fails all 3 retry attempts
      .mockResolvedValueOnce(
        createJsonResponse({
          results: [{ lat: -3.7319, lon: -38.5267, formatted: "Fortaleza, CE" }],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          results: [{ lat: -23.5505, lon: -46.6333, formatted: "São Paulo, SP" }],
        }),
      )
      .mockResolvedValueOnce(createJsonResponse({ error: "bad gateway" }, 502))
      .mockResolvedValueOnce(createJsonResponse({ error: "bad gateway" }, 502))
      .mockResolvedValueOnce(createJsonResponse({ error: "bad gateway" }, 502))
      // 2nd getRouteInfo call — geocode is cached from 1st call, routing succeeds
      .mockResolvedValueOnce(
        createJsonResponse({
          features: [{ properties: { distance: 3123456, time: 14418 } }],
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const { getRouteInfo } = await import("./routing.service.js");

    await expect(getRouteInfo("Fortaleza, CE", "São Paulo, SP")).rejects.toThrow();
    await expect(getRouteInfo("Fortaleza, CE", "São Paulo, SP")).resolves.toEqual({
      distance_km: 3123.46,
      duration_hours: 4.01,
    });
  });

  it("sends routing request with resolved coordinates and drive mode", async () => {
    process.env.GEOAPIFY_API_KEY = "test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          results: [{ lat: -3.7319, lon: -38.5267, formatted: "Fortaleza, CE" }],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          results: [{ lat: -23.5505, lon: -46.6333, formatted: "São Paulo, SP" }],
        }),
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          features: [{ properties: { distance: 3123456, time: 14418 } }],
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const { getRouteInfo } = await import("./routing.service.js");
    await getRouteInfo("Fortaleza, CE", "São Paulo, SP");

    const [routingUrl] = fetchMock.mock.calls[2];
    const parsedUrl = new URL(String(routingUrl));

    expect(parsedUrl.pathname).toBe("/v1/routing");
    expect(parsedUrl.searchParams.get("mode")).toBe("drive");
    expect(parsedUrl.searchParams.get("waypoints")).toBe("-3.7319,-38.5267|-23.5505,-46.6333");
  });
});
