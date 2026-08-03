/**
 * Cache + single-flight do claim-status do motorista (`GET /api/loads/:id/claim-status`).
 *
 * É a leitura de maior FREQUÊNCIA do lado do motorista: o portal faz poll de cada
 * lead rastreado a 30s (QUEUED) / 60s e o DriverClaimPanel a 15s por painel
 * aberto, sem dedupe entre abas/painéis — × centenas de motoristas. Cada poll
 * custava até 4 consultas frescas.
 *
 * Estes testes medem o custo REAL em consultas/linhas (proxy direto de egress) e
 * travam as duas propriedades que importam:
 *   1) o custo de N polls colapsa para 1 leitura por janela de TTL;
 *   2) NADA vaza entre identidades — a chave de cada cache é exatamente a lista
 *      de parâmetros da consulta que ele memoriza, então o claim/lead/perfil de
 *      um motorista nunca é servido a outro.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLAIM_STATUS, LOAD_STATUS, PUBLIC_LEAD_STATUS } from "../../domain/load-claims/constants.js";
import { NotFoundError } from "../../domain/load-claims/errors.js";
import {
  buildIdempotencyKey,
  closeTestDatabase,
  query as harnessQuery,
  resetTestDatabase,
  seedDriverProfile,
  seedLoad,
  withPgClient as harnessWithPgClient,
  withPgTransaction,
} from "./test-harness.js";

// Contador de consultas + linhas trafegadas (proxy de egress).
const dbStats = { queries: 0, rows: 0 };

function resetDbStats() {
  dbStats.queries = 0;
  dbStats.rows = 0;
}

// O pool do pg-mem REUTILIZA clients, então o wrapper precisa ser idempotente:
// envolver duas vezes o mesmo client contaria cada consulta em dobro.
const INSTRUMENTED = Symbol.for("egress.instrumented");

function instrumentClient(client) {
  if (client[INSTRUMENTED]) return client;
  const originalQuery = client.query.bind(client);
  client.query = async (...args) => {
    const result = await originalQuery(...args);
    dbStats.queries += 1;
    dbStats.rows += result?.rows?.length ?? result?.rowCount ?? 0;
    return result;
  };
  client[INSTRUMENTED] = true;
  return client;
}

// Só o caminho de LEITURA (withPgClient) é instrumentado — as transações de
// mutação e o seed não entram na contagem.
vi.mock("../../infrastructure/pg/postgres.js", () => ({
  withPgClient: (callback) => harnessWithPgClient((client) => callback(instrumentClient(client))),
  withPgTransaction,
}));

vi.mock("./logging.js", () => ({
  logLoadClaimEvent: vi.fn(),
}));

const service = await import("./service.js");

const CACHE_ON = "60000";
const CACHE_OFF = "0";

function applyClaimEnv() {
  process.env.CLAIM_V2_ENABLED = "true";
  process.env.WAITLIST_ENABLED = "true";
  process.env.RESERVATION_TTL_SECONDS = "120";
  process.env.CLAIM_IDEMPOTENCY_TTL_SECONDS = "86400";
  process.env.CLAIM_MAINTENANCE_BATCH_SIZE = "25";
  process.env.PUBLIC_LOAD_WHATSAPP_NUMBER = "5571999999999";
}

function setCache(ttl) {
  process.env.CLAIM_STATUS_CACHE_TTL_MS = ttl;
  service.__resetClaimStatusCache();
}

async function seedPublicLead({ loadId, cpf, status = PUBLIC_LEAD_STATUS.QUEUED }) {
  const { rows } = await harnessQuery(
    `
      INSERT INTO public.load_public_leads (
        load_id, cpf, phone, horse_plate, trailer_plate, vehicle_type, status, queued_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, now())
      RETURNING id
    `,
    [loadId, cpf, "(71) 99999-9999", "ABC1D23", "DEF4G56", "CARRETA", status],
  );

  return rows[0].id;
}

/** Simula um poll do portal (autenticado) e devolve o custo medido. */
async function pollAuthenticated({ loadId, driverId, publicLeadId = null, correlationId = "corr" }) {
  return service.getLoadClaimStatus({ loadId, driverId, publicLeadId, correlationId });
}

