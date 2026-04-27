import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDriverValidationMetricsSnapshot, resetDriverValidationMetricsForTests } from "../../infrastructure/metrics.js";

const { mockLookupAngelliraDriverByCpf, mockLookupAngelliraPlate, mockLookupAspxDriverByCpf } = vi.hoisted(() => ({
  mockLookupAngelliraDriverByCpf: vi.fn(),
  mockLookupAngelliraPlate: vi.fn(),
  mockLookupAspxDriverByCpf: vi.fn(),
}));

vi.mock("../../infrastructure/angellira/angellira-client.js", () => ({
  lookupAngelliraDriverByCpf: mockLookupAngelliraDriverByCpf,
  lookupAngelliraPlate: mockLookupAngelliraPlate,
}));

vi.mock("../../infrastructure/aspx/aspx-directory.js", () => ({
  lookupAspxDriverByCpf: mockLookupAspxDriverByCpf,
}));

// Mock Angellira DB-cache lookups so tests are isolated from the real database.
// Without this mock, lookupCachedAngelliraValidation connects to the real Supabase
// and may return stale cached entries with expired validUntil, overriding the
// Angellira API mock and producing spurious INVALID overallStatus results.
vi.mock("../operator-admin/use-cases/angellira-cache.js", () => ({
  lookupCachedAngelliraValidation: vi.fn().mockResolvedValue({ found: false, reason: "NO_MATCH" }),
  lookupCachedAngelliraPlate: vi.fn().mockResolvedValue({ found: false, reason: "NO_MATCH" }),
  syncDriverAngelliraValidation: vi.fn().mockResolvedValue(undefined),
  syncVehicleAngelliraLookup: vi.fn().mockResolvedValue(undefined),
}));

const buildPayload = (overrides = {}) => ({
  cpf: "12345678901",
  phone: "71999999999",
  horsePlate: "ABC1D23",
  trailerPlate: "DEF4G56",
  trailerPlate2: "",
  vehicleType: "CARRETA",
  ...overrides,
});

