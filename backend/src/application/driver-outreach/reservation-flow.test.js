import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  withPgClient,
  withPgTransaction,
} from "../operator-admin/test-harness.js";

vi.mock("../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));

const {
  parseAcceptanceIntent,
  expireStaleReservations,
  handleDriverReplyForReservation,
  confirmReservation,
  RESERVATION_ACCEPTANCE_WINDOW_MS,
} = await import("./reservation-flow.js");

async function seedApprovedReservation({
  loadId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
  leadId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1",
  cpf = "12345678901",
  phone = "5571900001111",
  origem = "Simoes Filho / BA",
  destino = "Jaboatão dos Guararapes / PE",
  approvedAt = new Date().toISOString(),
  cargoStatus = "RESERVED",
} = {}) {
  await seedCargo({ id: loadId, origem, destino, status: cargoStatus });
  await query(
    `INSERT INTO public.load_public_leads
       (id, load_id, cpf, phone, horse_plate, trailer_plate, vehicle_type, status, approved_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'ABC1D23', 'XYZ4E56', 'CARRETA', 'APPROVED', $5, now(), now())`,
    [leadId, loadId, cpf, phone, approvedAt],
  );
  return { loadId, leadId, cpf, phone };
}

// Simula que a oferta de reserva FOI entregue (worker marcou 'sent').
async function seedSentReservationOffer({ leadId, cpf = "12345678901", phone = "5571900001111" }) {
  await query(
    `INSERT INTO public.pending_driver_outreach (driver_key, trigger, phone, message, status, sent_at)
     VALUES ($1, $2, $3, $4, 'sent', now())`,
    [String(cpf).replace(/\D/g, ""), `reservation:${leadId}`, phone, "oferta"],
  );
}

describe("parseAcceptanceIntent", () => {
  it("detecta aceite em palavras-chave e emojis", () => {
    expect(parseAcceptanceIntent("Sim, aceito!")).toBe("accept");
    expect(parseAcceptanceIntent("confirmo 👍")).toBe("accept");
    expect(parseAcceptanceIntent("👍")).toBe("accept");
    expect(parseAcceptanceIntent("beleza, vou pegar")).toBe("accept");
    expect(parseAcceptanceIntent("Ok")).toBe("accept");
  });

  it("detecta recusa", () => {
    expect(parseAcceptanceIntent("Não posso")).toBe("reject");
    expect(parseAcceptanceIntent("cancela")).toBe("reject");
    expect(parseAcceptanceIntent("👎")).toBe("reject");
  });

  it("rejeição vence empate (não aceito)", () => {
    expect(parseAcceptanceIntent("Não aceito")).toBe("reject");
  });

  it("desconhecido para mensagens neutras", () => {
    expect(parseAcceptanceIntent("Quantos km?")).toBe("unknown");
    expect(parseAcceptanceIntent("")).toBe("unknown");
  });
});

describe("handleDriverReplyForReservation (integração pg-mem)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("aceite dentro de 2h confirma reserva → carga vira BOOKED e cria notificação", async () => {
    const { loadId, phone } = await seedApprovedReservation({});
    const r = await handleDriverReplyForReservation({
      phone,
      text: "Aceito!",
      driverKey: "12345678901",
    });
    expect(r.action).toBe("confirmed");
    const { rows } = await query(`SELECT status FROM public.cargas WHERE id = $1`, [loadId]);
    expect(rows[0].status).toBe("BOOKED");
    const { rows: notif } = await query(
      `SELECT kind FROM public.operator_notifications WHERE kind = 'driver_reply_accept'`,
    );
    expect(notif.length).toBe(1);
  });

  it("recusa reabre a carga (OPEN) e cria notificação", async () => {
    const { loadId, phone } = await seedApprovedReservation({
      loadId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2",
      leadId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2",
    });
    const r = await handleDriverReplyForReservation({
      phone,
      text: "Não quero",
      driverKey: "12345678901",
    });
    expect(r.action).toBe("rejected");
    const { rows } = await query(`SELECT status FROM public.cargas WHERE id = $1`, [loadId]);
    expect(rows[0].status).toBe("OPEN");
  });

  it("reserva fora de 2h → ignora (no_reservation)", async () => {
    const oldTs = new Date(Date.now() - (RESERVATION_ACCEPTANCE_WINDOW_MS + 60_000)).toISOString();
    const { phone } = await seedApprovedReservation({
      loadId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3",
      leadId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3",
      approvedAt: oldTs,
    });
    const r = await handleDriverReplyForReservation({
      phone,
      text: "aceito",
      driverKey: "12345678901",
    });
    expect(r.action).toBe("no_reservation");
  });

  it("mensagem sem intenção → ignored (não muda nada)", async () => {
    await seedApprovedReservation({
      loadId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4",
      leadId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb4",
    });
    const r = await handleDriverReplyForReservation({
      phone: "5571900001111",
      text: "Quanto é o frete?",
      driverKey: "12345678901",
    });
    expect(r.action).toBe("ignored");
  });
});

