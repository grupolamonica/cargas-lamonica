import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted: mocks declarados fora do `vi.mock` factory para garantir que
// as referencias estejam disponiveis no momento do import. Padrao usado em
// pre-check.test.js para mock de infra.
const {
  mockWithPgClient,
  mockClientQuery,
  mockLookupAngelliraDriverByCpf,
  mockLookupAngelliraPlate,
  mockLookupAspxDriverByCpf,
  mockLogStructuredEvent,
} = vi.hoisted(() => {
  const mockClientQuery = vi.fn();
  return {
    mockClientQuery,
    mockWithPgClient: vi.fn(async (callback) => callback({ query: mockClientQuery })),
    mockLookupAngelliraDriverByCpf: vi.fn(),
    mockLookupAngelliraPlate: vi.fn(),
    mockLookupAspxDriverByCpf: vi.fn(),
    mockLogStructuredEvent: vi.fn(),
  };
});

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: mockWithPgClient,
}));

vi.mock("../../../infrastructure/angellira/angellira-client.js", () => ({
  lookupAngelliraDriverByCpf: mockLookupAngelliraDriverByCpf,
  lookupAngelliraPlate: mockLookupAngelliraPlate,
}));

vi.mock("../../../infrastructure/aspx/aspx-directory.js", () => ({
  lookupAspxDriverByCpf: mockLookupAspxDriverByCpf,
}));

vi.mock("../../../infrastructure/security-log.js", () => ({
  logStructuredEvent: mockLogStructuredEvent,
}));

const { verifyDocument } = await import("./verify-document.js");

const NOT_FOUND_RESULT = { availability: "OK", status: "NOT_FOUND", found: false };
const UNAVAILABLE_RESULT = {
  availability: "UNAVAILABLE",
  status: "UNAVAILABLE",
  found: false,
};

function angelliraFound({ statusText = "ATIVO" } = {}) {
  return {
    availability: "OK",
    status: "FOUND",
    found: true,
    displayName: "FULANO DE TAL",
    statusText,
  };
}

function aspxFound() {
  return {
    availability: "OK",
    status: "FOUND",
    found: true,
    displayName: "FULANO ASPX",
  };
}

