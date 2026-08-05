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

  it("aceite REAL de LH com carga do sistema lançada → escreve linha-casca (createOnly) na planilha", async () => {
    process.env.SPX_ACCEPT_WRITE_ENABLED = "true";
    const acceptSpy = vi.fn().mockResolvedValue({ retcode: 0 });
    const writeSpy = vi.fn(async () => ({ ok: true }));
    // withPgClient devolve a carga do sistema (lh_manual) correspondente ao LH aceito.
    const withPgClient = async (fn) =>
      fn({
        query: async () => ({
          rows: [
            {
              lh_manual: "LT1",
              sheet_source: null,
              origem: "A / SP",
              destino: "B / BA",
              sheet_data_carregamento: "2026-08-05T14:00",
              sheet_data_descarga: null,
            },
          ],
        }),
      });
    const res = await acceptAspxTrips({
      lhs: ["LT1"],
      operatorId: "op",
      deps: {
        acceptTrip: acceptSpy,
        fetchIndex: async () => indexWith([["LT1", { tripId: 501 }]]),
        withPgClient,
        writeAllocationsToSheet: writeSpy,
      },
    });
    expect(res.payload.summary.accepted).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const arg = writeSpy.mock.calls[0][0][0];
    expect(arg.lh).toBe("LT1");
    expect(arg.createOnly).toBe(true);
    expect(arg.motorista).toBe("");
    expect(arg.dataCarregamento).toBe("05/08/2026 14:00");
  });

  // DC-201: o auto-lançamento não relança o já-lançado, então um spot lançado
  // não-aceito e aceito DEPOIS ficaria com trip_accepted_at NULL para sempre — e o
  // Monitor esconderia uma viagem que a agência já considera nossa.
  it("aceite REAL marca trip_accepted_at na carga lançada (mão única, só o que está NULL)", async () => {
    process.env.SPX_ACCEPT_WRITE_ENABLED = "true";
    const queries = [];
    const withPgClient = async (fn) =>
      fn({
        query: async (sql, params) => {
          queries.push({ sql, params });
          return /UPDATE/i.test(sql) ? { rowCount: 1, rows: [] } : { rows: [] };
        },
      });
    await acceptAspxTrips({
      lhs: ["LT1"],
      operatorId: "op",
      deps: {
        acceptTrip: vi.fn().mockResolvedValue({ retcode: 0 }),
        fetchIndex: async () => indexWith([["LT1", { tripId: 501 }]]),
        withPgClient,
        writeAllocationsToSheet: vi.fn(async () => ({ ok: true })),
      },
    });

    const update = queries.find((q) => /UPDATE public\.cargas/i.test(q.sql));
    expect(update).toBeTruthy();
    expect(update.sql).toMatch(/trip_accepted_at = now\(\)/);
    expect(update.sql).toMatch(/trip_accepted_at IS NULL/); // não reescreve aceite antigo
    expect(update.sql).toMatch(/sheet_lh IS NULL/); // só carga lançada, nunca a da planilha
    expect(update.params).toEqual([["LT1"]]);
    expect(recordSecurityAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ acceptanceMarked: 1 }) }),
    );
  });

  it("marcador falhando NÃO derruba o aceite nem a linha-casca (best-effort separado)", async () => {
    process.env.SPX_ACCEPT_WRITE_ENABLED = "true";
    const writeSpy = vi.fn(async () => ({ ok: true }));
    let call = 0;
    // 1ª chamada = UPDATE do marcador (explode); 2ª = SELECT da linha-casca (ok).
    const withPgClient = async (fn) => {
      call += 1;
      if (call === 1) throw new Error("coluna ausente");
      return fn({
        query: async () => ({
          rows: [{ lh_manual: "LT1", sheet_source: null, origem: "A", destino: "B", sheet_data_carregamento: null, sheet_data_descarga: null }],
        }),
      });
    };
    const res = await acceptAspxTrips({
      lhs: ["LT1"],
      operatorId: "op",
      deps: {
        acceptTrip: vi.fn().mockResolvedValue({ retcode: 0 }),
        fetchIndex: async () => indexWith([["LT1", { tripId: 501 }]]),
        withPgClient,
        writeAllocationsToSheet: writeSpy,
      },
    });
    expect(res.payload.summary.accepted).toBe(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it("aceite em dry_run (kill switch off) → NÃO escreve na planilha (nem consulta o banco)", async () => {
    const acceptSpy = vi.fn().mockResolvedValue({ dry_run: true });
    const writeSpy = vi.fn(async () => ({ ok: true }));
    const withPgClient = vi.fn(async (fn) => fn({ query: async () => ({ rows: [] }) }));
    await acceptAspxTrips({
      lhs: ["LT1"],
      operatorId: "op",
      deps: {
        acceptTrip: acceptSpy,
        fetchIndex: async () => indexWith([["LT1", { tripId: 501 }]]),
        withPgClient,
        writeAllocationsToSheet: writeSpy,
      },
    });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(withPgClient).not.toHaveBeenCalled();
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