describe("expireStaleReservations", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("reverte reserva AVISADA (>2h) como 'sem resposta' (reservation_timeout)", async () => {
    const oldTs = new Date(Date.now() - (RESERVATION_ACCEPTANCE_WINDOW_MS + 60_000)).toISOString();
    const { loadId } = await seedApprovedReservation({
      loadId: "cccccccc-cccc-cccc-cccc-cccccccccc01",
      leadId: "dddddddd-dddd-dddd-dddd-dddddddddd01",
      approvedAt: oldTs,
    });
    // Motorista FOI avisado (oferta entregue) → expira como "sem resposta".
    await seedSentReservationOffer({ leadId: "dddddddd-dddd-dddd-dddd-dddddddddd01" });
    // outra reserva recente (não deve expirar)
    await seedApprovedReservation({
      loadId: "cccccccc-cccc-cccc-cccc-cccccccccc02",
      leadId: "dddddddd-dddd-dddd-dddd-dddddddddd02",
      cpf: "99999999999",
      phone: "5571900002222",
    });
    const r = await expireStaleReservations();
    expect(r.expired).toBe(1);
    const { rows } = await query(`SELECT status FROM public.cargas WHERE id = $1`, [loadId]);
    expect(rows[0].status).toBe("OPEN");
    const { rows: notif } = await query(
      `SELECT kind FROM public.operator_notifications WHERE kind = 'reservation_timeout'`,
    );
    expect(notif.length).toBe(1);
  });

  it("reserva NÃO avisada (oferta não entregue) expira como 'não avisado' (reservation_undelivered)", async () => {
    const oldTs = new Date(Date.now() - (RESERVATION_ACCEPTANCE_WINDOW_MS + 60_000)).toISOString();
    const { loadId } = await seedApprovedReservation({
      loadId: "cccccccc-cccc-cccc-cccc-cccccccccc04",
      leadId: "dddddddd-dddd-dddd-dddd-dddddddddd04",
      approvedAt: oldTs,
    });
    // NÃO semeia oferta 'sent' (WhatsApp fora → nunca entregue).
    const r = await expireStaleReservations();
    expect(r.expired).toBe(1);
    // A carga volta pra fila do mesmo jeito (não fica presa em RESERVED).
    const { rows } = await query(`SELECT status FROM public.cargas WHERE id = $1`, [loadId]);
    expect(rows[0].status).toBe("OPEN");
    // Mas o aviso ao operador é honesto — não é "sem resposta".
    const { rows: undel } = await query(
      `SELECT kind FROM public.operator_notifications WHERE kind = 'reservation_undelivered'`,
    );
    expect(undel.length).toBe(1);
    const { rows: timeout } = await query(
      `SELECT kind FROM public.operator_notifications WHERE kind = 'reservation_timeout'`,
    );
    expect(timeout.length).toBe(0);
  });

  it("confirmReservation também respeita o estado RESERVED (dedupe/idempotência)", async () => {
    const { loadId, leadId } = await seedApprovedReservation({
      loadId: "cccccccc-cccc-cccc-cccc-cccccccccc03",
      leadId: "dddddddd-dddd-dddd-dddd-dddddddddd03",
    });
    const first = await withPgClient((c) => confirmReservation(c, { leadId }));
    expect(first).toBeTruthy();
    const { rows } = await query(`SELECT status FROM public.cargas WHERE id = $1`, [loadId]);
    expect(rows[0].status).toBe("BOOKED");
    // Chamar de novo: nada muda (a query não bate mais em RESERVED).
    const second = await withPgClient((c) => confirmReservation(c, { leadId }));
    expect(second).toBeNull();
  });
});
