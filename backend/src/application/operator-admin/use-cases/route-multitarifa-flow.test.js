import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedUser,
  withPgTransaction,
} from "../test-harness.js";
import { normalizeClientName } from "./_shared.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

const { saveRouteTrecho } = await import("./save-route-trecho.js");

// Teste grande de ponta a ponta (camada de dados) do fluxo multi-tarifa:
// cadastro do trecho com vários veículos → cascata numa carga aberta →
// remoção de uma tarifa. Espelha o que o operador faz na tela de Rotas.
const ORIGEM = "Campo Grande / MS";
const DESTINO = "Simoes Filho / BA";
const okey = normalizeClientName(ORIGEM).replace(/\s+/g, " ");
const dkey = normalizeClientName(DESTINO).replace(/\s+/g, " ");

const trecho = (tarifas) => ({
  origem: ORIGEM,
  destino: DESTINO,
  distancia_km: 1600,
  duracao_horas: 30,
  tempo_estimado_horas: 30,
  ativa: true,
  observacoes: null,
  tarifas,
});

async function catalogo() {
  const { rows } = await query(
    `SELECT perfil_padrao, eixos, valor_padrao, bonus_padrao
       FROM public.route_metrics_cache
      WHERE origin_key = $1 AND destination_key = $2
      ORDER BY perfil_padrao ASC, eixos ASC`,
    [okey, dkey],
  );
  return rows;
}

describe("fluxo multi-tarifa (ponta a ponta, camada de dados)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("cadastra trecho com 3 veículos, faz cascata numa carga aberta e remove uma tarifa", async () => {
    const op = await seedUser({ email: "op-fluxo-multitarifa@teste.local" });

    // ── Passo 1: operador cadastra Campo Grande → Simões Filho com 3 veículos.
    const passo1 = await saveRouteTrecho({
      operatorId: op.id,
      payload: trecho([
        { perfil: "CARRETA", eixos: 2, valor: 5000, bonus: 200, bonus_exigencias: null },
        { perfil: "CARRETA", eixos: 3, valor: 5500, bonus: 250, bonus_exigencias: null },
        { perfil: "BITREM", eixos: 6, valor: 9000, bonus: 500, bonus_exigencias: "Rastreador ativo" },
      ]),
      correlationId: "flow-1",
    });

    expect(passo1.statusCode).toBe(200);
    expect(passo1.payload.tarifasCount).toBe(3);

    const catalogoPasso1 = await catalogo();
    expect(catalogoPasso1).toHaveLength(3);
    expect(catalogoPasso1.map((r) => [r.perfil_padrao, r.eixos, Number(r.valor_padrao)])).toEqual([
      ["BITREM", 6, 9000],
      ["CARRETA", 2, 5000],
      ["CARRETA", 3, 5500],
    ]);

    // ── Passo 2: existe uma carga ABERTA de CARRETA 2 eixos nesse trecho.
    const cargaAberta = await seedCargo({
      origem: ORIGEM,
      destino: DESTINO,
      perfil: "CARRETA",
      status: "OPEN",
      valor: 1,
      bonus: 1,
    });
    await query(`UPDATE public.cargas SET eixos = 2 WHERE id = $1`, [cargaAberta.id]);

    // Operador reajusta o valor da CARRETA 2 eixos → cascata atualiza a carga.
    const passo2 = await saveRouteTrecho({
      operatorId: op.id,
      payload: trecho([
        { perfil: "CARRETA", eixos: 2, valor: 5300, bonus: 260, bonus_exigencias: null },
        { perfil: "CARRETA", eixos: 3, valor: 5500, bonus: 250, bonus_exigencias: null },
        { perfil: "BITREM", eixos: 6, valor: 9000, bonus: 500, bonus_exigencias: "Rastreador ativo" },
      ]),
      correlationId: "flow-2",
    });

    expect(passo2.payload.cascadedCargaCount).toBe(1);
    const cargaAtualizada = await query(`SELECT valor, bonus FROM public.cargas WHERE id = $1`, [cargaAberta.id]);
    expect(Number(cargaAtualizada.rows[0].valor)).toBe(5300);
    expect(Number(cargaAtualizada.rows[0].bonus)).toBe(260);

    // ── Passo 3: operador remove a tarifa BITREM (some do catálogo do trecho).
    const passo3 = await saveRouteTrecho({
      operatorId: op.id,
      payload: trecho([
        { perfil: "CARRETA", eixos: 2, valor: 5300, bonus: 260, bonus_exigencias: null },
        { perfil: "CARRETA", eixos: 3, valor: 5500, bonus: 250, bonus_exigencias: null },
      ]),
      correlationId: "flow-3",
    });

    expect(passo3.payload.deletedCount).toBe(1);
    const catalogoFinal = await catalogo();
    expect(catalogoFinal).toHaveLength(2);
    expect(catalogoFinal.some((r) => r.perfil_padrao === "BITREM")).toBe(false);

    // A carga CARRETA 2 eixos segue com o preço reajustado (não foi afetada pela remoção).
    const cargaFinal = await query(`SELECT valor FROM public.cargas WHERE id = $1`, [cargaAberta.id]);
    expect(Number(cargaFinal.rows[0].valor)).toBe(5300);
  });
});
