import { describe, expect, it } from "vitest";
import {
  renderMessage,
  buildCargoDetails,
  MESSAGE_DEFS,
  MESSAGE_KEYS,
} from "./message-templates.js";

// Sem override no cache → usa os defaults do registry.

describe("buildCargoDetails", () => {
  it("monta bloco com perfil+eixos e aviso do bônus", () => {
    const t = buildCargoDetails({
      origem: "A / BA",
      destino: "B / PE",
      data: "2026-07-12",
      horario: "08:00:00",
      perfil: "CARRETA",
      eixos: 6,
      valor: 5500,
      bonus: 300,
    });
    expect(t).toContain("📍 *Rota:* A / BA → B / PE");
    expect(t).toContain("🚛 *Perfil do veículo:* CARRETA · 6 eixos");
    expect(t).toMatch(/💰 \*Valor:\* R\$\s?5\.500,00/);
    expect(t).toMatch(/🎯 \*Bônus:\* R\$\s?300,00/);
    expect(t).toContain("bônus é pago");
  });
  it("sem bônus não mostra aviso; sem eixos mostra só perfil", () => {
    const t = buildCargoDetails({ origem: "A", destino: "B", perfil: "TRUCK", eixos: 0, valor: 4000, bonus: 0 });
    expect(t).not.toContain("bônus é pago");
    expect(t).toContain("🚛 *Perfil do veículo:* TRUCK");
    expect(t).not.toContain("·");
  });
});

describe("renderMessage", () => {
  it("substitui {nome} e {rota} no default", () => {
    const t = renderMessage("route_need_invite", { nome: "Antonio", rota: "A → B" });
    expect(t).toContain("Antonio");
    expect(t).toContain("A → B");
    expect(t).toContain("SIM");
  });
  it("injeta {detalhes}", () => {
    const detalhes = buildCargoDetails({ origem: "A", destino: "B", valor: 5000 });
    const t = renderMessage("route_need_offer", { nome: "Jose", detalhes, ajuste: "" });
    expect(t).toMatch(/💰 \*Valor:\* R\$\s?5\.000,00/);
    expect(t).toContain("Jose");
  });
  it("expande spintax (uma das opções da saudação)", () => {
    const t = renderMessage("route_need_invite", { nome: "X", rota: "A → B" });
    expect(/^(Oi|Opa|E aí|Olá), X!/.test(t)).toBe(true);
  });
  it("todas as keys do registry renderizam sem erro e sem placeholders órfãos", () => {
    for (const key of MESSAGE_KEYS) {
      const t = renderMessage(key, {
        nome: "Motorista",
        rota: "A → B",
        detalhes: "📍 detalhes",
        link: "https://x/y",
        ajuste: "",
        retorno: "",
        aviso_cadastro: "",
        openLoad: "",
        dias: "10 dias",
        midia: "áudio",
      });
      expect(typeof t).toBe("string");
      expect(t.length).toBeGreaterThan(0);
      // não deve sobrar {placeholder} conhecido sem resolver
      expect(t).not.toMatch(/\{(nome|rota|detalhes|link|ajuste|retorno|aviso_cadastro|openLoad|dias|midia)\}/);
    }
  });
  it("cada default tem label, description e placeholders", () => {
    for (const key of MESSAGE_KEYS) {
      const d = MESSAGE_DEFS[key];
      expect(d.label).toBeTruthy();
      expect(d.description).toBeTruthy();
      expect(Array.isArray(d.placeholders)).toBe(true);
      expect(d.default).toBeTruthy();
    }
  });
});