describe.sequential("claim-status — cache + single-flight (egress do poll do motorista)", () => {
  let loadId;
  let driverA;
  let driverB;

  beforeEach(async () => {
    applyClaimEnv();
    delete process.env.CLAIM_STATUS_CACHE_TTL_MS;
    await resetTestDatabase();
    service.__resetClaimStatusCache();

    ({ id: loadId } = await seedLoad());
    driverA = (await seedDriverProfile({ email: "driver-a@test.local" })).userId;
    driverB = (await seedDriverProfile({ email: "driver-b@test.local" })).userId;
    resetDbStats();
  });

  afterAll(async () => {
    delete process.env.CLAIM_STATUS_CACHE_TTL_MS;
    await closeTestDatabase();
  });

  it("SEM cache (TTL=0): cada poll custa uma leitura completa (custo linear)", async () => {
    setCache(CACHE_OFF);

    resetDbStats();
    await pollAuthenticated({ loadId, driverId: driverA });
    const single = { ...dbStats };

    const POLLS = 20;
    resetDbStats();
    for (let i = 0; i < POLLS; i += 1) {
      await pollAuthenticated({ loadId, driverId: driverA, correlationId: `corr-${i}` });
    }
    const many = { ...dbStats };

    expect(single.queries).toBe(3); // carga+cliente, perfil, claim
    expect(many.queries).toBe(single.queries * POLLS);
    expect(many.rows).toBe(single.rows * POLLS);

    console.log(`[egress] claim-status SEM cache: ${POLLS} polls => ${many.queries} consultas, ${many.rows} linhas`);
  }, 20_000);

  it("COM cache: N polls do MESMO motorista custam UMA leitura", async () => {
    setCache(CACHE_ON);

    resetDbStats();
    await pollAuthenticated({ loadId, driverId: driverA });
    const baseline = { ...dbStats };

    setCache(CACHE_ON); // zera o cache p/ medir do frio
    const POLLS = 20;
    resetDbStats();
    for (let i = 0; i < POLLS; i += 1) {
      await pollAuthenticated({ loadId, driverId: driverA, correlationId: `corr-${i}` });
    }

    expect(dbStats.queries).toBe(baseline.queries);
    expect(dbStats.rows).toBe(baseline.rows);
  }, 20_000);

  it("COM cache: rajada de N motoristas na MESMA carga lê a linha da carga UMA vez", async () => {
    const DRIVERS = 10;
    const POLLS_PER_DRIVER = 3; // painel (15s) + lead rastreado (30s) + refetch de foco
    const drivers = [];
    for (let i = 0; i < DRIVERS; i += 1) {
      drivers.push((await seedDriverProfile({ email: `burst-${i}@test.local` })).userId);
    }

    setCache(CACHE_OFF);
    resetDbStats();
    for (const driverId of drivers) {
      for (let p = 0; p < POLLS_PER_DRIVER; p += 1) {
        await pollAuthenticated({ loadId, driverId, correlationId: `off-${driverId}-${p}` });
      }
    }
    const off = { ...dbStats };

    setCache(CACHE_ON);
    resetDbStats();
    for (const driverId of drivers) {
      for (let p = 0; p < POLLS_PER_DRIVER; p += 1) {
        await pollAuthenticated({ loadId, driverId, correlationId: `on-${driverId}-${p}` });
      }
    }
    const on = { ...dbStats };

    // Sem cache: 3 consultas por poll.
    expect(off.queries).toBe(DRIVERS * POLLS_PER_DRIVER * 3);
    // Com cache: 1 leitura da carga (compartilhada) + 1 perfil + 1 claim por
    // MOTORISTA — os polls repetidos e os demais motoristas na mesma carga não
    // custam nada.
    expect(on.queries).toBe(1 + DRIVERS * 2);

    const reduction = 1 - on.queries / off.queries;
    expect(reduction).toBeGreaterThan(0.6);

    console.log(
      `[egress] claim-status ${DRIVERS} motoristas x ${POLLS_PER_DRIVER} polls: ` +
        `${off.queries} => ${on.queries} consultas (${off.rows} => ${on.rows} linhas, ` +
        `reducao de ${(reduction * 100).toFixed(1)}%)`,
    );
  }, 30_000);

  it("single-flight: rajada concorrente do mesmo motorista compartilha UMA leitura", async () => {
    setCache(CACHE_ON);

    resetDbStats();
    const burst = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        pollAuthenticated({ loadId, driverId: driverA, correlationId: `burst-${i}` }),
      ),
    );

    expect(dbStats.queries).toBe(3);
    burst.forEach((result) => expect(result.statusCode).toBe(200));
    burst.forEach((result) => expect(result.payload.load.id).toBe(loadId));
  }, 20_000);

  it("ISOLAMENTO: cada motorista recebe o SEU claim (a chave inclui o driverId)", async () => {
    const winner = await service.createLoadClaim({
      loadId,
      driverId: driverA,
      idempotencyKey: buildIdempotencyKey("iso-a"),
      correlationId: "corr-iso-a",
    });
    const waitlisted = await service.createLoadClaim({
      loadId,
      driverId: driverB,
      idempotencyKey: buildIdempotencyKey("iso-b"),
      correlationId: "corr-iso-b",
    });

    expect(winner.payload.claim.status).toBe(CLAIM_STATUS.WON_RESERVATION);
    expect(waitlisted.payload.claim.status).toBe(CLAIM_STATUS.WAITLISTED);

    setCache(CACHE_ON);

    // A ordem importa: A esquenta o cache da carga (compartilhado) e do próprio
    // claim; B tem de continuar vendo o SEU claim, não o de A.
    const statusA = await pollAuthenticated({ loadId, driverId: driverA, correlationId: "iso-a-1" });
    const statusB = await pollAuthenticated({ loadId, driverId: driverB, correlationId: "iso-b-1" });
    const statusAAgain = await pollAuthenticated({ loadId, driverId: driverA, correlationId: "iso-a-2" });
    const statusBAgain = await pollAuthenticated({ loadId, driverId: driverB, correlationId: "iso-b-2" });

    expect(statusA.payload.claim.id).toBe(winner.payload.claim.id);
    expect(statusA.payload.claim.status).toBe(CLAIM_STATUS.WON_RESERVATION);
    expect(statusB.payload.claim.id).toBe(waitlisted.payload.claim.id);
    expect(statusB.payload.claim.status).toBe(CLAIM_STATUS.WAITLISTED);
    expect(statusB.payload.claim.queuePosition).toBe(1);

    // Os hits de cache também respeitam a identidade.
    expect(statusAAgain.payload.claim).toEqual(statusA.payload.claim);
    expect(statusBAgain.payload.claim).toEqual(statusB.payload.claim);
    expect(statusA.payload.claim.id).not.toBe(statusB.payload.claim.id);
  }, 25_000);

  it("ISOLAMENTO: cada motorista recebe o SEU perfil (a chave é o driverId)", async () => {
    const named = (await seedDriverProfile({ email: "perfil-x@test.local", full_name: "MOTORISTA X" })).userId;
    const other = (await seedDriverProfile({ email: "perfil-y@test.local", full_name: "MOTORISTA Y" })).userId;

    setCache(CACHE_ON);

    const first = await pollAuthenticated({ loadId, driverId: named, correlationId: "perfil-1" });
    const second = await pollAuthenticated({ loadId, driverId: other, correlationId: "perfil-2" });
    const firstAgain = await pollAuthenticated({ loadId, driverId: named, correlationId: "perfil-3" });

    expect(first.payload.driverProfile.fullName).toBe("MOTORISTA X");
    expect(second.payload.driverProfile.fullName).toBe("MOTORISTA Y");
    expect(firstAgain.payload.driverProfile.fullName).toBe("MOTORISTA X");
  }, 20_000);

  it("ISOLAMENTO: poll anônimo não herda valor/bonus de um poll autenticado", async () => {
    const leadId = await seedPublicLead({ loadId, cpf: "111.111.111-11" });

    setCache(CACHE_ON);

    // Autenticado primeiro: esquenta a linha da carga (que contém valor/bonus).
    const authenticated = await pollAuthenticated({ loadId, driverId: driverA, correlationId: "anon-1" });
    expect(authenticated.payload.load.valor).not.toBeUndefined();

    // Anônimo (só leadId) reaproveita a MESMA linha cacheada, mas o gate de
    // valores monetários é aplicado por chamada.
    const anonymous = await service.getLoadClaimStatus({
      loadId,
      publicLeadId: leadId,
      correlationId: "anon-2",
    });

    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.payload.load.id).toBe(loadId);
    expect("valor" in anonymous.payload.load).toBe(false);
    expect("bonus" in anonymous.payload.load).toBe(false);
    expect(anonymous.payload.driverProfile).toBeNull();
    expect(anonymous.payload.publicLead.id).toBe(leadId);
  }, 20_000);

  it("ISOLAMENTO: leads distintos da mesma carga não se misturam", async () => {
    const leadOne = await seedPublicLead({ loadId, cpf: "222.222.222-22" });
    const leadTwo = await seedPublicLead({
      loadId,
      cpf: "333.333.333-33",
      status: PUBLIC_LEAD_STATUS.PRE_REGISTERED,
    });

    setCache(CACHE_ON);

    const first = await service.getLoadClaimStatus({ loadId, publicLeadId: leadOne, correlationId: "lead-1" });
    const second = await service.getLoadClaimStatus({ loadId, publicLeadId: leadTwo, correlationId: "lead-2" });
    const firstAgain = await service.getLoadClaimStatus({ loadId, publicLeadId: leadOne, correlationId: "lead-3" });

    expect(first.payload.publicLead.id).toBe(leadOne);
    expect(first.payload.publicLead.status).toBe(PUBLIC_LEAD_STATUS.QUEUED);
    expect(second.payload.publicLead.id).toBe(leadTwo);
    expect(second.payload.publicLead.status).toBe(PUBLIC_LEAD_STATUS.PRE_REGISTERED);
    expect(firstAgain.payload.publicLead.id).toBe(leadOne);
  }, 20_000);

  it("ISOLAMENTO: lead de OUTRA carga não é servido (o par leadId|loadId é a chave)", async () => {
    const { id: otherLoadId } = await seedLoad({ origem: "Salvador / BA", destino: "Campinas / SP" });
    const leadOfOtherLoad = await seedPublicLead({ loadId: otherLoadId, cpf: "444.444.444-44" });

    setCache(CACHE_ON);

    const correct = await service.getLoadClaimStatus({
      loadId: otherLoadId,
      publicLeadId: leadOfOtherLoad,
      correlationId: "cross-1",
    });
    // Mesmo leadId, carga errada: continua sendo null (o `AND load_id = $2` faz
    // parte da chave, então o cache não pode "promover" o lead para outra carga).
    const crossed = await service.getLoadClaimStatus({
      loadId,
      publicLeadId: leadOfOtherLoad,
      correlationId: "cross-2",
    });

    expect(correct.payload.publicLead.id).toBe(leadOfOtherLoad);
    expect(crossed.payload.publicLead).toBeNull();
  }, 20_000);

  it("read-your-write: o Aceitar do motorista aparece no poll seguinte (dentro do TTL)", async () => {
    setCache(CACHE_ON);

    const before = await pollAuthenticated({ loadId, driverId: driverA, correlationId: "ryw-1" });
    expect(before.payload.claim).toBeNull();
    expect(before.payload.load.status).toBe(LOAD_STATUS.OPEN);

    const claimed = await service.createLoadClaim({
      loadId,
      driverId: driverA,
      idempotencyKey: buildIdempotencyKey("ryw"),
      correlationId: "corr-ryw",
    });
    expect(claimed.payload.outcome).toBe("RESERVED");

    // Sem invalidação, o poll seguinte serviria o estado pré-claim por até 1 TTL.
    const after = await pollAuthenticated({ loadId, driverId: driverA, correlationId: "ryw-2" });
    expect(after.payload.claim.id).toBe(claimed.payload.claim.id);
    expect(after.payload.claim.status).toBe(CLAIM_STATUS.WON_RESERVATION);
    expect(after.payload.load.status).toBe(LOAD_STATUS.RESERVED);
  }, 25_000);

  it("read-your-write: cancelar reabre a carga no poll seguinte", async () => {
    const claimed = await service.createLoadClaim({
      loadId,
      driverId: driverA,
      idempotencyKey: buildIdempotencyKey("cancel-ryw"),
      correlationId: "corr-cancel-ryw",
    });

    setCache(CACHE_ON);
    const reserved = await pollAuthenticated({ loadId, driverId: driverA, correlationId: "cancel-1" });
    expect(reserved.payload.load.status).toBe(LOAD_STATUS.RESERVED);

    await service.cancelLoadClaim({
      loadId,
      claimId: claimed.payload.claim.id,
      driverId: driverA,
      idempotencyKey: buildIdempotencyKey("cancel-ryw-2"),
      correlationId: "corr-cancel-ryw-2",
    });

    const after = await pollAuthenticated({ loadId, driverId: driverA, correlationId: "cancel-2" });
    expect(after.payload.load.status).toBe(LOAD_STATUS.OPEN);
    expect(after.payload.claim.status).toBe(CLAIM_STATUS.CANCELLED);
  }, 25_000);

  it("read-your-write: a promoção da waitlist aparece para o OUTRO motorista", async () => {
    const winner = await service.createLoadClaim({
      loadId,
      driverId: driverA,
      idempotencyKey: buildIdempotencyKey("promo-a"),
      correlationId: "corr-promo-a",
    });
    await service.createLoadClaim({
      loadId,
      driverId: driverB,
      idempotencyKey: buildIdempotencyKey("promo-b"),
      correlationId: "corr-promo-b",
    });

    setCache(CACHE_ON);
    const waitlisted = await pollAuthenticated({ loadId, driverId: driverB, correlationId: "promo-1" });
    expect(waitlisted.payload.claim.status).toBe(CLAIM_STATUS.WAITLISTED);

    // A cancela → B é promovido. O claim de B mudou numa transação disparada por
    // OUTRO motorista: a invalidação precisa alcançá-lo.
    await service.cancelLoadClaim({
      loadId,
      claimId: winner.payload.claim.id,
      driverId: driverA,
      idempotencyKey: buildIdempotencyKey("promo-cancel"),
      correlationId: "corr-promo-cancel",
    });

    const promoted = await pollAuthenticated({ loadId, driverId: driverB, correlationId: "promo-2" });
    expect(promoted.payload.claim.status).toBe(CLAIM_STATUS.PROMOTED);
  }, 25_000);

  it("expira ao fim do TTL (não serve estado velho indefinidamente)", async () => {
    setCache("4000");

    await pollAuthenticated({ loadId, driverId: driverA, correlationId: "ttl-1" });

    resetDbStats();
    await pollAuthenticated({ loadId, driverId: driverA, correlationId: "ttl-2" });
    expect(dbStats.queries).toBe(0); // dentro da janela

    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(Date.now() + 4_001);
      resetDbStats();
      const afterTtl = await pollAuthenticated({ loadId, driverId: driverA, correlationId: "ttl-3" });
      expect(dbStats.queries).toBe(3); // passou o TTL: volta ao banco
      expect(afterTtl.statusCode).toBe(200);
    } finally {
      nowSpy.mockRestore();
    }
  }, 20_000);

  it("fail-safe: carga inexistente (404) NÃO é cacheada", async () => {
    setCache(CACHE_ON);
    const ghostId = "00000000-0000-4000-8000-000000000000";

    await expect(service.getLoadClaimStatus({ loadId: ghostId, correlationId: "ghost-1" })).rejects.toThrow(
      NotFoundError,
    );

    resetDbStats();
    await expect(service.getLoadClaimStatus({ loadId: ghostId, correlationId: "ghost-2" })).rejects.toThrow(
      NotFoundError,
    );
    // O 404 não grudou: a segunda tentativa foi ao banco de novo.
    expect(dbStats.queries).toBe(1);
  }, 20_000);

  it("preserva o resultado: payload cacheado é idêntico ao não-cacheado (só muda o correlationId)", async () => {
    const leadId = await seedPublicLead({ loadId, cpf: "555.555.555-55" });
    await service.createLoadClaim({
      loadId,
      driverId: driverA,
      idempotencyKey: buildIdempotencyKey("shape"),
      correlationId: "corr-shape",
    });

    setCache(CACHE_OFF);
    const uncached = await pollAuthenticated({
      loadId,
      driverId: driverA,
      publicLeadId: leadId,
      correlationId: "shape-uncached",
    });

    setCache(CACHE_ON);
    await pollAuthenticated({ loadId, driverId: driverA, publicLeadId: leadId, correlationId: "shape-warm" });
    const hit = await pollAuthenticated({
      loadId,
      driverId: driverA,
      publicLeadId: leadId,
      correlationId: "shape-hit",
    });

    const normalize = (result) => ({
      ...result,
      payload: { ...result.payload, meta: { ...result.payload.meta, correlationId: "<ignored>" } },
    });

    expect(normalize(hit)).toEqual(normalize(uncached));
    // O correlationId do chamador atual é preservado (não vaza o da 1ª chamada).
    expect(hit.payload.meta.correlationId).toBe("shape-hit");
  }, 25_000);
});

