function createIntegrationState() {
  return {
    requests: 0,
    successes: 0,
    unavailable: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    lastLatencyMs: null,
    lastOutcome: null,
    lastCheckedAt: null,
  };
}

function createValidationState() {
  return {
    totalRuns: 0,
    inconsistentRuns: 0,
    warningsObserved: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    lastRunAt: null,
    lastOverallStatus: null,
    statusCounts: {},
  };
}

const state = {
  integrations: {
    angellira: createIntegrationState(),
    aspx: createIntegrationState(),
  },
  validation: createValidationState(),
};

function normalizeLatency(latencyMs) {
  return typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0;
}

function buildAverageLatency(totalLatencyMs, requests) {
  if (!requests) {
    return null;
  }

  return Math.round((totalLatencyMs / requests) * 100) / 100;
}

export function recordDriverValidationIntegrationResult(source, { availability = "OK", latencyMs = 0 } = {}) {
  if (!Object.hasOwn(state.integrations, source)) {
    return;
  }

  const integrationState = state.integrations[source];
  const normalizedLatency = normalizeLatency(latencyMs);
  integrationState.requests += 1;
  integrationState.totalLatencyMs += normalizedLatency;
  integrationState.maxLatencyMs = Math.max(integrationState.maxLatencyMs, normalizedLatency);
  integrationState.lastLatencyMs = normalizedLatency;
  integrationState.lastCheckedAt = new Date().toISOString();
  integrationState.lastOutcome = availability === "UNAVAILABLE" ? "UNAVAILABLE" : "OK";

  if (availability === "UNAVAILABLE") {
    integrationState.unavailable += 1;
    return;
  }

  integrationState.successes += 1;
}

export function recordPublicLeadValidationMetrics({ overallStatus, warningsCount = 0, latencyMs = 0 } = {}) {
  const normalizedLatency = normalizeLatency(latencyMs);
  state.validation.totalRuns += 1;
  state.validation.totalLatencyMs += normalizedLatency;
  state.validation.maxLatencyMs = Math.max(state.validation.maxLatencyMs, normalizedLatency);
  state.validation.lastRunAt = new Date().toISOString();
  state.validation.lastOverallStatus = overallStatus || null;
  state.validation.warningsObserved += Number.isFinite(warningsCount) && warningsCount > 0 ? warningsCount : 0;

  if (overallStatus) {
    state.validation.statusCounts[overallStatus] = (state.validation.statusCounts[overallStatus] || 0) + 1;
  }

  if (overallStatus && overallStatus !== "VALID") {
    state.validation.inconsistentRuns += 1;
  }
}

export function getDriverValidationMetricsSnapshot() {
  return {
    mode: "in-memory",
    scope: "process-local",
    validation: {
      ...state.validation,
      averageLatencyMs: buildAverageLatency(state.validation.totalLatencyMs, state.validation.totalRuns),
    },
    integrations: Object.fromEntries(
      Object.entries(state.integrations).map(([source, integrationState]) => [
        source,
        {
          ...integrationState,
          averageLatencyMs: buildAverageLatency(integrationState.totalLatencyMs, integrationState.requests),
        },
      ]),
    ),
  };
}

export function resetDriverValidationMetricsForTests() {
  state.integrations.angellira = createIntegrationState();
  state.integrations.aspx = createIntegrationState();
  state.validation = createValidationState();
}
