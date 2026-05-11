/**
 * autocannon-setup.js — Autocannon instance factory and assertion helpers.
 */

import autocannon from "autocannon";

/**
 * Run an autocannon load test and return results.
 * @param {object} opts
 * @param {string} opts.url       — Base URL (e.g. "http://localhost:3001")
 * @param {string} opts.path      — Request path
 * @param {string} opts.method    — HTTP method (default: GET)
 * @param {object} opts.headers   — Request headers
 * @param {number} opts.connections — Concurrent connections (default: 20)
 * @param {number} opts.duration  — Duration in seconds (default: 15)
 * @param {boolean} opts.silent   — Suppress progress bar (default: false)
 */
export function runAutocannon({ url, path, method = "GET", headers = {}, connections = 20, duration = 15, silent = false }) {
  return new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        url,
        connections,
        duration,
        requests: [{ method, path, headers }],
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      }
    );

    if (!silent) {
      autocannon.track(instance, { renderProgressBar: true });
    }
  });
}

/**
 * Assert throughput thresholds. Throws descriptive errors on failure.
 */
export function assertThroughput(result, { minRps = 50, maxLatencyP99Ms = 200, label = "" }) {
  const prefix = label ? `[${label}] ` : "";

  if (result.requests.average < minRps) {
    throw new Error(
      `${prefix}Throughput too low: ${result.requests.average.toFixed(1)} rps < ${minRps} rps minimum`
    );
  }

  if (result.latency.p99 > maxLatencyP99Ms) {
    throw new Error(
      `${prefix}p99 latency too high: ${result.latency.p99}ms > ${maxLatencyP99Ms}ms maximum`
    );
  }
}

/**
 * Print a summary table for a bench result.
 */
export function printResult(label, result) {
  console.log(`\n  ${label}`);
  console.table({
    "RPS (avg)": result.requests.average.toFixed(1),
    "p50 latency (ms)": result.latency.p50,
    "p99 latency (ms)": result.latency.p99,
    "errors": result.errors,
    "timeouts": result.timeouts,
    "2xx": result["2xx"],
    "non-2xx": result.non2xx,
  });
}
