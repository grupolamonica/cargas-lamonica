/**
 * pg-spy.js — Query counter spy for N+1 detection.
 *
 * Wraps a pg Client's .query() to count every SQL call and record timing.
 * assertMaxQueries() throws if the count exceeds the threshold, making N+1
 * regressions visible immediately in bench output.
 */

export function createQuerySpy(client) {
  let callCount = 0;
  const calls = [];
  const originalQuery = client.query.bind(client);

  client.query = async function spiedQuery(sqlOrConfig, params) {
    const start = performance.now();
    try {
      const result = await originalQuery(sqlOrConfig, params);
      calls.push({
        sql:
          typeof sqlOrConfig === "string"
            ? sqlOrConfig.trim().slice(0, 120)
            : sqlOrConfig?.text?.trim().slice(0, 120) ?? "(unknown)",
        params,
        durationMs: performance.now() - start,
      });
      callCount++;
      return result;
    } catch (err) {
      callCount++;
      throw err;
    }
  };

  return {
    get count() {
      return callCount;
    },
    get calls() {
      return calls;
    },
    reset() {
      callCount = 0;
      calls.length = 0;
    },
    restore() {
      client.query = originalQuery;
    },
    assertMaxQueries(max, label = "") {
      if (callCount > max) {
        const detail = calls
          .slice(0, 10)
          .map((c, i) => `  [${i + 1}] ${c.sql}`)
          .join("\n");
        throw new Error(
          `[pg-spy] N+1 detected${label ? ` in "${label}"` : ""}:\n` +
            `  ${callCount} queries fired, max allowed: ${max}\n` +
            `First queries:\n${detail}`
        );
      }
    },
  };
}

/**
 * Pool-level spy: patches pool.connect() so every checked-out client is tracked.
 * Use when benchmarking concurrent operations across multiple clients.
 */
export function createPoolSpy(pool) {
  const originalConnect = pool.connect.bind(pool);
  const allSpies = [];

  pool.connect = async function spiedConnect() {
    const client = await originalConnect();
    const spy = createQuerySpy(client);
    allSpies.push(spy);
    return client;
  };

  return {
    get totalQueries() {
      return allSpies.reduce((s, spy) => s + spy.count, 0);
    },
    get allCalls() {
      return allSpies.flatMap((spy) => spy.calls);
    },
    resetAll() {
      allSpies.forEach((spy) => spy.reset());
    },
    restore() {
      pool.connect = originalConnect;
    },
  };
}
