import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLAIM_STATUS, LOAD_STATUS, PUBLIC_LEAD_STATUS } from "../../domain/load-claims/constants.js";

vi.mock("../../infrastructure/pg/postgres.js", async () => {
  const harness = await import("./test-harness.js");
  return {
    withPgClient: harness.withPgClient,
    withPgTransaction: harness.withPgTransaction,
  };
});

vi.mock("./logging.js", () => ({
  logLoadClaimEvent: vi.fn(),
}));

let harness;
let service;
let publicLeadService;

describe.sequential("load-claim service integration", () => {
  beforeAll(async () => {
    harness = await import("./test-harness.js");
    service = await import("./service.js");
    publicLeadService = await import("./public-leads.js");
  });

  beforeEach(async () => {
    process.env.CLAIM_V2_ENABLED = "true";
    process.env.WAITLIST_ENABLED = "true";
    process.env.RESERVATION_TTL_SECONDS = "120";
    process.env.CLAIM_IDEMPOTENCY_TTL_SECONDS = "86400";
    process.env.CLAIM_MAINTENANCE_BATCH_SIZE = "25";
    process.env.PUBLIC_LOAD_WHATSAPP_NUMBER = "5571999999999";
    await harness.resetTestDatabase();
  });

  afterAll(async () => {
    await harness.closeTestDatabase();
  });

  it("rejects an ineligible driver without creating a reservation", async () => {
    const { id: loadId } = await harness.seedLoad({
      cliente_exige_seguro: true,
    });
    const { userId: driverId } = await harness.seedDriverProfile({
      insurance_valid: false,
    });

    const result = await service.createLoadClaim({
      loadId,
      driverId,
      idempotencyKey: harness.buildIdempotencyKey("ineligible"),
      correlationId: "corr-ineligible",
    });

    const load = await harness.getLoad(loadId);
    const claims = await harness.getClaimsByLoad(loadId);

    expect(result.statusCode).toBe(200);
    expect(result.payload.outcome).toBe("REJECTED");
    expect(result.payload.claim?.rejectedReason).toBe("INSURANCE_REQUIRED");
    expect(load.status).toBe(LOAD_STATUS.OPEN);
    expect(load.reserved_driver_id).toBeNull();
    expect(claims).toHaveLength(1);
    expect(claims[0].status).toBe(CLAIM_STATUS.REJECTED);
  }, 15_000);

  it("rejects a claim as LOAD_UNAVAILABLE when the source spreadsheet already locked the load (sheet_motorista set)", async () => {
    const { id: loadId } = await harness.seedLoad();
    const { userId: driverId } = await harness.seedDriverProfile();

    // Simula sync atrasado: sheet já alocou (sheet_motorista preenchido)
    // mas o status do DB ainda está OPEN — o driver portal nem deveria mostrar,
    // e mesmo se o cliente forçar POST, o createLoadClaim precisa rejeitar.
    await harness.query(
      `UPDATE public.cargas SET sheet_motorista = $2 WHERE id = $1`,
      [loadId, "JOAO SILVA"],
    );

    const result = await service.createLoadClaim({
      loadId,
      driverId,
      idempotencyKey: harness.buildIdempotencyKey("sheet-locked-motorista"),
      correlationId: "corr-sheet-locked-motorista",
    });

    const load = await harness.getLoad(loadId);
    const claims = await harness.getClaimsByLoad(loadId);

    expect(result.statusCode).toBe(200);
    expect(result.payload.outcome).toBe("REJECTED");
    expect(result.payload.claim?.rejectedReason).toBe("LOAD_UNAVAILABLE");
    expect(load.status).toBe(LOAD_STATUS.OPEN); // DB intacto — só rejeita
    expect(load.reserved_driver_id).toBeNull();
    expect(claims).toHaveLength(1);
    expect(claims[0].status).toBe(CLAIM_STATUS.REJECTED);
  }, 15_000);

  it("allows a claim when sheet_status indicates pipeline-open state (AGUARDANDO CARREGAMENTO) and no sheet_motorista", async () => {
    // Regressao do fix sheet-status-overbroad: statuses de pipeline aberto
    // ('AGUARDANDO CARREGAMENTO', 'AGUARDANDO CHEGAR NO CLIENTE') representam
    // carga ainda disponivel na planilha. O filtro nao deve bloquear claim.
    const { id: loadId } = await harness.seedLoad();
    const { userId: driverId } = await harness.seedDriverProfile();

    await harness.query(
      `UPDATE public.cargas SET sheet_status = $2 WHERE id = $1`,
      [loadId, "AGUARDANDO CARREGAMENTO"],
    );

    const result = await service.createLoadClaim({
      loadId,
      driverId,
      idempotencyKey: harness.buildIdempotencyKey("sheet-pipeline-open"),
      correlationId: "corr-sheet-pipeline-open",
    });

    expect(result.statusCode).toBe(201);
    expect(result.payload.outcome).toBe("RESERVED");
  }, 15_000);

  it("runs the OPEN -> RESERVED -> BOOKED flow for the winning driver", async () => {
    const { id: loadId } = await harness.seedLoad();
    const { userId: driverId } = await harness.seedDriverProfile();

    const reserved = await service.createLoadClaim({
      loadId,
      driverId,
      idempotencyKey: harness.buildIdempotencyKey("reserve"),
      correlationId: "corr-reserve",
    });

    const confirmed = await service.confirmLoadClaim({
      loadId,
      claimId: reserved.payload.claim.id,
      driverId,
      idempotencyKey: harness.buildIdempotencyKey("confirm"),
      correlationId: "corr-confirm",
    });

    const load = await harness.getLoad(loadId);
    const claim = await harness.getClaim(reserved.payload.claim.id);

    expect(reserved.statusCode).toBe(201);
    expect(reserved.payload.outcome).toBe("RESERVED");
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.payload.outcome).toBe("BOOKED");
    expect(load.status).toBe(LOAD_STATUS.BOOKED);
    expect(load.booked_driver_id).toBe(driverId);
    expect(claim.status).toBe(CLAIM_STATUS.CONFIRMED);
  }, 15_000);

  it("creates a reservation even when the load has no linked client row", async () => {
    const { id: loadId } = await harness.seedLoad({
      skipClient: true,
      cliente_id: null,
    });
    const { userId: driverId } = await harness.seedDriverProfile();

    const reserved = await service.createLoadClaim({
      loadId,
      driverId,
      idempotencyKey: harness.buildIdempotencyKey("reserve-no-client"),
      correlationId: "corr-reserve-no-client",
    });

    const load = await harness.getLoad(loadId);
    const claim = await harness.getClaim(reserved.payload.claim.id);

    expect(reserved.statusCode).toBe(201);
    expect(reserved.payload.outcome).toBe("RESERVED");
    expect(load.status).toBe(LOAD_STATUS.RESERVED);
    expect(load.reserved_driver_id).toBe(driverId);
    expect(claim.status).toBe(CLAIM_STATUS.WON_RESERVATION);
  }, 15_000);

  it("returns the approved public lead when the portal asks for a specific queued lead", async () => {
    const { id: loadId } = await harness.seedLoad();
    const operator = await harness.seedDriverProfile({ email: "operator-public-lead@test.local" });

    const preregistered = await publicLeadService.createPublicLoadLeadPreRegistration({
      loadId,
      payload: {
        cpf: "123.456.789-01",
        phone: "(71) 99999-9999",
        horsePlate: "ABC1D23",
        trailerPlate: "DEF4G56",
        trailerPlate2: "",
        vehicleType: "CARRETA",
      },
      correlationId: "corr-public-prereg",
    });

    const queued = await publicLeadService.queuePublicLoadLeadViaWhatsApp({
      loadId,
      leadId: preregistered.payload.lead.id,
      correlationId: "corr-public-queue",
    });

    await publicLeadService.approvePublicLoadLead({
      loadId,
      leadId: queued.payload.lead.id,
      operatorId: operator.userId,
      correlationId: "corr-public-approve",
    });

    const result = await service.getLoadClaimStatus({
      loadId,
      publicLeadId: queued.payload.lead.id,
      correlationId: "corr-status-public-lead",
    });

    expect(result.statusCode).toBe(200);
    expect(result.payload.load.status).toBe(LOAD_STATUS.RESERVED);
    expect(result.payload.publicLead).toMatchObject({
      id: queued.payload.lead.id,
      status: PUBLIC_LEAD_STATUS.APPROVED,
    });
  }, 15_000);

  it("waitlists later eligible claims behind the current reservation", async () => {
    const { id: loadId } = await harness.seedLoad();
    const firstDriver = await harness.seedDriverProfile({ email: "first@test.local" });
    const secondDriver = await harness.seedDriverProfile({ email: "second@test.local" });

    const winner = await service.createLoadClaim({
      loadId,
      driverId: firstDriver.userId,
      idempotencyKey: harness.buildIdempotencyKey("winner"),
      correlationId: "corr-winner",
    });
    const waitlisted = await service.createLoadClaim({
      loadId,
      driverId: secondDriver.userId,
      idempotencyKey: harness.buildIdempotencyKey("waitlist"),
      correlationId: "corr-waitlist",
    });

    const claims = await harness.getClaimsByLoad(loadId);

    expect(winner.payload.outcome).toBe("RESERVED");
    expect(waitlisted.statusCode).toBe(202);
    expect(waitlisted.payload.outcome).toBe("WAITLISTED");
    expect(waitlisted.payload.claim?.queuePosition).toBe(1);
    expect(claims.map((claim) => claim.status)).toEqual([
      CLAIM_STATUS.WON_RESERVATION,
      CLAIM_STATUS.WAITLISTED,
    ]);
  }, 15_000);

  it("fails confirmation after expiration and promotes the next eligible waitlisted driver", async () => {
    const { id: loadId } = await harness.seedLoad();
    const firstDriver = await harness.seedDriverProfile({ email: "expired@test.local" });
    const secondDriver = await harness.seedDriverProfile({ email: "promoted@test.local" });

    const winner = await service.createLoadClaim({
      loadId,
      driverId: firstDriver.userId,
      idempotencyKey: harness.buildIdempotencyKey("winner"),
      correlationId: "corr-winner",
    });

    await service.createLoadClaim({
      loadId,
      driverId: secondDriver.userId,
      idempotencyKey: harness.buildIdempotencyKey("waitlisted"),
      correlationId: "corr-waitlisted",
    });

    await harness.expireReservation(loadId);

    await expect(
      service.confirmLoadClaim({
        loadId,
        claimId: winner.payload.claim.id,
        driverId: firstDriver.userId,
        idempotencyKey: harness.buildIdempotencyKey("confirm-expired"),
        correlationId: "corr-confirm-expired",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        code: "RESERVATION_NOT_ACTIVE",
      },
    });

    const load = await harness.getLoad(loadId);
    const claims = await harness.getClaimsByLoad(loadId);

    expect(load.status).toBe(LOAD_STATUS.RESERVED);
    expect(load.reserved_driver_id).toBe(secondDriver.userId);
    expect(claims.map((claim) => claim.status)).toEqual([
      CLAIM_STATUS.EXPIRED,
      CLAIM_STATUS.PROMOTED,
    ]);
  }, 15_000);

  it("cancels a waitlisted claim and resequences the queue", async () => {
    const { id: loadId } = await harness.seedLoad();
    const winner = await harness.seedDriverProfile({ email: "winner@test.local" });
    const waitlistA = await harness.seedDriverProfile({ email: "waitlist-a@test.local" });
    const waitlistB = await harness.seedDriverProfile({ email: "waitlist-b@test.local" });

    await service.createLoadClaim({
      loadId,
      driverId: winner.userId,
      idempotencyKey: harness.buildIdempotencyKey("winner"),
      correlationId: "corr-winner",
    });

    const queuedA = await service.createLoadClaim({
      loadId,
      driverId: waitlistA.userId,
      idempotencyKey: harness.buildIdempotencyKey("queue-a"),
      correlationId: "corr-queue-a",
    });

    await service.createLoadClaim({
      loadId,
      driverId: waitlistB.userId,
      idempotencyKey: harness.buildIdempotencyKey("queue-b"),
      correlationId: "corr-queue-b",
    });

    const cancelled = await service.cancelLoadClaim({
      loadId,
      claimId: queuedA.payload.claim.id,
      driverId: waitlistA.userId,
      idempotencyKey: harness.buildIdempotencyKey("cancel-queue-a"),
      correlationId: "corr-cancel-queue-a",
    });

    const claims = await harness.getClaimsByLoad(loadId);

    expect(cancelled.payload.outcome).toBe("CANCELLED");
    expect(claims.map((claim) => [claim.driver_id, claim.status, claim.queue_position])).toEqual([
      [winner.userId, CLAIM_STATUS.WON_RESERVATION, null],
      [waitlistA.userId, CLAIM_STATUS.CANCELLED, null],
      [waitlistB.userId, CLAIM_STATUS.WAITLISTED, 1],
    ]);
  }, 15_000);

  it("runs the OPEN -> RESERVED -> EXPIRED -> OPEN flow when there is no waitlist", async () => {
    const { id: loadId } = await harness.seedLoad();
    const { userId: driverId } = await harness.seedDriverProfile();

    const reserved = await service.createLoadClaim({
      loadId,
      driverId,
      idempotencyKey: harness.buildIdempotencyKey("reserve-expire-open"),
      correlationId: "corr-reserve-expire-open",
    });

    await harness.expireReservation(loadId);

    const maintenance = await service.processExpiredLoadClaims({
      batchSize: 10,
      correlationId: "corr-maintenance-open",
    });

    const load = await harness.getLoad(loadId);
    const claim = await harness.getClaim(reserved.payload.claim.id);

    expect(maintenance).toMatchObject({
      processedCount: 1,
      promotedCount: 0,
      reopenedCount: 1,
    });
    expect(load.status).toBe(LOAD_STATUS.OPEN);
    expect(load.reserved_driver_id).toBeNull();
    expect(claim.status).toBe(CLAIM_STATUS.EXPIRED);
  }, 15_000);

  it("runs the OPEN -> RESERVED -> EXPIRED -> PROMOTED -> BOOKED flow", async () => {
    const { id: loadId } = await harness.seedLoad();
    const firstDriver = await harness.seedDriverProfile({ email: "first-promo@test.local" });
    const secondDriver = await harness.seedDriverProfile({ email: "second-promo@test.local" });

    const firstClaim = await service.createLoadClaim({
      loadId,
      driverId: firstDriver.userId,
      idempotencyKey: harness.buildIdempotencyKey("promo-first"),
      correlationId: "corr-promo-first",
    });

    await service.createLoadClaim({
      loadId,
      driverId: secondDriver.userId,
      idempotencyKey: harness.buildIdempotencyKey("promo-second"),
      correlationId: "corr-promo-second",
    });

    await harness.expireReservation(loadId);

    await service.processExpiredLoadClaims({
      batchSize: 10,
      correlationId: "corr-maintenance-promote",
    });

    const claimsAfterPromotion = await harness.getClaimsByLoad(loadId);
    const promotedClaim = claimsAfterPromotion.find((claim) => claim.driver_id === secondDriver.userId);

    const confirmed = await service.confirmLoadClaim({
      loadId,
      claimId: promotedClaim.id,
      driverId: secondDriver.userId,
      idempotencyKey: harness.buildIdempotencyKey("promo-confirm"),
      correlationId: "corr-promo-confirm",
    });

    const load = await harness.getLoad(loadId);
    const firstClaimRow = await harness.getClaim(firstClaim.payload.claim.id);
    const secondClaimRow = await harness.getClaim(promotedClaim.id);

    expect(confirmed.payload.outcome).toBe("BOOKED");
    expect(load.status).toBe(LOAD_STATUS.BOOKED);
    expect(load.booked_driver_id).toBe(secondDriver.userId);
    expect(firstClaimRow.status).toBe(CLAIM_STATUS.EXPIRED);
    expect(secondClaimRow.status).toBe(CLAIM_STATUS.CONFIRMED);
  }, 15_000);

  it("rejects the same idempotency key when the payload fingerprint changes", async () => {
    const { id: loadId } = await harness.seedLoad();
    const { userId: driverId } = await harness.seedDriverProfile();
    const idempotencyKey = harness.buildIdempotencyKey("idem-conflict");

    await service.createLoadClaim({
      loadId,
      driverId,
      idempotencyKey,
      correlationId: "corr-idem-1",
      requestPayload: {
        source: "mobile",
      },
    });

    await expect(
      service.createLoadClaim({
        loadId,
        driverId,
        idempotencyKey,
        correlationId: "corr-idem-2",
        requestPayload: {
          source: "backoffice",
        },
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: {
        code: "IDEMPOTENCY_CONFLICT",
      },
    });
  }, 15_000);
});
