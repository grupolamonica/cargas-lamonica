import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockValidatePublicLeadPreRegistration, mockPgClient, canned } = vi.hoisted(() => {
  const mockPgClient = { query: vi.fn() };
  return {
    mockValidatePublicLeadPreRegistration: vi.fn(),
    mockPgClient,
    // Estado do duplicate-check (iter #7). O RF001/selfie foram revertidos: o
    // pre-check nao consulta mais cadastro local — so o duplicate-check bate no DB.
    canned: { duplicate: null, duplicateError: false },
  };
});

vi.mock("../../load-claims/public-lead-validation.js", () => ({
  validatePublicLeadPreRegistration: mockValidatePublicLeadPreRegistration,
}));

// pre-check.js consulta o DB só no duplicate-check (iter #7).
vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) => cb(mockPgClient),
}));

import { candidaturaPreCheck } from "./pre-check.js";
import { candidaturaPreCheckSchema } from "../../../interface/http/schemas/candidatura-schemas.js";

describe("candidaturaPreCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canned.duplicate = null;
    canned.duplicateError = false;
    mockPgClient.query.mockImplementation(async () => {
      if (canned.duplicateError) throw new Error("pg down");
      return canned.duplicate ? { rows: [canned.duplicate], rowCount: 1 } : { rows: [], rowCount: 0 };
    });
  });

  it("motorista + placas encontrados e vigentes (>20d) → sem pendencias, tudo em completos", async () => {
    const submittedAt = "2026-05-12";
    const validUntil = "2026-07-12"; // ~61 dias

    mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
      summary: {
        driver: {
          angelira: { status: "FOUND", found: true },
          aspx: { status: "FOUND", found: true },
        },
        plates: [
          { field: "horsePlate", status: "FOUND", found: true, validUntil },
          { field: "trailerPlate", status: "FOUND", found: true, validUntil },
          { field: "trailerPlate2", status: "FOUND", found: true, validUntil },
        ],
      },
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${submittedAt}T00:00:00.000Z`));
    try {
      const result = await candidaturaPreCheck({
        driverCpf: "12345678901",
        horsePlate: "ABC1D23",
        trailerPlates: ["DEF4G56", "GHI7H89"],
        correlationId: "ok-1",
      });
      expect(result.pendencias).toEqual([]);
      expect(result.completos).toHaveLength(3);
      for (const completo of result.completos) {
        expect(completo.daysUntilExpiry).toBeGreaterThan(20);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("REVERSAO: motorista no Angellira SEM cadastro local → passa direto (sem pendencia de motorista)", async () => {
    mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
      summary: {
        driver: { angelira: { found: true }, aspx: { found: false } },
        plates: [{ field: "horsePlate", status: "FOUND", found: true, validUntil: "2030-01-01" }],
      },
    });
    const result = await candidaturaPreCheck({
      driverCpf: "12345678901",
      horsePlate: "ABC1D23",
      trailerPlates: [],
      correlationId: "revert-A",
    });
    // Sem RF001/selfie: nada de LOCAL_REGISTRATION_REQUIRED / SELFIE_REQUIRED / step A.
    expect(result.pendencias.find((p) => p.step === "A")).toBeUndefined();
    expect(result.pendencias.find((p) => p.reason === "LOCAL_REGISTRATION_REQUIRED")).toBeUndefined();
    expect(result.pendencias.find((p) => p.reason === "SELFIE_REQUIRED")).toBeUndefined();
    // Placa vigente vira completo (nao exige CRLV).
    expect(result.completos).toEqual(expect.arrayContaining([expect.objectContaining({ plate: "ABC1D23" })]));
  });

  it("DRIVER_NOT_FOUND: nao encontrado no Angellira NEM no ASPX → pendencia step A", async () => {
    mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
      summary: {
        driver: { angelira: { status: "NOT_FOUND", found: false }, aspx: { status: "NOT_FOUND", found: false } },
        plates: [],
      },
    });
    const result = await candidaturaPreCheck({
      driverCpf: "99988877766",
      horsePlate: "ABC1D23",
      trailerPlates: [],
      correlationId: "notfound",
    });
    const p = result.pendencias.find((x) => x.reason === "DRIVER_NOT_FOUND");
    expect(p).toBeDefined();
    expect(p.step).toBe("A");
    expect(p.label).toMatch(/CPF/);
    expect(p.description).toContain("Dados do motorista");
  });

  it("placa do cavalo NOT_FOUND → pendencia step B", async () => {
    mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
      summary: {
        driver: { angelira: { found: true }, aspx: { found: true } },
        plates: [{ field: "horsePlate", status: "NOT_FOUND", found: false, validUntil: null }],
      },
    });
    const result = await candidaturaPreCheck({
      driverCpf: "12345678901",
      horsePlate: "ZZZ9Z99",
      trailerPlates: [],
      correlationId: "plate-notfound",
    });
    expect(result.pendencias).toHaveLength(1);
    expect(result.pendencias[0]).toMatchObject({ step: "B", plate: "ZZZ9Z99", reason: "NOT_FOUND" });
    expect(result.pendencias[0].description).toContain("Cavalo");
  });

  it("carreta com CRLV vencendo (12 dias) → pendencia EXPIRING; cavalo vigente vai p/ completos", async () => {
    const submittedAt = "2026-05-12";
    mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
      summary: {
        driver: { angelira: { found: true }, aspx: { found: true } },
        plates: [
          { field: "horsePlate", status: "FOUND", found: true, validUntil: "2026-07-12" },
          { field: "trailerPlate", status: "FOUND", found: true, validUntil: "2026-05-24" }, // 12 dias
        ],
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${submittedAt}T00:00:00.000Z`));
    try {
      const result = await candidaturaPreCheck({
        driverCpf: "12345678901",
        horsePlate: "ABC1D23",
        trailerPlates: ["DEF4G56"],
        correlationId: "expiring",
      });
      const exp = result.pendencias.find((p) => p.plate === "DEF4G56");
      expect(exp).toMatchObject({ step: "D", reason: "EXPIRING", daysUntilExpiry: 12 });
      expect(result.completos).toEqual(expect.arrayContaining([expect.objectContaining({ plate: "ABC1D23" })]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("VEHICLE_TYPE_MISMATCH quando a placa do cavalo retorna classificada como carreta", async () => {
    mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
      summary: {
        driver: { angelira: { found: true }, aspx: { found: true } },
        plates: [
          { field: "horsePlate", status: "FOUND", found: true, validUntil: "2027-01-01", vehicleClassification: "carreta" },
        ],
      },
    });
    const result = await candidaturaPreCheck({
      driverCpf: "12345678901",
      horsePlate: "XYZ9X99",
      trailerPlates: [],
      correlationId: "mismatch",
    });
    expect(result.pendencias[0]).toMatchObject({
      step: "B",
      plate: "XYZ9X99",
      reason: "VEHICLE_TYPE_MISMATCH",
      expectedType: "cavalo",
      actualType: "carreta",
    });
  });

  it("nao gera mismatch quando a classificacao e null (Angellira nao retornou tipo) → completo", async () => {
    const submittedAt = "2026-05-12";
    mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
      summary: {
        driver: { angelira: { found: true }, aspx: { found: true } },
        plates: [
          { field: "horsePlate", status: "FOUND", found: true, validUntil: "2027-01-01", vehicleClassification: null },
        ],
      },
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${submittedAt}T00:00:00.000Z`));
    try {
      const result = await candidaturaPreCheck({
        driverCpf: "12345678901",
        horsePlate: "ABC1D23",
        trailerPlates: [],
        correlationId: "mismatch-null",
      });
      expect(result.pendencias).toEqual([]);
      expect(result.completos).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejeita schema quando recebe 3 ou mais trailerPlates (D-08)", () => {
    const result = candidaturaPreCheckSchema.safeParse({
      horsePlate: "ABC1D23",
      trailerPlates: ["DEF4G56", "GHI7H89", "JKL2L34"],
    });
    expect(result.success).toBe(false);
  });

  it("aceita schema com placa Mercosul e placa antiga (normaliza)", () => {
    const result = candidaturaPreCheckSchema.safeParse({
      cpf: "12345678901",
      horsePlate: "abc1d23",
      trailerPlates: ["def4567"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.horsePlate).toBe("ABC1D23");
      expect(result.data.trailerPlates[0]).toBe("DEF4567");
    }
  });

  // ── Iter #7 — Duplicate detection ─────────────────────────────────────────
  describe("duplicate detection (iter #7)", () => {
    it("retorna DUPLICATE_PENDING_REGISTRATION quando ja existe cadastro pendente <30d (cpf, horsePlate)", async () => {
      const dupCreated = new Date();
      canned.duplicate = { id: "existing-row-1", status: "em_analise", created_at: dupCreated, carga_id: "c-1" };
      mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
        summary: { driver: { angelira: { found: true }, aspx: { found: true } }, plates: [{ field: "horsePlate", status: "UNAVAILABLE" }] },
      });
      const result = await candidaturaPreCheck({
        driverCpf: "12345678901",
        horsePlate: "ABC1D23",
        trailerPlates: [],
        correlationId: "dup-1",
      });
      const dup = result.pendencias.find((p) => p.reason === "DUPLICATE_PENDING_REGISTRATION");
      expect(dup).toBeDefined();
      expect(dup.allowSkipWizard).toBe(true);
      expect(dup.pendingRegistrationId).toBe("existing-row-1");
      expect(dup.status).toBe("em_analise");
    });

    it("NAO emite pendencia quando duplicate-check retorna 0 rows", async () => {
      mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
        summary: { driver: { angelira: { found: true }, aspx: { found: true } }, plates: [] },
      });
      const result = await candidaturaPreCheck({
        driverCpf: "12345678901",
        horsePlate: "ABC1D23",
        trailerPlates: [],
        correlationId: "dup-2",
      });
      expect(result.pendencias.find((p) => p.reason === "DUPLICATE_PENDING_REGISTRATION")).toBeUndefined();
    });

    it("falha de DB no duplicate-check NAO bloqueia o pre-check (log + ausencia da pendencia)", async () => {
      canned.duplicateError = true;
      mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
        summary: { driver: { angelira: { found: true }, aspx: { found: true } }, plates: [] },
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = await candidaturaPreCheck({
        driverCpf: "12345678901",
        horsePlate: "ABC1D23",
        trailerPlates: [],
        correlationId: "dup-3",
      });
      expect(result.pendencias.find((p) => p.reason === "DUPLICATE_PENDING_REGISTRATION")).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
