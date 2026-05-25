import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCarga,
  seedCliente,
  seedLoadClaim,
  seedPacote,
  seedUser,
  withPgClient,
  withPgTransaction,
} from "./test-harness.js";

vi.mock("../../infrastructure/pg/postgres.js", () => ({
  withPgClient,
  withPgTransaction,
}));

const service = await import("./service.js");

describe("cargas-casadas service", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  // ── createPacote ────────────────────────────────────────────────────────────

  it("createPacote cria em rascunho com version=1 e valor_total null", async () => {
    const operator = await seedUser({ email: "op@teste.local" });
    const response = await service.createPacote({
      operatorId: operator.id,
      payload: {},
      requestIp: "10.0.0.1",
      correlationId: "corr-create-1",
    });

    expect(response.statusCode).toBe(201);
    expect(response.payload.pacote).toMatchObject({
      status: "rascunho",
      version: 1,
      valor_total: null,
    });

    const { rows: pacotes } = await query(`SELECT * FROM public.cargas_casadas`);
    expect(pacotes).toHaveLength(1);

    const { rows: audit } = await query(`SELECT * FROM public.security_audit_logs`);
    expect(audit[0]).toMatchObject({
      event_type: "operator.pacote.created",
      resource_type: "cargas-casadas",
      outcome: "success",
    });
  });

  it("createPacote aceita valor_total opcional", async () => {
    const operator = await seedUser();
    const response = await service.createPacote({
      operatorId: operator.id,
      payload: { valor_total: 12500 },
      correlationId: "corr-create-2",
    });
    expect(response.payload.pacote.valor_total).toBe(12500);
  });

  // ── addCargaToPacote ────────────────────────────────────────────────────────

  it("addCargaToPacote rejeita 4a carga com code='limite_cargas_excedido' (D-04)", async () => {
    const operator = await seedUser();
    const { id: pacoteId } = await seedPacote({ created_by: operator.id });
    // semeia 3 cargas ja vinculadas
    for (let i = 1; i <= 3; i += 1) {
      await seedCarga({ viagem_id: pacoteId, ordem_viagem: i });
    }
    const { id: extraCargaId } = await seedCarga();

    await expect(
      service.addCargaToPacote({
        operatorId: operator.id,
        pacoteId,
        cargaId: extraCargaId,
        correlationId: "corr-limit",
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: "limite_cargas_excedido" }),
    });
  });

  it("addCargaToPacote rejeita carga com reserved_driver_id NOT NULL (CONTEXT edge case 1)", async () => {
    const operator = await seedUser();
    const driver = await seedUser({ email: "driver@teste.local" });
    const { id: pacoteId } = await seedPacote();
    const { id: cargaId } = await seedCarga({ reserved_driver_id: driver.id });

    await expect(
      service.addCargaToPacote({
        operatorId: operator.id,
        pacoteId,
        cargaId,
        correlationId: "corr-reserved",
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: "carga_com_reserva_ativa" }),
    });
  });

  it("addCargaToPacote rejeita carga PUBLIC quando pacote ja publicado (D-05)", async () => {
    const operator = await seedUser();
    const { id: pacoteId } = await seedPacote({ status: "publicado", valor_total: 5000 });
    const { id: cargaId } = await seedCarga({ driver_visibility: "PUBLIC", status: "OPEN" });

    await expect(
      service.addCargaToPacote({
        operatorId: operator.id,
        pacoteId,
        cargaId,
        correlationId: "corr-public",
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: "carga_nao_premium" }),
    });
  });

  it("addCargaToPacote sucesso atribui ordem incremental", async () => {
    const operator = await seedUser();
    const { id: pacoteId } = await seedPacote();
    const { id: cargaId } = await seedCarga();

    const response = await service.addCargaToPacote({
      operatorId: operator.id,
      pacoteId,
      cargaId,
      correlationId: "corr-add",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.ordem).toBe(1);
    expect(response.payload.total_cargas).toBe(1);

    const { rows } = await query(`SELECT viagem_id, ordem_viagem FROM public.cargas WHERE id=$1`, [cargaId]);
    expect(rows[0]).toMatchObject({ viagem_id: pacoteId, ordem_viagem: 1 });
  });

  // ── publishPacote ───────────────────────────────────────────────────────────

  it("publishPacote sucesso: 2 cargas PREMIUM+OPEN -> publicado, published_at NOT NULL, version+1", async () => {
    const operator = await seedUser();
    const { id: pacoteId } = await seedPacote({ valor_total: 12000, version: 1 });
    await seedCarga({ viagem_id: pacoteId, ordem_viagem: 1, driver_visibility: "PREMIUM", status: "OPEN" });
    await seedCarga({ viagem_id: pacoteId, ordem_viagem: 2, driver_visibility: "PREMIUM", status: "OPEN" });

    const response = await service.publishPacote({
      operatorId: operator.id,
      pacoteId,
      correlationId: "corr-publish-ok",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.pacote).toMatchObject({
      status: "publicado",
      version: 2,
    });
    expect(response.payload.pacote.published_at).not.toBeNull();
    expect(response.payload.total_cargas).toBe(2);
  });

  it("publishPacote falha sem PREMIUM com code='cargas_nao_premium'", async () => {
    const operator = await seedUser();
    const { id: pacoteId } = await seedPacote({ valor_total: 5000 });
    await seedCarga({ viagem_id: pacoteId, ordem_viagem: 1, driver_visibility: "PUBLIC", status: "OPEN" });

    await expect(
      service.publishPacote({ operatorId: operator.id, pacoteId, correlationId: "corr-publish-public" }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: "cargas_nao_premium" }),
    });
  });

  it("publishPacote falha sem valor_total>0 com code='valor_total_obrigatorio'", async () => {
    const operator = await seedUser();
    const { id: pacoteId } = await seedPacote({ valor_total: null });
    await seedCarga({ viagem_id: pacoteId, ordem_viagem: 1 });

    await expect(
      service.publishPacote({ operatorId: operator.id, pacoteId, correlationId: "corr-publish-valor" }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: "valor_total_obrigatorio" }),
    });
  });

  it("publishPacote falha sem cargas com code='pacote_vazio'", async () => {
    const operator = await seedUser();
    const { id: pacoteId } = await seedPacote({ valor_total: 5000 });

    await expect(
      service.publishPacote({ operatorId: operator.id, pacoteId, correlationId: "corr-publish-empty" }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: "pacote_vazio" }),
    });
  });

  // ── updatePacote ────────────────────────────────────────────────────────────

  it("updatePacote em status='publicado' incrementa version (D-06)", async () => {
    const operator = await seedUser();
    const { id: pacoteId } = await seedPacote({ status: "publicado", valor_total: 5000, version: 3 });

    const response = await service.updatePacote({
      operatorId: operator.id,
      pacoteId,
      payload: { valor_total: 6500 },
      correlationId: "corr-update-pub",
    });

    expect(response.payload.pacote).toMatchObject({ valor_total: 6500, version: 4 });
  });

  // ── cancelPacote (cascade D-05) ─────────────────────────────────────────────

  it("cancelPacote cascade: pacote=cancelado + cargas=CANCELLED + claims REJECTED em transacao unica", async () => {
    const operator = await seedUser();
    const driver1 = await seedUser({ email: "d1@teste.local" });
    const driver2 = await seedUser({ email: "d2@teste.local" });

    const { id: pacoteId } = await seedPacote({ status: "publicado", valor_total: 8000 });
    const { id: cargaA } = await seedCarga({
      viagem_id: pacoteId,
      ordem_viagem: 1,
      status: "RESERVED",
      reserved_driver_id: driver1.id,
    });
    const { id: cargaB } = await seedCarga({
      viagem_id: pacoteId,
      ordem_viagem: 2,
      status: "OPEN",
    });
    await seedLoadClaim({ load_id: cargaA, driver_id: driver1.id, status: "WAITLISTED" });
    await seedLoadClaim({ load_id: cargaA, driver_id: driver2.id, status: "PROMOTED" });
    await seedLoadClaim({ load_id: cargaB, driver_id: driver1.id, status: "CONFIRMED" });

    const response = await service.cancelPacote({
      operatorId: operator.id,
      pacoteId,
      correlationId: "corr-cancel",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.pacote.status).toBe("cancelado");
    expect(response.payload.cargas_afetadas).toBe(2);
    expect(response.payload.claims_rejeitados).toBe(2); // WAITLISTED + PROMOTED; CONFIRMED nao tocado

    const { rows: cargas } = await query(
      `SELECT status, reserved_driver_id, booked_driver_id FROM public.cargas WHERE viagem_id=$1`,
      [pacoteId],
    );
    cargas.forEach((c) => {
      expect(c.status).toBe("CANCELLED");
      expect(c.reserved_driver_id).toBeNull();
      expect(c.booked_driver_id).toBeNull();
    });

    const { rows: claims } = await query(
      `SELECT status, rejected_reason FROM public.load_claims ORDER BY status`,
    );
    const byStatus = Object.fromEntries(claims.map((c) => [c.status, c]));
    expect(byStatus.CONFIRMED).toBeDefined();
    expect(byStatus.CONFIRMED.rejected_reason).toBeNull();
    expect(claims.filter((c) => c.status === "REJECTED")).toHaveLength(2);
    expect(claims.filter((c) => c.status === "REJECTED").every((c) => c.rejected_reason === "PACOTE_CANCELLED")).toBe(true);
  });

  // ── removeCargaFromPacote ───────────────────────────────────────────────────

  it("removeCargaFromPacote ressequencia (1,2,3 -> remove 2 -> 1,2)", async () => {
    const operator = await seedUser();
    const { id: pacoteId } = await seedPacote();
    const { id: cargaA } = await seedCarga({ viagem_id: pacoteId, ordem_viagem: 1 });
    const { id: cargaB } = await seedCarga({ viagem_id: pacoteId, ordem_viagem: 2 });
    const { id: cargaC } = await seedCarga({ viagem_id: pacoteId, ordem_viagem: 3 });

    await service.removeCargaFromPacote({
      operatorId: operator.id,
      pacoteId,
      cargaId: cargaB,
      correlationId: "corr-rm",
    });

    const { rows: rowsA } = await query(`SELECT id, viagem_id, ordem_viagem FROM public.cargas WHERE id=$1`, [cargaA]);
    const { rows: rowsB } = await query(`SELECT id, viagem_id, ordem_viagem FROM public.cargas WHERE id=$1`, [cargaB]);
    const { rows: rowsC } = await query(`SELECT id, viagem_id, ordem_viagem FROM public.cargas WHERE id=$1`, [cargaC]);
    expect(rowsA[0].ordem_viagem).toBe(1);
    expect(rowsC[0].ordem_viagem).toBe(2);
    expect(rowsB[0].viagem_id).toBeNull();
    expect(rowsB[0].ordem_viagem).toBeNull();
  });

  // ── reorderCargasInPacote ───────────────────────────────────────────────────

  it("reorderCargasInPacote rejeita conjunto divergente com code='orderings_cargas_divergentes'", async () => {
    const operator = await seedUser();
    const { id: pacoteId } = await seedPacote();
    const { id: cargaA } = await seedCarga({ viagem_id: pacoteId, ordem_viagem: 1 });
    await seedCarga({ viagem_id: pacoteId, ordem_viagem: 2 });
    const cargaDesconhecida = "00000000-0000-0000-0000-000000000099";

    await expect(
      service.reorderCargasInPacote({
        operatorId: operator.id,
        pacoteId,
        orderings: [
          { cargaId: cargaA, ordem: 1 },
          { cargaId: cargaDesconhecida, ordem: 2 },
        ],
        correlationId: "corr-reorder",
      }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({ code: "orderings_cargas_divergentes" }),
    });
  });

  it("reorderCargasInPacote aplica nova ordem com sucesso", async () => {
    const operator = await seedUser();
    const { id: pacoteId } = await seedPacote();
    const { id: cargaA } = await seedCarga({ viagem_id: pacoteId, ordem_viagem: 1 });
    const { id: cargaB } = await seedCarga({ viagem_id: pacoteId, ordem_viagem: 2 });

    await service.reorderCargasInPacote({
      operatorId: operator.id,
      pacoteId,
      orderings: [
        { cargaId: cargaA, ordem: 2 },
        { cargaId: cargaB, ordem: 1 },
      ],
      correlationId: "corr-reorder-ok",
    });

    const { rows } = await query(
      `SELECT id, ordem_viagem FROM public.cargas WHERE viagem_id=$1 ORDER BY ordem_viagem ASC`,
      [pacoteId],
    );
    expect(rows).toEqual([
      expect.objectContaining({ id: cargaB, ordem_viagem: 1 }),
      expect.objectContaining({ id: cargaA, ordem_viagem: 2 }),
    ]);
  });

  // ── list/get sem N+1 ────────────────────────────────────────────────────────

  it("listPacotes retorna join sem N+1 (cargas + cliente.nome inline via json_agg)", async () => {
    const operator = await seedUser();
    const { id: clienteId } = await seedCliente({ nome: "Lamonica Atlas" });
    const { id: p1 } = await seedPacote({ status: "publicado", valor_total: 6000 });
    await seedCarga({ viagem_id: p1, ordem_viagem: 1, cliente_id: clienteId });
    await seedCarga({ viagem_id: p1, ordem_viagem: 2, cliente_id: clienteId });

    const spy = vi.spyOn(await import("./test-harness.js"), "query");

    const response = await service.listPacotes({
      status: "publicado",
      limit: 20,
      offset: 0,
      correlationId: "corr-list",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.items).toHaveLength(1);
    expect(response.payload.items[0].cargas).toHaveLength(2);
    expect(response.payload.items[0].cargas[0].cliente_nome).toBe("Lamonica Atlas");
    expect(response.payload.pagination.total).toBe(1);
    spy.mockRestore();
  });

  it("getPacote retorna pacote + cargas ordenadas com cliente.nome", async () => {
    const operator = await seedUser();
    const { id: clienteId } = await seedCliente({ nome: "Cliente X" });
    const { id: pacoteId } = await seedPacote({ status: "rascunho" });
    await seedCarga({ viagem_id: pacoteId, ordem_viagem: 2, cliente_id: clienteId });
    await seedCarga({ viagem_id: pacoteId, ordem_viagem: 1, cliente_id: clienteId });

    const response = await service.getPacote({ pacoteId, correlationId: "corr-get" });

    expect(response.statusCode).toBe(200);
    expect(response.payload.pacote.id).toBe(pacoteId);
    expect(response.payload.cargas).toHaveLength(2);
    expect(response.payload.cargas[0].ordem_viagem).toBe(1);
    expect(response.payload.cargas[1].ordem_viagem).toBe(2);
    expect(response.payload.cargas[0].cliente_nome).toBe("Cliente X");
  });
});
