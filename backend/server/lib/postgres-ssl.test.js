import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildPostgresSslConfig,
  getPostgresTlsConfiguration,
  isSelfSignedChainError,
  shouldRejectUnauthorizedSsl,
} from "./postgres-ssl.js";

const ORIGINAL_ENV = {
  CLAIMS_DB_SSL_REJECT_UNAUTHORIZED: process.env.CLAIMS_DB_SSL_REJECT_UNAUTHORIZED,
  CLAIMS_DB_SSL_CA_PATH: process.env.CLAIMS_DB_SSL_CA_PATH,
  CLAIMS_DB_SSL_CA_B64: process.env.CLAIMS_DB_SSL_CA_B64,
  CLAIMS_DB_SSL_CA_CERT: process.env.CLAIMS_DB_SSL_CA_CERT,
};

function restoreEnv() {
  Object.entries(ORIGINAL_ENV).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key];
      return;
    }

    process.env[key] = value;
  });
}

afterEach(() => {
  restoreEnv();
});

describe("postgres ssl configuration", () => {
  it("uses strict TLS by default without a custom CA", () => {
    delete process.env.CLAIMS_DB_SSL_REJECT_UNAUTHORIZED;
    delete process.env.CLAIMS_DB_SSL_CA_PATH;
    delete process.env.CLAIMS_DB_SSL_CA_B64;
    delete process.env.CLAIMS_DB_SSL_CA_CERT;

    expect(shouldRejectUnauthorizedSsl()).toBe(true);
    expect(getPostgresTlsConfiguration()).toMatchObject({
      rejectUnauthorized: true,
      caConfigured: false,
      caSource: null,
    });
    expect(buildPostgresSslConfig()).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("loads a CA certificate from file path", () => {
    const certificatePath = path.join(os.tmpdir(), `postgres-ca-${Date.now()}.pem`);
    fs.writeFileSync(certificatePath, "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n", "utf8");

    process.env.CLAIMS_DB_SSL_CA_PATH = certificatePath;
    delete process.env.CLAIMS_DB_SSL_CA_B64;
    delete process.env.CLAIMS_DB_SSL_CA_CERT;

    const tlsConfiguration = getPostgresTlsConfiguration();

    expect(tlsConfiguration.caConfigured).toBe(true);
    expect(tlsConfiguration.caSource).toBe("path");
    expect(tlsConfiguration.caDetail).toBe(certificatePath);
    expect(buildPostgresSslConfig()).toMatchObject({
      rejectUnauthorized: true,
      ca: expect.stringContaining("BEGIN CERTIFICATE"),
    });

    fs.unlinkSync(certificatePath);
  });

  it("loads a CA certificate from base64", () => {
    process.env.CLAIMS_DB_SSL_CA_B64 = Buffer.from("-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n").toString("base64");
    delete process.env.CLAIMS_DB_SSL_CA_PATH;
    delete process.env.CLAIMS_DB_SSL_CA_CERT;

    const tlsConfiguration = getPostgresTlsConfiguration();

    expect(tlsConfiguration.caConfigured).toBe(true);
    expect(tlsConfiguration.caSource).toBe("b64");
    expect(buildPostgresSslConfig()).toMatchObject({
      rejectUnauthorized: true,
      ca: expect.stringContaining("BEGIN CERTIFICATE"),
    });
  });

  it("rejects ambiguous CA configuration", () => {
    process.env.CLAIMS_DB_SSL_CA_PATH = "certs/db.pem";
    process.env.CLAIMS_DB_SSL_CA_B64 = "VEVTVA==";

    expect(() => getPostgresTlsConfiguration()).toThrow(
      "Configure only one of CLAIMS_DB_SSL_CA_PATH, CLAIMS_DB_SSL_CA_B64 or CLAIMS_DB_SSL_CA_CERT.",
    );
  });

  it("detects self-signed chain errors", () => {
    expect(isSelfSignedChainError(new Error("self-signed certificate in certificate chain"))).toBe(true);
    expect(isSelfSignedChainError(new Error("connect ETIMEDOUT"))).toBe(false);
  });
});
