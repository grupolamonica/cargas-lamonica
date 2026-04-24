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

describe("geocodeLocation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("reuses the cached result for identical follow-up lookups", async () => {
    process.env.GEOAPIFY_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(
      createJsonResponse({
        results: [{ lat: -3.7319, lon: -38.5267, formatted: "Fortaleza, CE" }],
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const { geocodeLocation } = await import("./geocoding.service.js");

    const firstResult = await geocodeLocation("Fortaleza, CE");
    const secondResult = await geocodeLocation("Fortaleza, CE");

    expect(secondResult).toEqual(firstResult);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares the same in-flight lookup for concurrent duplicates", async () => {
    process.env.GEOAPIFY_API_KEY = "test-key";
    let resolved = false;
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve(
              createJsonResponse({
                results: [{ lat: -3.7319, lon: -38.5267, formatted: "Fortaleza, CE" }],
              }),
            );
          }, 5);
        }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const { geocodeLocation } = await import("./geocoding.service.js");

    const [firstResult, secondResult] = await Promise.all([
      geocodeLocation("Fortaleza, CE"),
      geocodeLocation("Fortaleza, CE"),
    ]);

    expect(resolved).toBe(true);
    expect(firstResult).toEqual(secondResult);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
