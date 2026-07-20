import { afterEach, describe, expect, it } from "vitest";

import { getEvolutionInstance, getRepomInstance, resolveInstance } from "./evolution-client.js";

// Multi-instância retrocompatível (Fase 2a): resolveInstance sem argumento DEVE
// devolver a instância de Cargas (comportamento atual, intocado); com argumento
// usa a informada (ex.: a do Repom). É o contrato que garante "não quebrar".
describe("evolution-client — resolução de instância", () => {
  const orig = {
    cargas: process.env.EVOLUTION_API_INSTANCE,
    repom: process.env.EVOLUTION_REPOM_INSTANCE,
  };
  const restore = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  afterEach(() => {
    restore("EVOLUTION_API_INSTANCE", orig.cargas);
    restore("EVOLUTION_REPOM_INSTANCE", orig.repom);
  });

  it("getEvolutionInstance: default 'lamonica' sem env", () => {
    delete process.env.EVOLUTION_API_INSTANCE;
    expect(getEvolutionInstance()).toBe("lamonica");
  });

  it("getRepomInstance: default 'lamonica-repom' sem env; respeita a env quando setada", () => {
    delete process.env.EVOLUTION_REPOM_INSTANCE;
    expect(getRepomInstance()).toBe("lamonica-repom");
    process.env.EVOLUTION_REPOM_INSTANCE = "repom-x";
    expect(getRepomInstance()).toBe("repom-x");
  });

  it("resolveInstance SEM argumento → instância de Cargas (retrocompat)", () => {
    delete process.env.EVOLUTION_API_INSTANCE;
    expect(resolveInstance()).toBe("lamonica");
    expect(resolveInstance(null)).toBe("lamonica");
    expect(resolveInstance("")).toBe("lamonica");
    expect(resolveInstance("   ")).toBe("lamonica");
  });

  it("resolveInstance COM argumento → usa a instância informada (Repom)", () => {
    expect(resolveInstance("lamonica-repom")).toBe("lamonica-repom");
    expect(resolveInstance("  repom-y  ")).toBe("repom-y");
  });

  it("resolveInstance usa EVOLUTION_API_INSTANCE como default quando setada", () => {
    process.env.EVOLUTION_API_INSTANCE = "cargas-prod";
    expect(resolveInstance()).toBe("cargas-prod");
    expect(resolveInstance("lamonica-repom")).toBe("lamonica-repom");
  });
});
