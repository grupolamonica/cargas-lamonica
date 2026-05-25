import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Testes de listIncompleteCadastroDrafts (iter #7).
 *
 * Mocka withPgClient com um fake que entende a query do LEFT JOIN entre
 * pending_driver_registrations e cargas.
 */

const fakeDb = {
  drafts: [], // pdr rows
  cargas: [], // cargas rows
};

const fakeClient = {
  async query(sql, params = []) {
    const normalizedSql = sql.replace(/\s+/g, " ").trim();

    if (/SELECT[\s\S]+FROM public\.pending_driver_registrations pdr\s+LEFT JOIN public\.cargas c ON c\.id::text = pdr\.carga_id\s+WHERE pdr\.driver_user_id = \$1[\s\S]+AND pdr\.carga_id IS NOT NULL[\s\S]+ORDER BY pdr\.updated_at DESC/i.test(normalizedSql)) {
      const [driverUserId] = params;
      const cutoff = Date.now() - 72 * 3600 * 1000;
      const matches = fakeDb.drafts
        .filter(
          (d) =>
            d.driver_user_id === driverUserId &&
            d.status === "draft" &&
            d.versao_cadastro === "v2" &&
            d.carga_id != null &&
            d.updated_at.getTime() > cutoff,
        )
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());

      const rows = matches.map((d) => {
        const carga = fakeDb.cargas.find((c) => c.id === d.carga_id);
        return {
          id: d.id,
          carga_id: d.carga_id,
          updated_at: d.updated_at,
          current_step: d.dados?.__currentStep || null,
          origem: carga?.origem ?? null,
          destino: carga?.destino ?? null,
          data_coleta: carga?.data ?? null,
          horario_coleta: carga?.horario ?? null,
        };
      });
      return { rows, rowCount: rows.length };
    }

    throw new Error(`[fakeClient] query nao mockada: ${normalizedSql.slice(0, 120)}...`);
  },
};

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) => cb(fakeClient),
}));

const { listIncompleteCadastroDrafts } = await import("./list-incomplete-drafts.js");

function addDraft({ id, driverUserId, cargaId, dados = {}, ageMs = 0 }) {
  fakeDb.drafts.push({
    id,
    driver_user_id: driverUserId,
    carga_id: cargaId,
    status: "draft",
    versao_cadastro: "v2",
    dados,
    updated_at: new Date(Date.now() - ageMs),
  });
}

function addCarga({ id, origem, destino, data, horario }) {
  fakeDb.cargas.push({ id, origem, destino, data, horario });
}

describe("listIncompleteCadastroDrafts (iter #7)", () => {
  beforeEach(() => {
    fakeDb.drafts = [];
    fakeDb.cargas = [];
  });

  it("retorna lista vazia quando driver nao tem drafts", async () => {
    const result = await listIncompleteCadastroDrafts({
      driverUserId: "11111111-1111-1111-1111-111111111111",
    });
    expect(result.statusCode).toBe(200);
    expect(result.payload.drafts).toEqual([]);
  });

  it("retorna 1 entrada com origem/destino quando ha 1 draft", async () => {
    const driverUserId = "22222222-2222-2222-2222-222222222222";
    addCarga({
      id: "carga-1",
      origem: "Salvador-BA",
      destino: "Sao Paulo-SP",
      data: new Date("2026-05-30"),
      horario: "08:00",
    });
    addDraft({
      id: "draft-1",
      driverUserId,
      cargaId: "carga-1",
      dados: { __currentStep: "step-c" },
      ageMs: 30 * 60 * 1000,
    });

    const result = await listIncompleteCadastroDrafts({ driverUserId });
    expect(result.statusCode).toBe(200);
    expect(result.payload.drafts).toHaveLength(1);
    const draft = result.payload.drafts[0];
    expect(draft.cargaId).toBe("carga-1");
    expect(draft.origem).toBe("Salvador-BA");
    expect(draft.destino).toBe("Sao Paulo-SP");
    expect(draft.currentStep).toBe("step-c");
    expect(draft.horarioColeta).toBe("08:00");
    expect(draft.expiresAt).toBeTruthy();
  });

  it("retorna 2 entradas quando driver tem drafts em multiplas cargas (ordenado por updated_at DESC)", async () => {
    const driverUserId = "33333333-3333-3333-3333-333333333333";
    addCarga({ id: "carga-A", origem: "A", destino: "AA" });
    addCarga({ id: "carga-B", origem: "B", destino: "BB" });
    addDraft({ id: "draft-A", driverUserId, cargaId: "carga-A", ageMs: 60 * 60 * 1000 }); // 1h
    addDraft({ id: "draft-B", driverUserId, cargaId: "carga-B", ageMs: 10 * 60 * 1000 }); // 10min

    const result = await listIncompleteCadastroDrafts({ driverUserId });
    expect(result.payload.drafts).toHaveLength(2);
    expect(result.payload.drafts[0].cargaId).toBe("carga-B"); // mais recente
    expect(result.payload.drafts[1].cargaId).toBe("carga-A");
  });

  it("exclui drafts sem carga_id (legacy) e drafts expirados (>72h)", async () => {
    const driverUserId = "44444444-4444-4444-4444-444444444444";
    addCarga({ id: "carga-OK", origem: "X", destino: "Y" });
    addDraft({ id: "draft-legacy", driverUserId, cargaId: null, ageMs: 0 });
    addDraft({ id: "draft-expired", driverUserId, cargaId: "carga-OK", ageMs: 73 * 3600 * 1000 });
    addDraft({ id: "draft-fresh", driverUserId, cargaId: "carga-OK", ageMs: 60 * 1000 });

    const result = await listIncompleteCadastroDrafts({ driverUserId });
    expect(result.payload.drafts).toHaveLength(1);
    expect(result.payload.drafts[0].id).toBe("draft-fresh");
  });
});
