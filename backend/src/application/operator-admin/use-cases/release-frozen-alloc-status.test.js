import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedCliente,
  withPgClient,
} from "../test-harness.js";
import { releaseFrozenAllocStatus } from "./release-frozen-alloc-status.js";

const deps = { withPgClient };

async function seedComOverride(clienteId, lh, { sheet_status, alloc_status, motorista = null, allocMotorista = null }) {
  const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: lh });
  await query(
    `UPDATE public.cargas
        SET sheet_status = $2, alloc_status = $3, sheet_motorista = $4, alloc_motorista = $5
      WHERE id = $1`,
    [carga.id, sheet_status, alloc_status, motorista, allocMotorista],
  );
  return carga.id;
}

const allocOf = async (id) =>
  (await query(`SELECT alloc_status FROM public.cargas WHERE id = $1`, [id])).rows[0].alloc_status;

describe("releaseFrozenAllocStatus", () => {
  let clienteId;
  beforeEach(async () => {
    await resetTestDatabase();
    clienteId = (await seedCliente({ nome: "Shopee" })).id;
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("DRY-RUN lista os congelados sem gravar", async () => {
    const id = await seedComOverride(clienteId, "LT-FZ-1", {
      sheet_status: "DESCARREGADO",
      alloc_status: "AGUARDANDO CHEGAR NO CLIENTE",
    });

    const r = await releaseFrozenAllocStatus({ deps });

    expect(r).toMatchObject({ released: 1, applied: false });
    expect(r.items[0]).toMatchObject({ lh: "LT-FZ-1", de: "AGUARDANDO CHEGAR NO CLIENTE", para: "DESCARREGADO" });
    expect(await allocOf(id)).toBe("AGUARDANDO CHEGAR NO CLIENTE"); // nada gravado
  });

  it("--apply solta o override congelado", async () => {
    const id = await seedComOverride(clienteId, "LT-FZ-2", {
      sheet_status: "DESCARREGADO",
      alloc_status: "AGUARDANDO CHEGAR NO CLIENTE",
    });

    const r = await releaseFrozenAllocStatus({ apply: true, deps });

    expect(r).toMatchObject({ released: 1, applied: true });
    expect(await allocOf(id)).toBeNull();
  });

  it("preserva overrides deliberados (CTE / NO SHOW / CANCELADO)", async () => {
    const cte = await seedComOverride(clienteId, "LT-FZ-CTE", {
      sheet_status: "CARREGADO",
      alloc_status: "CTE EM EMISSÃO",
    });
    const enviado = await seedComOverride(clienteId, "LT-FZ-ENV", {
      sheet_status: "CARREGADO",
      alloc_status: "CTE ENVIADO",
    });
    const noShow = await seedComOverride(clienteId, "LT-FZ-NS", {
      sheet_status: "CARREGADO",
      alloc_status: "NO SHOW",
    });
    const cancelado = await seedComOverride(clienteId, "LT-FZ-CANC", {
      sheet_status: "CARREGADO",
      alloc_status: "CANCELADO",
    });

    const r = await releaseFrozenAllocStatus({ apply: true, deps });

    expect(r.released).toBe(0);
    expect(await allocOf(cte)).toBe("CTE EM EMISSÃO");
    expect(await allocOf(enviado)).toBe("CTE ENVIADO");
    expect(await allocOf(noShow)).toBe("NO SHOW");
    expect(await allocOf(cancelado)).toBe("CANCELADO");
  });

  it("ignora override vazio SEM motorista ('Disponível') e carga sem status na planilha", async () => {
    const vazio = await seedComOverride(clienteId, "LT-FZ-VZ", { sheet_status: "CARREGADO", alloc_status: "" });
    const semSheet = await seedComOverride(clienteId, "LT-FZ-SS", { sheet_status: "", alloc_status: "CARREGADO" });
    // Motorista REMOVIDO pelo operador (alloc "" vence a planilha) → sem motorista.
    const removido = await seedComOverride(clienteId, "LT-FZ-RM", {
      sheet_status: "DESCARREGADO",
      alloc_status: "",
      motorista: "JOAO DA SILVA",
      allocMotorista: "",
    });

    const r = await releaseFrozenAllocStatus({ apply: true, deps });

    expect(r.released).toBe(0);
    expect(await allocOf(vazio)).toBe("");
    expect(await allocOf(semSheet)).toBe("CARREGADO");
    expect(await allocOf(removido)).toBe("");
  });

  it("solta o override VAZIO com motorista (carga aparecia SEM status) e reporta como (vazio)", async () => {
    const id = await seedComOverride(clienteId, "LT-FZ-VZM", {
      sheet_status: "DESCARREGADO",
      alloc_status: "",
      motorista: "JOAO DA SILVA",
    });

    const r = await releaseFrozenAllocStatus({ apply: true, deps });

    expect(r).toMatchObject({ released: 1, applied: true });
    expect(r.items[0]).toMatchObject({ lh: "LT-FZ-VZM", de: "(vazio)", para: "DESCARREGADO" });
    expect(await allocOf(id)).toBeNull();
  });

  it("override VAZIO com planilha CANCELADO é preservado (cascata de rota é decisão de operação)", async () => {
    const id = await seedComOverride(clienteId, "LT-FZ-VZC", {
      sheet_status: "CANCELADO",
      alloc_status: "",
      motorista: "JOAO DA SILVA",
    });

    const r = await releaseFrozenAllocStatus({ apply: true, deps });

    expect(r.released).toBe(0);
    expect(await allocOf(id)).toBe("");
  });
});
