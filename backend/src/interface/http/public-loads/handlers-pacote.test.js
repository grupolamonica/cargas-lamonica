/**
 * Integration tests para os endpoints driver-facing do Phase 10 (cargas casadas).
 *
 * Cobre:
 *  - resolveDriverLoadsReadModelResponse (listing) com pacote_meta + DISTINCT ON
 *  - resolveGetPublicPacoteResponse (GET /api/driver/pacotes/:pacoteId)
 *
 * Usa o test-harness do cargas-casadas (pg-mem) — espelha o schema completo
 * de cargas + cargas_casadas + clientes + route_metrics_cache.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCarga,
  seedCliente,
  seedPacote,
  withPgClient,
  withPgTransaction,
} from "../../../application/cargas-casadas/test-harness.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient,
  withPgTransaction,
}));

// Bypass do sheet-sync (depende de SUPABASE_*); o handler usa internamente.
vi.mock("../../../application/google-sheets/google-sheet-loads.js", () => ({
  createSupabaseAdminClient: () => null,
  syncGoogleSheetLoads: vi.fn().mockResolvedValue({ availableLoadsCount: 0, unlinkedLoadsCount: 0 }),
}));

const {
  resetDriverLoadsSheetRefreshStateForTests,
  resolveDriverLoadsReadModelResponse,
  resolveGetPublicPacoteResponse,
} = await import("./handlers.js");

function mockRequest({ params = {}, query: q = {}, headers = {} } = {}) {
  // O wrap() em routes.js mescla req.params em req.query via withParams adapter.
  // Aqui passamos params direto como query — espelha o estado pos-adapter.
  return {
    params,
    query: { ...q, ...params },
    headers,
  };
}

/**
 * Wrapper para seedCarga que inclui as route metrics necessarias para que
 * buildDriverLoadPublicationState marque a carga como publishable
 * (isReady=true) — sem isso, o driver-portal listing filtra ela fora.
 */
async function seedPublishableCarga(overrides = {}) {
  return seedCarga({
    distancia_km: 800,
    duracao_horas: 12,
    valor: overrides.valor ?? 4000,
    bonus: overrides.bonus ?? 200,
    perfil: overrides.perfil ?? "CARRETA",
    ...overrides,
  });
}

