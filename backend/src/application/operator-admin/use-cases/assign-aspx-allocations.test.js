import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async () => {
    throw new Error("withPgClient não deveria ser chamado (use deps.listByLhs)");
  },
}));
vi.mock("../../../infrastructure/security-audit.js", () => ({
  recordSecurityAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

const { assignAspxAllocations } = await import("./assign-aspx-allocations.js");
const { SpxSidecarUnavailable } = await import("../../../infrastructure/spx/spx-allocation-client.js");
const { recordSecurityAuditEvent } = await import("../../../infrastructure/security-audit.js");

const CARGAS = [
  { sheet_lh: "LH1", motorista: "João Silva", cavalo: "ABC1234", carreta: "XYZ9876" },
  { sheet_lh: "LH2", motorista: "Maria Souza", cavalo: "DEF5678", carreta: "" },
];

function baseDeps(assignSpy) {
  return {
    listByLhs: async () => CARGAS,
    fetchTrips: async () => [
      { trip_id: 11, trip_number: "LH1" },
      { trip_id: 12, trip_number: "LH2" },
    ],
    fetchDrivers: async () => [
      { driver_id: 91, name: "JOAO SILVA" },
      { driver_id: 92, name: "Maria Souza" },
    ],
    fetchIndex: async () => ({ byNumber: new Map(), truncated: false, partial: false }),
    assignTrip: assignSpy,
  };
}

afterEach(() => {
  delete process.env.SPX_ALLOC_WRITE_ENABLED;
  vi.clearAllMocks();
});

describe("assignAspxAllocations", () => {
  it("rejeita quando nenhum LH é selecionado", async () => {
    await expect(assignAspxAllocations({ lhs: [], operatorId: "op" })).rejects.toThrow();
  });

  it("reassign: LH fora da fila mas no índice → usa trip_id do índice (trocar motorista)", async () => {
    const spy = vi.fn().mockResolvedValue({ dry_run: true });
    const res = await assignAspxAllocations({
      lhs: ["LH1"],
      operatorId: "op",
      deps: {
        ...baseDeps(spy),
        fetchTrips: async () => [], // LH1 NÃO está atribuível (já tem motorista no ASPX)
        fetchIndex: async () => ({
          byNumber: new Map([["LH1", { tripId: 777, status: 5, statusName: "Assigned", driver: "OUTRO" }]]),
          truncated: false,
          partial: false,
        }),
      },
    });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ tripId: 777, driverIds: [91] }));
    expect(res.payload.results[0].reassign).toBe(true);
    expect(res.payload.results[0].state).toBe("dry_run");
  });

  it("kill switch off → força dry_run (não envia ao ASPX)", async () => {
    const spy = vi.fn().mockResolvedValue({ dry_run: true });
    const res = await assignAspxAllocations({
      lhs: ["LH1", "LH2"],
      operatorId: "op",
      correlationId: "c1",
      deps: baseDeps(spy),
    });

    expect(res.payload.writeEnabled).toBe(false);
    expect(res.payload.dryRun).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(res.payload.summary.dryRun).toBe(2);
    expect(res.payload.summary.assigned).toBe(0);
    // veículo: LH2 só tem cavalo (carreta vazia não vai)
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ tripId: 12, driverIds: [92], vehiclePlates: ["DEF5678"] }));
    expect(recordSecurityAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("kill switch on → envia de verdade (dryRun false), estado 'assigned'", async () => {
    process.env.SPX_ALLOC_WRITE_ENABLED = "true";
    const spy = vi.fn().mockResolvedValue({ ok: true });
    const res = await assignAspxAllocations({
      lhs: ["LH1"],
      operatorId: "op",
      deps: baseDeps(spy),
    });
    expect(res.payload.writeEnabled).toBe(true);
    expect(res.payload.dryRun).toBe(false);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false, tripId: 11, driverIds: [91] }));
    expect(res.payload.summary.assigned).toBe(1);
  });

  it("sidecar fora do ar → resultado simulado, nada enviado", async () => {
    const spy = vi.fn();
    const res = await assignAspxAllocations({
      lhs: ["LH1", "LH2"],
      operatorId: "op",
      deps: {
        ...baseDeps(spy),
        fetchTrips: async () => { throw new SpxSidecarUnavailable("down"); },
      },
    });
    expect(res.payload.simulated).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(res.payload.summary.simulated).toBe(2);
  });

  it("motorista não encontrado no ASPX → pending; sem trip → skipped", async () => {
    const spy = vi.fn().mockResolvedValue({});
    const res = await assignAspxAllocations({
      lhs: ["LH1", "LH2"],
      operatorId: "op",
      deps: {
        ...baseDeps(spy),
        fetchTrips: async () => [{ trip_id: 11, trip_number: "LH1" }], // LH2 sem trip
        fetchDrivers: async () => [], // ninguém casa
      },
    });
    const byLh = Object.fromEntries(res.payload.results.map((r) => [r.lh, r.state]));
    expect(byLh.LH1).toBe("pending"); // tem trip, sem driver
    expect(byLh.LH2).toBe("skipped"); // sem trip
    expect(spy).not.toHaveBeenCalled();
  });
});