describe.sequential("claim-status — default do TTL do cache", () => {
  const originalVitestFlag = process.env.VITEST;
  const originalNodeEnv = process.env.NODE_ENV;
  let loadId;
  let driverId;

  beforeEach(async () => {
    applyClaimEnv();
    delete process.env.CLAIM_STATUS_CACHE_TTL_MS; // sem override: vale o default
    await resetTestDatabase();
    service.__resetClaimStatusCache();
    ({ id: loadId } = await seedLoad());
    driverId = (await seedDriverProfile({ email: "default-ttl@test.local" })).userId;
    resetDbStats();
  });

  afterAll(async () => {
    if (originalVitestFlag === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitestFlag;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    service.__resetClaimStatusCache();
    await closeTestDatabase();
  });

  it("sem override e sob teste o cache fica DESLIGADO (isola os outros suites)", async () => {
    resetDbStats();
    await service.getLoadClaimStatus({ loadId, driverId, correlationId: "default-1" });
    await service.getLoadClaimStatus({ loadId, driverId, correlationId: "default-2" });

    expect(dbStats.queries).toBe(6); // 3 + 3: nenhuma leitura veio do cache
  }, 20_000);

  it("default de produção é 4s", async () => {
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    service.__resetClaimStatusCache();

    const nowSpy = vi.spyOn(Date, "now");
    try {
      const base = Date.now();
      nowSpy.mockReturnValue(base);
      await service.getLoadClaimStatus({ loadId, driverId, correlationId: "prod-1" });

      nowSpy.mockReturnValue(base + 3_900); // dentro da janela de 4s → cache
      resetDbStats();
      await service.getLoadClaimStatus({ loadId, driverId, correlationId: "prod-2" });
      expect(dbStats.queries).toBe(0);

      nowSpy.mockReturnValue(base + 4_100); // passou de 4s → volta ao banco
      resetDbStats();
      await service.getLoadClaimStatus({ loadId, driverId, correlationId: "prod-3" });
      expect(dbStats.queries).toBe(3);
    } finally {
      nowSpy.mockRestore();
      if (originalVitestFlag === undefined) delete process.env.VITEST;
      else process.env.VITEST = originalVitestFlag;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  }, 20_000);
});
