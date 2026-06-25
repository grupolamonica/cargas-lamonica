import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../infrastructure/cadastro-bots/unificada-bot-client.js", () => ({
  consultarStatus: vi.fn(),
}));
vi.mock("../../../../infrastructure/security-log.js", () => ({
  logStructuredEvent: vi.fn(),
}));

import { consultarStatus } from "../../../../infrastructure/cadastro-bots/unificada-bot-client.js";
import { consultRiskExpiry, defaultExpiryIso, __clearRiskExpiryCacheForTests } from "./risk-expiry.js";

beforeEach(() => {
  vi.clearAllMocks();
  __clearRiskExpiryCacheForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("defaultExpiryIso", () => {
  it("retorna YYYY-MM-DD no futuro", () => {
    const iso = defaultExpiryIso(90);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${iso}T00:00:00Z`).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("consultRiskExpiry", () => {
  it("extrai item.limitDate (ISO datetime) → YYYY-MM-DD, found:true", async () => {
    consultarStatus.mockResolvedValue({
      ok: true, status: "CONFORME", status_description: "Conforme",
      item: { limitDate: "2026-09-01T03:00:00.000Z" },
    });
    const r = await consultRiskExpiry({ cpf: "019.724.126-39" });
    expect(r).toMatchObject({ ok: true, found: true, rad_expire_date: "2026-09-01" });
  });

  it("sem limitDate no item → found:false, rad_expire_date null (pipeline usa default)", async () => {
    consultarStatus.mockResolvedValue({ ok: true, status: "AGUARDANDO_STATUS", status_description: "Em análise", item: {} });
    const r = await consultRiskExpiry({ cpf: "01972412639" });
    expect(r).toMatchObject({ found: false, rad_expire_date: null });
  });

  it("consulta que lança → {ok:false, found:false, null} (não propaga)", async () => {
    consultarStatus.mockRejectedValue(new Error("AngelLira fora"));
    const r = await consultRiskExpiry({ cpf: "01972412639" });
    expect(r).toMatchObject({ ok: false, found: false, rad_expire_date: null });
  });

  it("cacheia found:true (2ª chamada não re-consulta)", async () => {
    consultarStatus.mockResolvedValue({ ok: true, item: { limitDate: "2026-09-01" } });
    await consultRiskExpiry({ cpf: "01972412639" });
    await consultRiskExpiry({ cpf: "01972412639" });
    expect(consultarStatus).toHaveBeenCalledTimes(1);
  });

  it("NÃO cacheia found:false (transitório — re-consulta)", async () => {
    consultarStatus.mockResolvedValue({ ok: true, item: {} });
    await consultRiskExpiry({ cpf: "01972412639" });
    await consultRiskExpiry({ cpf: "01972412639" });
    expect(consultarStatus).toHaveBeenCalledTimes(2);
  });

  it("cpf vazio → não consulta", async () => {
    const r = await consultRiskExpiry({ cpf: "" });
    expect(r.found).toBe(false);
    expect(consultarStatus).not.toHaveBeenCalled();
  });
});
