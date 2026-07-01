import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockAdvance } = vi.hoisted(() => ({ mockAdvance: vi.fn() }));

vi.mock("../../application/operator-admin/use-cases/advance-recurring-cargas.js", () => ({
  advanceRecurringCargas: mockAdvance,
}));

const { resolveAdvanceRecurringCargasResponse } = await import("./recurring-cargo.handler.js");

const makeRequest = (authorization) => ({ headers: authorization ? { authorization } : {} });

describe("resolveAdvanceRecurringCargasResponse (autorização CRON_SECRET)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("401 fail-closed quando CRON_SECRET não está configurado", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const res = await resolveAdvanceRecurringCargasResponse(makeRequest("Bearer qualquer"));
    expect(res.statusCode).toBe(401);
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it("401 quando o Bearer está ausente ou errado", async () => {
    vi.stubEnv("CRON_SECRET", "s3cr3t");
    expect((await resolveAdvanceRecurringCargasResponse(makeRequest())).statusCode).toBe(401);
    expect((await resolveAdvanceRecurringCargasResponse(makeRequest("Bearer errado"))).statusCode).toBe(401);
    expect(mockAdvance).not.toHaveBeenCalled();
  });

  it("200 e executa o avanço com o Bearer correto", async () => {
    vi.stubEnv("CRON_SECRET", "s3cr3t");
    mockAdvance.mockResolvedValue({ advanced: 2, scanned: 5 });
    const res = await resolveAdvanceRecurringCargasResponse(makeRequest("Bearer s3cr3t"));
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ ok: true, advanced: 2, scanned: 5 });
    expect(mockAdvance).toHaveBeenCalledTimes(1);
  });

  it("500 quando o avanço lança erro", async () => {
    vi.stubEnv("CRON_SECRET", "s3cr3t");
    mockAdvance.mockRejectedValue(new Error("boom"));
    const res = await resolveAdvanceRecurringCargasResponse(makeRequest("Bearer s3cr3t"));
    expect(res.statusCode).toBe(500);
  });
});
