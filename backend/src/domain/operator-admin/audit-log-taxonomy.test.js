import { describe, expect, it } from "vitest";

import {
  AUDIT_EVENT_CATALOG,
  AUDIT_LOG_CATEGORIES,
  eventTypesForCategories,
  resolveEventCategory,
  resolveEventLabel,
} from "./audit-log-taxonomy.js";

describe("audit-log-taxonomy", () => {
  it("toda categoria do catálogo está declarada em AUDIT_LOG_CATEGORIES", () => {
    const validKeys = new Set(AUDIT_LOG_CATEGORIES.map((c) => c.key));
    for (const [eventType, meta] of Object.entries(AUDIT_EVENT_CATALOG)) {
      expect(validKeys.has(meta.category), `${eventType} → ${meta.category}`).toBe(true);
    }
  });

  it("resolveEventLabel devolve rótulo humano e cai no event_type se desconhecido", () => {
    expect(resolveEventLabel("operator.route.updated")).toBe("Rota atualizada");
    expect(resolveEventLabel("evento.desconhecido")).toBe("evento.desconhecido");
  });

  it("resolveEventCategory devolve a categoria e 'Outros' para desconhecidos", () => {
    expect(resolveEventCategory("operator.cargo.reserva_assigned")).toEqual({
      key: "reservas",
      label: "Reservas",
    });
    expect(resolveEventCategory("evento.desconhecido")).toEqual({ key: "outros", label: "Outros" });
  });

  it("eventTypesForCategories expande as chaves nos event_types certos", () => {
    const rotas = eventTypesForCategories(["rotas"]);
    expect(rotas).toContain("operator.route.updated");
    expect(rotas).toContain("operator.rota_cliente.attached");
    expect(rotas).not.toContain("operator.cargo.created");
  });

  it("une múltiplas categorias e ignora chaves inválidas", () => {
    const combined = eventTypesForCategories(["cargas", "reservas"]);
    expect(combined).toContain("operator.cargo.created");
    expect(combined).toContain("operator.cargo.reserva_assigned");
    expect(eventTypesForCategories(["nao-existe"])).toEqual([]);
    expect(eventTypesForCategories([])).toEqual([]);
    expect(eventTypesForCategories(null)).toEqual([]);
  });
});
