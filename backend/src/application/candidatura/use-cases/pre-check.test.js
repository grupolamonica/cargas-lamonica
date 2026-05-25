import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockValidatePublicLeadPreRegistration, mockPgClient } = vi.hoisted(() => {
  const mockPgClient = { query: vi.fn() };
  return {
    mockValidatePublicLeadPreRegistration: vi.fn(),
    mockPgClient,
  };
});

vi.mock("../../load-claims/public-lead-validation.js", () => ({
  validatePublicLeadPreRegistration: mockValidatePublicLeadPreRegistration,
}));

// Iter #7 — pre-check.js agora consulta o DB para duplicate detection.
// Default: nao retorna duplicates. Testes especificos override.
vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) => cb(mockPgClient),
}));

import { candidaturaPreCheck } from "./pre-check.js";
import { candidaturaPreCheckSchema } from "../../../interface/http/schemas/candidatura-schemas.js";

describe("candidaturaPreCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: duplicate-check query retorna 0 rows.
    mockPgClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("retorna pendencias vazias e 3 completos quando motorista + cavalo + 2 carretas estao validos com vigencia > 20 dias", async () => {
    // Vigencia 60 dias no futuro a partir de uma data fixa
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

    // Forca data fixa para previsibilidade do calculo de dias
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${submittedAt}T00:00:00.000Z`));

    try {
      const result = await candidaturaPreCheck({
        driverCpf: "12345678901",
        driverPhone: "71999999999",
        horsePlate: "ABC1D23",
        trailerPlates: ["DEF4G56", "GHI7H89"],
        correlationId: "test-corr-1",
      });

      expect(result.pendencias).toEqual([]);
      expect(result.completos).toHaveLength(3);
      expect(result.completos).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ plate: "ABC1D23", daysUntilExpiry: expect.any(Number) }),
          expect.objectContaining({ plate: "DEF4G56" }),
          expect.objectContaining({ plate: "GHI7H89" }),
        ]),
      );
      // Cada veiculo OK deve ter mais que 20 dias
      for (const completo of result.completos) {
        expect(completo.daysUntilExpiry).toBeGreaterThan(20);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("gera pendencia step B com reason NOT_FOUND quando o cavalo nao foi encontrado", async () => {
    mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
      summary: {
        driver: {
          angelira: { status: "FOUND", found: true },
          aspx: { status: "FOUND", found: true },
        },
        plates: [
          { field: "horsePlate", status: "NOT_FOUND", found: false, validUntil: null },
        ],
      },
    });

    const result = await candidaturaPreCheck({
      driverCpf: "12345678901",
      driverPhone: "71999999999",
      horsePlate: "ZZZ9Z99",
      trailerPlates: [],
      correlationId: "test-corr-2",
    });

    expect(result.pendencias).toHaveLength(1);
    expect(result.pendencias[0]).toMatchObject({
      step: "B",
      plate: "ZZZ9Z99",
      reason: "NOT_FOUND",
    });
    // Iter #10: label foca no CTA (cadastre veiculo), description traz
    // contexto da etapa "Cavalo" porque step B = cavalo.
    expect(result.pendencias[0].label).toContain("ZZZ9Z99");
    expect(result.pendencias[0].label.toLowerCase()).toContain("cadastre");
    expect(result.pendencias[0].description).toContain("cavalo");
    expect(result.pendencias[0].description).toContain("Cavalo");
    expect(result.completos).toEqual([]);
  });

  it("Iter #10 — NOT_FOUND no step D rotula como 'carreta' na descricao", async () => {
    mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
      summary: {
        driver: {
          angelira: { status: "FOUND", found: true },
          aspx: { status: "FOUND", found: true },
        },
        plates: [
          { field: "horsePlate", status: "FOUND", found: true, validUntil: "2027-01-01" },
          { field: "trailerPlate", status: "NOT_FOUND", found: false, validUntil: null },
        ],
      },
    });

    const result = await candidaturaPreCheck({
      driverCpf: "12345678901",
      driverPhone: "71999999999",
      horsePlate: "ABC1D23",
      trailerPlates: ["DEF4G56"],
      correlationId: "test-step-d",
    });

    const carretaPendency = result.pendencias.find((p) => p.plate === "DEF4G56");
    expect(carretaPendency).toMatchObject({
      step: "D",
      reason: "NOT_FOUND",
    });
    expect(carretaPendency.description).toContain("carreta");
    expect(carretaPendency.description).toContain("Carreta");
  });

  it("Iter #10 — DRIVER_NOT_FOUND retorna label + description orientando etapa A", async () => {
    mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
      summary: {
        driver: {
          angelira: { status: "NOT_FOUND", found: false },
          aspx: { status: "NOT_FOUND", found: false },
        },
        plates: [],
      },
    });

    const result = await candidaturaPreCheck({
      driverCpf: "99988877766",
      driverPhone: "71988888888",
      horsePlate: "ABC1D23",
      trailerPlates: [],
      correlationId: "test-driver-pending",
    });

    const driverPendency = result.pendencias.find((p) => p.reason === "DRIVER_NOT_FOUND");
    expect(driverPendency).toBeDefined();
    expect(driverPendency.step).toBe("A");
    expect(driverPendency.label).toMatch(/CPF/);
    expect(driverPendency.description).toContain("Dados do motorista");
    expect(driverPendency.description).toContain("ASPX");
  });

  it("gera pendencia step D com daysUntilExpiry=12 quando a carreta esta com CRLV vencendo", async () => {
    const submittedAt = "2026-05-12";
    const validUntil = "2026-05-24"; // 12 dias

    mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
      summary: {
        driver: {
          angelira: { status: "FOUND", found: true },
          aspx: { status: "FOUND", found: true },
        },
        plates: [
          // Cavalo OK com vigencia distante (60 dias) — deve ir para completos.
          { field: "horsePlate", status: "FOUND", found: true, validUntil: "2026-07-12" },
          // Carreta com 12 dias para vencer — deve gerar pendencia EXPIRING.
          { field: "trailerPlate", status: "FOUND", found: true, validUntil },
        ],
      },
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${submittedAt}T00:00:00.000Z`));

    try {
      const result = await candidaturaPreCheck({
        driverCpf: "12345678901",
        driverPhone: "71999999999",
        horsePlate: "ABC1D23",
        trailerPlates: ["DEF4G56"],
        correlationId: "test-corr-3",
      });

      const expiringPendency = result.pendencias.find((p) => p.plate === "DEF4G56");
      expect(expiringPendency).toMatchObject({
        step: "D",
        plate: "DEF4G56",
        reason: "EXPIRING",
        daysUntilExpiry: 12,
      });
      expect(expiringPendency.label).toContain("DEF4G56");
      expect(expiringPendency.label).toContain("12");

      // Cavalo deve continuar em completos
      expect(result.completos).toEqual(
        expect.arrayContaining([expect.objectContaining({ plate: "ABC1D23" })]),
      );
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
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.some((message) => /2/.test(message))).toBe(true);
    }
  });

  // NOTA (08-23): pre-check virou PUBLICO em Phase 7 (commit c5fa0bc) e o schema
  // agora ACEITA `cpf` no body. O teste antigo de anti-tampering (D-02) foi
  // removido — o motorista nao esta autenticado no Tela0 do wizard, entao o
  // CPF precisa vir do form. Validacao de tampering acontece no submit final
  // (candidaturaSubmitSchema) e nao mais no pre-check.

  it("rejeita schema quando placa esta fora do padrao", () => {
    const result = candidaturaPreCheckSchema.safeParse({
      cpf: "12345678901",
      horsePlate: "AB1234",
      trailerPlates: [],
    });

    expect(result.success).toBe(false);
  });

  it("aceita schema com placa Mercosul e placa antiga", () => {
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

  it("gera pendencia VEHICLE_TYPE_MISMATCH quando placa do cavalo retorna como carreta", async () => {
    // Motorista digitou a placa da CARRETA no campo do cavalo — Angellira
    // retorna FOUND, classificacao=carreta, mas o slot e horsePlate (esperado: cavalo).
    mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
      summary: {
        driver: {
          angelira: { status: "FOUND", found: true },
          aspx: { status: "FOUND", found: true },
        },
        plates: [
          {
            field: "horsePlate",
            status: "FOUND",
            found: true,
            validUntil: "2027-01-01",
            vehicleClassification: "carreta",
          },
        ],
      },
    });

    const result = await candidaturaPreCheck({
      driverCpf: "12345678901",
      driverPhone: "71999999999",
      horsePlate: "XYZ9X99",
      trailerPlates: [],
      correlationId: "test-mismatch-1",
    });

    expect(result.pendencias).toHaveLength(1);
    expect(result.pendencias[0]).toMatchObject({
      step: "B",
      plate: "XYZ9X99",
      reason: "VEHICLE_TYPE_MISMATCH",
      expectedType: "cavalo",
      actualType: "carreta",
    });
    expect(result.pendencias[0].label).toContain("XYZ9X99");
  });

  it("nao gera mismatch quando classification bate com o slot (cavalo no horsePlate)", async () => {
    const submittedAt = "2026-05-12";
    mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
      summary: {
        driver: {
          angelira: { status: "FOUND", found: true },
          aspx: { status: "FOUND", found: true },
        },
        plates: [
          {
            field: "horsePlate",
            status: "FOUND",
            found: true,
            validUntil: "2027-01-01",
            vehicleClassification: "cavalo",
          },
        ],
      },
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${submittedAt}T00:00:00.000Z`));

    try {
      const result = await candidaturaPreCheck({
        driverCpf: "12345678901",
        driverPhone: "71999999999",
        horsePlate: "ABC1D23",
        trailerPlates: [],
        correlationId: "test-mismatch-2",
      });

      expect(result.pendencias).toEqual([]);
      expect(result.completos).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("nao gera mismatch quando classification e null (Angellira nao retornou tipo)", async () => {
    const submittedAt = "2026-05-12";
    mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
      summary: {
        driver: {
          angelira: { status: "FOUND", found: true },
          aspx: { status: "FOUND", found: true },
        },
        plates: [
          {
            field: "horsePlate",
            status: "FOUND",
            found: true,
            validUntil: "2027-01-01",
            vehicleClassification: null,
          },
        ],
      },
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${submittedAt}T00:00:00.000Z`));

    try {
      const result = await candidaturaPreCheck({
        driverCpf: "12345678901",
        driverPhone: "71999999999",
        horsePlate: "ABC1D23",
        trailerPlates: [],
        correlationId: "test-mismatch-3",
      });

      // Sem classificacao confiavel, NAO bloqueia — fica em completos.
      expect(result.pendencias).toEqual([]);
      expect(result.completos).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Iter #7 — Duplicate detection ─────────────────────────────────────────

  describe("duplicate detection (iter #7)", () => {
    it("retorna pendencia DUPLICATE_PENDING_REGISTRATION quando ja existe cadastro pendente <30d com mesma (cpf, horsePlate)", async () => {
      mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
        summary: {
          driver: { angelira: { found: true }, aspx: { found: true } },
          plates: [
            { field: "horsePlate", status: "UNAVAILABLE" },
          ],
        },
      });

      const dupCreated = new Date(Date.now() - 5 * 24 * 3600 * 1000);
      mockPgClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: "existing-row-1",
            status: "em_analise",
            created_at: dupCreated,
            carga_id: "carga-X",
          },
        ],
        rowCount: 1,
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
      expect(dup.submittedAt).toBe(dupCreated.toISOString());
    });

    it("NAO emite pendencia quando duplicate-check retorna 0 rows", async () => {
      mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
        summary: {
          driver: { angelira: { found: true }, aspx: { found: true } },
          plates: [],
        },
      });
      mockPgClient.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await candidaturaPreCheck({
        driverCpf: "12345678901",
        horsePlate: "ABC1D23",
        trailerPlates: [],
        correlationId: "dup-2",
      });

      const dup = result.pendencias.find((p) => p.reason === "DUPLICATE_PENDING_REGISTRATION");
      expect(dup).toBeUndefined();
    });

    it("falha de DB no duplicate-check NAO bloqueia o pre-check (log + ausencia da pendencia)", async () => {
      mockValidatePublicLeadPreRegistration.mockResolvedValueOnce({
        summary: {
          driver: { angelira: { found: true }, aspx: { found: true } },
          plates: [],
        },
      });
      mockPgClient.query.mockRejectedValueOnce(new Error("pg down"));

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
