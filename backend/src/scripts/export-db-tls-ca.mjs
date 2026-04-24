import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

import "../infrastructure/config/load-env.js";

process.on("unhandledRejection", (reason) => {
  console.error("[script] Unhandled promise rejection:", reason);
  process.exit(1);
});

const currentFilePath = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFilePath);
const projectRoot = path.resolve(currentDirectory, "../../..");

function getConnectionString() {
  const connectionString = process.env.SUPABASE_DB_URL?.trim();

  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is not configured.");
  }

  return connectionString;
}

function getOutputPath() {
  const outputFlagIndex = process.argv.findIndex((argument) => argument === "--output");
  const rawOutputPath =
    outputFlagIndex >= 0 && process.argv[outputFlagIndex + 1]
      ? process.argv[outputFlagIndex + 1]
      : ".local/supabase-db-ca-chain.pem";

  return path.isAbsolute(rawOutputPath) ? rawOutputPath : path.resolve(projectRoot, rawOutputPath);
}

function encodePemCertificate(rawCertificate) {
  const base64Body = rawCertificate.toString("base64").match(/.{1,64}/g)?.join("\n") || "";
  return `-----BEGIN CERTIFICATE-----\n${base64Body}\n-----END CERTIFICATE-----\n`;
}

function collectPeerCertificateChain(peerCertificate) {
  const certificates = [];
  const seenFingerprints = new Set();
  let currentCertificate = peerCertificate;

  while (currentCertificate?.raw) {
    const fingerprint =
      currentCertificate.fingerprint256 ||
      currentCertificate.fingerprint ||
      `${currentCertificate.subject?.CN || "unknown"}:${currentCertificate.serialNumber || "serial"}`;

    if (seenFingerprints.has(fingerprint)) {
      break;
    }

    certificates.push(currentCertificate);
    seenFingerprints.add(fingerprint);

    if (
      !currentCertificate.issuerCertificate ||
      currentCertificate === currentCertificate.issuerCertificate
    ) {
      break;
    }

    currentCertificate = currentCertificate.issuerCertificate;
  }

  return certificates;
}

async function main() {
  const outputPath = getOutputPath();
  const client = new Client({
    connectionString: getConnectionString(),
    ssl: {
      rejectUnauthorized: false,
    },
  });

  try {
    await client.connect();

    const tlsStream = client.connection?.stream;

    if (!tlsStream || typeof tlsStream.getPeerCertificate !== "function") {
      throw new Error("The active Postgres connection is not exposing a TLS socket.");
    }

    const certificateChain = collectPeerCertificateChain(tlsStream.getPeerCertificate(true));

    if (!certificateChain.length) {
      throw new Error("No peer certificates were returned by the database connection.");
    }

    const issuerCertificates = certificateChain.length > 1 ? certificateChain.slice(1) : certificateChain;
    const pemBundle = issuerCertificates.map((certificate) => encodePemCertificate(certificate.raw)).join("\n");

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, pemBundle, "utf8");

    console.log(
      JSON.stringify(
        {
          ok: true,
          outputPath,
          certificateCount: certificateChain.length,
          exportedCertificateCount: issuerCertificates.length,
          certificates: certificateChain.map((certificate, index) => ({
            depth: index,
            subject: certificate.subject?.CN || null,
            issuer: certificate.issuer?.CN || null,
            validFrom: certificate.valid_from || null,
            validTo: certificate.valid_to || null,
            fingerprint256: certificate.fingerprint256 || null,
          })),
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: {
          name: error?.name || "Error",
          code: error?.code || null,
          message: error?.message || String(error),
        },
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
