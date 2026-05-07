/**
 * timer.js — High-resolution wall-clock helpers for pool/concurrency benches.
 */

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export async function measureMs(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

/**
 * Run fn `iterations` times sequentially, return timing stats in ms.
 */
export async function measureMsRepeat(fn, iterations = 5) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    times.push(await measureMs(fn));
  }
  const sorted = [...times].sort((a, b) => a - b);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    avg: times.reduce((a, b) => a + b, 0) / times.length,
    samples: times,
  };
}

/**
 * Fire `concurrency` concurrent invocations of fn, measure total wall-clock.
 */
export async function measureConcurrent(fn, concurrency) {
  const start = performance.now();
  const individualTimes = await Promise.all(
    Array.from({ length: concurrency }, () => measureMs(fn))
  );
  const wallMs = performance.now() - start;
  const sorted = [...individualTimes].sort((a, b) => a - b);
  return {
    wallMs,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    avg: individualTimes.reduce((a, b) => a + b, 0) / individualTimes.length,
  };
}
