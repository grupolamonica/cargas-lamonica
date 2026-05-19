import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConflictError, NotFoundError } from "../../../domain/load-claims/errors.js";

// ─── Shared mock client ───────────────────────────────────────────────────────

let mockQueryImpl = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });

const mockClient = {
  query: (...args) => mockQueryImpl(...args),
};

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgTransaction: vi.fn(async (callback) => callback(mockClient)),
  withPgClient: vi.fn(async (callback) => callback(mockClient)),
}));

vi.mock("../../../infrastructure/security-audit.js", () => ({
  insertSecurityAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

const { mockFindCargoById, mockWriteCargo } = vi.hoisted(() => ({
  mockFindCargoById: vi.fn(),
  mockWriteCargo: vi.fn(),
}));

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findCargoById: mockFindCargoById,
    writeCargo: mockWriteCargo,
  };
});

// ─── Imports after mocks ─────────────────────────────────────────────────────

const { deleteOperatorCargo } = await import("./delete-cargo.js");
const { createOperatorCargo } = await import("./create-cargo.js");
const { updateOperatorCargo } = await import("./update-cargo.js");
const { deleteOperatorCliente } = await import("./delete-cliente.js");
const { insertSecurityAuditEvent } = await import("../../../infrastructure/security-audit.js");

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OPERATOR_ID = "op-aaaaaaaa-0000-0000-0000-000000000001";
const CARGO_ID = "cg-aaaaaaaa-0000-0000-0000-000000000001";
const CLIENTE_ID = "cl-aaaaaaaa-0000-0000-0000-000000000001";
const CORRELATION_ID = "test-correlation-id";

