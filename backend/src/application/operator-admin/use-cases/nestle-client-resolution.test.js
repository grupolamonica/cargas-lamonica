import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCliente,
  withPgClient,
} from "../test-harness.js";
import { findNestleClientId, nestleClientNameCandidates } from "./_shared.js";
import { launchCargoFromTrip } from "./launch-cargo-from-trip.js";

// Regressão do incidente de 30/07→01/08: o operador renomeou o cliente "Nestlé" para
// "Produtos Alimentícios" na tela e o lançamento — que procurava o literal "Nestle" —
// passou a falhar em 100% das ofertas Nestlé por 2 dias, com 288 tentativas/dia e
// nenhuma linha de diagnóstico no log.

describe("resolução do cliente Nestlé (não depende de nome cravado)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });
  afterEach(() => {
    delete process.env.GOOGLE_SHEET_NESTLE_CLIENT_NAME;
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("acha o cliente pelo nome do ENV que o sync usa (caso do incidente)", async () => {
    process.env.GOOGLE_SHEET_NESTLE_CLIENT_NAME = "Produtos Alimentícios";
    const cliente = await seedCliente({ nome: "Produtos Alimentícios" });

    const id = await withPgClient((client) => findNestleClientId(client, null));

    expect(id).toBe(cliente.id);
  });

  it("acha pelos nomes históricos quando o env não está setado", async () => {
    const cliente = await seedCliente({ nome: "Nestlé" });
    const id = await withPgClient((client) => findNestleClientId(client, null));
    expect(id).toBe(cliente.id);
  });

  it("casa ignorando acento e caixa (a tela grava como o operador digitou)", async () => {
    process.env.GOOGLE_SHEET_NESTLE_CLIENT_NAME = "Produtos Alimentícios";
    const cliente = await seedCliente({ nome: "PRODUTOS ALIMENTICIOS" });

    const id = await withPgClient((client) => findNestleClientId(client, null));

    expect(id).toBe(cliente.id);
  });

  it("nome vindo do chamador tem precedência", async () => {
    await seedCliente({ nome: "Nestlé" });
    const outro = await seedCliente({ nome: "Cliente Especifico" });

    const id = await withPgClient((client) => findNestleClientId(client, "Cliente Especifico"));

    expect(id).toBe(outro.id);
  });

  it("sem nenhum cliente compatível → null (e a mensagem de erro lista o que foi tentado)", async () => {
    process.env.GOOGLE_SHEET_NESTLE_CLIENT_NAME = "Produtos Alimentícios";
    await seedCliente({ nome: "Shopee" });

    const id = await withPgClient((client) => findNestleClientId(client, null));

    expect(id).toBeNull();
    expect(nestleClientNameCandidates()).toContain("Produtos Alimentícios");
    expect(nestleClientNameCandidates()).toContain("Nestlé");
  });

  it("lança a carga Nestlé com o cliente renomeado — detecção pelo NOME que a tela envia", async () => {
    process.env.GOOGLE_SHEET_NESTLE_CLIENT_NAME = "Produtos Alimentícios";
    const cliente = await seedCliente({ nome: "Produtos Alimentícios" });

    const res = await launchCargoFromTrip({
      lh: "NESTLE-B101472757",
      origem: "Feira de Santana/BA",
      destino: "Maceió/AL",
      data: "2026-08-05",
      horario: "08:00",
      // A tela manda o rótulo do cliente da linha Nestlé; o incidente aconteceu
      // justamente porque esse nome mudou.
      clienteNome: "Produtos Alimentícios",
      deps: { withPgClient },
    });

    expect(res.statusCode).toBe(201);
    const { rows } = await query(
      "SELECT cliente_id, lh_manual, status FROM public.cargas WHERE lh_manual = $1",
      ["NESTLE-B101472757"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].cliente_id).toBe(cliente.id);
    expect(rows[0].status).toBe("OPEN");
  });

  it("detecta Nestlé pela oferta em nestle_ofertas mesmo sem clienteNome", async () => {
    process.env.GOOGLE_SHEET_NESTLE_CLIENT_NAME = "Produtos Alimentícios";
    const cliente = await seedCliente({ nome: "Produtos Alimentícios" });
    await query(
      "INSERT INTO public.nestle_ofertas (codprogcoleta, codembarque, grupos_id) VALUES ($1, $2, $3)",
      ["NST-9", "2328999", "B101469361"],
    );

    const res = await launchCargoFromTrip({
      lh: "B101469361",
      origem: "Cabo de Santo Agostinho/PE",
      destino: "Maracanaú/CE",
      data: "2026-08-06",
      horario: "09:00",
      deps: { withPgClient },
    });

    expect(res.statusCode).toBe(201);
    const { rows } = await query("SELECT cliente_id FROM public.cargas WHERE lh_manual = $1", ["B101469361"]);
    expect(rows[0].cliente_id).toBe(cliente.id);
  });
});
