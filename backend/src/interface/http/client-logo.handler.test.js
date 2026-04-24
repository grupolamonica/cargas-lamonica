import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockLookup } = vi.hoisted(() => ({
  mockLookup: vi.fn(),
}));

const { mockHttpsRequest } = vi.hoisted(() => ({
  mockHttpsRequest: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  lookup: mockLookup,
}));

vi.mock("node:https", () => ({
  request: mockHttpsRequest,
}));

import { isPrivateNetworkIpAddress, resolveClientLogoResponse } from "./client-logo.handler.js";

describe("client logo proxy guards", () => {
  afterEach(() => {
    mockLookup.mockReset();
    mockHttpsRequest.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("blocks private and local network ip addresses", () => {
    expect(isPrivateNetworkIpAddress("127.0.0.1")).toBe(true);
    expect(isPrivateNetworkIpAddress("10.0.0.8")).toBe(true);
    expect(isPrivateNetworkIpAddress("172.20.4.9")).toBe(true);
    expect(isPrivateNetworkIpAddress("192.168.1.12")).toBe(true);
    expect(isPrivateNetworkIpAddress("169.254.10.20")).toBe(true);
    expect(isPrivateNetworkIpAddress("::1")).toBe(true);
    expect(isPrivateNetworkIpAddress("fc00::1")).toBe(true);
    expect(isPrivateNetworkIpAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("allows public ip addresses", () => {
    expect(isPrivateNetworkIpAddress("8.8.8.8")).toBe(false);
    expect(isPrivateNetworkIpAddress("1.1.1.1")).toBe(false);
    expect(isPrivateNetworkIpAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("blocks redirects that attempt to leave the public internet", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34" }]);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: {
            location: "http://127.0.0.1/internal-logo.png",
          },
        }),
      ),
    );

    const response = await resolveClientLogoResponse("https://example.com/logo.png");

    expect(response.statusCode).toBe(502);
    expect(response.body.toString("utf8")).toContain("LOGO_FETCH_FAILED");
  });

  it("rejects images that exceed the configured size limit", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    vi.stubEnv("CLIENT_LOGO_MAX_BYTES", "16");

    mockHttpsRequest.mockImplementation((_url, _options, callback) => {
      const responseStream = new PassThrough();
      responseStream.statusCode = 200;
      responseStream.headers = {
        "content-type": "image/png",
        "content-length": "32",
      };

      queueMicrotask(() => {
        callback(responseStream);
        responseStream.end(Buffer.alloc(32));
      });

      return {
        on: vi.fn(),
        destroy: vi.fn(),
        end: vi.fn(),
        setTimeout: vi.fn(),
      };
    });

    const response = await resolveClientLogoResponse("https://example.com/logo.png");

    expect(response.statusCode).toBe(413);
    expect(response.body.toString("utf8")).toContain("LOGO_TOO_LARGE");
  });

  it("falls back to the node transport when fetch fails in production-like environments", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("fetch unavailable")),
    );

    mockHttpsRequest.mockImplementation((_url, _options, callback) => {
      const responseStream = new PassThrough();
      responseStream.statusCode = 200;
      responseStream.headers = {
        "content-type": "image/png",
      };

      queueMicrotask(() => {
        callback(responseStream);
        responseStream.end(Buffer.from("png-body"));
      });

      return {
        on: vi.fn(),
        destroy: vi.fn(),
        end: vi.fn(),
        setTimeout: vi.fn(),
      };
    });

    const response = await resolveClientLogoResponse("https://example.com/logo.png");

    expect(response.statusCode).toBe(200);
    expect(response.headers["Content-Type"]).toContain("image/png");
    expect(response.body.toString("utf8")).toBe("png-body");
    expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
  });

  it("supports lookup all mode and retries the next public address when the first request fails", async () => {
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("fetch unavailable")),
    );

    mockHttpsRequest
      .mockImplementationOnce((_url, options) => {
        options.lookup("example.com", { all: true }, (error, addresses) => {
          expect(error).toBeNull();
          expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
        });

        return {
          on(eventName, handler) {
            if (eventName === "error") {
              queueMicrotask(() => handler(new Error("first address failed")));
            }

            return this;
          },
          destroy: vi.fn(),
          end: vi.fn(),
          setTimeout: vi.fn(),
        };
      })
      .mockImplementationOnce((_url, options, callback) => {
        options.lookup("example.com", { all: true }, (error, addresses) => {
          expect(error).toBeNull();
          expect(addresses).toEqual([{ address: "93.184.216.35", family: 4 }]);
        });

        const responseStream = new PassThrough();
        responseStream.statusCode = 200;
        responseStream.headers = {
          "content-type": "image/png",
        };

        queueMicrotask(() => {
          callback(responseStream);
          responseStream.end(Buffer.from("png-body-retried"));
        });

        return {
          on: vi.fn(),
          destroy: vi.fn(),
          end: vi.fn(),
          setTimeout: vi.fn(),
        };
      });

    const response = await resolveClientLogoResponse("https://example.com/logo.png");

    expect(response.statusCode).toBe(200);
    expect(response.body.toString("utf8")).toBe("png-body-retried");
    expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
  });
});