const buildCargo = (overrides = {}) => ({
  id: CARGO_ID,
  status: "OPEN",
  created_by: OPERATOR_ID,
  origem: "Salvador / BA",
  destino: "Campinas / SP",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryImpl = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── delete-cargo.js ─────────────────────────────────────────────────────────

describe("deleteOperatorCargo", () => {
  it("throws NotFoundError when cargo does not exist", async () => {
    mockFindCargoById.mockResolvedValue(null);

    await expect(
      deleteOperatorCargo({
        cargoId: CARGO_ID,
        operatorId: OPERATOR_ID,
        operatorAccessLevel: "advanced",
        requestIp: "1.2.3.4",
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("throws ConflictError when cargo status is not manual (BOOKED)", async () => {
    mockFindCargoById.mockResolvedValue(buildCargo({ status: "BOOKED" }));

    await expect(
      deleteOperatorCargo({
        cargoId: CARGO_ID,
        operatorId: OPERATOR_ID,
        operatorAccessLevel: "advanced",
        requestIp: "1.2.3.4",
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("deletes OPEN cargo and returns 200 with audit", async () => {
    mockFindCargoById.mockResolvedValue(buildCargo({ status: "OPEN" }));

    const result = await deleteOperatorCargo({
      cargoId: CARGO_ID,
      operatorId: OPERATOR_ID,
      operatorAccessLevel: "advanced",
      requestIp: "1.2.3.4",
      correlationId: CORRELATION_ID,
    });

    expect(result.statusCode).toBe(200);
    expect(result.payload.ok).toBe(true);
    expect(insertSecurityAuditEvent).toHaveBeenCalledOnce();
    expect(insertSecurityAuditEvent).toHaveBeenCalledWith(
      mockClient,
      expect.objectContaining({
        eventType: "operator.cargo.deleted",
        actorUserId: OPERATOR_ID,
        resourceId: CARGO_ID,
        action: "delete",
        outcome: "success",
      }),
    );
  });

  it("deletes DRAFT cargo and returns 200", async () => {
    mockFindCargoById.mockResolvedValue(buildCargo({ status: "DRAFT" }));

    const result = await deleteOperatorCargo({
      cargoId: CARGO_ID,
      operatorId: OPERATOR_ID,
      operatorAccessLevel: "advanced",
      requestIp: "1.2.3.4",
      correlationId: CORRELATION_ID,
    });

    expect(result.statusCode).toBe(200);
  });

  it("echoes correlationId in meta", async () => {
    mockFindCargoById.mockResolvedValue(buildCargo({ status: "DRAFT" }));

    const result = await deleteOperatorCargo({
      cargoId: CARGO_ID,
      operatorId: OPERATOR_ID,
      operatorAccessLevel: "advanced",
      requestIp: null,
      correlationId: CORRELATION_ID,
    });

    expect(result.payload.meta.correlationId).toBe(CORRELATION_ID);
  });
});

// ─── create-cargo.js ─────────────────────────────────────────────────────────

describe("createOperatorCargo", () => {
  it("delegates to writeCargo and returns 201", async () => {
    mockWriteCargo.mockResolvedValue({ warnings: [] });

    const result = await createOperatorCargo({
      operatorId: OPERATOR_ID,
      payload: { origem: "Salvador / BA", destino: "Campinas / SP" },
      requestIp: "1.2.3.4",
      correlationId: CORRELATION_ID,
    });

    expect(result.statusCode).toBe(201);
    expect(result.payload.ok).toBe(true);
    expect(mockWriteCargo).toHaveBeenCalledOnce();
  });

  it("forwards warnings from writeCargo", async () => {
    const warnings = ["Some column missing"];
    mockWriteCargo.mockResolvedValue({ warnings });

    const result = await createOperatorCargo({
      operatorId: OPERATOR_ID,
      payload: {},
      requestIp: "1.2.3.4",
      correlationId: CORRELATION_ID,
    });

    expect(result.payload.warnings).toEqual(warnings);
  });

  it("propagates writeCargo errors", async () => {
    mockWriteCargo.mockRejectedValue(new Error("DB_ERROR"));

    await expect(
      createOperatorCargo({
        operatorId: OPERATOR_ID,
        payload: {},
        requestIp: "1.2.3.4",
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toThrow("DB_ERROR");
  });
});

// ─── update-cargo.js ─────────────────────────────────────────────────────────

describe("updateOperatorCargo", () => {
  it("delegates to writeCargo and returns 200", async () => {
    mockWriteCargo.mockResolvedValue({ warnings: [] });

    const result = await updateOperatorCargo({
      cargoId: CARGO_ID,
      operatorId: OPERATOR_ID,
      payload: {},
      requestIp: "1.2.3.4",
      correlationId: CORRELATION_ID,
    });

    expect(result.statusCode).toBe(200);
    expect(result.payload.ok).toBe(true);
    expect(mockWriteCargo).toHaveBeenCalledWith(
      mockClient,
      expect.objectContaining({ cargoId: CARGO_ID, operatorId: OPERATOR_ID }),
    );
  });
});

// ─── delete-cliente.js ───────────────────────────────────────────────────────

describe("deleteOperatorCliente", () => {
  it("throws ConflictError when cliente has linked cargas", async () => {
    mockQueryImpl = vi.fn()
      .mockResolvedValueOnce({ rows: [{ load_count: 3 }], rowCount: 1 });

    await expect(
      deleteOperatorCliente({
        clienteId: CLIENTE_ID,
        operatorId: OPERATOR_ID,
        requestIp: "1.2.3.4",
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("throws NotFoundError when DELETE matches zero rows", async () => {
    mockQueryImpl = vi.fn()
      .mockResolvedValueOnce({ rows: [{ load_count: 0 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(
      deleteOperatorCliente({
        clienteId: CLIENTE_ID,
        operatorId: OPERATOR_ID,
        requestIp: "1.2.3.4",
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("deletes cliente and returns 200 with audit", async () => {
    mockQueryImpl = vi.fn()
      .mockResolvedValueOnce({ rows: [{ load_count: 0 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await deleteOperatorCliente({
      clienteId: CLIENTE_ID,
      operatorId: OPERATOR_ID,
      requestIp: "1.2.3.4",
      correlationId: CORRELATION_ID,
    });

    expect(result.statusCode).toBe(200);
    expect(result.payload.ok).toBe(true);
    expect(insertSecurityAuditEvent).toHaveBeenCalledWith(
      mockClient,
      expect.objectContaining({
        eventType: "operator.cliente.deleted",
        actorUserId: OPERATOR_ID,
        resourceId: CLIENTE_ID,
        action: "delete",
        outcome: "success",
      }),
    );
  });

  it("ConflictError carries CLIENTE_HAS_CARGAS code", async () => {
    mockQueryImpl = vi.fn()
      .mockResolvedValueOnce({ rows: [{ load_count: 1 }], rowCount: 1 });

    await expect(
      deleteOperatorCliente({
        clienteId: CLIENTE_ID,
        operatorId: OPERATOR_ID,
        requestIp: null,
        correlationId: CORRELATION_ID,
      }),
    ).rejects.toMatchObject({ details: { code: "CLIENTE_HAS_CARGAS" } });
  });
});
