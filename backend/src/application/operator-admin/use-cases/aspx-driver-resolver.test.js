import { describe, expect, it } from "vitest";
import { prepareAspxRoster, resolveAspxDriverId } from "./aspx-driver-resolver.js";

const roster = (arr) => prepareAspxRoster(arr);

describe("resolveAspxDriverId — atribuição no ASPX (tolerante + trava)", () => {
  it("match exato resolve", () => {
    const r = roster([{ name: "JOAO PEDRO SILVA", driver_id: 10 }]);
    expect(resolveAspxDriverId("JOAO PEDRO SILVA", r).driverId).toBe(10);
  });

  it("tolera conectivo / ordem / acento (mesma pessoa) — corrige o 'não encontrado'", () => {
    const r = roster([
      { name: "WESLEY DE ARAUJO SOARES", driver_id: 1 },
      { name: "JOSE MARCOS DA SILVA", driver_id: 2 },
      { name: "ANDERSON SANTOS DE ASSUNCAO", driver_id: 3 },
    ]);
    expect(resolveAspxDriverId("WESLEY ARAUJO SOARES", r).driverId).toBe(1); // conectivo "DE"
    expect(resolveAspxDriverId("MARCOS JOSE DA SILVA", r).driverId).toBe(2); // ordem trocada
    expect(resolveAspxDriverId("ANDERSON SANTOS ASSUNÇÃO", r).driverId).toBe(3); // acento
  });

  it("nome genérico de 2 tokens NÃO casa nome completo (estrito) → não encontrado", () => {
    const r = roster([{ name: "MARCELO DA SILVA", driver_id: 9 }]);
    const res = resolveAspxDriverId("MARCELO SANTOS SILVA", r);
    expect(res.driverId).toBeNull();
    expect(res.reason).toMatch(/não encontrado/);
  });

  it("homônimo exato (mesmo nome, CPFs/ids diferentes) → NÃO atribui (trava)", () => {
    const r = roster([{ name: "JOAO SILVA", driver_id: 1 }, { name: "JOAO SILVA", driver_id: 2 }]);
    const res = resolveAspxDriverId("JOAO SILVA", r);
    expect(res.driverId).toBeNull();
    expect(res.reason).toMatch(/homônimo/);
  });

  it("correspondência tolerante ambígua (2 pessoas casam) → NÃO atribui", () => {
    const r = roster([
      { name: "MARIA CLARA SOUZA LIMA", driver_id: 1 },
      { name: "MARIA SOUZA COSTA LIMA", driver_id: 2 },
    ]);
    const res = resolveAspxDriverId("MARIA SOUZA LIMA", r);
    expect(res.driverId).toBeNull();
    expect(res.reason).toMatch(/ambígua/);
  });

  it("mesmo id em 2 entradas do roster não conta como ambíguo", () => {
    const r = roster([{ name: "WESLEY DE ARAUJO SOARES", driver_id: 7 }, { name: "WESLEY ARAUJO SOARES", driver_id: 7 }]);
    expect(resolveAspxDriverId("WESLEY ARAUJO SOARES", r).driverId).toBe(7);
  });

  it("não encontrado → reason", () => {
    const r = roster([{ name: "FULANO DE TAL SANTOS", driver_id: 1 }]);
    expect(resolveAspxDriverId("CICLANO BELTRANO COSTA", r).driverId).toBeNull();
  });

  it("sem motorista → reason", () => {
    expect(resolveAspxDriverId("", roster([{ name: "X Y", driver_id: 1 }])).driverId).toBeNull();
  });
});
