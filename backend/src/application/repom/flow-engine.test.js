import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedDriverProfile,
  seedPendingRegistration,
  withPgClient,
  withPgTransaction,
} from "../operator-admin/test-harness.js";

vi.mock("../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));

// ensureAppSettingsTable roda `CREATE TABLE IF NOT EXISTS` (idempotente em Postgres
// real). O checker estrito de AST do pg-mem não digere os nós de constraint desse
// statement; a tabela já existe no harness, então aqui vira no-op.
vi.mock("../operator-admin/use-cases/angellira/auto-approve-vigentes.js", () => ({
  ensureAppSettingsTable: async () => {},
}));

// Evolution é externo — mock: capturamos os envios do número Repom.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock("../../infrastructure/whatsapp/evolution-client.js", () => ({
  getRepomInstance: () => "lamonica-repom",
  sendWhatsappText: sendMock,
}));

const { handleRepomIncomingMessage, setRepomFlowEnabled, extractCpfFromText } = await import("./flow-engine.js");

const inbound = (text, phone = "5571988887777") => ({
  instance: "lamonica-repom",
  direction: "in",
  externalId: `m-${Math.random().toString(36).slice(2, 8)}`,
  phone,
  text,
  messageType: "text",
});

async function session(phone = "5571988887777") {
  const { rows } = await query(
    `SELECT cpf, current_node, status, variables FROM public.repom_flow_sessions WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`,
    [phone],
  );
  return rows[0] || null;
}

describe("repom flow-engine (integração pg-mem)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
    sendMock.mockResolvedValue({ ok: true });
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("extractCpfFromText: aceita máscara e texto ao redor; rejeita tamanho errado", () => {
    expect(extractCpfFromText("meu cpf é 123.456.789-01")).toBe("12345678901");
    expect(extractCpfFromText("12345678901")).toBe("12345678901");
    expect(extractCpfFromText("123")).toBeNull();
    expect(extractCpfFromText("")).toBeNull();
  });

  it("flag OFF (default): não responde nada", async () => {
    const r = await handleRepomIncomingMessage(inbound("oi"));
    expect(r).toMatchObject({ skipped: "disabled" });
    expect(sendMock).not.toHaveBeenCalled();
    expect(await session()).toBeNull();
  });

  it("primeira mensagem (flag ON): cria sessão e cumprimenta pedindo CPF", async () => {
    await setRepomFlowEnabled({ enabled: true });
    const r = await handleRepomIncomingMessage(inbound("oi, quero me cadastrar"));
    expect(r).toMatchObject({ ok: true, node: "ask_cpf", action: "greeted" });
    expect(sendMock).toHaveBeenCalledOnce();
    expect(sendMock.mock.calls[0][0].text).toMatch(/CPF/);
    expect(sendMock.mock.calls[0][0].instance).toBe("lamonica-repom");
    expect(await session()).toMatchObject({ current_node: "ask_cpf", status: "active" });
  });

  it("texto sem CPF em ask_cpf: repede o CPF (não avança)", async () => {
    await setRepomFlowEnabled({ enabled: true });
    await handleRepomIncomingMessage(inbound("oi"));
    const r = await handleRepomIncomingMessage(inbound("meu nome é João"));
    expect(r).toMatchObject({ ok: true, node: "ask_cpf", action: "invalid_cpf" });
    expect(await session()).toMatchObject({ current_node: "ask_cpf" });
  });

  it("CPF novo: caso create → grava CPF, avança p/ ask_cnh e pede a CNH", async () => {
    await setRepomFlowEnabled({ enabled: true });
    await handleRepomIncomingMessage(inbound("oi"));
    const r = await handleRepomIncomingMessage(inbound("123.456.789-01"));
    expect(r).toMatchObject({ ok: true, node: "ask_cnh", action: "create" });
    const s = await session();
    expect(s).toMatchObject({ cpf: "12345678901", current_node: "ask_cnh", status: "active" });
    expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/CNH/);
  });

  it("CPF de motorista já oficial: informa e encerra a sessão (nunca duplica)", async () => {
    await seedDriverProfile({ document_number: "44444444444" });
    await setRepomFlowEnabled({ enabled: true });
    await handleRepomIncomingMessage(inbound("oi"));
    const r = await handleRepomIncomingMessage(inbound("44444444444"));
    expect(r).toMatchObject({ ok: true, node: "done", action: "inform_approved" });
    expect(await session()).toMatchObject({ status: "done", cpf: "44444444444" });
    expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/já está cadastrado/);
  });

  it("CPF com cadastro rejeitado: mensagem de reabertura e avança p/ ask_cnh", async () => {
    await seedPendingRegistration({ status: "rejeitado", dados: { motorista: { cpf: "55555555555" } } });
    await setRepomFlowEnabled({ enabled: true });
    await handleRepomIncomingMessage(inbound("oi"));
    const r = await handleRepomIncomingMessage(inbound("55555555555"));
    expect(r).toMatchObject({ ok: true, node: "ask_cnh", action: "reopen" });
    expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/não foi aprovado/);
  });

  it("mensagem em ask_cnh: confirma recebimento (mídia/OCR chega na Fase 3b)", async () => {
    await setRepomFlowEnabled({ enabled: true });
    await handleRepomIncomingMessage(inbound("oi"));
    await handleRepomIncomingMessage(inbound("12345678901"));
    const r = await handleRepomIncomingMessage(inbound("[image]"));
    expect(r).toMatchObject({ ok: true, node: "ask_cnh", action: "parked" });
  });

  it("falha de envio → cria notificação reply_send_failed para o operador", async () => {
    await setRepomFlowEnabled({ enabled: true });
    sendMock.mockRejectedValueOnce(new Error("EVOLUTION_HTTP_500"));
    await handleRepomIncomingMessage(inbound("oi"));
    const { rows } = await query(`SELECT kind FROM public.operator_notifications WHERE kind = 'reply_send_failed'`);
    expect(rows.length).toBe(1);
  });

  it("ignora mensagens OUT e sem telefone", async () => {
    await setRepomFlowEnabled({ enabled: true });
    expect(await handleRepomIncomingMessage({ ...inbound("oi"), direction: "out" })).toMatchObject({ skipped: "not_in" });
    expect(await handleRepomIncomingMessage(inbound("oi", ""))).toMatchObject({ skipped: "no_phone" });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
