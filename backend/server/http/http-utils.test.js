import { afterEach, describe, expect, it } from "vitest";

import { getRequestIp, parseJsonBody } from "./http-utils.js";

const originalTrustProxyHeaders = process.env.TRUST_PROXY_HEADERS;
const originalTrustedClientIpHeader = process.env.TRUSTED_CLIENT_IP_HEADER;

afterEach(() => {
  if (originalTrustProxyHeaders === undefined) {
    delete process.env.TRUST_PROXY_HEADERS;
  } else {
    process.env.TRUST_PROXY_HEADERS = originalTrustProxyHeaders;
  }

  if (originalTrustedClientIpHeader === undefined) {
    delete process.env.TRUSTED_CLIENT_IP_HEADER;
  } else {
    process.env.TRUSTED_CLIENT_IP_HEADER = originalTrustedClientIpHeader;
  }
});

describe("http-utils", () => {
  it("usa o header confiavel quando proxy headers estao habilitados", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    process.env.TRUSTED_CLIENT_IP_HEADER = "x-forwarded-for";

    const request = {
      headers: {
        "x-forwarded-for": "198.51.100.10, 10.0.0.1",
      },
      socket: {
        remoteAddress: "10.0.0.5",
      },
    };

    expect(getRequestIp(request)).toBe("198.51.100.10");
  });

  it("ignora headers de proxy quando TRUST_PROXY_HEADERS=false", () => {
    process.env.TRUST_PROXY_HEADERS = "false";

    const request = {
      headers: {
        "cf-connecting-ip": "198.51.100.11",
      },
      socket: {
        remoteAddress: "10.0.0.6",
      },
    };

    expect(getRequestIp(request)).toBe("10.0.0.6");
  });

  it("parseia JSON a partir de request em stream quando body e text nao existem", async () => {
    const chunks = [Buffer.from('{"hello":"'), Buffer.from('world"}')];

    const request = {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };

    await expect(parseJsonBody(request)).resolves.toEqual({
      hello: "world",
    });
  });
});
