import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
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

const CSV_HEADER = "COD. CARGA,TIPO,VEÍCULO,DATA CARREGAMENTO,DATA DESCARGA,Origem,Destino,STATUS";

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

    const csv = [
      CSV_HEADER,
      "LH-1,Forecast,CARRETA,15/07/2026 08:00,16/07/2026 18:00,Sao Paulo,Rio de Janeiro,rascunho",
      ",Forecast,CARRETA,xx,,A,,PROGRAMADA",
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
    expect(response.payload.rows[0].preview.tipo).toBe("Forecast");
    expect(response.payload.rows[0].preview.veiculo).toBe("CARRETA");

    const { rows } = await query("SELECT count(*)::int AS n FROM public.cargas");
    expect(rows[0].n).toBe(0);
  });

  it("importa válidas: VEÍCULO→perfil, TIPO(viagem)→sheet_tipo, COD.CARGA→sheet_lh+id", async () => {
    const operator = await seedUser({ email: "op2@teste.local" });

    const csv = [
      CSV_HEADER,
      "LH-100,Forecast,CARRETA,15/07/2026 08:00,16/07/2026 18:00,Sao Paulo,Rio de Janeiro,rascunho",
      "LH-101,Spot,TRUCK,16/07/2026 13:30,,Campinas,Belo Horizonte,ativa",
      ",Forecast,CARRETA,bad,,X,Y,ativa",
    ].join("\n");

    const response = await importOperatorCargas({
      operatorId: operator.id,
      csv,
      dryRun: false,
      requestIp: "203.0.113.5",
      correlationId: "corr-import",
    });

    expect(response.statusCode).toBe(201);
    expect(response.payload.summary).toMatchObject({ total: 3, valid: 2, invalid: 1, duplicated: 0, imported: 2 });

    const { rows } = await query(
      "SELECT sheet_lh, perfil, sheet_tipo, status, sheet_data_descarga, cliente_id FROM public.cargas ORDER BY sheet_lh",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      sheet_lh: "LH-100",
      perfil: "CARRETA",
      sheet_tipo: "Forecast",
      status: "DRAFT",
      sheet_data_descarga: "16/07/2026 18:00",
      cliente_id: null,
    });
    expect(rows[1]).toMatchObject({
      sheet_lh: "LH-101",
      perfil: "TRUCK",
      sheet_tipo: "Spot",
      status: "OPEN",
      sheet_data_descarga: null,
    });
  });

  it("evita duplicata por COD. CARGA: reimportar o mesmo LH não cria carga nova", async () => {
    const operator = await seedUser({ email: "op3@teste.local" });
    const csv = [CSV_HEADER, "LH-200,Forecast,CARRETA,15/07/2026 08:00,,Sao Paulo,Rio,ativa"].join("\n");

    const first = await importOperatorCargas({ operatorId: operator.id, csv, dryRun: false, requestIp: "ip", correlationId: "c1" });
    expect(first.payload.summary).toMatchObject({ imported: 1, duplicated: 0 });

    const second = await importOperatorCargas({ operatorId: operator.id, csv, dryRun: false, requestIp: "ip", correlationId: "c2" });
    expect(second.payload.summary).toMatchObject({ imported: 0, duplicated: 1 });

    const { rows } = await query("SELECT count(*)::int AS n FROM public.cargas");
    expect(rows[0].n).toBe(1);
  });

  it("dry-run marca como duplicada uma carga que já existe", async () => {
    const operator = await seedUser({ email: "op4@teste.local" });
    const csv = [CSV_HEADER, "LH-300,Forecast,CARRETA,15/07/2026 08:00,,Sao Paulo,Rio,ativa"].join("\n");

    await importOperatorCargas({ operatorId: operator.id, csv, dryRun: false, requestIp: "ip", correlationId: "c1" });

    const preview = await importOperatorCargas({ operatorId: operator.id, csv, dryRun: true, requestIp: "ip", correlationId: "c2" });
    expect(preview.payload.summary).toMatchObject({ total: 1, valid: 1, duplicated: 1, importable: 0 });
    expect(preview.payload.rows[0].duplicate).toBe(true);
  });

  it("rejeita cabeçalho inválido sem gravar", async () => {
    const operator = await seedUser({ email: "op5@teste.local" });
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
