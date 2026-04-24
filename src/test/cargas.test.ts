import { describe, expect, it } from "vitest";
import { getCargaById, getCargaPath, getCargaShareUrl } from "@/data/cargas";

describe("cargas data", () => {
  it("builds a stable direct link for a specific load", () => {
    expect(getCargaPath("88291")).toBe("/cargas/88291");
  });

  it("builds an absolute share url for operator copy actions", () => {
    expect(getCargaShareUrl("http://localhost:8080/", "88291")).toBe(
      "http://localhost:8080/cargas/88291",
    );
  });

  it("returns the detailed load with client information", () => {
    const carga = getCargaById("88291");

    expect(carga).toBeDefined();
    expect(carga?.cliente.nome).toBe("Porto Sul Embalagens");
    expect(carga?.origemEndereco).toContain("Av. Portuaria");
    expect(carga?.documentos.length).toBeGreaterThan(0);
  });

  it("returns undefined for unknown load ids", () => {
    expect(getCargaById("00000")).toBeUndefined();
  });
});
