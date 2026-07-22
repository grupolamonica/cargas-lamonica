import { describe, expect, it } from "vitest";

import {
  REVERTIBLE_EVENT_TYPES,
  extractRevertItemsFromAuditEvent,
  sameAlloc,
  allocChanged,
  allocEqualsStrict,
} from "./allocation-revert.js";

describe("allocation-revert domain", () => {
  describe("sameAlloc / allocChanged (efetivo: null e '' contam como vazio)", () => {
    it("trata null e '' como iguais (mesmo efetivo)", () => {
      expect(sameAlloc({ motorista: null }, { motorista: "" }, ["motorista"])).toBe(true);
      expect(allocChanged({ motorista: null }, { motorista: "" }, ["motorista"])).toBe(false);
    });
    it("detecta mudança real de motorista", () => {
      expect(allocChanged({ motorista: "A", cavalo: "", carreta: "" }, { motorista: "B", cavalo: "", carreta: "" })).toBe(true);
    });
  });

  describe("allocEqualsStrict (guarda: null ≠ '')", () => {
    it("distingue null de '' (estado diferente, mesmo efetivo)", () => {
      expect(allocEqualsStrict({ motorista: null }, { motorista: "" }, ["motorista"])).toBe(false);
      expect(allocEqualsStrict({ motorista: "" }, { motorista: "" }, ["motorista"])).toBe(true);
      expect(allocEqualsStrict({ motorista: "A" }, { motorista: "A" }, ["motorista"])).toBe(true);
    });
    it("false quando current é null (carga sumiu)", () => {
      expect(allocEqualsStrict(null, { motorista: "A" })).toBe(false);
    });
  });

  describe("extractRevertItemsFromAuditEvent", () => {
    it("evento fora do catálogo → não suportado", () => {
      const r = extractRevertItemsFromAuditEvent({ eventType: "operator.cargo.created", metadata: {} });
      expect(r.supported).toBe(false);
      expect(REVERTIBLE_EVENT_TYPES).not.toContain("operator.cargo.created");
    });

    it("allocation_updated com beforeAlloc/afterAlloc → 1 item, com status", () => {
      const r = extractRevertItemsFromAuditEvent({
        eventType: "operator.cargo.allocation_updated",
        metadata: {
          lh: "LT-1",
          beforeAlloc: { motorista: "ANTIGO", cavalo: "AAA1A11", carreta: "BBB2B22", status: "" },
          afterAlloc: { motorista: "NOVO", cavalo: "CCC3C33", carreta: "DDD4D44", status: "DESCARREGADO" },
        },
      });
      expect(r.supported).toBe(true);
      expect(r.touchesStatus).toBe(true);
      expect(r.items).toHaveLength(1);
      expect(r.items[0].lh).toBe("LT-1");
      expect(r.items[0].before.motorista).toBe("ANTIGO");
      expect(r.items[0].after.status).toBe("DESCARREGADO");
    });

    it("allocation_updated legado (sem beforeAlloc) → não suportado", () => {
      const r = extractRevertItemsFromAuditEvent({
        eventType: "operator.cargo.allocation_updated",
        metadata: { lh: "LT-1", motorista: "NOVO" },
      });
      expect(r.supported).toBe(false);
      expect(r.reason).toMatch(/anterior/i);
    });

    it("queue_descended casa moves × beforeMoves por LH", () => {
      const r = extractRevertItemsFromAuditEvent({
        eventType: "operator.cargo.queue_descended",
        metadata: {
          route: "A→B",
          reserva: false,
          moves: [
            { lh: "LT-A", motorista: "", cavalo: "", carreta: "" },
            { lh: "LT-B", motorista: "MOT A", cavalo: "P1", carreta: "P2" },
          ],
          beforeMoves: [
            { lh: "LT-A", motorista: "MOT A", cavalo: "P1", carreta: "P2" },
            { lh: "LT-B", motorista: "MOT B", cavalo: "P3", carreta: "P4" },
          ],
        },
      });
      expect(r.supported).toBe(true);
      expect(r.touchesStatus).toBe(false);
      expect(r.items).toHaveLength(2);
      const a = r.items.find((i) => i.lh === "LT-A");
      expect(a.before.motorista).toBe("MOT A");
      expect(a.after.motorista).toBe("");
    });

    it("cancel_cascade legado (moves = número) → não suportado", () => {
      const r = extractRevertItemsFromAuditEvent({
        eventType: "operator.cargo.cancel_cascade",
        metadata: { lh: "LT-1", moves: 3, reserva: true },
      });
      expect(r.supported).toBe(false);
    });

    it("allocation_reassigned casa por cargoId quando não há LH", () => {
      const r = extractRevertItemsFromAuditEvent({
        eventType: "operator.cargo.allocation_reassigned",
        metadata: {
          moves: [{ lh: null, cargoId: "cid-1", motorista: "NOVO", cavalo: "", carreta: "" }],
          beforeMoves: [{ lh: null, cargoId: "cid-1", motorista: "VELHO", cavalo: "", carreta: "" }],
        },
      });
      expect(r.supported).toBe(true);
      expect(r.items).toHaveLength(1);
      expect(r.items[0].cargoId).toBe("cid-1");
      expect(r.items[0].before.motorista).toBe("VELHO");
    });

    it("reserva: true é propagado (aviso de standby)", () => {
      const r = extractRevertItemsFromAuditEvent({
        eventType: "operator.cargo.queue_descended",
        metadata: { reserva: true, moves: [{ lh: "X", motorista: "" }], beforeMoves: [{ lh: "X", motorista: "Y" }] },
      });
      expect(r.reserva).toBe(true);
    });
  });
});
