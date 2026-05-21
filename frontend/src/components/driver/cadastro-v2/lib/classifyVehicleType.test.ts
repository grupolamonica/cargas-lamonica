import { describe, expect, it } from "vitest";

import { classifyVehicleType } from "./classifyVehicleType";

describe("classifyVehicleType", () => {
  it.each([
    ["CAVALO MECANICO", "cavalo"],
    ["Cavalo mecânico", "cavalo"],
    ["CAMINHAO TRATOR", "cavalo"],
    ["CAMINHÃO", "cavalo"],
    ["TRATOR", "cavalo"],
    ["TRUCK", "cavalo"],
  ])("classifica '%s' como cavalo", (input, expected) => {
    expect(classifyVehicleType(input)).toBe(expected);
  });

  it.each([
    ["SEMI-REBOQUE", "carreta"],
    ["SEMIREBOQUE", "carreta"],
    ["Semi Reboque", "carreta"],
    ["REBOQUE", "carreta"],
    ["CARRETA", "carreta"],
    ["BITREM", "carreta"],
    ["RODOTREM", "carreta"],
  ])("classifica '%s' como carreta", (input, expected) => {
    expect(classifyVehicleType(input)).toBe(expected);
  });

  it("retorna null para string vazia / nula / undefined", () => {
    expect(classifyVehicleType("")).toBeNull();
    expect(classifyVehicleType(null)).toBeNull();
    expect(classifyVehicleType(undefined)).toBeNull();
    expect(classifyVehicleType("   ")).toBeNull();
  });

  it("retorna null para tipos desconhecidos", () => {
    expect(classifyVehicleType("MOTOCICLETA")).toBeNull();
    expect(classifyVehicleType("AUTOMOVEL")).toBeNull();
    expect(classifyVehicleType("FOO BAR")).toBeNull();
  });

  it("prioriza carreta quando o tipo menciona ambos (texto hibrido raro)", () => {
    // Caso defensivo: alguns CRLVs antigos tem "REBOQUE TIPO CAVALO" em
    // observacoes. Carreta vence porque e a classificacao mais especifica
    // estrutural (sem motor).
    expect(classifyVehicleType("REBOQUE CAVALO")).toBe("carreta");
  });
});
