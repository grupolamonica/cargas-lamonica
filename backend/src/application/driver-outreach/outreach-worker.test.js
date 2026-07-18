import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedDriverOutreachOptout,
  seedOutreachLog,
  seedPendingOutreach,
  withPgTransaction,
} from "../operator-admin/test-harness.js";

vi.mock("../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

const sendMock = vi.fn();
class CircuitOpen extends Error {}
class MissingConfig extends Error {}
class RecipientNotAllowed extends Error {}
vi.mock("../../infrastructure/whatsapp/evolution-client.js", () => ({
  sendWhatsappText: (...args) => sendMock(...args),
  EvolutionCircuitOpenError: CircuitOpen,
  MissingConfigError: MissingConfig,
  RecipientNotAllowedError: RecipientNotAllowed,
}));

const { processOutreachQueue } = await import("./outreach-worker.js");

function enableSending() {
  process.env.DRIVER_OUTREACH_ENABLED = "true";
  process.env.EVOLUTION_API_TOKEN = "test-token";
  process.env.DRIVER_OUTREACH_QUIET_START_HOUR = "0";
  process.env.DRIVER_OUTREACH_QUIET_END_HOUR = "0"; // 24h
  delete process.env.DRIVER_OUTREACH_COLD_ENABLED;
  delete process.env.DRIVER_OUTREACH_DAILY_CAP;
  // Knobs anti-ban resetados para os defaults entre os testes.
  delete process.env.DRIVER_OUTREACH_HOURLY_CAP;
  delete process.env.DRIVER_OUTREACH_SENDS_PER_CYCLE;
  delete process.env.DRIVER_OUTREACH_WARMUP_ENABLED;
  delete process.env.DRIVER_OUTREACH_MIN_GAP_SECONDS;
  delete process.env.DRIVER_OUTREACH_MAX_GAP_SECONDS;
}

async function getRow(id) {
  const { rows } = await query(`SELECT * FROM public.pending_driver_outreach WHERE id = $1`, [id]);
  return rows[0];
}

describe("processOutreachQueue (integração pg-mem)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
    enableSending();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("não envia outreach quando o kill-switch está desligado (item é atrasado, não enviado)", async () => {
    process.env.DRIVER_OUTREACH_ENABLED = "false";
    const { id } = await seedPendingOutreach({});
    const r = await processOutreachQueue();
    expect(r.sent).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
    const row = await getRow(id);
    expect(row.status).toBe("pending"); // atrasado, ainda pendente
    expect(row.next_attempt_at).toBeTruthy();
  });

  it("ENVIA gatilho transacional (reservation:*) mesmo com kill-switch desligado", async () => {
    process.env.DRIVER_OUTREACH_ENABLED = "false";
    sendMock.mockResolvedValue({ ok: true });
    const { id } = await seedPendingOutreach({ trigger: "reservation:abc-123" });
    const r = await processOutreachQueue();
    expect(r.sent).toBe(1);
    expect(sendMock).toHaveBeenCalledOnce();
    expect((await getRow(id)).status).toBe("sent");
  });

  it("envia pendente consent-implied, marca sent e registra no log", async () => {
    sendMock.mockResolvedValue({ ok: true });
    const { id } = await seedPendingOutreach({ trigger: "lost_registration" });
    const r = await processOutreachQueue();
    expect(r.sent).toBe(1);
    expect(sendMock).toHaveBeenCalledOnce();
    expect((await getRow(id)).status).toBe("sent");
    const { rows: log } = await query(`SELECT * FROM public.driver_outreach_log WHERE status = 'sent'`);
    expect(log.length).toBe(1);
  });

  it("pula motorista com opt-out sem enviar", async () => {
    const { id } = await seedPendingOutreach({ driver_key: "999", trigger: "lost_registration" });
    await seedDriverOutreachOptout({ driver_key: "999" });
    const r = await processOutreachQueue();
    expect(r.skipped).toBe(1);
    expect(sendMock).not.toHaveBeenCalled();
    expect((await getRow(id)).status).toBe("skipped");
  });

  it("pula gatilho frio quando cold está desabilitado", async () => {
    const { id } = await seedPendingOutreach({ trigger: "churn" });
    const r = await processOutreachQueue();
    expect(r.skipped).toBe(1);
    expect(sendMock).not.toHaveBeenCalled();
    expect((await getRow(id)).status).toBe("skipped");
  });

  it("envia gatilho frio quando cold está habilitado", async () => {
    process.env.DRIVER_OUTREACH_COLD_ENABLED = "true";
    sendMock.mockResolvedValue({ ok: true });
    const { id } = await seedPendingOutreach({ trigger: "churn" });
    const r = await processOutreachQueue();
    expect(r.sent).toBe(1);
    expect((await getRow(id)).status).toBe("sent");
  });

  it("respeita o cap diário (outreach): item é atrasado, não enviado", async () => {
    process.env.DRIVER_OUTREACH_DAILY_CAP = "1";
    await seedOutreachLog({ status: "sent" });
    const { id } = await seedPendingOutreach({ trigger: "lost_registration" });
    const r = await processOutreachQueue();
    expect(r.sent).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
    expect((await getRow(id)).status).toBe("pending");
  });

  it("faz retry em falha (mantém pending até o máximo)", async () => {
    sendMock.mockRejectedValue(new Error("boom"));
    const { id } = await seedPendingOutreach({ trigger: "lost_registration" });
    const r = await processOutreachQueue();
    expect(r.sent).toBe(0);
    const row = await getRow(id);
    expect(row.status).toBe("pending");
    expect(Number(row.retry_count)).toBe(1);
    expect(row.next_attempt_at).toBeTruthy();
  });

  // ── Anti-ban: cap horário, limite por ciclo, typing delay, warmup ──────────

  it("respeita o cap HORÁRIO: item é atrasado quando a hora estourou", async () => {
    process.env.DRIVER_OUTREACH_HOURLY_CAP = "1";
    await seedOutreachLog({ status: "sent", created_at: new Date().toISOString() });
    const { id } = await seedPendingOutreach({ trigger: "lost_registration" });
    const r = await processOutreachQueue();
    expect(r.sent).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
    expect((await getRow(id)).status).toBe("pending");
  });

  it("cap horário NÃO conta envios de mais de 1h atrás", async () => {
    process.env.DRIVER_OUTREACH_HOURLY_CAP = "1";
    sendMock.mockResolvedValue({ ok: true });
    // envio antigo (2h atrás) não deve contar na janela de 1h
    await seedOutreachLog({ status: "sent", created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });
    const { id } = await seedPendingOutreach({ trigger: "lost_registration" });
    const r = await processOutreachQueue();
    expect(r.sent).toBe(1);
    expect((await getRow(id)).status).toBe("sent");
  });

  it("limita envios PROATIVOS por ciclo (sendsPerCycle): resto fica pending", async () => {
    process.env.DRIVER_OUTREACH_SENDS_PER_CYCLE = "1";
    sendMock.mockResolvedValue({ ok: true });
    const a = await seedPendingOutreach({ driver_key: "111", trigger: "lost_registration" });
    const b = await seedPendingOutreach({ driver_key: "222", trigger: "lost_registration" });
    const c = await seedPendingOutreach({ driver_key: "333", trigger: "lost_registration" });
    const r = await processOutreachQueue();
    expect(r.sent).toBe(1);
    expect(sendMock).toHaveBeenCalledOnce();
    const states = [await getRow(a.id), await getRow(b.id), await getRow(c.id)].map((x) => x.status);
    expect(states.filter((s) => s === "sent").length).toBe(1);
    expect(states.filter((s) => s === "pending").length).toBe(2);
  });

  it("passa delay de digitação (>0) no envio proativo", async () => {
    sendMock.mockResolvedValue({ ok: true });
    await seedPendingOutreach({ trigger: "lost_registration" });
    await processOutreachQueue();
    expect(sendMock).toHaveBeenCalledOnce();
    const arg = sendMock.mock.calls[0][0];
    expect(arg.delayMs).toBeGreaterThan(0);
    expect(arg.delayMs).toBeLessThanOrEqual(3500);
  });

  it("NÃO aplica delay de digitação em gatilho transacional", async () => {
    process.env.DRIVER_OUTREACH_ENABLED = "false"; // transacional bypassa
    sendMock.mockResolvedValue({ ok: true });
    await seedPendingOutreach({ trigger: "reservation:xyz" });
    await processOutreachQueue();
    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][0].delayMs).toBe(0);
  });

  it("bloqueio pela allowlist de teste: marca skipped, sem retry", async () => {
    sendMock.mockRejectedValue(new RecipientNotAllowed("**27"));
    const { id } = await seedPendingOutreach({ trigger: "lost_registration" });
    const r = await processOutreachQueue();
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);
    const row = await getRow(id);
    expect(row.status).toBe("skipped");
    expect(row.last_error).toBe("not_in_test_allowlist");
    expect(Number(row.retry_count)).toBe(0); // NÃO conta como tentativa
  });

  it("warmup reduz o cap diário efetivo nos primeiros dias", async () => {
    process.env.DRIVER_OUTREACH_WARMUP_ENABLED = "true";
    process.env.DRIVER_OUTREACH_WARMUP_START_CAP = "1";
    process.env.DRIVER_OUTREACH_WARMUP_STEP_PER_DAY = "10";
    process.env.DRIVER_OUTREACH_DAILY_CAP = "50";
    // 1 envio hoje = primeiro dia (daysSinceStart 0) → cap efetivo 1 → estoura.
    await seedOutreachLog({ status: "sent", created_at: new Date().toISOString() });
    const { id } = await seedPendingOutreach({ trigger: "lost_registration" });
    const r = await processOutreachQueue();
    expect(r.sent).toBe(0);
    expect((await getRow(id)).status).toBe("pending");
  });
});
