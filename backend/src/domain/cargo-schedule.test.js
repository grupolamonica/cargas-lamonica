import { describe, expect, it } from "vitest";

import { systemCarregamentoLabel, syncedCarregamentoLabel } from "./cargo-schedule.js";

describe("systemCarregamentoLabel", () => {
  it("monta 'YYYY-MM-DDTHH:MM' a partir de data (string) + horário 'HH:MM:SS'", () => {
    expect(systemCarregamentoLabel("2026-07-06", "13:00:00")).toBe("2026-07-06T13:00");
  });

  it("aceita data como Date (UTC-midnight, sem off-by-one)", () => {
    expect(systemCarregamentoLabel(new Date("2026-07-06T00:00:00.000Z"), "08:30")).toBe("2026-07-06T08:30");
  });

  it("fatia a data ISO longa e o horário para HH:MM", () => {
    expect(systemCarregamentoLabel("2026-07-06T00:00:00.000Z", "13:00:00")).toBe("2026-07-06T13:00");
  });

  it("usa 00:00 quando o horário é vazio/nulo", () => {
    expect(systemCarregamentoLabel("2026-07-06", null)).toBe("2026-07-06T00:00");
    expect(systemCarregamentoLabel("2026-07-06", "")).toBe("2026-07-06T00:00");
  });

  it("retorna null para data ausente/inválida", () => {
    expect(systemCarregamentoLabel(null, "13:00")).toBeNull();
    expect(systemCarregamentoLabel("", "13:00")).toBeNull();
    expect(systemCarregamentoLabel("2026-07", "13:00")).toBeNull();
  });
});

describe("syncedCarregamentoLabel", () => {
  it("preserva NULL quando o campo atual é null (carga sem rótulo → fallback data+horário no front)", () => {
    expect(syncedCarregamentoLabel(null, "2026-07-06", "13:00:00")).toBeNull();
    expect(syncedCarregamentoLabel(undefined, "2026-07-06", "13:00:00")).toBeNull();
  });

  it("deriva o rótulo canônico quando o campo já está preenchido (corrige o drift)", () => {
    // valor defasado (data antiga) → sincroniza para a data/horário atuais
    expect(syncedCarregamentoLabel("2026-06-26T13:00", "2026-07-06", "13:00:00")).toBe("2026-07-06T13:00");
  });
});
