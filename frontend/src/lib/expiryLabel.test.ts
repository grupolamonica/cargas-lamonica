import { describe, expect, it } from "vitest";

import { formatExpiryLabel } from "@/lib/expiryLabel";

describe("formatExpiryLabel", () => {
  describe("null/undefined/invalid input", () => {
    it("trata null como 'sem data de validade'", () => {
      const label = formatExpiryLabel(null);
      expect(label.tone).toBe("expiring");
      expect(label.text).toBe("Documento sem data de validade");
      expect(label.short).toBe("(sem validade)");
    });

    it("trata undefined como 'sem data de validade'", () => {
      expect(formatExpiryLabel(undefined).tone).toBe("expiring");
      expect(formatExpiryLabel(undefined).text).toBe(
        "Documento sem data de validade",
      );
    });

    it("trata NaN como 'sem data de validade'", () => {
      const label = formatExpiryLabel(Number.NaN);
      expect(label.tone).toBe("expiring");
      expect(label.text).toBe("Documento sem data de validade");
    });

    it("trata Infinity como 'sem data de validade'", () => {
      const label = formatExpiryLabel(Number.POSITIVE_INFINITY);
      expect(label.tone).toBe("expiring");
      expect(label.text).toBe("Documento sem data de validade");
    });

    it("trata -Infinity como 'sem data de validade'", () => {
      const label = formatExpiryLabel(Number.NEGATIVE_INFINITY);
      expect(label.tone).toBe("expiring");
      expect(label.text).toBe("Documento sem data de validade");
    });
  });

  describe("expired (days <= -1)", () => {
    it("formata venceu há 1 dia (singular)", () => {
      const label = formatExpiryLabel(-1);
      expect(label.tone).toBe("expired");
      expect(label.text).toBe("Documento venceu há 1 dia");
      expect(label.short).toBe("(vencido)");
    });

    it("formata venceu há N dias para -30 (limite do stale)", () => {
      const label = formatExpiryLabel(-30);
      expect(label.tone).toBe("expired");
      expect(label.text).toBe("Documento venceu há 30 dias");
      expect(label.short).toBe("(vencido)");
    });

    it("vencido > 30 dias sem validUntil → 'está vencido faz tempo'", () => {
      const label = formatExpiryLabel(-2891);
      expect(label.tone).toBe("expired");
      expect(label.text).toBe("Documento está vencido faz tempo");
      expect(label.short).toBe("(vencido)");
    });

    it("vencido > 30 dias com validUntil → mostra mês/ano", () => {
      const label = formatExpiryLabel(-1558, "2022-02-08");
      expect(label.tone).toBe("expired");
      expect(label.text).toBe("Documento venceu em fev/2022");
      expect(label.short).toBe("(fev/2022)");
    });

    it("trata fração negativa como vencido", () => {
      const label = formatExpiryLabel(-1.7);
      expect(label.tone).toBe("expired");
      // trunc(-1.7) === -1 → "há 1 dia"
      expect(label.text).toBe("Documento venceu há 1 dia");
    });
  });

  describe("expired (days === 0)", () => {
    it("formata vence hoje", () => {
      const label = formatExpiryLabel(0);
      expect(label.tone).toBe("expired");
      expect(label.text).toBe("Documento vence hoje");
      expect(label.short).toBe("(vence hoje)");
    });
  });

  describe("expiring (1 <= days <= 30)", () => {
    it("formata vence em 1 dia (singular)", () => {
      const label = formatExpiryLabel(1);
      expect(label.tone).toBe("expiring");
      expect(label.text).toBe("Documento vence em 1 dia");
      expect(label.short).toBe("(vence em 1 dia)");
    });

    it("formata vence em 15 dias (plural)", () => {
      const label = formatExpiryLabel(15);
      expect(label.tone).toBe("expiring");
      expect(label.text).toBe("Documento vence em 15 dias");
      expect(label.short).toBe("(vence em 15 dias)");
    });

    it("limite superior inclusivo: 30 ainda é expiring", () => {
      const label = formatExpiryLabel(30);
      expect(label.tone).toBe("expiring");
      expect(label.text).toBe("Documento vence em 30 dias");
    });
  });

  describe("valid (days > 30)", () => {
    it("formata vigente para 31 dias", () => {
      const label = formatExpiryLabel(31);
      expect(label.tone).toBe("valid");
      expect(label.text).toBe("Documento vigente (31 dias)");
      expect(label.short).toBe("(31 dias)");
    });

    it("formata vigente para valores grandes", () => {
      const label = formatExpiryLabel(365);
      expect(label.tone).toBe("valid");
      expect(label.text).toBe("Documento vigente (365 dias)");
    });
  });
});
