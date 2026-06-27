import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCliente,
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

  it("dry-run valida sem gravar, reporta erros e não vaza payload", async () => {
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
    expect(response.payload.summary).toMatchObject({ total: 2, valid: 1, invalid: 1, duplicated: 0, imported: 0 });
    expect(response.payload.rows[1].ok).toBe(false);
    expect(response.payload.rows[0].payload).toBeUndefined();
    expect(response.payload.rows[0].preview.cliente_nome).toBe("Shopee");

    const { rows } = await query("SELECT count(*)::int AS n FROM public.cargas");
    expect(rows[0].n).toBe(0);
  });

  it("importa válidas resolvendo CLIENTE pelo nome; cliente em branco fica null", async () => {
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

    expect(response.payload.summary).toMatchObject({ total: 2, valid: 2, imported: 2 });

    const { rows } = await query(
      "SELECT sheet_lh, perfil, sheet_tipo, status, cliente_id FROM public.cargas ORDER BY sheet_lh",
    );
    expect(rows[0]).toMatchObject({ sheet_lh: "LH-100", perfil: "CARRETA", sheet_tipo: "Forecast", cliente_id: cliente.id });
    expect(rows[1]).toMatchObject({ sheet_lh: "LH-101", perfil: "TRUCK", status: "OPEN", cliente_id: null });
  });

  it("rejeita linha cujo CLIENTE não existe (não grava a linha)", async () => {
    const operator = await seedUser({ email: "op3@teste.local" });
    await seedCliente({ nome: "Shopee" });

    const csv = [
      CSV_HEADER,
      "LH-200,Forecast,CARRETA,15/07/2026 08:00,,Sao Paulo,Rio,Shopee,ativa",
      "LH-201,Forecast,CARRETA,15/07/2026 08:00,,Sao Paulo,Rio,Cliente Fantasma,ativa",
    ].join("\n");

    const response = await importOperatorCargas({
      operatorId: operator.id,
      csv,
      dryRun: false,
      requestIp: "ip",
      correlationId: "c",
    });

    expect(response.payload.summary).toMatchObject({ total: 2, valid: 1, invalid: 1, imported: 1 });
    const { rows } = await query("SELECT sheet_lh FROM public.cargas ORDER BY sheet_lh");
    expect(rows.map((r) => r.sheet_lh)).toEqual(["LH-200"]);
  });

  it("evita duplicata por COD. CARGA: reimportar o mesmo LH não cria carga nova", async () => {
    const operator = await seedUser({ email: "op4@teste.local" });
    const csv = [CSV_HEADER, "LH-300,Forecast,CARRETA,15/07/2026 08:00,,Sao Paulo,Rio,,ativa"].join("\n");

    const first = await importOperatorCargas({ operatorId: operator.id, csv, dryRun: false, requestIp: "ip", correlationId: "c1" });
    expect(first.payload.summary).toMatchObject({ imported: 1, duplicated: 0 });

    const second = await importOperatorCargas({ operatorId: operator.id, csv, dryRun: false, requestIp: "ip", correlationId: "c2" });
    expect(second.payload.summary).toMatchObject({ imported: 0, duplicated: 1 });

    const { rows } = await query("SELECT count(*)::int AS n FROM public.cargas");
    expect(rows[0].n).toBe(1);
  });

  it("aceita CSV ;-delimitado sem coluna CLIENTE (arquivo real do Excel pt-BR)", async () => {
    const operator = await seedUser({ email: "op5@teste.local" });

    const csv = [
      "COD. CARGA;TIPO;VEÍCULO;DATA CARREGAMENTO;DATA DESCARGA;Origem;Destino;STATUS",
      "B101437150;Transferência;Truck;17/06/2026 10:00;21/06/2026 23:00;SAO BERNARDO DO CAMPO;FEIRA DE SANTANA;ATIVA",
      ";;;;;;;",
    ].join("\r\n");

    const response = await importOperatorCargas({
      operatorId: operator.id,
      csv,
      dryRun: false,
      requestIp: "ip",
      correlationId: "c",
    });

    expect(response.payload.summary).toMatchObject({ total: 1, valid: 1, imported: 1 });
    const { rows } = await query("SELECT sheet_lh, perfil, status, cliente_id FROM public.cargas");
    expect(rows[0]).toMatchObject({ sheet_lh: "B101437150", perfil: "TRUCK", status: "OPEN", cliente_id: null });
  });

  it("rejeita cabeçalho inválido sem gravar", async () => {
    const operator = await seedUser({ email: "op6@teste.local" });
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