describe("verifyDocument", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientQuery.mockResolvedValue({ rows: [] });
    mockLookupAngelliraDriverByCpf.mockResolvedValue(NOT_FOUND_RESULT);
    mockLookupAngelliraPlate.mockResolvedValue(NOT_FOUND_RESULT);
    mockLookupAspxDriverByCpf.mockResolvedValue(NOT_FOUND_RESULT);
  });

  describe("type=cpf (motorista)", () => {
    it("retorna externalRegistration={source:angellira} quando AngelLira encontra mas DB local nao tem", async () => {
      mockClientQuery.mockResolvedValueOnce({ rows: [] }); // findLatestCandidaturaByCpf
      mockLookupAngelliraDriverByCpf.mockResolvedValueOnce(angelliraFound());

      const result = await verifyDocument({ type: "cpf", value: "12345678901" });

      expect(result.exists).toBe(true);
      expect(result.status).toBe("completo");
      expect(result.lastCandidatura).toBeNull();
      expect(result.externalRegistration).toEqual({
        source: "angellira",
        situacao: "ATIVO",
      });
    });

    it("retorna source=both quando AngelLira E ASPX encontram", async () => {
      mockClientQuery.mockResolvedValueOnce({ rows: [] });
      mockLookupAngelliraDriverByCpf.mockResolvedValueOnce(angelliraFound());
      mockLookupAspxDriverByCpf.mockResolvedValueOnce(aspxFound());

      const result = await verifyDocument({ type: "cpf", value: "12345678901" });

      expect(result.exists).toBe(true);
      expect(result.externalRegistration).toEqual({
        source: "both",
        situacao: "ATIVO",
      });
    });

    it("degrada para DB-only quando AngelLira timeout (UNAVAILABLE) e ASPX nao tem", async () => {
      mockClientQuery.mockResolvedValueOnce({ rows: [] });
      mockLookupAngelliraDriverByCpf.mockResolvedValueOnce(UNAVAILABLE_RESULT);
      mockLookupAspxDriverByCpf.mockResolvedValueOnce(NOT_FOUND_RESULT);

      const result = await verifyDocument({ type: "cpf", value: "12345678901" });

      expect(result.exists).toBe(false);
      expect(result.status).toBeNull();
      expect(result.lastCandidatura).toBeNull();
      // externalRegistration nao foi enviado quando nada externo casou.
      expect(result.externalRegistration).toBeUndefined();
    });

    it("retorna lastCandidatura + externalRegistration quando ambos existem", async () => {
      mockClientQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "row-1",
            status: "pendente",
            created_at: "2026-05-01T10:00:00Z",
            updated_at: "2026-05-02T10:00:00Z",
            dados: { protocolo: "CAD-2026-00001" },
          },
        ],
      });
      mockLookupAngelliraDriverByCpf.mockResolvedValueOnce(angelliraFound({ statusText: "EM RENOVACAO" }));

      const result = await verifyDocument({ type: "cpf", value: "12345678901" });

      expect(result.exists).toBe(true);
      expect(result.status).toBe("pendente");
      expect(result.lastCandidatura).toMatchObject({
        protocolo: "CAD-2026-00001",
      });
      expect(result.externalRegistration).toEqual({
        source: "angellira",
        situacao: "EM RENOVACAO",
      });
    });

    it("rejeita CPF invalido (defesa em profundidade) sem chamar externo", async () => {
      const result = await verifyDocument({ type: "cpf", value: "123" });
      expect(result.exists).toBe(false);
      expect(mockLookupAngelliraDriverByCpf).not.toHaveBeenCalled();
      expect(mockLookupAspxDriverByCpf).not.toHaveBeenCalled();
    });
  });

  describe("type=ownerCpf", () => {
    it("consulta findLatestCandidaturaByOwnerDoc + AngelLira + ASPX", async () => {
      mockClientQuery.mockResolvedValueOnce({ rows: [] });
      mockLookupAngelliraDriverByCpf.mockResolvedValueOnce(angelliraFound());

      const result = await verifyDocument({
        type: "ownerCpf",
        value: "98765432100",
      });

      expect(result.exists).toBe(true);
      expect(result.externalRegistration?.source).toBe("angellira");
      // Sanity check: a query rodou contra dados->'cavalo'->'owner' etc.
      const lastSqlCall = mockClientQuery.mock.calls.at(-1);
      expect(lastSqlCall?.[0]).toMatch(/cavalo'->'owner'->>'doc'/);
    });

    it("retorna apenas externalRegistration quando AngelLira encontra mas DB nao", async () => {
      mockClientQuery.mockResolvedValueOnce({ rows: [] });
      mockLookupAngelliraDriverByCpf.mockResolvedValueOnce(angelliraFound());

      const result = await verifyDocument({
        type: "ownerCpf",
        value: "98765432100",
      });

      expect(result.lastCandidatura).toBeNull();
      expect(result.externalRegistration?.source).toBe("angellira");
    });
  });

  describe("type=ownerCnpj", () => {
    it("consulta DB local + emite warning TODO sem chamar AngelLira/ASPX", async () => {
      mockClientQuery.mockResolvedValueOnce({ rows: [] });

      const result = await verifyDocument({
        type: "ownerCnpj",
        value: "12345678000199",
      });

      expect(result.exists).toBe(false);
      expect(mockLookupAngelliraDriverByCpf).not.toHaveBeenCalled();
      expect(mockLookupAspxDriverByCpf).not.toHaveBeenCalled();
      expect(mockLogStructuredEvent).toHaveBeenCalledWith(
        "info",
        "candidatura.verify-document.cnpj.external_skipped",
        expect.objectContaining({
          reason: "EXTERNAL_CNPJ_LOOKUP_NOT_IMPLEMENTED",
        }),
      );
    });

    it("retorna lastCandidatura quando CNPJ aparece como owner de carreta no DB", async () => {
      mockClientQuery.mockResolvedValueOnce({
        rows: [
          {
            id: "row-2",
            status: "aprovado",
            created_at: "2026-04-01T10:00:00Z",
            updated_at: "2026-04-02T10:00:00Z",
            dados: { protocolo: "CAD-2026-00099" },
          },
        ],
      });

      const result = await verifyDocument({
        type: "ownerCnpj",
        value: "12345678000199",
      });

      expect(result.exists).toBe(true);
      expect(result.status).toBe("completo");
      expect(result.lastCandidatura?.protocolo).toBe("CAD-2026-00099");
      expect(result.externalRegistration).toBeUndefined();
    });
  });

  describe("type=horsePlate", () => {
    it("consulta AngelLira plate e retorna externalRegistration quando encontra", async () => {
      mockClientQuery.mockResolvedValue({ rows: [] }); // candidatura + vigency vazios
      mockLookupAngelliraPlate.mockResolvedValueOnce(angelliraFound({ statusText: "ATIVO" }));

      const result = await verifyDocument({ type: "horsePlate", value: "ABC1D23" });

      expect(result.exists).toBe(true);
      expect(result.externalRegistration).toEqual({
        source: "angellira",
        situacao: "ATIVO",
      });
    });

    it("degrada quando AngelLira plate UNAVAILABLE", async () => {
      mockClientQuery.mockResolvedValue({ rows: [] });
      mockLookupAngelliraPlate.mockResolvedValueOnce(UNAVAILABLE_RESULT);

      const result = await verifyDocument({ type: "horsePlate", value: "ABC1D23" });

      expect(result.exists).toBe(false);
    });
  });

  describe("resiliencia: errors thrown pelos infra clients", () => {
    it("captura throw de lookupAngelliraDriverByCpf e nao propaga", async () => {
      mockClientQuery.mockResolvedValueOnce({ rows: [] });
      mockLookupAngelliraDriverByCpf.mockRejectedValueOnce(new Error("ECONNRESET"));
      mockLookupAspxDriverByCpf.mockResolvedValueOnce(NOT_FOUND_RESULT);

      const result = await verifyDocument({ type: "cpf", value: "12345678901" });

      expect(result.exists).toBe(false);
      expect(mockLogStructuredEvent).toHaveBeenCalledWith(
        "warn",
        "candidatura.verify-document.angellira.error",
        expect.any(Object),
      );
    });

    it("captura throw de lookupAspxDriverByCpf e nao propaga", async () => {
      mockClientQuery.mockResolvedValueOnce({ rows: [] });
      mockLookupAngelliraDriverByCpf.mockResolvedValueOnce(NOT_FOUND_RESULT);
      mockLookupAspxDriverByCpf.mockRejectedValueOnce(new Error("ASPX_DOWN"));

      const result = await verifyDocument({ type: "cpf", value: "12345678901" });

      expect(result.exists).toBe(false);
      expect(mockLogStructuredEvent).toHaveBeenCalledWith(
        "warn",
        "candidatura.verify-document.aspx.error",
        expect.any(Object),
      );
    });
  });
});
