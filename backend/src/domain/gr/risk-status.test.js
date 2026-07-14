import { describe, expect, it } from "vitest";
import {
  classifyExpiry,
  consolidateVerdict,
  deriveDriverAlerts,
  deriveVehicleAlerts,
  sortByUrgency,
  VERDICT,
  SEVERITY,
  ALERT_TYPE,
  SOURCE,
  EXPIRY_WARN_DAYS,
} from "./risk-status.js";

const NOW = Date.UTC(2026, 6, 14, 12, 0, 0); // 2026-07-14 12:00 UTC
const DAY = 86_400_000;
const iso = (offsetDays) => new Date(NOW + offsetDays * DAY).toISOString().slice(0, 10);

describe("classifyExpiry", () => {
  it("null/vazio → sem nível", () => {
    expect(classifyExpiry(null, { nowMs: NOW })).toEqual({ daysUntilExpiry: null, alertLevel: null });
    expect(classifyExpiry("", { nowMs: NOW })).toEqual({ daysUntilExpiry: null, alertLevel: null });
  });

  it("bem no futuro → OK", () => {
    expect(classifyExpiry(iso(90), { nowMs: NOW })).toEqual({ daysUntilExpiry: 90, alertLevel: "OK" });
  });

  it("exatamente 30 dias → EXPIRING_SOON (fronteira inclusiva)", () => {
    expect(classifyExpiry(iso(30), { nowMs: NOW })).toEqual({ daysUntilExpiry: 30, alertLevel: "EXPIRING_SOON" });
  });

  it("31 dias → OK (fora da janela)", () => {
    expect(classifyExpiry(iso(31), { nowMs: NOW }).alertLevel).toBe("OK");
  });

  it("hoje (0 dias) → EXPIRING_SOON", () => {
    expect(classifyExpiry(iso(0), { nowMs: NOW })).toEqual({ daysUntilExpiry: 0, alertLevel: "EXPIRING_SOON" });
  });

  it("no passado → EXPIRED com dias negativos", () => {
    expect(classifyExpiry(iso(-4), { nowMs: NOW })).toEqual({ daysUntilExpiry: -4, alertLevel: "EXPIRED" });
  });

  it("aceita objeto Date além de string", () => {
    expect(classifyExpiry(new Date(NOW + 10 * DAY), { nowMs: NOW }).alertLevel).toBe("EXPIRING_SOON");
  });

  it("janela configurável via warnDays", () => {
    expect(classifyExpiry(iso(20), { nowMs: NOW, warnDays: 7 }).alertLevel).toBe("OK");
    expect(classifyExpiry(iso(20), { nowMs: NOW, warnDays: 30 }).alertLevel).toBe("EXPIRING_SOON");
    expect(EXPIRY_WARN_DAYS).toBe(30);
  });
});

describe("consolidateVerdict", () => {
  const okAng = { status: "FOUND", alertLevel: "OK" };
  const okBrk = { conjuntoApto: true, alertLevel: "OK" };
  const okSpx = { status: "ativo" };

  it("todas as fontes OK → OK", () => {
    expect(consolidateVerdict({ angellira: okAng, brk: okBrk, spx: okSpx })).toEqual({ status: VERDICT.OK, reasons: [] });
  });

  it("nenhuma fonte com dado → SEM_DADO", () => {
    expect(consolidateVerdict({ angellira: null, brk: null, spx: null })).toEqual({ status: VERDICT.SEM_DADO, reasons: [] });
    expect(consolidateVerdict({}).status).toBe(VERDICT.SEM_DADO);
  });

  it("uma fonte vencendo → ATENCAO apontando a fonte", () => {
    const r = consolidateVerdict({ angellira: { alertLevel: "EXPIRING_SOON" }, brk: okBrk, spx: okSpx });
    expect(r.status).toBe(VERDICT.ATENCAO);
    expect(r.reasons).toEqual([SOURCE.ANGELLIRA]);
  });

  it("conjunto BRK reprovado → CRITICO", () => {
    const r = consolidateVerdict({ angellira: okAng, brk: { conjuntoApto: false }, spx: okSpx });
    expect(r.status).toBe(VERDICT.CRITICO);
    expect(r.reasons).toEqual([SOURCE.BRK]);
  });

  it("crítico vence atenção (pior severidade ganha)", () => {
    const r = consolidateVerdict({
      angellira: { alertLevel: "EXPIRING_SOON" },
      brk: okBrk,
      spx: { status: "inativo" },
    });
    expect(r.status).toBe(VERDICT.CRITICO);
    expect(r.reasons).toEqual([SOURCE.SPX]);
  });

  it("SPX com status desconhecido não derruba o veredito (conservador)", () => {
    const r = consolidateVerdict({ angellira: okAng, brk: okBrk, spx: { status: "xyz-desconhecido" } });
    expect(r.status).toBe(VERDICT.OK);
  });
});

