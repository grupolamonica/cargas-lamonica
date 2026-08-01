import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeTestDatabase, query, resetTestDatabase, seedCargo, seedCliente } from "../test-harness.js";
import { buildDriverLoadFilters } from "./_shared.js";

// Guarda de LEITURA da marca "fora do ASPX": a carga continua no sistema (quem cancela
// ou expira é o operador), mas não pode ser oferecida nem aceita — a viagem não existe
// mais no portal da Shopee. Antes desta guarda a única carga marcada em prod ficou ~12h
// candidatável (LT1Q8102CLEN1); as outras 41 estavam blindadas por coincidência (a rota
// tinha route_metrics_cache.ativa=false).
//
// O teste executa o WHERE gerado contra o banco do harness — não basta afirmar o texto
// do SQL, o filtro tem que de fato filtrar.

const AMANHA = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

describe("guarda de leitura 'fora do ASPX' (portal do motorista)", () => {
  let clienteId;

  beforeEach(async () => {
    await resetTestDatabase();
    clienteId = (await seedCliente({ nome: "Shopee" })).id;
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  async function seedPublicavel({ lh, marcada }) {
    const carga = await seedCargo({
      cliente_id: clienteId,
      data: AMANHA,
      horario: "08:00:00",
      status: "OPEN",
      driver_visibility: "PUBLIC",
      sheet_lh: null,
      valor: 5000,
      distancia_km: 300,
      duracao_horas: 6,
    });
    await query(
      "UPDATE public.cargas SET lh_manual = $2, aspx_missing_since = $3 WHERE id = $1",
      [carga.id, lh, marcada ? new Date().toISOString() : null],
    );
    return carga;
  }

  /** Roda o WHERE do portal no banco do harness e devolve os ids visíveis. */
  async function idsVisiveis(opts = {}) {
    const { whereSql, values } = buildDriverLoadFilters({}, opts);
    const { rows } = await query(`SELECT cargas.id FROM public.cargas WHERE ${whereSql}`, values);
    return rows.map((r) => r.id);
  }

  it("carga MARCADA sai da listagem; a não marcada continua", async () => {
    const boa = await seedPublicavel({ lh: "LT-BOA-1", marcada: false });
    const fora = await seedPublicavel({ lh: "LT-FORA-1", marcada: true });

    const ids = await idsVisiveis();

    expect(ids).toContain(boa.id);
    expect(ids).not.toContain(fora.id);
  });

  it("o WHERE do portal contém a guarda", () => {
    expect(buildDriverLoadFilters({}).whereSql).toContain("cargas.aspx_missing_since IS NULL");
  });

  it("banco sem a coluna: guarda desligável — degrada, não derruba o portal", async () => {
    const boa = await seedPublicavel({ lh: "LT-BOA-2", marcada: false });
    const fora = await seedPublicavel({ lh: "LT-FORA-2", marcada: true });

    const { whereSql } = buildDriverLoadFilters({}, { includeAspxMissingFilter: false });
    expect(whereSql).not.toContain("aspx_missing_since");
    // sem a guarda, a marcada volta a aparecer (comportamento anterior à feature)
    const ids = await idsVisiveis({ includeAspxMissingFilter: false });
    expect(ids).toContain(boa.id);
    expect(ids).toContain(fora.id);
    // e as outras guardas seguem valendo
    expect(whereSql).toContain("cargas.status = 'OPEN'");
  });

  it("a guarda não interfere nas demais regras (carga fechada segue fora)", async () => {
    const fechada = await seedCargo({
      cliente_id: clienteId,
      data: AMANHA,
      horario: "08:00:00",
      status: "BOOKED",
      driver_visibility: "PUBLIC",
      sheet_lh: null,
    });

    const ids = await idsVisiveis();

    expect(ids).not.toContain(fechada.id);
  });
});