describe("public lead validation", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetDriverValidationMetricsForTests();
    mockLookupAngelliraDriverByCpf.mockReset();
    mockLookupAngelliraPlate.mockReset();
    mockLookupAspxDriverByCpf.mockReset();

    vi.stubEnv("PUBLIC_LOAD_WHATSAPP_NUMBER", "71997254530");
  });

  it("marks a fully matched and valid registration as valid", async () => {
    mockLookupAngelliraDriverByCpf.mockResolvedValue({
      status: "FOUND",
      availability: "OK",
      found: true,
      displayName: "Motorista Angelira",
      validUntil: "2026-06-20",
      lastSeenAt: "2026-04-14T10:00:00.000Z",
      statusText: "Aprovado",
      driverDetails: {
        name: "Motorista Angelira",
        cpf: "12345678901",
        birthDate: "1985-03-14",
        rg: "1234567 SSP/BA",
        uf: "BA",
        fatherName: "Pai Exemplo",
        motherName: "Mae Exemplo",
        cnhNumber: "99887766554",
        cnhCategory: "E",
        cnhSecurityCode: "SEG-001",
        cnhValidity: "2028-09-12",
        phone: "71999999999",
        city: "Salvador",
        naturalness: "Salvador/BA",
      },
    });
    mockLookupAspxDriverByCpf.mockResolvedValue({
      status: "FOUND",
      availability: "OK",
      found: true,
      displayName: "Motorista ASPx",
    });
    mockLookupAngelliraPlate.mockResolvedValue({
      status: "FOUND",
      availability: "OK",
      found: true,
      validUntil: "2026-06-20",
      lastSeenAt: "2026-04-14T10:00:00.000Z",
    });

    const { validatePublicLeadPreRegistration } = await import("./public-lead-validation.js");
    const result = await validatePublicLeadPreRegistration({
      loadId: "load-1",
      payload: buildPayload(),
      candidateSubmittedAt: "2026-04-14T09:00:00.000Z",
      correlationId: "corr-public-validation-valid",
    });

    expect(result.summary).toMatchObject({
      overallStatus: "VALID",
      driver: {
        angelira: {
          status: "FOUND",
        },
        aspx: {
          status: "FOUND",
        },
      },
      vigency: {
        status: "VALID",
        validUntil: "2026-06-20",
      },
      support: {
        whatsappNumber: "5571997254530",
      },
    });
    // displayName is now preserved in stored summary for operator visibility
    expect(result.storedSummary.driver.angelira.displayName).toBe("Motorista Angelira");
    expect(result.storedSummary.driver.aspx.displayName).toBe("Motorista ASPx");
    // Full Angellira driver details must be preserved in the stored summary
    // so the operator can pre-fill the driver registration form (CPF, RG, UF,
    // parents, CNH, security code, CNH validity, phone, city, naturalness).
    expect(result.storedSummary.driver.angelira.details).toMatchObject({
      name: "Motorista Angelira",
      cpf: "12345678901",
      birthDate: "1985-03-14",
      rg: "1234567 SSP/BA",
      uf: "BA",
      fatherName: "Pai Exemplo",
      motherName: "Mae Exemplo",
      cnhNumber: "99887766554",
      cnhCategory: "E",
      cnhSecurityCode: "SEG-001",
      cnhValidity: "2028-09-12",
      phone: "71999999999",
      city: "Salvador",
      naturalness: "Salvador/BA",
    });
    expect(result.storedSummary.driver.angelira.statusText).toBe("Aprovado");
    expect(result.storedSummary.driver.angelira.lastSeenAt).toBe("2026-04-14T10:00:00.000Z");
  });

  it("marks registrations close to expiry as expiring", async () => {
    mockLookupAngelliraDriverByCpf.mockResolvedValue({
      status: "FOUND",
      availability: "OK",
      found: true,
      displayName: "Motorista Angelira",
      validUntil: "2026-05-01",
      lastSeenAt: "2026-04-14T10:00:00.000Z",
    });
    mockLookupAspxDriverByCpf.mockResolvedValue({
      status: "NOT_FOUND",
      availability: "OK",
      found: false,
      displayName: null,
    });
    mockLookupAngelliraPlate.mockResolvedValue({
      status: "FOUND",
      availability: "OK",
      found: true,
      validUntil: "2026-05-01",
      lastSeenAt: "2026-04-14T10:00:00.000Z",
    });

    const { validatePublicLeadPreRegistration } = await import("./public-lead-validation.js");
    const result = await validatePublicLeadPreRegistration({
      loadId: "load-2",
      payload: buildPayload(),
      candidateSubmittedAt: "2026-04-14T09:00:00.000Z",
      correlationId: "corr-public-validation-expiring",
    });

    expect(result.summary.overallStatus).toBe("EXPIRING");
    expect(result.summary.vigency).toMatchObject({
      status: "EXPIRING",
      daysUntilExpiry: 17,
    });
    expect(result.summary.warnings).toContain("Motorista nao encontrado no diretorio ASPx.");
  });

  it("marks registrations as invalid when the vigency is already expired", async () => {
    mockLookupAngelliraDriverByCpf.mockResolvedValue({
      status: "FOUND",
      availability: "OK",
      found: true,
      displayName: "Motorista Angelira",
      validUntil: "2026-04-10",
      lastSeenAt: "2026-04-14T10:00:00.000Z",
    });
    mockLookupAspxDriverByCpf.mockResolvedValue({
      status: "FOUND",
      availability: "OK",
      found: true,
      displayName: "Motorista ASPx",
    });
    mockLookupAngelliraPlate.mockResolvedValue({
      status: "FOUND",
      availability: "OK",
      found: true,
      validUntil: "2026-04-10",
      lastSeenAt: "2026-04-14T10:00:00.000Z",
    });

    const { validatePublicLeadPreRegistration } = await import("./public-lead-validation.js");
    const result = await validatePublicLeadPreRegistration({
      loadId: "load-3",
      payload: buildPayload(),
      candidateSubmittedAt: "2026-04-14T09:00:00.000Z",
      correlationId: "corr-public-validation-invalid",
    });

    expect(result.summary.overallStatus).toBe("INVALID");
    expect(result.summary.vigency.status).toBe("INVALID");
  });

  it("marks registrations missing from both directories as not found", async () => {
    mockLookupAngelliraDriverByCpf.mockResolvedValue({
      status: "NOT_FOUND",
      availability: "OK",
      found: false,
      displayName: null,
      validUntil: null,
      lastSeenAt: null,
    });
    mockLookupAspxDriverByCpf.mockResolvedValue({
      status: "NOT_FOUND",
      availability: "OK",
      found: false,
      displayName: null,
    });
    mockLookupAngelliraPlate.mockResolvedValue({
      status: "NOT_FOUND",
      availability: "OK",
      found: false,
      validUntil: null,
      lastSeenAt: null,
    });

    const { validatePublicLeadPreRegistration } = await import("./public-lead-validation.js");
    const result = await validatePublicLeadPreRegistration({
      loadId: "load-4",
      payload: buildPayload(),
      candidateSubmittedAt: "2026-04-14T09:00:00.000Z",
      correlationId: "corr-public-validation-not-found",
    });

    expect(result.summary.overallStatus).toBe("NOT_FOUND");
    expect(result.summary.warnings).toContain("Motorista nao encontrado no Angellira.");
    expect(result.summary.warnings).toContain("Motorista nao encontrado no diretorio ASPx.");
  });

  it("marks registrations as partial when only the ASPx directory finds the driver", async () => {
    mockLookupAngelliraDriverByCpf.mockResolvedValue({
      status: "NOT_FOUND",
      availability: "OK",
      found: false,
      displayName: null,
      validUntil: null,
      lastSeenAt: null,
    });
    mockLookupAspxDriverByCpf.mockResolvedValue({
      status: "FOUND",
      availability: "OK",
      found: true,
      displayName: "Motorista ASPx",
    });
    mockLookupAngelliraPlate.mockResolvedValue({
      status: "NOT_FOUND",
      availability: "OK",
      found: false,
      validUntil: null,
      lastSeenAt: null,
    });

    const { validatePublicLeadPreRegistration } = await import("./public-lead-validation.js");
    const result = await validatePublicLeadPreRegistration({
      loadId: "load-5",
      payload: buildPayload(),
      candidateSubmittedAt: "2026-04-14T09:00:00.000Z",
      correlationId: "corr-public-validation-partial",
    });

    expect(result.summary.overallStatus).toBe("PLATE_MISMATCH");
    expect(result.summary.driver.aspx.status).toBe("FOUND");
  });

  it("keeps the registration valid when only Angelira finds the driver and the plates match", async () => {
    mockLookupAngelliraDriverByCpf.mockResolvedValue({
      status: "FOUND",
      availability: "OK",
      found: true,
      displayName: "Motorista Angelira",
      validUntil: "2026-08-10",
      lastSeenAt: "2026-04-14T10:00:00.000Z",
    });
    mockLookupAspxDriverByCpf.mockResolvedValue({
      status: "NOT_FOUND",
      availability: "OK",
      found: false,
      displayName: null,
    });
    mockLookupAngelliraPlate.mockResolvedValue({
      status: "FOUND",
      availability: "OK",
      found: true,
      validUntil: "2026-08-10",
      lastSeenAt: "2026-04-14T10:00:00.000Z",
    });

    const { validatePublicLeadPreRegistration } = await import("./public-lead-validation.js");
    const result = await validatePublicLeadPreRegistration({
      loadId: "load-6",
      payload: buildPayload(),
      candidateSubmittedAt: "2026-04-14T09:00:00.000Z",
      correlationId: "corr-public-validation-angelira-only",
    });

    expect(result.summary.overallStatus).toBe("VALID");
    expect(result.summary.driver.angelira.status).toBe("FOUND");
    expect(result.summary.driver.aspx.status).toBe("NOT_FOUND");
  });

  it("records lightweight metrics for the completed validation flow", async () => {
    mockLookupAngelliraDriverByCpf.mockResolvedValue({
      status: "FOUND",
      availability: "OK",
      found: true,
      displayName: "Motorista Angelira",
      validUntil: "2026-08-10",
      lastSeenAt: "2026-04-14T10:00:00.000Z",
    });
    mockLookupAspxDriverByCpf.mockResolvedValue({
      status: "FOUND",
      availability: "OK",
      found: true,
      displayName: "Motorista ASPx",
    });
    mockLookupAngelliraPlate.mockResolvedValue({
      status: "FOUND",
      availability: "OK",
      found: true,
      validUntil: "2026-08-10",
      lastSeenAt: "2026-04-14T10:00:00.000Z",
    });

    const { validatePublicLeadPreRegistration } = await import("./public-lead-validation.js");
    await validatePublicLeadPreRegistration({
      loadId: "load-7",
      payload: buildPayload(),
      candidateSubmittedAt: "2026-04-14T09:00:00.000Z",
      correlationId: "corr-public-validation-metrics",
    });

    const snapshot = getDriverValidationMetricsSnapshot();

    expect(snapshot.validation.totalRuns).toBe(1);
    expect(snapshot.validation.statusCounts.VALID).toBe(1);
    expect(snapshot.validation.averageLatencyMs).not.toBeNull();
  });
});
