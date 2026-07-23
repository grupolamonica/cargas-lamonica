import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedDriverOutreachOptout,
  seedMotoristaHistorico,
  seedPendingOutreach,
  seedPendingRegistration,
  withPgClient,
  withPgTransaction,
} from "../operator-admin/test-harness.js";

vi.mock("../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));

const sendMock = vi.fn();
vi.mock("../../infrastructure/whatsapp/evolution-client.js", () => ({
  sendWhatsappText: (...args) => sendMock(...args),
  connectWhatsappInstance: vi.fn(),
  getWhatsappConnectionState: vi.fn(),
  logoutWhatsappInstance: vi.fn(),
}));

// Angellira é externo (API) — mock p/ controlar vigência nos testes.
const { angMock } = vi.hoisted(() => ({ angMock: vi.fn() }));
vi.mock("./angellira-check.js", () => ({ checkAngelliraVigencia: angMock }));

const {
  createManualOutreach,
  getOutreachQueueItem,
  reconcileRegistrationsWithAngellira,
  revalidateOutreachQueueAgainstAngellira,
  sendOutreachQueueItemNow,
  updateOutreachQueueItem,
} = await import("./admin.js");

async function getRow(id) {
  const { rows } = await query(`SELECT * FROM public.pending_driver_outreach WHERE id = $1`, [id]);
  return rows[0];
}

describe("outreach queue-item (integração pg-mem)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
    process.env.EVOLUTION_API_TOKEN = "test-token";
    // Padrão: não vigente (não bloqueia nada).
    angMock.mockResolvedValue({ checked: true, vigente: false, status: "NOT_FOUND", found: false, validUntil: null });
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("getOutreachQueueItem traz a linha + mensagens por gatilho + candidatos de telefone", async () => {
    const { id } = await seedPendingOutreach({ phone: "5571988887777", message: "Msg original." });
    const detail = await getOutreachQueueItem(id);

    expect(detail.item.id).toBe(id);
    expect(detail.item.message).toBe("Msg original.");
    // As 4 opções de gatilho sempre têm uma mensagem sugerida (detecção ou genérica).
    for (const t of ["churn", "lost_registration", "abandonment", "return_load"]) {
      expect(typeof detail.messagesByTrigger[t]).toBe("string");
      expect(detail.messagesByTrigger[t].length).toBeGreaterThan(0);
    }
    expect(detail.phoneCandidates).toContain("5571988887777");
  });

  it("getOutreachQueueItem lança quando o item não existe", async () => {
    await expect(getOutreachQueueItem(crypto.randomUUID())).rejects.toThrow();
  });

  it("updateOutreachQueueItem edita gatilho, telefone e mensagem de item pendente", async () => {
    const { id } = await seedPendingOutreach({ trigger: "lost_registration" });
    await updateOutreachQueueItem(id, { trigger: "churn", phone: "(71) 90000-1122", message: "Nova mensagem." });

    const row = await getRow(id);
    expect(row.trigger).toBe("churn");
    expect(row.phone).toBe("5571900001122"); // normalizado com DDI
    expect(row.message).toBe("Nova mensagem.");
  });

  it("updateOutreachQueueItem rejeita mensagem vazia e gatilho inválido", async () => {
    const { id } = await seedPendingOutreach({});
    await expect(updateOutreachQueueItem(id, { message: "   " })).rejects.toThrow();
    await expect(updateOutreachQueueItem(id, { trigger: "preferences" })).rejects.toThrow();
  });

  it("updateOutreachQueueItem não edita item já enviado", async () => {
    const { id } = await seedPendingOutreach({ status: "sent" });
    await expect(updateOutreachQueueItem(id, { message: "tentativa" })).rejects.toThrow();
  });

  it("updateOutreachQueueItem: CPF informado vira driver_key e registra em motoristas_historico", async () => {
    // Cenário do operador: CPF não veio do documento → driver_key era o nome.
    const { id } = await seedPendingOutreach({ driver_key: "joao motorista", phone: "5571988887777" });
    await updateOutreachQueueItem(id, { cpf: "123.456.789-01", nome: "João Motorista" });

    const row = await getRow(id);
    expect(row.driver_key).toBe("12345678901"); // identidade agora é o CPF
    const { rows: mh } = await query(`SELECT nome, telefone FROM public.motoristas_historico WHERE cpf = '12345678901'`);
    expect(mh[0]).toMatchObject({ nome: "João Motorista", telefone: "5571988887777" });
  });

  it("updateOutreachQueueItem rejeita CPF com dígitos errados", async () => {
    const { id } = await seedPendingOutreach({});
    await expect(updateOutreachQueueItem(id, { cpf: "123" })).rejects.toThrow(/CPF/i);
  });

  it("sendOutreachQueueItemNow envia via Evolution, marca sent e registra no log", async () => {
    sendMock.mockResolvedValue({ ok: true });
    const { id } = await seedPendingOutreach({ message: "Enviar isto." });

    const res = await sendOutreachQueueItemNow(id);
    expect(res.ok).toBe(true);
    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][0]).toMatchObject({ text: "Enviar isto." });

    expect((await getRow(id)).status).toBe("sent");
    const { rows: log } = await query(
      `SELECT * FROM public.driver_outreach_log WHERE channel = 'evolution' AND status = 'sent'`,
    );
    expect(log.length).toBe(1);
  });

  it("sendOutreachQueueItemNow bloqueia motorista em opt-out", async () => {
    const { id } = await seedPendingOutreach({ driver_key: "55500011122" });
    await seedDriverOutreachOptout({ driver_key: "55500011122" });

    await expect(sendOutreachQueueItemNow(id)).rejects.toThrow(/opt-out|perturbe/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sendOutreachQueueItemNow marca failed quando o envio falha", async () => {
    sendMock.mockRejectedValue(new Error("boom"));
    const { id } = await seedPendingOutreach({});

    await expect(sendOutreachQueueItemNow(id)).rejects.toThrow(/boom/i);
    const row = await getRow(id);
    expect(row.status).toBe("failed");
    expect(Number(row.retry_count)).toBe(1);
  });

  it("getOutreachQueueItem resolve o NOME do motorista pelo CPF", async () => {
    await seedMotoristaHistorico({ cpf: "12345678901", nome: "MARIA DA SILVA", telefone: "71988887777" });
    const { id } = await seedPendingOutreach({ driver_key: "12345678901" });
    const detail = await getOutreachQueueItem(id);
    expect(detail.driver.nome).toBe("MARIA DA SILVA");
  });

  it("getOutreachQueueItem inclui o status do Angellira", async () => {
    angMock.mockResolvedValue({ checked: true, vigente: true, status: "FOUND", found: true, validUntil: "2026-12-31", name: "FULANO" });
    const { id } = await seedPendingOutreach({ driver_key: "12345678901" });
    const detail = await getOutreachQueueItem(id);
    expect(detail.angellira.vigente).toBe(true);
    expect(detail.angellira.validUntil).toBe("2026-12-31");
  });

  it("createManualOutreach enfileira um item novo (compõe msg do gatilho)", async () => {
    const res = await createManualOutreach({ nome: "Teste Manual", phone: "(71) 90000-1122", trigger: "churn" });
    expect(res.ok).toBe(true);
    const { rows } = await query(
      `SELECT * FROM public.pending_driver_outreach WHERE id = $1`,
      [res.id],
    );
    expect(rows[0].phone).toBe("5571900001122");
    expect(rows[0].trigger).toBe("churn");
    expect(rows[0].message.length).toBeGreaterThan(0);
  });

  it("createManualOutreach rejeita gatilho inválido e telefone ruim", async () => {
    await expect(createManualOutreach({ nome: "X", phone: "5571999999999", trigger: "preferences" })).rejects.toThrow();
    await expect(createManualOutreach({ nome: "X", phone: "123", trigger: "churn" })).rejects.toThrow();
  });

  it("reconcileRegistrationsWithAngellira marca 'concluido' quem já é vigente", async () => {
    await seedPendingRegistration({ status: "pendente", dados: { motorista: { cpf: "11111111111", nome: "A" } } });
    await seedPendingRegistration({ status: "draft", dados: { motorista: { cpf: "22222222222", nome: "B" } } });
    angMock.mockImplementation(async (cpf) => ({ checked: true, vigente: cpf === "11111111111", validUntil: "2026-12-31" }));

    const r = await reconcileRegistrationsWithAngellira();
    expect(r.vigentes).toBe(1);
    expect(r.updated).toBe(1);

    const { rows } = await query(
      `SELECT status FROM public.pending_driver_registrations WHERE dados->'motorista'->>'cpf' = '11111111111'`,
    );
    expect(rows[0].status).toBe("concluido");
    const { rows: other } = await query(
      `SELECT status FROM public.pending_driver_registrations WHERE dados->'motorista'->>'cpf' = '22222222222'`,
    );
    expect(other[0].status).toBe("draft");
  });

  it("revalidateOutreachQueueAgainstAngellira cancela cadastro de quem já é vigente", async () => {
    await seedPendingOutreach({ driver_key: "11111111111", trigger: "lost_registration" });
    const keep = await seedPendingOutreach({ driver_key: "22222222222", trigger: "lost_registration" });
    angMock.mockImplementation(async (cpf) => ({
      checked: true,
      vigente: cpf === "11111111111",
      status: "FOUND",
      found: true,
      validUntil: "2026-12-31",
    }));

    const r = await revalidateOutreachQueueAgainstAngellira();
    expect(r.cancelled).toBe(1);
    const { rows: vig } = await query(`SELECT status FROM public.pending_driver_outreach WHERE driver_key='11111111111'`);
    expect(vig[0].status).toBe("skipped");
    expect((await getRow(keep.id)).status).toBe("pending");
  });
});
