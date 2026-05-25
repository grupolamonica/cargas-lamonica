/**
 * cascade.test.js — Tests de cascade reverso (D-05 LOCKED) + invalidacao
 * de candidaturas em mutacao de pacote publicado (D-06 LOCKED) + backward-compat
 * para carga avulsa.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCarga,
  seedDriverProfile,
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

const { cascadeCancelFromCarga } = await import("./use-cases/cascade-cancel-from-carga.js");
const { createPacoteClaim } = await import("./use-cases/atomic-claim.js");
const { updatePacote } = await import("./use-cases/update-pacote.js");
const { addCargaToPacote } = await import("./use-cases/add-carga.js");
const { reorderCargasInPacote } = await import("./use-cases/reorder-carga.js");
const { removeCargaFromPacote } = await import("./use-cases/remove-carga.js");
const { toggleOperatorCargoStatus } = await import("../operator-admin/use-cases/toggle-cargo-status.js");

async function seedPublishedPacoteWithCargas(count = 3) {
  const operator = await seedUser();
  const { id: pacoteId } = await seedPacote({
    status: "publicado",
    valor_total: 12000,
    version: 2,
    published_at: new Date().toISOString(),
    created_by: operator.id,
  });
  const cargaIds = [];
  for (let i = 1; i <= count; i++) {
    const { id } = await seedCarga({
      viagem_id: pacoteId,
      ordem_viagem: i,
      driver_visibility: "PREMIUM",
      status: "OPEN",
    });
    cargaIds.push(id);
  }
  return { operator, pacoteId, cargaIds };
}

describe("cargas-casadas — cascade (D-05) + invalidation (D-06) + backward-compat", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  // ── D-05 — cancel cascade ───────────────────────────────────────────────────
  it("cancelar 1 carga de pacote [C1,C2,C3] -> pacote='cancelado', irmas='CANCELLED' (transacao unica)", async () => {
    const { operator, pacoteId, cargaIds } = await seedPublishedPacoteWithCargas(3);

    const result = await cascadeCancelFromCarga({
      cargaId: cargaIds[0],
      operatorId: operator.id,
      reason: "TEST_CASCADE",
      correlationId: "corr-cas-1",
    });

    expect(result.pacoteId).toBe(pacoteId);
    expect(result.cancelledCargaIds).toHaveLength(3);

    const { rows: pacoteRows } = await query(
      `SELECT status, version FROM public.cargas_casadas WHERE id=$1`,
      [pacoteId],
    );
    expect(pacoteRows[0].status).toBe("cancelado");
    expect(pacoteRows[0].version).toBe(3); // 2 + 1

    const { rows: cargasRows } = await query(
      `SELECT id, status, reserved_driver_id, booked_driver_id FROM public.cargas WHERE viagem_id=$1`,
      [pacoteId],
    );
    expect(cargasRows).toHaveLength(3);
    cargasRows.forEach((c) => {
      expect(c.status).toBe("CANCELLED");
      expect(c.reserved_driver_id).toBeNull();
      expect(c.booked_driver_id).toBeNull();
    });
  });

  it("cascade cancel rejeita claims ativos do pacote (WON_RESERVATION/WAITLISTED/PROMOTED -> REJECTED)", async () => {
    const { operator, pacoteId, cargaIds } = await seedPublishedPacoteWithCargas(2);
    const driverA = await seedUser({ email: "da@teste.local" });
    const driverB = await seedUser({ email: "db@teste.local" });
    const driverC = await seedUser({ email: "dc@teste.local" });

    await seedLoadClaim({ load_id: cargaIds[0], driver_id: driverA.id, status: "WON_RESERVATION" });
    await seedLoadClaim({ load_id: cargaIds[1], driver_id: driverB.id, status: "WAITLISTED" });
    await seedLoadClaim({ load_id: cargaIds[0], driver_id: driverC.id, status: "CONFIRMED" });

    await cascadeCancelFromCarga({
      cargaId: cargaIds[0],
      operatorId: operator.id,
      reason: "TEST_CLAIMS",
      correlationId: "corr-cas-2",
    });

    const { rows: claims } = await query(
      `SELECT status, rejected_reason FROM public.load_claims ORDER BY status`,
    );
    const byStatus = Object.fromEntries(claims.map((c) => [c.status, c]));
    expect(byStatus.CONFIRMED).toBeDefined();
    expect(byStatus.CONFIRMED.rejected_reason).toBeNull(); // CONFIRMED nao e tocado
    const rejectedClaims = claims.filter((c) => c.status === "REJECTED");
    expect(rejectedClaims).toHaveLength(2);
    expect(rejectedClaims.every((c) => c.rejected_reason === "PACOTE_CARGA_CANCELLED")).toBe(true);
  });

  it("cascade idempotente: pacote ja em status='cancelado' -> no-op (alreadyCancelled=true)", async () => {
    const { operator, pacoteId, cargaIds } = await seedPublishedPacoteWithCargas(2);
    // 1a vez
    await cascadeCancelFromCarga({
      cargaId: cargaIds[0],
      operatorId: operator.id,
      reason: "TEST_FIRST",
      correlationId: "corr-cas-idem-1",
    });
    // 2a vez no mesmo pacote (qualquer carga)
    const second = await cascadeCancelFromCarga({
      cargaId: cargaIds[1],
      operatorId: operator.id,
      reason: "TEST_SECOND",
      correlationId: "corr-cas-idem-2",
    });
    expect(second.alreadyCancelled).toBe(true);
    expect(second.cancelledCargaIds).toHaveLength(0);
  });

  // ── D-06 — invalidacao em version bump ──────────────────────────────────────
  it("updatePacote em status='publicado' -> claims ativos viram REJECTED + cargas voltam OPEN + pacote desce de reservado para publicado", async () => {
    const { operator, pacoteId, cargaIds } = await seedPublishedPacoteWithCargas(2);
    const driver = await seedDriverProfile({ email: "ed@teste.local" });

    // Driver candidata - pacote vira 'reservado'.
    await createPacoteClaim({
      pacoteId,
      driverId: driver.userId,
      idempotencyKey: "edt-1",
      requestPayload: {},
      correlationId: "corr-edt-1",
    });
    let { rows: pacoteAntes } = await query(
      `SELECT status, reserved_driver_id FROM public.cargas_casadas WHERE id=$1`,
      [pacoteId],
    );
    expect(pacoteAntes[0].status).toBe("reservado");

    // Operador edita valor_total - dispara invalidacao.
    await updatePacote({
      operatorId: operator.id,
      pacoteId,
      payload: { valor_total: 15000 },
      correlationId: "corr-edt-2",
    });

    // Pacote: 'reservado' -> 'publicado', reserved_driver_id null.
    const { rows: pacoteDepois } = await query(
      `SELECT status, valor_total, reserved_driver_id FROM public.cargas_casadas WHERE id=$1`,
      [pacoteId],
    );
    expect(pacoteDepois[0].status).toBe("publicado");
    expect(pacoteDepois[0].reserved_driver_id).toBeNull();
    expect(Number(pacoteDepois[0].valor_total)).toBe(15000);

    // Claims: todos REJECTED com reason='PACOTE_VERSION_BUMPED'.
    const { rows: claims } = await query(`SELECT status, rejected_reason FROM public.load_claims`);
    expect(claims).toHaveLength(2);
    claims.forEach((c) => {
      expect(c.status).toBe("REJECTED");
      expect(c.rejected_reason).toBe("PACOTE_VERSION_BUMPED");
    });

    // Cargas: voltam OPEN, reserved_* limpo.
    const { rows: cargas } = await query(
      `SELECT id, status, reserved_driver_id FROM public.cargas WHERE viagem_id=$1`,
      [pacoteId],
    );
    cargas.forEach((c) => {
      expect(c.status).toBe("OPEN");
      expect(c.reserved_driver_id).toBeNull();
    });
  });

  it("reorderCargasInPacote em status='publicado' com claim WAITLISTED ativo -> dispara invalidacao", async () => {
    const { operator, pacoteId, cargaIds } = await seedPublishedPacoteWithCargas(2);
    const driver = await seedUser({ email: "reord@teste.local" });

    // Seed direto um claim WAITLISTED para a carga[0] do pacote — simulando estado
    // pre-existente. Pacote continua em 'publicado'.
    await seedLoadClaim({
      load_id: cargaIds[0],
      driver_id: driver.id,
      status: "WAITLISTED",
    });

    await reorderCargasInPacote({
      operatorId: operator.id,
      pacoteId,
      orderings: [
        { cargaId: cargaIds[1], ordem: 1 },
        { cargaId: cargaIds[0], ordem: 2 },
      ],
      correlationId: "corr-reord-2",
    });

    const { rows: claims } = await query(
      `SELECT status, rejected_reason FROM public.load_claims`,
    );
    claims.forEach((c) => {
      expect(c.status).toBe("REJECTED");
      expect(c.rejected_reason).toBe("PACOTE_VERSION_BUMPED");
    });
  });

  it("addCargaToPacote em 'publicado' com claim WON_RESERVATION pre-existente -> invalida claim", async () => {
    const { operator, pacoteId, cargaIds } = await seedPublishedPacoteWithCargas(2);
    const driver = await seedUser({ email: "add@teste.local" });

    // Seed claim WON_RESERVATION + reserved_driver_id na carga[0] — simulando estado
    // de pacote com candidato ativo (sem usar createPacoteClaim para evitar mudar
    // status do pacote para 'reservado').
    const { id: existingClaimId } = await seedLoadClaim({
      load_id: cargaIds[0],
      driver_id: driver.id,
      status: "WON_RESERVATION",
    });
    await query(
      `UPDATE public.cargas SET status='RESERVED', reserved_driver_id=$2, reserved_claim_id=$3 WHERE id=$1`,
      [cargaIds[0], driver.id, existingClaimId],
    );

    // Nova carga PREMIUM avulsa para adicionar.
    const { id: novaCargaId } = await seedCarga({
      driver_visibility: "PREMIUM",
      status: "OPEN",
    });

    await addCargaToPacote({
      operatorId: operator.id,
      pacoteId,
      cargaId: novaCargaId,
      correlationId: "corr-add",
    });

    const { rows: claimRows } = await query(
      `SELECT id, status, rejected_reason FROM public.load_claims WHERE id=$1`,
      [existingClaimId],
    );
    expect(claimRows[0].status).toBe("REJECTED");
    expect(claimRows[0].rejected_reason).toBe("PACOTE_VERSION_BUMPED");
  });

  it("removeCargaFromPacote em 'publicado' com claim PROMOTED -> invalida claim", async () => {
    const { operator, pacoteId, cargaIds } = await seedPublishedPacoteWithCargas(3);
    const driver = await seedUser({ email: "rem@teste.local" });

    await seedLoadClaim({
      load_id: cargaIds[1],
      driver_id: driver.id,
      status: "PROMOTED",
    });

    await removeCargaFromPacote({
      operatorId: operator.id,
      pacoteId,
      cargaId: cargaIds[2],
      correlationId: "corr-rem",
    });

    const { rows: claims } = await query(
      `SELECT status, rejected_reason FROM public.load_claims WHERE driver_id=$1`,
      [driver.id],
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].status).toBe("REJECTED");
    expect(claims[0].rejected_reason).toBe("PACOTE_VERSION_BUMPED");
  });

  it("updatePacote em 'rascunho' NAO incrementa version nem invalida (D-06 so vale em publicado)", async () => {
    const { operator, pacoteId } = await seedPublishedPacoteWithCargas(1);
    // Forca pacote para rascunho
    await query(
      `UPDATE public.cargas_casadas SET status='rascunho', version=5 WHERE id=$1`,
      [pacoteId],
    );

    await updatePacote({
      operatorId: operator.id,
      pacoteId,
      payload: { valor_total: 10000 },
      correlationId: "corr-rasc",
    });

    const { rows } = await query(
      `SELECT version FROM public.cargas_casadas WHERE id=$1`,
      [pacoteId],
    );
    expect(rows[0].version).toBe(5); // sem bump
  });

  // ── Backward-compat: carga avulsa preserva fluxo original ──────────────────
  it("toggleOperatorCargoStatus em carga avulsa (viagem_id IS NULL) preserva fluxo OPEN<->DRAFT sem cascade", async () => {
    const operator = await seedUser({ email: "op-avulsa@teste.local" });
    const { id: cargaId } = await seedCarga({
      created_by: operator.id,
      status: "OPEN",
      viagem_id: null,
    });

    const result = await toggleOperatorCargoStatus({
      cargoId: cargaId,
      operatorId: operator.id,
      operatorAccessLevel: "advanced",
      correlationId: "corr-bc-1",
    });

    expect(result.statusCode).toBe(200);
    expect(result.payload.cascade).toBeUndefined();
    expect(result.payload.status).toBe("DRAFT");

    // Nenhuma alteracao em cargas_casadas (zero rows inseridos).
    const { rows: pacotes } = await query(`SELECT COUNT(*)::int AS n FROM public.cargas_casadas`);
    expect(pacotes[0].n).toBe(0);

    // Carga avulsa: status agora DRAFT, viagem_id continua NULL.
    const { rows: cargaRows } = await query(
      `SELECT status, viagem_id FROM public.cargas WHERE id=$1`,
      [cargaId],
    );
    expect(cargaRows[0].status).toBe("DRAFT");
    expect(cargaRows[0].viagem_id).toBeNull();
  });

  it("toggleOperatorCargoStatus em carga DENTRO de pacote -> dispara cascade (pacote+irmas CANCELLED)", async () => {
    const { operator, pacoteId, cargaIds } = await seedPublishedPacoteWithCargas(2);

    const result = await toggleOperatorCargoStatus({
      cargoId: cargaIds[0],
      operatorId: operator.id,
      operatorAccessLevel: "advanced",
      correlationId: "corr-bc-2",
    });

    expect(result.statusCode).toBe(200);
    expect(result.payload.cascade).toBe(true);
    expect(result.payload.pacoteId).toBe(pacoteId);
    expect(result.payload.cancelledCargaIds).toHaveLength(2);

    const { rows: cargas } = await query(
      `SELECT status FROM public.cargas WHERE viagem_id=$1`,
      [pacoteId],
    );
    cargas.forEach((c) => expect(c.status).toBe("CANCELLED"));

    const { rows: pacoteRows } = await query(
      `SELECT status FROM public.cargas_casadas WHERE id=$1`,
      [pacoteId],
    );
    expect(pacoteRows[0].status).toBe("cancelado");
  });
});
