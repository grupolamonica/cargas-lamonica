import { describe, expect, it } from "vitest";

import {
  classifyAspxPresence,
  classifyRouteRemoval,
  isSpxTripNumber,
  routeKeyFromLabels,
} from "./aspx-trip-presence.js";

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

describe("routeKeyFromLabels", () => {
  it("normaliza acento, caixa e espaço", () => {
    expect(routeKeyFromLabels(" Simões Filho/BA ", "Itaitinga/CE")).toBe("simoes filho/ba>itaitinga/ce");
    expect(routeKeyFromLabels("SIMOES FILHO/BA", "itaitinga/ce")).toBe("simoes filho/ba>itaitinga/ce");
  });

  it("PRESERVA sufixo operacional da estação (São Paulo-02 ≠ São Paulo)", () => {
    const comSufixo = routeKeyFromLabels("São Paulo-02/SP", "Simoes Filho/BA");
    const semSufixo = routeKeyFromLabels("São Paulo/SP", "Simoes Filho/BA");
    expect(comSufixo).not.toBe(semSufixo);
  });

  it("sem origem ou destino → chave vazia (não agrupa)", () => {
    expect(routeKeyFromLabels("", "Itaitinga/CE")).toBe("");
    expect(routeKeyFromLabels("Simoes Filho/BA", null)).toBe("");
  });
});

describe("classifyRouteRemoval", () => {
  const base = { portalTripsOnRoute: 0, launchedOnRoute: 10, missingOnRoute: 10, now: NOW };
  const seisHorasAtras = new Date(NOW.getTime() - 6 * 3600_000).toISOString();

  it("rota com viagem no portal NUNCA é removida (volta à regra por viagem)", () => {
    expect(classifyRouteRemoval({ ...base, portalTripsOnRoute: 1 }).action).toBe("none");
  });

  it("rota parcialmente ausente não é remoção de rota", () => {
    expect(classifyRouteRemoval({ ...base, missingOnRoute: 9 }).action).toBe("none");
  });

  it("poucas cargas na rota não caracterizam remoção", () => {
    expect(classifyRouteRemoval({ ...base, launchedOnRoute: 2, missingOnRoute: 2 }).action).toBe("none");
  });

  it("primeira observação apenas OBSERVA (não marca)", () => {
    expect(classifyRouteRemoval({ ...base, firstAbsentAt: null }).action).toBe("observing");
  });

  it("ausência dentro da janela de confirmação segue em observação", () => {
    const umaHoraAtras = new Date(NOW.getTime() - 3600_000).toISOString();
    expect(classifyRouteRemoval({ ...base, firstAbsentAt: umaHoraAtras }).action).toBe("observing");
  });

  it("ausência sustentada além da janela → route_removed", () => {
    expect(classifyRouteRemoval({ ...base, firstAbsentAt: seisHorasAtras }).action).toBe("route_removed");
  });
});
