import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedCliente,
  seedRoute,
  seedUser,
  withPgClient,
  withPgTransaction,
} from "../test-harness.js";
import { buildSheetLoadId } from "../../../domain/operator-admin/import-programacao.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient,
  withPgTransaction,
}));

const { importOperatorCargas } = await import("./import-cargas.js");

const CSV_HEADER = "COD. CARGA,TIPO,VEÍCULO,DATA CARREGAMENTO,DATA DESCARGA,Origem,Destino,CLIENTE,STATUS";

describe("importOperatorCargas (programação)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("dry-run classifica linhas (nova/erro) sem gravar e não vaza payload", async () => {
    const operator = await seedUser({ email: "op@teste.local" });
    await seedCliente({ nome: "Shopee" });

    const csv = [
      CSV_HEADER,
      "LH-1,Forecast,CARRETA,15/07/2026 08:00,16/07/2026 18:00,Sao Paulo,Rio de Janeiro,Shopee,rascunho",
      ",Forecast,CARRETA,xx,,A,,,PROGRAMADA",
    ].join("\n");

    const response = await importOperatorCargas({
      operatorId: operator.id,
      csv,
      dryRun: true,
      requestIp: "203.0.113.5",
      correlationId: "corr-dry",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.summary).toMatchObject({ total: 2, inserted: 1, updated: 0, skipped: 0, invalid: 1 });
    expect(response.payload.rows[0].action).toBe("insert");
    expect(response.payload.rows[0].payload).toBeUndefined();
    expect(response.payload.rows[1].ok).toBe(false);
    expect(response.payload.rows[0].preview.cliente_nome).toBe("Shopee");

    const { rows } = await query("SELECT count(*)::int AS n FROM public.cargas");
    expect(rows[0].n).toBe(0);
  });

  it("insere novas resolvendo CLIENTE; cliente em branco fica null", async () => {
    const operator = await seedUser({ email: "op2@teste.local" });
    const cliente = await seedCliente({ nome: "Shopee" });

    const csv = [
      CSV_HEADER,
      "LH-100,Forecast,CARRETA,15/07/2026 08:00,16/07/2026 18:00,Sao Paulo,Rio de Janeiro,shopee,rascunho",
      "LH-101,Spot,TRUCK,16/07/2026 13:30,,Campinas,Belo Horizonte,,ativa",
    ].join("\n");

    const response = await importOperatorCargas({
      operatorId: operator.id,
      csv,
      dryRun: false,
      requestIp: "203.0.113.5",
      correlationId: "corr-import",
    });

    expect(response.payload.summary).toMatchObject({ total: 2, inserted: 2, updated: 0 });
    const { rows } = await query(
      "SELECT sheet_lh, perfil, sheet_tipo, status, cliente_id FROM public.cargas ORDER BY sheet_lh",
    );
    expect(rows[0]).toMatchObject({ sheet_lh: "LH-100", perfil: "CARRETA", sheet_tipo: "Forecast", cliente_id: cliente.id });
    expect(rows[1]).toMatchObject({ sheet_lh: "LH-101", perfil: "TRUCK", status: "OPEN", cliente_id: null });
  });

  it("reimportar o mesmo COD. CARGA ATUALIZA a carga (revive expirada com data nova)", async () => {
    const operator = await seedUser({ email: "op3@teste.local" });
    await seedCargo({
      id: buildSheetLoadId("LH-200"),
      sheet_lh: "LH-200",
      status: "EXPIRED",
      data: "2026-06-17",
      origem: "Velho",
      destino: "Antigo",
    });

    const csv = [CSV_HEADER, "LH-200,Forecast,TRUCK,17/07/2026 10:00,,Sao Paulo,Rio,,ativa"].join("\n");
    const response = await importOperatorCargas({ operatorId: operator.id, csv, dryRun: false, requestIp: "ip", correlationId: "c" });

    expect(response.payload.summary).toMatchObject({ total: 1, inserted: 0, updated: 1, skipped: 0 });
    expect(response.payload.rows[0].action).toBe("update");

    const { rows } = await query("SELECT status, data, perfil, origem FROM public.cargas WHERE sheet_lh = 'LH-200'");
    expect(rows).toHaveLength(1); // não duplicou
    expect(rows[0]).toMatchObject({ status: "OPEN", perfil: "TRUCK", origem: "Sao Paulo" });
    // pg-mem devolve DATE como objeto Date em UTC-meia-noite; compara em UTC.
    expect(new Date(rows[0].data).toISOString().slice(0, 10)).toBe("2026-07-17");
  });

  it("NÃO sobrescreve carga com motorista/viagem (BOOKED) — pula", async () => {
    const operator = await seedUser({ email: "op4@teste.local" });
    await seedCargo({ id: buildSheetLoadId("LH-300"), sheet_lh: "LH-300", status: "BOOKED", origem: "Origem Reservada" });

    const csv = [CSV_HEADER, "LH-300,Forecast,CARRETA,17/07/2026 10:00,,Nova Origem,Novo Destino,,ativa"].join("\n");
    const response = await importOperatorCargas({ operatorId: operator.id, csv, dryRun: false, requestIp: "ip", correlationId: "c" });

    expect(response.payload.summary).toMatchObject({ inserted: 0, updated: 0, skipped: 1 });
    expect(response.payload.rows[0].action).toBe("skip");
    expect(response.payload.rows[0].reason).toContain("BOOKED");

    const { rows } = await query("SELECT status, origem FROM public.cargas WHERE sheet_lh = 'LH-300'");
    expect(rows[0]).toMatchObject({ status: "BOOKED", origem: "Origem Reservada" }); // intacta
  });

  it("rejeita linha cujo CLIENTE não existe", async () => {
    const operator = await seedUser({ email: "op5@teste.local" });
    await seedCliente({ nome: "Shopee" });

    const csv = [
      CSV_HEADER,
      "LH-400,Forecast,CARRETA,17/07/2026 10:00,,Sao Paulo,Rio,Shopee,ativa",
      "LH-401,Forecast,CARRETA,17/07/2026 10:00,,Sao Paulo,Rio,Cliente Fantasma,ativa",
    ].join("\n");

    const response = await importOperatorCargas({ operatorId: operator.id, csv, dryRun: false, requestIp: "ip", correlationId: "c" });

    expect(response.payload.summary).toMatchObject({ total: 2, inserted: 1, invalid: 1 });
    const { rows } = await query("SELECT sheet_lh FROM public.cargas ORDER BY sheet_lh");
    expect(rows.map((r) => r.sheet_lh)).toEqual(["LH-400"]);
  });

  it("aceita CSV ;-delimitado sem coluna CLIENTE (arquivo real do Excel pt-BR)", async () => {
    const operator = await seedUser({ email: "op6@teste.local" });

    const csv = [
      "COD. CARGA;TIPO;VEÍCULO;DATA CARREGAMENTO;DATA DESCARGA;Origem;Destino;STATUS",
      "B101437150;Transferência;Truck;17/07/2026 10:00;21/07/2026 23:00;SAO BERNARDO DO CAMPO;FEIRA DE SANTANA;ATIVA",
      ";;;;;;;",
    ].join("\r\n");

    const response = await importOperatorCargas({ operatorId: operator.id, csv, dryRun: false, requestIp: "ip", correlationId: "c" });

    expect(response.payload.summary).toMatchObject({ total: 1, inserted: 1 });
    const { rows } = await query("SELECT sheet_lh, perfil, sheet_tipo, status FROM public.cargas");
    expect(rows[0]).toMatchObject({ sheet_lh: "B101437150", perfil: "TRUCK", sheet_tipo: "Transferência", status: "OPEN" });
  });

  it("marca route_registered: rota no catálogo vs sem cadastro", async () => {
    const operator = await seedUser({ email: "oprota@teste.local" });
    await seedRoute({}); // catálogo: Salvador / BA -> Simoes Filho / BA (defaults do harness)

    const csv = [
      CSV_HEADER,
      "LH-R1,Forecast,CARRETA,18/07/2026 08:00,,Salvador / BA,Simoes Filho / BA,,ativa",
      "LH-R2,Forecast,CARRETA,18/07/2026 09:00,,Cidade Inexistente,Outro Lugar,,ativa",
    ].join("\n");

    const response = await importOperatorCargas({ operatorId: operator.id, csv, dryRun: true, requestIp: "ip", correlationId: "c" });
    const byLh = Object.fromEntries(response.payload.rows.map((r) => [r.preview.cod_carga, r.preview.route_registered]));
    expect(byLh["LH-R1"]).toBe(true); // trajeto cadastrado no route_metrics_cache
    expect(byLh["LH-R2"]).toBe(false); // sem cadastro
  });

  it("rejeita cabeçalho inválido sem gravar", async () => {
    const operator = await seedUser({ email: "op7@teste.local" });
    const response = await importOperatorCargas({
      operatorId: operator.id,
      csv: "foo,bar\n1,2",
      dryRun: false,
      requestIp: "ip",
      correlationId: "c",
    });

    expect(response.statusCode).toBe(400);
    expect(response.payload.headerError).toContain("COD. CARGA");

    const { rows } = await query("SELECT count(*)::int AS n FROM public.cargas");
    expect(rows[0].n).toBe(0);
  });
});
