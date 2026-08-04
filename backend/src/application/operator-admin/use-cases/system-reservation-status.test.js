import { describe, expect, it } from "vitest";
import { applySystemReservationStatus } from "./system-reservation-status.js";
import { mapSystemCargoToMonitorRow } from "./list-system-cargas-monitor.js";

const CARGO_ID = "8f5567b4-7de3-45e6-91e6-db306aa2c9cb";

/** Reserva vinda da Fila SEM nome resolvido (Angellira NOT_FOUND) — o mapa cai no
 *  rótulo de telefone, igual à rede das linhas da planilha. */
const reservaSemNome = {
  [CARGO_ID]: { motorista: "Reservado (fila) · 71982430000", cavalo: "ABC1234", carreta: "ACB1234" },
};
const reservaComNome = {
  [CARGO_ID]: { motorista: "SILVIO SANTOS OLIVEIRA", cavalo: "XYZ9876", carreta: "XYZ9877" },
};

function systemRow(over = {}) {
  return {
    lh: "B101474572",
    source: "sistema",
    cargoId: CARGO_ID,
    status: "Reservado",
    motoristas: "",
    cavalo: "",
    carreta: "",
    hasDriver: false,
    isAvailable: false,
    lifecycleStatus: "RESERVED",
    ...over,
  };
}

describe("applySystemReservationStatus", () => {
  it("injeta o motorista da reserva da Fila numa linha do sistema sem motorista", () => {
    const r = applySystemReservationStatus(systemRow(), { reservedByCargoId: reservaComNome });
    expect(r.motoristas).toBe("SILVIO SANTOS OLIVEIRA");
    expect(r.hasDriver).toBe(true);
    expect(r.isAvailable).toBe(false);
    expect(r.cavalo).toBe("XYZ9876");
    expect(r.carreta).toBe("XYZ9877");
  });

  it("sem nome resolvido, usa o rótulo de telefone (a carga NÃO fica vazia)", () => {
    const r = applySystemReservationStatus(systemRow(), { reservedByCargoId: reservaSemNome });
    expect(r.motoristas).toBe("Reservado (fila) · 71982430000");
    expect(r.hasDriver).toBe(true);
  });

  it("NÃO mexe no status — rótulo do ciclo de vida e status operacional continuam mandando", () => {
    const semOp = applySystemReservationStatus(systemRow(), { reservedByCargoId: reservaComNome });
    expect(semOp.status).toBe("Reservado");
    const comOp = applySystemReservationStatus(systemRow({ status: "CARREGADO" }), {
      reservedByCargoId: reservaComNome,
    });
    expect(comOp.status).toBe("CARREGADO");
    expect(comOp.motoristas).toBe("SILVIO SANTOS OLIVEIRA");
  });

  it("NÃO sobrescreve motorista efetivo já gravado (alloc_motorista vence)", () => {
    const r = applySystemReservationStatus(systemRow({ motoristas: "OUTRO MOTORISTA", hasDriver: true }), {
      reservedByCargoId: reservaComNome,
    });
    expect(r.motoristas).toBe("OUTRO MOTORISTA");
  });

  it("NÃO sobrescreve placas já preenchidas na alocação", () => {
    const r = applySystemReservationStatus(systemRow({ cavalo: "JA1234", carreta: "JA5678" }), {
      reservedByCargoId: reservaComNome,
    });
    expect(r.cavalo).toBe("JA1234");
    expect(r.carreta).toBe("JA5678");
  });

  it("não toca linha da PLANILHA (a rede dela é applyPlanilhaAvailabilityStatus)", () => {
    const sheet = systemRow({ source: "planilha", cargoId: undefined });
    expect(applySystemReservationStatus(sheet, { reservedByCargoId: reservaComNome })).toBe(sheet);
  });

  it("carga sem reserva no mapa passa inalterada", () => {
    const r = systemRow({ cargoId: "outro-id" });
    expect(applySystemReservationStatus(r, { reservedByCargoId: reservaComNome })).toBe(r);
  });

  it("mapa vazio / ausente é no-op", () => {
    const r = systemRow();
    expect(applySystemReservationStatus(r, { reservedByCargoId: {} })).toBe(r);
    expect(applySystemReservationStatus(r, {})).toBe(r);
    expect(applySystemReservationStatus(r)).toBe(r);
  });

  it("entrada com motorista vazio no mapa não marca hasDriver (não inventa reserva)", () => {
    const r = systemRow();
    expect(applySystemReservationStatus(r, { reservedByCargoId: { [CARGO_ID]: { motorista: "  " } } })).toBe(r);
  });
});

// Regressão do bug relatado pelo operador: carga Nestlé (só existe como carga
// LANÇADA — sheet_lh NULL) aceita na Fila aparecia no Monitor sem motorista e com
// o token cru "RESERVED". Cobre a projeção da carga + a rede de segurança juntas.
describe("carga lançada reservada pela Fila (Nestlé) na linha do Monitor", () => {
  const now = { todayIso: "2026-08-04", nowTimeIso: "14:00" };
  const cargoReservado = {
    id: CARGO_ID,
    origem: "FEIRA DE SANTANA/BA",
    destino: "SIMOES FILHO/BA",
    data: "2026-08-05",
    horario: "08:00:00",
    status: "RESERVED",
    lh_manual: "B101474572",
    driver_visibility: "PUBLIC",
    alloc_motorista: null, // aceite não resolveu nome → nunca gravou alloc_*
  };

  it("rotula 'Reservado' em vez do token cru RESERVED", () => {
    const row = mapSystemCargoToMonitorRow(cargoReservado, {}, now);
    expect(row.status).toBe("Reservado");
    expect(row.status).not.toBe("RESERVED");
  });

  it("com a rede de segurança, a linha sai com motorista e como reservada", () => {
    const row = applySystemReservationStatus(mapSystemCargoToMonitorRow(cargoReservado, {}, now), {
      reservedByCargoId: reservaSemNome,
    });
    expect(row.motoristas).toBe("Reservado (fila) · 71982430000");
    expect(row.hasDriver).toBe(true);
    expect(row.isAvailable).toBe(false);
    expect(row.status).toBe("Reservado");
  });

  it("carga OPEN (ninguém aceitou) segue Disponível — a rede não a afeta", () => {
    const aberta = mapSystemCargoToMonitorRow({ ...cargoReservado, status: "OPEN" }, {}, now);
    expect(aberta.status).toBe("");
    expect(aberta.isAvailable).toBe(true);
    const r = applySystemReservationStatus(aberta, { reservedByCargoId: {} });
    expect(r.isAvailable).toBe(true);
  });
});
