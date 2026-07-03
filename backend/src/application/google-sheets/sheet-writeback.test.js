import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isSheetWritebackEnabled, writeAllocationsToSheet } from "./sheet-writeback.js";

const URL_KEY = "GOOGLE_SHEET_WRITEBACK_URL";
const SECRET_KEY = "GOOGLE_SHEET_WRITEBACK_SECRET";
const TEST_URL = "https://script.google.com/macros/s/abc/exec";

function jsonResponse(obj, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(obj) };
}

describe("sheet-writeback", () => {
  let prevUrl, prevSecret;
  beforeEach(() => {
    prevUrl = process.env[URL_KEY];
    prevSecret = process.env[SECRET_KEY];
  });
  afterEach(() => {
    if (prevUrl === undefined) delete process.env[URL_KEY]; else process.env[URL_KEY] = prevUrl;
    if (prevSecret === undefined) delete process.env[SECRET_KEY]; else process.env[SECRET_KEY] = prevSecret;
    vi.restoreAllMocks();
  });

  it("desligado (sem URL) → skipped, sem chamar fetch", async () => {
    delete process.env[URL_KEY];
    const fetchImpl = vi.fn();
    const res = await writeAllocationsToSheet([{ lh: "X", motorista: "A" }], { fetchImpl });
    expect(res).toEqual({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(isSheetWritebackEnabled()).toBe(false);
  });

  it("updates vazio → não chama fetch, updated 0", async () => {
    process.env[URL_KEY] = TEST_URL;
    const fetchImpl = vi.fn();
    const res = await writeAllocationsToSheet([], { fetchImpl });
    expect(res).toEqual({ ok: true, updated: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sucesso: envia secret + updates normalizados e retorna updated", async () => {
    process.env[URL_KEY] = TEST_URL;
    process.env[SECRET_KEY] = "segredo";
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, updated: 2 }));
    const res = await writeAllocationsToSheet(
      [{ lh: "L1", motorista: "A", cavalo: "C1" }, { lh: "L2", motorista: "" }],
      { fetchImpl },
    );
    expect(res).toEqual({ ok: true, updated: 2 });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.secret).toBe("segredo");
    expect(body.updates).toEqual([
      { lh: "L1", motorista: "A", cavalo: "C1", carreta: "" },
      { lh: "L2", motorista: "", cavalo: "", carreta: "" },
    ]);
  });

  it("resposta ok:false (ex.: forbidden) → ok:false, não lança", async () => {
    process.env[URL_KEY] = TEST_URL;
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: "forbidden" }));
    const res = await writeAllocationsToSheet([{ lh: "L1", motorista: "A" }], { fetchImpl });
    expect(res.ok).toBe(false);
  });

  it("fetch lança → ok:false, NUNCA propaga o erro", async () => {
    process.env[URL_KEY] = TEST_URL;
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const res = await writeAllocationsToSheet([{ lh: "L1", motorista: "A" }], { fetchImpl });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("network down");
  });
});
