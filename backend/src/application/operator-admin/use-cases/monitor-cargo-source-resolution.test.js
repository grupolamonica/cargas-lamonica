// Resolução de carga do Monitor por LH em cenário MULTI-PLANILHA.
//
// O id da carga de planilha é namespaced por fonte (createSheetLoadId): a Shopee
// mantém o namespace histórico `sheet-load:<LH>` e as demais usam
// `sheet-load:<source>:<LH>`. Sem receber a fonte, a resolução derivava sempre o id
// da Shopee — o ramo `id = $1` era falso para qualquer linha Nestlé e toda escrita
// do Monitor nela devolvia 404 "Carga da planilha não encontrada".
//
// Estes testes travam as três garantias do fix:
//   1) com a fonte, resolve a carga daquela fonte;
//   2) sem a fonte, o comportamento da Shopee é BYTE-IDÊNTICO ao anterior;
//   3) LH repetido entre planilhas (fato de produção) não resolve a carga errada.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSheetLoadId } from "../../google-sheets/google-sheet-loads.js";

let harness;
let shared;

const LH_SO_NESTLE = "B101464733";
const LH_NAS_DUAS = "B101454518"; // colide entre nestle e shopee em produção
const LH_SO_SHOPEE = "LT1Q8402D53N1";

describe.sequential("resolveMonitorCargoByLh — multi-planilha", () => {
  beforeAll(async () => {
    harness = await import("../test-harness.js");
    shared = await import("./_shared.js");
  });

  beforeEach(async () => {
    await harness.resetTestDatabase();
  });

  /** Cria carga de planilha no id namespaced da fonte (como o sync faz). */
  async function seedSheetCargo({ lh, source, allocMotorista = null }) {
    const id = createSheetLoadId(lh, source ?? undefined);
    await harness.query(
      `INSERT INTO public.cargas
         (id, cliente_id, data, horario, origem, destino, perfil, status, is_template,
          driver_visibility, sheet_lh, sheet_source, alloc_motorista, alloc_updated_at)
       VALUES ($1, NULL, '2026-08-05', '08:00', 'A', 'B', 'CARRETA', 'OPEN', false,
               'PUBLIC', $2, $3, $4, CASE WHEN $4 IS NULL THEN NULL ELSE now() END)`,
      [id, lh, source, allocMotorista],
    );
    return id;
  }

  it("COM a fonte, resolve a carga da planilha daquela fonte (antes dava 404)", async () => {
    const nestleId = await seedSheetCargo({ lh: LH_SO_NESTLE, source: "nestle" });

    const semFonte = await harness.withPgClient((c) =>
      shared.resolveMonitorCargoByLh(c, LH_SO_NESTLE, { forUpdate: false }),
    );
    expect(semFonte).toBeNull(); // o 404 de hoje

    const comFonte = await harness.withPgClient((c) =>
      shared.resolveMonitorCargoByLh(c, LH_SO_NESTLE, { forUpdate: false, source: "nestle" }),
    );
    expect(comFonte?.id).toBe(nestleId);
  });

  it("SEM fonte segue resolvendo a Shopee igual a antes (e 'shopee' explícito é o mesmo)", async () => {
    const shopeeId = await seedSheetCargo({ lh: LH_SO_SHOPEE, source: "shopee" });

    const implicito = await harness.withPgClient((c) =>
      shared.resolveMonitorCargoByLh(c, LH_SO_SHOPEE, { forUpdate: false }),
    );
    const explicito = await harness.withPgClient((c) =>
      shared.resolveMonitorCargoByLh(c, LH_SO_SHOPEE, { forUpdate: false, source: "shopee" }),
    );
    expect(implicito?.id).toBe(shopeeId);
    expect(explicito?.id).toBe(shopeeId);
  });

  // O ponto que derrubou o desenho inicial (um ramo `OR sheet_lh = $lh`): com LH
  // repetido entre fontes, o 1º termo do ORDER BY (alloc_updated_at) entregaria a
  // carga da OUTRA planilha — e o write-back iria para a planilha errada.
  it("LH repetido entre planilhas: cada fonte resolve a SUA carga", async () => {
    // A Nestlé é a que tem alocação viva — a que "ganharia" um ramo por sheet_lh.
    const nestleId = await seedSheetCargo({ lh: LH_NAS_DUAS, source: "nestle", allocMotorista: "MOTORISTA NESTLE" });
    const shopeeId = await seedSheetCargo({ lh: LH_NAS_DUAS, source: "shopee" });
    expect(nestleId).not.toBe(shopeeId);

    const comoShopee = await harness.withPgClient((c) =>
      shared.resolveMonitorCargoByLh(c, LH_NAS_DUAS, { forUpdate: false, source: "shopee" }),
    );
    const comoNestle = await harness.withPgClient((c) =>
      shared.resolveMonitorCargoByLh(c, LH_NAS_DUAS, { forUpdate: false, source: "nestle" }),
    );
    expect(comoShopee?.id).toBe(shopeeId);
    expect(comoNestle?.id).toBe(nestleId);
  });

  it("carga LANÇADA (lh_manual, sheet_lh NULL) continua resolvendo por qualquer fonte", async () => {
    const { rows } = await harness.query(
      `INSERT INTO public.cargas
         (cliente_id, data, horario, origem, destino, perfil, status, is_template,
          driver_visibility, lh_manual)
       VALUES (NULL, '2026-08-05', '08:00', 'A', 'B', 'CARRETA', 'OPEN', false, 'PUBLIC', $1)
       RETURNING id`,
      ["B101474572"],
    );
    const lancadaId = rows[0].id;

    for (const source of [null, "shopee", "nestle"]) {
      const found = await harness.withPgClient((c) =>
        shared.resolveMonitorCargoByLh(c, "B101474572", { forUpdate: false, source }),
      );
      expect(found?.id).toBe(lancadaId);
    }
  });
});

describe.sequential("ensureMonitorSheetCargo — materialização só na Shopee", () => {
  beforeAll(async () => {
    harness = await import("../test-harness.js");
    shared = await import("./_shared.js");
  });

  beforeEach(async () => {
    await harness.resetTestDatabase();
  });

  // Materializar fora da Shopee produziria carga malformada que nenhum sync
  // conserta (perfil fixo 'CARRETA', sem valor/distância; o sync pula LH que já é
  // carga) e poderia publicar carga fantasma no portal. 404 é a resposta honesta.
  it("fonte != shopee com LH desconhecido NÃO materializa (devolve null → 404)", async () => {
    await harness.query(
      `INSERT INTO public.sheet_monitor_snapshot (id, source, rows_json, summary_json, synced_at)
       VALUES (2, 'nestle', $1, '{}'::jsonb, now())`,
      [JSON.stringify([{ lh: "B999999999", origem: "X", destino: "Y", data: "2026-08-10", horario: "07:00" }])],
    );

    const row = await harness.withPgClient((c) =>
      shared.ensureMonitorSheetCargo(c, "B999999999", { forUpdate: false, source: "nestle" }),
    );
    expect(row).toBeNull();

    const { rows: criadas } = await harness.query(
      "SELECT COUNT(*)::int AS total FROM public.cargas WHERE sheet_lh = $1",
      ["B999999999"],
    );
    expect(criadas[0].total).toBe(0);
  });
});
