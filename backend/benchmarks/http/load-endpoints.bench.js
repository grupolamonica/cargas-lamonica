/**
 * load-endpoints.bench.js
 *
 * HTTP-level load test using autocannon.
 * Requires a running backend server. Set BASE_URL env var or use default.
 *
 * Usage:
 *   npm run bench:http
 *   BASE_URL=http://localhost:3001 BENCH_TOKEN=<jwt> npm run bench:http
 *
 * Endpoints tested (20 connections, 15s each):
 *   GET /health                           — baseline (no auth)
 *   GET /api/operator/cargas              — cargo list (ILIKE + pagination)
 *   GET /api/operator/veiculos            — vehicles list (REPLACE JOIN + LATERAL)
 *   GET /api/operator/routes              — routes list (LIMIT 2000)
 *
 * Thresholds: RPS ≥ 50, p99 ≤ 200ms.
 * Unauthenticated endpoints (like /health) use RPS ≥ 200.
 *
 * NOTE: Authenticated endpoints require BENCH_TOKEN.
 *       If not set, auth-required tests are skipped with a warning.
 */

import { runAutocannon, assertThroughput, printResult } from "./autocannon-setup.js";

const BASE_URL = process.env.BASE_URL || "http://localhost:3001";
const BENCH_TOKEN = process.env.BENCH_TOKEN || "";
const CONNECTIONS = parseInt(process.env.BENCH_CONNECTIONS || "20", 10);
const DURATION_SECONDS = parseInt(process.env.BENCH_DURATION || "15", 10);

const authHeaders = BENCH_TOKEN
  ? { Authorization: `Bearer ${BENCH_TOKEN}` }
  : {};

const scenarios = [
  {
    label: "/health (no auth — baseline)",
    path: "/health",
    method: "GET",
    headers: {},
    thresholds: { minRps: 200, maxLatencyP99Ms: 100 },
    requiresAuth: false,
  },
  {
    label: "GET /api/operator/cargas (no search)",
    path: "/api/operator/cargas?page=1&pageSize=20",
    method: "GET",
    headers: authHeaders,
    thresholds: { minRps: 50, maxLatencyP99Ms: 300 },
    requiresAuth: true,
  },
  {
    label: "GET /api/operator/cargas (ILIKE search='Salvador')",
    path: "/api/operator/cargas?page=1&pageSize=20&search=Salvador",
    method: "GET",
    headers: authHeaders,
    thresholds: { minRps: 50, maxLatencyP99Ms: 500 },
    requiresAuth: true,
  },
  {
    label: "GET /api/operator/veiculos (REPLACE+LATERAL join)",
    path: "/api/operator/veiculos?page=1&pageSize=20",
    method: "GET",
    headers: authHeaders,
    thresholds: { minRps: 50, maxLatencyP99Ms: 300 },
    requiresAuth: true,
  },
  {
    label: "GET /api/operator/routes (LIMIT 2000)",
    path: "/api/operator/routes?page=1&pageSize=20",
    method: "GET",
    headers: authHeaders,
    thresholds: { minRps: 50, maxLatencyP99Ms: 300 },
    requiresAuth: true,
  },
];

async function checkServerReachable() {
  try {
    const { default: http } = await import("node:http");
    await new Promise((resolve, reject) => {
      const req = http.get(`${BASE_URL}/health`, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 600) resolve();
        else reject(new Error(`Unexpected status: ${res.statusCode}`));
      });
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("timeout")));
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log("  Lamonica Cargas — HTTP Load Bench");
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  Connections: ${CONNECTIONS}, Duration: ${DURATION_SECONDS}s`);
  console.log(`${"=".repeat(60)}\n`);

  const reachable = await checkServerReachable();
  if (!reachable) {
    console.error(
      `\n  ERROR: Server not reachable at ${BASE_URL}\n` +
      `  Start the backend first:\n` +
      `    cd backend && npm start\n` +
      `  Or set BASE_URL to point to a running instance.\n`
    );
    process.exit(1);
  }

  const results = [];
  let failures = 0;

  for (const scenario of scenarios) {
    if (scenario.requiresAuth && !BENCH_TOKEN) {
      console.warn(`  SKIPPED (no BENCH_TOKEN): ${scenario.label}`);
      continue;
    }

    console.log(`\n  Running: ${scenario.label} ...`);

    try {
      const result = await runAutocannon({
        url: BASE_URL,
        path: scenario.path,
        method: scenario.method,
        headers: scenario.headers,
        connections: CONNECTIONS,
        duration: DURATION_SECONDS,
        silent: false,
      });

      printResult(scenario.label, result);

      try {
        assertThroughput(result, { ...scenario.thresholds, label: scenario.label });
        console.log(`  ✓ PASS: ${scenario.label}`);
        results.push({ label: scenario.label, status: "PASS", ...extractMetrics(result) });
      } catch (assertErr) {
        console.error(`  ✗ FAIL: ${assertErr.message}`);
        failures++;
        results.push({ label: scenario.label, status: "FAIL", error: assertErr.message, ...extractMetrics(result) });
      }
    } catch (err) {
      console.error(`  ✗ ERROR running ${scenario.label}: ${err.message}`);
      failures++;
      results.push({ label: scenario.label, status: "ERROR", error: err.message });
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("  RESULTS SUMMARY");
  console.log(`${"=".repeat(60)}`);
  console.table(results);

  if (failures > 0) {
    console.error(`\n  ${failures} scenario(s) FAILED.\n`);
    process.exit(1);
  } else {
    console.log(`\n  All scenarios PASSED.\n`);
  }
}

function extractMetrics(result) {
  return {
    rpsAvg: result.requests.average.toFixed(1),
    p50Ms: result.latency.p50,
    p99Ms: result.latency.p99,
    errors: result.errors,
    "2xx": result["2xx"],
  };
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
