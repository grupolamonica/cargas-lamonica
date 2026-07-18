import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  resetTestDatabase,
  withPgClient,
  withPgTransaction,
} from "../operator-admin/test-harness.js";

vi.mock("../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));

const { addOutreachOptout, getOutreachOverview, removeOutreachOptout, saveOutreachSettings } =
  await import("./admin.js");
const { getOutreachConfig } = await import("./config.js");

describe("outreach admin (integração pg-mem)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("salva settings no banco e getOutreachConfig sobrescreve o env", async () => {
    process.env.DRIVER_OUTREACH_ENABLED = "false"; // env diz OFF
    const saved = await saveOutreachSettings(
      { enabled: true, coldEnabled: true, dailyCap: 20, quietStartHour: 6, quietEndHour: 22 },
      null,
    );
    expect(saved.enabled).toBe(true);

    const cfg = await withPgClient((c) => getOutreachConfig(c));
    expect(cfg.enabled).toBe(true); // banco vence o env
    expect(cfg.coldEnabled).toBe(true);
    expect(cfg.dailyCap).toBe(20);
    expect(cfg.quietStartHour).toBe(6);
    expect(cfg.quietEndHour).toBe(22);
  });

  it("clampa valores fora do intervalo", async () => {
    const saved = await saveOutreachSettings({ dailyCap: 99999, quietStartHour: 99 }, null);
    expect(saved.dailyCap).toBe(1000);
    expect(saved.quietStartHour).toBe(23);
  });

  it("overview traz settings + estatísticas + fila vazia", async () => {
    await saveOutreachSettings({ enabled: true }, null);
    const ov = await getOutreachOverview({});
    expect(ov.settings.enabled).toBe(true);
    expect(ov.queueStats).toEqual({ pending: 0, sent: 0, failed: 0, skipped: 0 });
    expect(Array.isArray(ov.queue)).toBe(true);
    expect(typeof ov.evolutionConfigured).toBe("boolean");
  });

  it("adiciona e remove opt-out (chave = CPF em dígitos)", async () => {
    await addOutreachOptout({ cpf: "123.456.789-01", reason: "pediu para não receber" }, null);
    let ov = await getOutreachOverview({});
    expect(ov.optouts.some((o) => o.driver_key === "12345678901")).toBe(true);

    await removeOutreachOptout("12345678901");
    ov = await getOutreachOverview({});
    expect(ov.optouts.some((o) => o.driver_key === "12345678901")).toBe(false);
  });
});
