import { describe, expect, it } from "vitest";

import {
  buildRegistrationApprovedMessage,
  isRegistrationApprovedOutreachEnabled,
  notifyRegistrationApproved,
} from "./registration-approved-outreach.js";

describe("registration-approved-outreach (DC-198)", () => {
  describe("buildRegistrationApprovedMessage", () => {
    it("usa o primeiro nome e cita aprovação + Grupo Lamônica", () => {
      const msg = buildRegistrationApprovedMessage({ nome: "Rafael Roberto Sales" });
      expect(msg).toContain("Rafael");
      expect(msg).not.toContain("Roberto"); // só o primeiro nome
      expect(msg).toMatch(/aprovado/i);
      expect(msg).toMatch(/Grupo Lam[oô]nica/i);
    });

    it("fallback 'motorista' quando sem nome", () => {
      expect(buildRegistrationApprovedMessage({})).toContain("motorista");
      expect(buildRegistrationApprovedMessage()).toContain("motorista");
    });
  });

  describe("isRegistrationApprovedOutreachEnabled", () => {
    it("off por padrão; on só com true/1", () => {
      expect(isRegistrationApprovedOutreachEnabled({})).toBe(false);
      expect(isRegistrationApprovedOutreachEnabled({ DRIVER_OUTREACH_REGISTRATION_APPROVED_ENABLED: "false" })).toBe(false);
      expect(isRegistrationApprovedOutreachEnabled({ DRIVER_OUTREACH_REGISTRATION_APPROVED_ENABLED: "true" })).toBe(true);
      expect(isRegistrationApprovedOutreachEnabled({ DRIVER_OUTREACH_REGISTRATION_APPROVED_ENABLED: "1" })).toBe(true);
    });
  });

  describe("notifyRegistrationApproved", () => {
    const ON = { DRIVER_OUTREACH_REGISTRATION_APPROVED_ENABLED: "true" };

    it("flag off → feature_disabled, não envia", () => {
      const r = notifyRegistrationApproved({ nome: "Rafael", telefone: "11999998888", allConforme: true }, { env: {} });
      expect(r).toEqual({ sent: false, reason: "feature_disabled" });
    });

    it("flag on + NÃO conforme → nao_conforme (não avisa 'apto')", () => {
      expect(
        notifyRegistrationApproved({ nome: "Rafael", telefone: "11999998888", allConforme: false }, { env: ON }).reason,
      ).toBe("nao_conforme");
      // conformidade desconhecida (undefined) também não notifica
      expect(
        notifyRegistrationApproved({ nome: "Rafael", telefone: "11999998888" }, { env: ON }).reason,
      ).toBe("nao_conforme");
    });

    it("flag on + conforme + telefone inválido → no_phone", () => {
      expect(notifyRegistrationApproved({ nome: "Rafael", telefone: "", allConforme: true }, { env: ON }).reason).toBe("no_phone");
      expect(notifyRegistrationApproved({ nome: "Rafael", telefone: "123", allConforme: true }, { env: ON }).reason).toBe("no_phone");
    });

    it("flag on + conforme + telefone ok → pending_channel com a mensagem (mas NÃO envia)", () => {
      const r = notifyRegistrationApproved({ nome: "Rafael Sales", telefone: "(11) 99999-8888", allConforme: true }, { env: ON });
      expect(r.sent).toBe(false);
      expect(r.reason).toBe("pending_channel");
      expect(r.recipientPhone).toBe("11999998888");
      expect(r.message).toMatch(/Rafael/);
    });
  });
});
