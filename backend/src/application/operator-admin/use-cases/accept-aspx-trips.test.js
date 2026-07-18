import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../infrastructure/security-audit.js", () => ({
  recordSecurityAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

const { acceptAspxTrips } = await import("./accept-aspx-trips.js");
const { SpxSidecarUnavailable } = await import("../../../infrastructure/spx/spx-allocation-client.js");
const { recordSecurityAuditEvent } = await import("../../../infrastructure/security-audit.js");

function indexWith(entries) {
  return { byNumber: new Map(entries), truncated: false, partial: false };
}

afterEach(() => {
  delete process.env.SPX_ACCEPT_WRITE_ENABLED;
  vi.clearAllMocks();
});

describe("acceptAspxTrips", () => {
  it("rejeita quando nada é selecionado", async () => {
    await expect(acceptAspxTrips({ operatorId: "op" })).rejects.toThrow();
  });

  it("tripIds diretos + kill switch off → força dry_run (não envia)", async () => {
    const spy = vi.fn().mockResolvedValue({ dry_run: true });
    const res = await acceptAspxTrips({
      tripIds: [111, 222],
      operatorId: "op",
      correlationId: "c1",
      deps: { acceptTrip: spy, fetchIndex: async () => indexWith([]) },
    });
    expect(res.payload.writeEnabled).toBe(false);
    expect(res.payload.dryRun).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ tripId: 111, dryRun: true }));
    expect(res.payload.summary.dryRun).toBe(2);
    expect(res.payload.summary.accepted).toBe(0);
    expect(recordSecurityAuditEvent).toHaveBeenCalledTimes(1);
  });

  it("kill switch on → aceita de verdade (dryRun false), estado 'accepted'", async () => {
    process.env.SPX_ACCEPT_WRITE_ENABLED = "true";
    const spy = vi.fn().mockResolvedValue({ retcode: 0 });
    const res = await acceptAspxTrips({
      tripIds: [111],
      operatorId: "op",
      deps: { acceptTrip: spy, fetchIndex: async () => indexWith([]) },
    });
    expect(res.payload.writeEnabled).toBe(true);
    expect(res.payload.dryRun).toBe(false);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ tripId: 111, dryRun: false }));
    expect(res.payload.summary.accepted).toBe(1);
  });

  it("por LH → resolve trip_id pelo índice do sidecar", async () => {
    const spy = vi.fn().mockResolvedValue({ dry_run: true });
    const res = await acceptAspxTrips({
      lhs: ["LT1", "LT2"],
      operatorId: "op",
      deps: {
        acceptTrip: spy,
        fetchIndex: async () => indexWith([
          ["LT1", { tripId: 501 }],
          ["LT2", { tripId: 502 }],
        ]),
      },
    });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ tripId: 501 }));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ tripId: 502 }));
    expect(res.payload.summary.dryRun).toBe(2);
  });

  it("LH sem trip no índice → skipped; LH que não é LT → skipped (nunca chega ao sidecar)", async () => {
    const spy = vi.fn().mockResolvedValue({ dry_run: true });
    const res = await acceptAspxTrips({
      lhs: ["LT1", "LTX", "MANUAL-9"],
      operatorId: "op",
      deps: {
        acceptTrip: spy,
        fetchIndex: async () => indexWith([["LT1", { tripId: 501 }]]),
      },
    });
    const byKey = Object.fromEntries(res.payload.results.map((r) => [r.key, r.state]));
    expect(byKey.LT1).toBe("dry_run");
    expect(byKey.LTX).toBe("skipped"); // LT mas ausente do índice
    expect(byKey["MANUAL-9"]).toBe("skipped"); // não começa com LT
    expect(spy).toHaveBeenCalledTimes(1); // só LT1
  });

  it("sidecar fora do ar na resolução por LH → propaga erro (nada enviado)", async () => {
    const spy = vi.fn();
    await expect(
      acceptAspxTrips({
        lhs: ["LT1"],
        operatorId: "op",
        deps: {
          acceptTrip: spy,
          fetchIndex: async () => { throw new SpxSidecarUnavailable("down"); },
        },
      }),
    ).rejects.toThrow(SpxSidecarUnavailable);
    expect(spy).not.toHaveBeenCalled();
    // auditou a falha
    expect(recordSecurityAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failure" }));
  });
});
