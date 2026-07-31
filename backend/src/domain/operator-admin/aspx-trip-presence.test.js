import { describe, expect, it } from "vitest";

import { classifyAspxPresence, isSpxTripNumber } from "./aspx-trip-presence.js";

const NOW = new Date("2026-07-31T18:00:00.000Z");

describe("isSpxTripNumber", () => {
  it("aceita só viagens LT… (viagem real do SPX)", () => {
    expect(isSpxTripNumber("LT1Q8102CLEN1")).toBe(true);
    expect(isSpxTripNumber(" lt1q8102clen1 ")).toBe(true);
    expect(isSpxTripNumber("NESTLE-B101462743")).toBe(false);
    expect(isSpxTripNumber("")).toBe(false);
    expect(isSpxTripNumber(null)).toBe(false);
  });
});

describe("classifyAspxPresence", () => {
  it("viagem presente e carga sem marca → nada a fazer", () => {
    expect(classifyAspxPresence({ present: true, now: NOW }).action).toBe("none");
  });

  it("viagem sumiu e carga ainda sem marca → marca (e avisa)", () => {
    expect(classifyAspxPresence({ present: false, now: NOW }).action).toBe("mark");
  });

  it("viagem voltou ao portal → limpa a marca", () => {
    const r = classifyAspxPresence({
      present: true,
      missingSince: "2026-07-30T12:00:00.000Z",
      notifiedAt: "2026-07-30T12:00:00.000Z",
      now: NOW,
    });
    expect(r.action).toBe("clear");
  });

  it("continua sumida e o aviso é recente → não repete", () => {
    const r = classifyAspxPresence({
      present: false,
      missingSince: "2026-07-31T14:00:00.000Z",
      notifiedAt: "2026-07-31T14:00:00.000Z",
      now: NOW,
      realertHours: 6,
    });
    expect(r.action).toBe("none");
  });

  it("continua sumida e o aviso já passou da janela → re-avisa (avisar sempre)", () => {
    const r = classifyAspxPresence({
      present: false,
      missingSince: "2026-07-30T00:00:00.000Z",
      notifiedAt: "2026-07-31T11:59:00.000Z",
      now: NOW,
      realertHours: 6,
    });
    expect(r.action).toBe("renotify");
  });

  it("marcada sem aviso registrado → avisa agora", () => {
    const r = classifyAspxPresence({
      present: false,
      missingSince: "2026-07-30T00:00:00.000Z",
      notifiedAt: null,
      now: NOW,
    });
    expect(r.action).toBe("renotify");
  });
});