describe("deriveDriverAlerts", () => {
  const driver = { entityId: "driver:1", displayName: "Paulo C. Nunes", document: "12345678907" };

  it("Angellira vencido → 1 alerta crítico de vencimento com id estável", () => {
    const alerts = deriveDriverAlerts({ ...driver, angellira: { alertLevel: "EXPIRED", daysUntilExpiry: -4, validUntil: iso(-4) } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      entityType: "motorista",
      source: SOURCE.ANGELLIRA,
      alertType: ALERT_TYPE.EXPIRY,
      severity: SEVERITY.CRIT,
      daysUntilExpiry: -4,
      id: "motorista:driver:1:ANGELLIRA:EXPIRY",
    });
    expect(alerts[0].message).toContain("vencido há 4d");
  });

  it("Angellira vencendo → alerta de atenção", () => {
    const alerts = deriveDriverAlerts({ ...driver, angellira: { alertLevel: "EXPIRING_SOON", daysUntilExpiry: 12, validUntil: iso(12) } });
    expect(alerts[0].severity).toBe(SEVERITY.WARN);
    expect(alerts[0].message).toContain("vence em 12d");
  });

  it("conjunto BRK reprovado → alerta crítico de estado", () => {
    const alerts = deriveDriverAlerts({ ...driver, brk: { conjuntoApto: false } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: SOURCE.BRK, alertType: ALERT_TYPE.STATE, severity: SEVERITY.CRIT });
    expect(alerts[0].message).toBe("Conjunto BRK reprovado");
  });

  it("SPX inativo → alerta crítico de estado", () => {
    const alerts = deriveDriverAlerts({ ...driver, spx: { status: "inativo", statusText: "Inativo" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: SOURCE.SPX, alertType: ALERT_TYPE.STATE, severity: SEVERITY.CRIT });
  });

  it("tudo conforme → nenhum alerta", () => {
    const alerts = deriveDriverAlerts({
      ...driver,
      angellira: { alertLevel: "OK" },
      brk: { conjuntoApto: true, alertLevel: "OK" },
      spx: { status: "ativo" },
    });
    expect(alerts).toEqual([]);
  });

  it("múltiplas fontes com problema → múltiplos alertas", () => {
    const alerts = deriveDriverAlerts({
      ...driver,
      angellira: { alertLevel: "EXPIRED", daysUntilExpiry: -1, validUntil: iso(-1) },
      brk: { conjuntoApto: false },
    });
    expect(alerts).toHaveLength(2);
    expect(alerts.map((a) => a.source).sort()).toEqual([SOURCE.ANGELLIRA, SOURCE.BRK]);
  });

  it("entrada nula → array vazio", () => {
    expect(deriveDriverAlerts(null)).toEqual([]);
  });
});

describe("deriveVehicleAlerts", () => {
  const vehicle = { entityId: "veh:1", plate: "ABC1D23", plateRole: "TRAILER_1", linkedDriver: { name: "Edson", cpf: "1" } };

  it("Angellira vencendo → 1 alerta de veículo", () => {
    const alerts = deriveVehicleAlerts({ ...vehicle, angellira: { alertLevel: "EXPIRING_SOON", daysUntilExpiry: 8, validUntil: iso(8) } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      entityType: "veiculo",
      plate: "ABC1D23",
      plateRole: "TRAILER_1",
      source: SOURCE.ANGELLIRA,
      severity: SEVERITY.WARN,
      id: "veiculo:veh:1:ANGELLIRA:EXPIRY",
    });
  });

  it("veículo vigente → nenhum alerta", () => {
    expect(deriveVehicleAlerts({ ...vehicle, angellira: { alertLevel: "OK" } })).toEqual([]);
    expect(deriveVehicleAlerts({ ...vehicle, angellira: null })).toEqual([]);
  });
});

describe("sortByUrgency", () => {
  it("crítico antes de atenção; estado antes de vencimento; vencimento por dias crescentes", () => {
    const warnExpiry = { id: "a", severity: SEVERITY.WARN, alertType: ALERT_TYPE.EXPIRY, daysUntilExpiry: 5 };
    const critExpiryFar = { id: "b", severity: SEVERITY.CRIT, alertType: ALERT_TYPE.EXPIRY, daysUntilExpiry: -2 };
    const critExpiryNear = { id: "c", severity: SEVERITY.CRIT, alertType: ALERT_TYPE.EXPIRY, daysUntilExpiry: -10 };
    const critState = { id: "d", severity: SEVERITY.CRIT, alertType: ALERT_TYPE.STATE, daysUntilExpiry: null };
    const warnState = { id: "e", severity: SEVERITY.WARN, alertType: ALERT_TYPE.STATE, daysUntilExpiry: null };

    const sorted = sortByUrgency([warnExpiry, critExpiryFar, critExpiryNear, critState, warnState]);
    expect(sorted.map((a) => a.id)).toEqual(["d", "c", "b", "e", "a"]);
  });

  it("não muta o array original", () => {
    const input = [
      { id: "x", severity: SEVERITY.WARN, alertType: ALERT_TYPE.EXPIRY, daysUntilExpiry: 5 },
      { id: "y", severity: SEVERITY.CRIT, alertType: ALERT_TYPE.STATE, daysUntilExpiry: null },
    ];
    const copy = [...input];
    sortByUrgency(input);
    expect(input).toEqual(copy);
  });
});