describe("public-loads handlers — Phase 10 pacote support", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
    resetDriverLoadsSheetRefreshStateForTests();
    // Desabilita o auto-sync da planilha — sem SUPABASE_URL nao roda.
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  describe("GET /api/driver/loads (resolveDriverLoadsReadModelResponse)", () => {
    it("retorna pacote_meta=null para cargas avulsas (backward-compat)", async () => {
      const cliente = await seedCliente({ nome: "Cliente Avulso" });
      await seedPublishableCarga({
        cliente_id: cliente.id,
        driver_visibility: "PUBLIC",
        status: "OPEN",
        viagem_id: null,
      });

      const res = await resolveDriverLoadsReadModelResponse(mockRequest());

      expect(res.statusCode).toBe(200);
      expect(res.payload.items).toHaveLength(1);
      expect(res.payload.items[0].pacote_meta).toBeNull();
      expect(res.payload.items[0].viagem_id).toBeNull();
      expect(res.payload.items[0].ordem_viagem).toBeNull();
    });

    it("retorna pacote_meta populado para carga em pacote publicado", async () => {
      const cliente = await seedCliente({ nome: "Cliente Pacote" });
      const { id: pacoteId } = await seedPacote({
        status: "publicado",
        valor_total: 15000,
        version: 3,
      });
      await seedPublishableCarga({
        cliente_id: cliente.id,
        driver_visibility: "PREMIUM",
        viagem_id: pacoteId,
        ordem_viagem: 1,
        origem: "Sao Paulo / SP",
        destino: "Rio de Janeiro / RJ",
      });

      const res = await resolveDriverLoadsReadModelResponse(mockRequest());

      expect(res.statusCode).toBe(200);
      const entry = res.payload.items.find((it) => it.viagem_id === pacoteId);
      expect(entry).toBeDefined();
      expect(entry.pacote_meta).toMatchObject({
        id: pacoteId,
        status: "publicado",
        valor_total: 15000,
        version: 3,
        total_cargas: 1,
        ordem_propria: 1,
      });
      // Plan revisao 2026-05-23: campos derivados.
      // Cliente unico -> cliente_uniforme nao-nulo; pacote single-carga -> perfil_uniforme presente.
      expect(entry.pacote_meta.cliente_uniforme).toMatchObject({
        id: cliente.id,
        nome: "Cliente Pacote",
      });
      expect(entry.pacote_meta.perfil_uniforme).toBe("CARRETA");
      // Soma 800km + 12h para 1 carga.
      expect(entry.pacote_meta.total_km).toBe(800);
      expect(entry.pacote_meta.total_duration_horas).toBe(12);
      expect(entry.pacote_meta.earliest_carga_date).toBeTruthy();
    });

    it("agrega derivados (km/horas/earliest_date) com cliente_uniforme e perfil_uniforme para pacote multi-carga", async () => {
      const cliente = await seedCliente({ nome: "Cliente Uniforme" });
      const { id: pacoteId } = await seedPacote({
        status: "publicado",
        valor_total: 21000,
        version: 1,
      });
      // 3 cargas mesmo cliente + mesmo perfil + datas escaladas.
      await seedPublishableCarga({
        cliente_id: cliente.id,
        driver_visibility: "PREMIUM",
        viagem_id: pacoteId,
        ordem_viagem: 1,
        data: "2026-06-10",
        distancia_km: 800,
        duracao_horas: 12,
        perfil: "CARRETA",
      });
      await seedPublishableCarga({
        cliente_id: cliente.id,
        driver_visibility: "PREMIUM",
        viagem_id: pacoteId,
        ordem_viagem: 2,
        data: "2026-06-12",
        distancia_km: 500,
        duracao_horas: 8,
        perfil: "CARRETA",
      });
      await seedPublishableCarga({
        cliente_id: cliente.id,
        driver_visibility: "PREMIUM",
        viagem_id: pacoteId,
        ordem_viagem: 3,
        data: "2026-06-15",
        distancia_km: 300,
        duracao_horas: 5,
        perfil: "CARRETA",
      });

      const res = await resolveDriverLoadsReadModelResponse(mockRequest());

      expect(res.statusCode).toBe(200);
      const entry = res.payload.items.find((it) => it.viagem_id === pacoteId);
      expect(entry).toBeDefined();
      expect(entry.pacote_meta.total_cargas).toBe(3);
      expect(entry.pacote_meta.total_km).toBe(1600);
      expect(entry.pacote_meta.total_duration_horas).toBe(25);
      expect(entry.pacote_meta.perfil_uniforme).toBe("CARRETA");
      expect(entry.pacote_meta.cliente_uniforme).toMatchObject({
        id: cliente.id,
        nome: "Cliente Uniforme",
      });
      // earliest_date pode vir como string YYYY-MM-DD (postgres real) ou Date
      // (pg-mem em ambiente local — tipa DATE como Date). Aceitar ambos.
      const earliest = entry.pacote_meta.earliest_carga_date;
      const earliestIso = earliest instanceof Date ? earliest.toISOString().slice(0, 10) : String(earliest);
      // Date instance pode estar em TZ local (Jun 9 23h em America/Sao_Paulo ===
      // Jun 10 02h UTC). Aceitar +/- 1 dia para nao ser flaky em CI multi-TZ.
      expect(["2026-06-09", "2026-06-10", "2026-06-11"]).toContain(earliestIso);
    });

    it("retorna cliente_uniforme=null e perfil_uniforme=null quando cargas do pacote sao heterogeneas", async () => {
      const clienteA = await seedCliente({ nome: "Cliente A" });
      const clienteB = await seedCliente({ nome: "Cliente B" });
      const { id: pacoteId } = await seedPacote({
        status: "publicado",
        valor_total: 9000,
        version: 1,
      });
      await seedPublishableCarga({
        cliente_id: clienteA.id,
        driver_visibility: "PREMIUM",
        viagem_id: pacoteId,
        ordem_viagem: 1,
        perfil: "CARRETA",
      });
      await seedPublishableCarga({
        cliente_id: clienteB.id,
        driver_visibility: "PREMIUM",
        viagem_id: pacoteId,
        ordem_viagem: 2,
        perfil: "TRUCK",
      });

      const res = await resolveDriverLoadsReadModelResponse(mockRequest());

      expect(res.statusCode).toBe(200);
      const entry = res.payload.items.find((it) => it.viagem_id === pacoteId);
      expect(entry).toBeDefined();
      expect(entry.pacote_meta.cliente_uniforme).toBeNull();
      expect(entry.pacote_meta.perfil_uniforme).toBeNull();
    });

    it("colapsa pacote com 3 cargas a UMA entry no listing (DISTINCT ON)", async () => {
      const cliente = await seedCliente({ nome: "Cliente 3 Stops" });
      const { id: pacoteId } = await seedPacote({ status: "publicado", valor_total: 30000 });
      for (let i = 1; i <= 3; i += 1) {
        await seedPublishableCarga({
          cliente_id: cliente.id,
          driver_visibility: "PREMIUM",
          viagem_id: pacoteId,
          ordem_viagem: i,
          origem: `Sao Paulo / SP`,
          destino: `Cidade${i}B / SP`,
        });
      }

      const res = await resolveDriverLoadsReadModelResponse(mockRequest());

      expect(res.statusCode).toBe(200);
      const pacoteEntries = res.payload.items.filter((it) => it.viagem_id === pacoteId);
      expect(pacoteEntries).toHaveLength(1);
      expect(pacoteEntries[0].pacote_meta.total_cargas).toBe(3);
      expect(pacoteEntries[0].pacote_meta.ordem_propria).toBe(1);
    });

    it("listing misto (5 avulsas + 1 pacote com 3 cargas) -> 6 entries", async () => {
      const cliente = await seedCliente({ nome: "Misto" });

      // 5 cargas avulsas
      for (let i = 0; i < 5; i += 1) {
        await seedPublishableCarga({
          cliente_id: cliente.id,
          driver_visibility: "PUBLIC",
          viagem_id: null,
          data: `2026-06-1${i}`,
          origem: `OrigemAvulsa${i} / SP`,
          destino: `DestinoAvulsa${i} / RJ`,
        });
      }

      // 1 pacote com 3 cargas
      const { id: pacoteId } = await seedPacote({ status: "publicado", valor_total: 25000 });
      for (let i = 1; i <= 3; i += 1) {
        await seedPublishableCarga({
          cliente_id: cliente.id,
          driver_visibility: "PREMIUM",
          viagem_id: pacoteId,
          ordem_viagem: i,
          origem: `PacoteOrigem${i} / MG`,
          destino: `PacoteDestino${i} / MG`,
        });
      }

      const res = await resolveDriverLoadsReadModelResponse(mockRequest());

      expect(res.statusCode).toBe(200);
      expect(res.payload.items).toHaveLength(6);
      const pacoteEntries = res.payload.items.filter((it) => it.viagem_id === pacoteId);
      const avulsaEntries = res.payload.items.filter((it) => it.viagem_id === null);
      expect(pacoteEntries).toHaveLength(1);
      expect(avulsaEntries).toHaveLength(5);
      avulsaEntries.forEach((entry) => {
        expect(entry.pacote_meta).toBeNull();
      });
    });

    it("nao expoe cargas de pacote em rascunho", async () => {
      const cliente = await seedCliente({ nome: "Rascunho Test" });
      const { id: pacoteRascunhoId } = await seedPacote({ status: "rascunho" });
      await seedPublishableCarga({
        cliente_id: cliente.id,
        driver_visibility: "PREMIUM",
        viagem_id: pacoteRascunhoId,
        ordem_viagem: 1,
      });
      // Adiciona avulsa pra garantir que nao retorna lista vazia por outro motivo
      await seedPublishableCarga({ cliente_id: cliente.id, driver_visibility: "PUBLIC" });

      const res = await resolveDriverLoadsReadModelResponse(mockRequest());

      expect(res.statusCode).toBe(200);
      expect(res.payload.items.find((it) => it.viagem_id === pacoteRascunhoId)).toBeUndefined();
    });

    it("nao expoe cargas de pacote cancelado", async () => {
      const cliente = await seedCliente({ nome: "Cancelado Test" });
      const { id: pacoteCanceladoId } = await seedPacote({ status: "cancelado" });
      await seedPublishableCarga({
        cliente_id: cliente.id,
        driver_visibility: "PREMIUM",
        viagem_id: pacoteCanceladoId,
        ordem_viagem: 1,
      });

      const res = await resolveDriverLoadsReadModelResponse(mockRequest());

      expect(res.statusCode).toBe(200);
      expect(res.payload.items.find((it) => it.viagem_id === pacoteCanceladoId)).toBeUndefined();
    });

    it("expoe cargas de pacote reservado/em_andamento", async () => {
      const cliente = await seedCliente({ nome: "Reservado/EmAndamento Test" });
      const { id: pacoteReservadoId } = await seedPacote({ status: "reservado" });
      const { id: pacoteEmAndamentoId } = await seedPacote({ status: "em_andamento" });

      await seedPublishableCarga({
        cliente_id: cliente.id,
        driver_visibility: "PREMIUM",
        viagem_id: pacoteReservadoId,
        ordem_viagem: 1,
        origem: "Sao Paulo / SP",
        destino: "Salvador / BA",
      });
      await seedPublishableCarga({
        cliente_id: cliente.id,
        driver_visibility: "PREMIUM",
        viagem_id: pacoteEmAndamentoId,
        ordem_viagem: 1,
        origem: "Belo Horizonte / MG",
        destino: "Recife / PE",
      });

      const res = await resolveDriverLoadsReadModelResponse(mockRequest());

      expect(res.statusCode).toBe(200);
      const ids = res.payload.items.map((it) => it.viagem_id).filter(Boolean);
      expect(ids).toContain(pacoteReservadoId);
      expect(ids).toContain(pacoteEmAndamentoId);
    });
  });

  describe("GET /api/driver/pacotes/:pacoteId (resolveGetPublicPacoteResponse)", () => {
    it("retorna 200 com pacote completo + cargas ordenadas quando publicado", async () => {
      const cliente = await seedCliente({ nome: "Atlas Logistica" });
      const { id: pacoteId } = await seedPacote({
        status: "publicado",
        valor_total: 12000,
        version: 1,
        published_at: "2026-05-22T10:00:00Z",
      });
      for (let i = 1; i <= 3; i += 1) {
        await seedCarga({
          cliente_id: cliente.id,
          viagem_id: pacoteId,
          ordem_viagem: i,
          origem: `Origem${i}`,
          destino: `Destino${i}`,
        });
      }

      const res = await resolveGetPublicPacoteResponse(mockRequest({ params: { pacoteId } }));

      expect(res.statusCode).toBe(200);
      expect(res.payload.pacote.id).toBe(pacoteId);
      expect(res.payload.pacote.status).toBe("publicado");
      expect(res.payload.pacote.valor_total).toBe(12000);
      expect(res.payload.pacote.total_cargas).toBe(3);
      expect(res.payload.pacote.cargas.map((c) => c.ordem_viagem)).toEqual([1, 2, 3]);
      expect(res.payload.pacote.cargas[0].cliente).toMatchObject({ nome: "Atlas Logistica" });
    });

    it("retorna 404 quando pacote esta em rascunho", async () => {
      const { id: pacoteId } = await seedPacote({ status: "rascunho" });
      await seedCarga({ viagem_id: pacoteId, ordem_viagem: 1 });

      const res = await resolveGetPublicPacoteResponse(mockRequest({ params: { pacoteId } }));

      expect(res.statusCode).toBe(404);
      expect(res.payload.code).toBe("NOT_FOUND");
    });

    it("retorna 404 quando pacoteId nao existe", async () => {
      const res = await resolveGetPublicPacoteResponse(
        mockRequest({ params: { pacoteId: "00000000-0000-0000-0000-000000000000" } }),
      );

      expect(res.statusCode).toBe(404);
      expect(res.payload.code).toBe("NOT_FOUND");
    });

    it("retorna 400/422 quando pacoteId nao e UUID valido", async () => {
      const res = await resolveGetPublicPacoteResponse(
        mockRequest({ params: { pacoteId: "not-a-uuid" } }),
      );

      // zodErrorToHttpResponse no codebase retorna 422 (mesmo statusCode usado em
      // outros handlers que validam params via Zod). Aceita 400 ou 422 — o que
      // importa e que rejeita a request antes de tocar no DB.
      expect([400, 422]).toContain(res.statusCode);
    });

    it("retorna 404 quando pacote esta cancelado (nao vazar info)", async () => {
      const { id: pacoteId } = await seedPacote({ status: "cancelado" });
      const res = await resolveGetPublicPacoteResponse(mockRequest({ params: { pacoteId } }));
      expect(res.statusCode).toBe(404);
    });

    it("retorna 404 quando pacote esta concluido (nao vazar info)", async () => {
      const { id: pacoteId } = await seedPacote({ status: "concluido" });
      const res = await resolveGetPublicPacoteResponse(mockRequest({ params: { pacoteId } }));
      expect(res.statusCode).toBe(404);
    });
  });
});
