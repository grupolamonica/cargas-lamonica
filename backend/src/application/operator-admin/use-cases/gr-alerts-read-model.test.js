import { describe, expect, it } from "vitest";
import { buildGrAlertsPayload } from "./gr-alerts-read-model.js";

const NOW = Date.UTC(2026, 6, 14, 12, 0, 0); // 2026-07-14
const DAY = 86_400_000;
const iso = (offsetDays) => new Date(NOW + offsetDays * DAY).toISOString().slice(0, 10);

// Linhas no formato do banco (driver_profiles / vehicles).
const driverOk = {
  user_id: "u1", full_name: "José R. Almeida", document_number: "111",
  angellira_status: "FOUND", angellira_valid_until: iso(200),
  brk_status: "vigente", brk_conjunto_apto: true, brk_valid_until: iso(200),
  spx_vigency_status: "ativo", spx_vigency_encontrado: true,
};
const driverCrit = {
  user_id: "u2", full_name: "Paulo C. Nunes", document_number: "222",
  angellira_status: "FOUND", angellira_valid_until: iso(-4),
  brk_conjunto_apto: false,
  spx_vigency_status: "inativo", spx_vigency_encontrado: false,
};
const driverWarn = {
  user_id: "u3", full_name: "Marcos A. Souza", document_number: "333",
  angellira_status: "FOUND", angellira_valid_until: iso(12),
  brk_conjunto_apto: true, brk_valid_until: iso(200),
  spx_vigency_status: "ativo",
};

const vehicleWarn = {
  id: "v1", plate: "ABC1D23", plate_role: "TRAILER_1",
  angellira_status: "FOUND", angellira_valid_until: iso(8),
  linked_driver_cpf: "333", linked_driver_name: "Marcos A. Souza",
};
const vehicleOk = {
  id: "v2", plate: "XYZ9K88", plate_role: "HORSE",
  angellira_status: "FOUND", angellira_valid_until: iso(120),
};

describe("buildGrAlertsPayload", () => {
  it("base vazia → payload válido e zerado", () => {
    const { statusCode, payload } = buildGrAlertsPayload({ nowMs: NOW });
    expect(statusCode).toBe(200);
    expect(payload.items).toEqual([]);
    expect(payload.summary.drivers.total).toBe(0);
    expect(payload.summary.alertas.total).toBe(0);
    expect(payload.meta.count).toBe(0);
  });

  it("conta o veredito consolidado por motorista", () => {
    const { payload } = buildGrAlertsPayload({
      driverRows: [driverOk, driverCrit, driverWarn],
      vehicleRows: [],
      nowMs: NOW,
    });
    expect(payload.summary.drivers).toMatchObject({ total: 3, ok: 1, atencao: 1, critico: 1, semDado: 0 });
  });

  it("agrega e ordena alertas de motoristas + veículos por urgência", () => {
    const { payload } = buildGrAlertsPayload({
      driverRows: [driverOk, driverCrit, driverWarn],
      vehicleRows: [vehicleWarn, vehicleOk],
      nowMs: NOW,
    });

    // driverCrit: 3 (angellira vencido + BRK reprovado + SPX inativo); driverWarn: 1; vehicleWarn: 1
    expect(payload.items).toHaveLength(5);
    expect(payload.summary.alertas).toMatchObject({ total: 5, criticos: 3, atencao: 2 });
    expect(payload.summary.vehicles).toMatchObject({ total: 2, expiringSoon: 1, expired: 0 });

    // Todos os críticos vêm antes dos de atenção.
    const severities = payload.items.map((a) => a.severity);
    expect(severities).toEqual(["crit", "crit", "crit", "warn", "warn"]);

    // Dentro do grupo crítico, os alertas de ESTADO (reprovado/inativo) vêm antes do de vencimento.
    expect(payload.items[0].alertType).toBe("STATE");
    expect(payload.items[2].alertType).toBe("EXPIRY");
    expect(payload.items[2].source).toBe("ANGELLIRA");

    // No grupo de atenção, o mais próximo do vencimento vem primeiro (veículo 8d antes do motorista 12d).
    expect(payload.items[3]).toMatchObject({ entityType: "veiculo", daysUntilExpiry: 8 });
    expect(payload.items[4]).toMatchObject({ entityType: "motorista", daysUntilExpiry: 12 });
  });

  it("propaga o correlationId no meta", () => {
    const { payload } = buildGrAlertsPayload({ driverRows: [], vehicleRows: [], nowMs: NOW, correlationId: "corr-123" });
    expect(payload.meta.correlationId).toBe("corr-123");
  });
});
