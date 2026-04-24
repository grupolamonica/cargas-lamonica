import { beforeEach, describe, expect, it } from "vitest";

import {
  getDriverValidationMetricsSnapshot,
  recordDriverValidationIntegrationResult,
  recordPublicLeadValidationMetrics,
  resetDriverValidationMetricsForTests,
} from "./metrics.js";

describe("driver validation metrics", () => {
  beforeEach(() => {
    resetDriverValidationMetricsForTests();
  });

  it("tracks integration outcomes and average latency per source", () => {
    recordDriverValidationIntegrationResult("angellira", {
      availability: "OK",
      latencyMs: 120,
    });
    recordDriverValidationIntegrationResult("angellira", {
      availability: "UNAVAILABLE",
      latencyMs: 250,
    });
    recordDriverValidationIntegrationResult("aspx", {
      availability: "OK",
      latencyMs: 80,
    });

    const snapshot = getDriverValidationMetricsSnapshot();

    expect(snapshot.integrations.angellira).toMatchObject({
      requests: 2,
      successes: 1,
      unavailable: 1,
      averageLatencyMs: 185,
      maxLatencyMs: 250,
      lastOutcome: "UNAVAILABLE",
    });
    expect(snapshot.integrations.aspx).toMatchObject({
      requests: 1,
      successes: 1,
      unavailable: 0,
      averageLatencyMs: 80,
      maxLatencyMs: 80,
    });
  });

  it("tracks validation outcomes and inconsistency rate groundwork", () => {
    recordPublicLeadValidationMetrics({
      overallStatus: "VALID",
      warningsCount: 0,
      latencyMs: 90,
    });
    recordPublicLeadValidationMetrics({
      overallStatus: "EXPIRING",
      warningsCount: 2,
      latencyMs: 140,
    });

    const snapshot = getDriverValidationMetricsSnapshot();

    expect(snapshot.validation).toMatchObject({
      totalRuns: 2,
      inconsistentRuns: 1,
      warningsObserved: 2,
      averageLatencyMs: 115,
      maxLatencyMs: 140,
      lastOverallStatus: "EXPIRING",
      statusCounts: {
        VALID: 1,
        EXPIRING: 1,
      },
    });
  });
});
