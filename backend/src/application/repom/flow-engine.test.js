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

// Evolution é externo — mock: envios + download de mídia do número Repom.
const { sendMock, getMediaMock } = vi.hoisted(() => ({ sendMock: vi.fn(), getMediaMock: vi.fn() }));
vi.mock("../../infrastructure/whatsapp/evolution-client.js", () => ({
  getRepomInstance: () => "lamonica-repom",
  sendWhatsappText: sendMock,
  getMediaBase64: getMediaMock,
}));

// OpenAI é externo — mock do cliente usado pelo agente-orientador (Fase 3c).
const { chatMock, configuredMock } = vi.hoisted(() => ({ chatMock: vi.fn(), configuredMock: vi.fn() }));
vi.mock("../../infrastructure/openai/openai-client.js", () => ({
  chatComplete: chatMock,
  isOpenAiConfigured: configuredMock,
}));

// Fase 3b: OCR (sidecar) e staging (Storage) são externos — mockados.
const { extractMock, uploadMock } = vi.hoisted(() => ({ extractMock: vi.fn(), uploadMock: vi.fn() }));
vi.mock("./ocr-sidecar-client.js", () => ({ extractCnhFromMedia: extractMock }));
vi.mock("../candidatura/use-cases/upload-draft-file.js", () => ({ uploadDraftFile: uploadMock }));

const { handleRepomIncomingMessage, setRepomFlowEnabled, setRepomCnhOcrEnabled, extractCpfFromText } = await import(
  "./flow-engine.js"
);
const { setRepomAgentEnabled, resetRepomAgentRateLimitForTests } = await import("./agent-orientador.js");

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

// Mensagem de MÍDIA (foto da CNH) — carrega raw com a key p/ baixar do Evolution.
const mediaInbound = (phone = "5571988887777") => {
  const id = `mm-${Math.random().toString(36).slice(2, 8)}`;
  return {
    instance: "lamonica-repom",
    direction: "in",
    externalId: id,
    phone,
    text: "[image]",
    messageType: "image",
    raw: { key: { id, remoteJid: `${phone}@s.whatsapp.net` }, message: { imageMessage: { mimetype: "image/jpeg" } } },
  };
};

// Leva a sessão até ask_cnh pelo fluxo real (oi → CPF).
async function reachAskCnh(cpf = "12345678901", phone = "5571988887777") {
  await handleRepomIncomingMessage(inbound("oi", phone));
  await handleRepomIncomingMessage(inbound(cpf, phone));
}

async function pendings() {
  const { rows } = await query(
    `SELECT id_cadastro, status, versao_cadastro, observacoes, dados FROM public.pending_driver_registrations ORDER BY created_at DESC`,
  );
  return rows;
}

describe("repom flow-engine (integração pg-mem)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    resetRepomAgentRateLimitForTests();
    vi.clearAllMocks();
    sendMock.mockResolvedValue({ ok: true });
    // Por padrão o agente fica OFF (flag não setada); mesmo assim damos defaults
    // aos mocks OpenAI para os testes que o ligam.
    configuredMock.mockReturnValue(true);
    chatMock.mockResolvedValue({ text: "Sem problema! Me manda só os 11 números do seu CPF. 🙂" });
    // Fase 3b defaults (a flag repom_cnh_ocr_enabled fica OFF; os testes que a ligam setam).
    getMediaMock.mockResolvedValue({ base64: "BASE64CNH", mimetype: "image/jpeg" });
    extractMock.mockResolvedValue({
      ok: true,
      provider: "infosimples",
      fields: { nome: "LUCAS CAVALHEIRO", cpf: "12345678901", numero_registro: "07314868241", categoria: "D", validade: "06/04/2032" },
    });
    uploadMock.mockResolvedValue({ statusCode: 200, payload: { storage_path: "12345678901/repom/motorista_cnh_1.jpg" } });
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

  // ── Agente orientador (Fase 3c) — só atua fora do roteiro, nunca decide fluxo ──
  describe("agente orientador", () => {
    const AGENTE = "🤖 Sem estresse! É só me mandar os números do seu CPF que a gente continua.";

    it("ON: em ask_cpf sem CPF, responde com o texto do AGENTE (não a fixa)", async () => {
      await setRepomFlowEnabled({ enabled: true });
      await setRepomAgentEnabled({ enabled: true });
      configuredMock.mockReturnValue(true);
      chatMock.mockResolvedValue({ text: AGENTE });

      await handleRepomIncomingMessage(inbound("oi"));
      const r = await handleRepomIncomingMessage(inbound("não sei o que é isso"));

      expect(r).toMatchObject({ ok: true, node: "ask_cpf", action: "invalid_cpf" });
      expect(sendMock.mock.calls.at(-1)[0].text).toBe(AGENTE);
      // o texto do motorista foi passado ao modelo no papel user (isolado)
      expect(chatMock).toHaveBeenCalledOnce();
      expect(chatMock.mock.calls[0][0].user).toBe("não sei o que é isso");
    });

    it("ON mas OpenAI FALHA: cai na mensagem fixa (fluxo idêntico ao sem agente)", async () => {
      await setRepomFlowEnabled({ enabled: true });
      await setRepomAgentEnabled({ enabled: true });
      configuredMock.mockReturnValue(true);
      chatMock.mockRejectedValue(new Error("OPENAI_HTTP_500"));

      await handleRepomIncomingMessage(inbound("oi"));
      const r = await handleRepomIncomingMessage(inbound("aaa"));

      expect(r).toMatchObject({ ok: true, node: "ask_cpf", action: "invalid_cpf" });
      expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/11 números/); // MSG.invalidCpf
    });

    it("ON mas SEM chave OpenAI: usa a fixa e nem chama o modelo", async () => {
      await setRepomFlowEnabled({ enabled: true });
      await setRepomAgentEnabled({ enabled: true });
      configuredMock.mockReturnValue(false);

      await handleRepomIncomingMessage(inbound("oi"));
      await handleRepomIncomingMessage(inbound("aaa"));

      expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/11 números/);
      expect(chatMock).not.toHaveBeenCalled();
    });

    it("ON não atua no CAMINHO FELIZ: CPF válido → mensagem fixa de CNH, sem chamar o modelo", async () => {
      await setRepomFlowEnabled({ enabled: true });
      await setRepomAgentEnabled({ enabled: true });
      configuredMock.mockReturnValue(true);
      chatMock.mockResolvedValue({ text: AGENTE });

      await handleRepomIncomingMessage(inbound("oi"));
      const r = await handleRepomIncomingMessage(inbound("123.456.789-01"));

      expect(r).toMatchObject({ ok: true, node: "ask_cnh", action: "create" });
      expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/foto da sua CNH/); // MSG.createNew
      expect(chatMock).not.toHaveBeenCalled();
    });

    it("ON não atua em MÍDIA/texto vazio no ask_cnh: usa a fixa (não gasta chamada)", async () => {
      await setRepomFlowEnabled({ enabled: true });
      await setRepomAgentEnabled({ enabled: true });
      configuredMock.mockReturnValue(true);
      chatMock.mockResolvedValue({ text: AGENTE });

      await handleRepomIncomingMessage(inbound("oi"));
      await handleRepomIncomingMessage(inbound("12345678901"));
      // motorista manda a FOTO da CNH → Evolution entrega text=null
      const r = await handleRepomIncomingMessage({ ...inbound(""), text: null, messageType: "image" });

      expect(r).toMatchObject({ ok: true, node: "ask_cnh", action: "parked" });
      expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/Recebido/); // MSG.cnhParked
      expect(chatMock).not.toHaveBeenCalled();
    });

    it("ON mas estourou o RATE LIMIT por telefone: cai na fixa (freio de custo)", async () => {
      await setRepomFlowEnabled({ enabled: true });
      await setRepomAgentEnabled({ enabled: true });
      configuredMock.mockReturnValue(true);
      chatMock.mockResolvedValue({ text: AGENTE });

      await handleRepomIncomingMessage(inbound("oi")); // greeting (não conta)
      // default cap = 5 chamadas/telefone: as 5 primeiras usam o agente…
      for (let i = 0; i < 5; i++) await handleRepomIncomingMessage(inbound(`pergunta ${i}`));
      expect(chatMock).toHaveBeenCalledTimes(5);

      // …a 6ª estoura → mensagem fixa, sem nova chamada ao modelo
      await handleRepomIncomingMessage(inbound("mais uma pergunta"));
      expect(chatMock).toHaveBeenCalledTimes(5);
      expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/11 números/); // MSG.invalidCpf
    });
  });

  // ── Fase 3b — processamento da CNH (mídia → OCR → gates → pending) ──
  describe("Fase 3b — OCR da CNH", () => {
    beforeEach(async () => {
      await setRepomFlowEnabled({ enabled: true });
    });

    it("flag OFF: mídia no ask_cnh NÃO processa OCR (cai no fallback), sem pending", async () => {
      await reachAskCnh();
      const r = await handleRepomIncomingMessage(mediaInbound());
      expect(r).toMatchObject({ node: "ask_cnh", action: "parked" });
      expect(extractMock).not.toHaveBeenCalled();
      expect((await pendings()).length).toBe(0);
    });

    it("flag ON + CNH boa (CPF batendo): cria pending 'pendente' com dados.motorista.cnh + cnh_url, encerra e confirma", async () => {
      await setRepomCnhOcrEnabled({ enabled: true });
      await reachAskCnh("12345678901");
      const r = await handleRepomIncomingMessage(mediaInbound());

      expect(r).toMatchObject({ ok: true, node: "submitted", action: "submitted" });
      expect(getMediaMock).toHaveBeenCalledOnce();
      expect(extractMock).toHaveBeenCalledOnce();

      const p = await pendings();
      expect(p.length).toBe(1);
      expect(p[0]).toMatchObject({ id_cadastro: "repom-12345678901", status: "pendente", versao_cadastro: "v2" });
      expect(p[0].dados.motorista.cnh.registro).toBe("07314868241");
      expect(p[0].dados.motorista.cnh.validade).toBe("2032-04-06"); // ISO
      expect(p[0].dados.motorista.cnh_url).toContain("motorista_cnh");
      expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/Recebi sua CNH/);
      expect(await session()).toMatchObject({ current_node: "submitted", status: "done" });
    });

    it("flag ON + OCR fora do ar: SALVA a foto + cria pending 'OCR indisponível' (não perde o doc)", async () => {
      await setRepomCnhOcrEnabled({ enabled: true });
      extractMock.mockResolvedValue({ ok: false, requiresUpload: true, error: "OPENAI_HTTP_500" });
      await reachAskCnh("12345678901");
      const r = await handleRepomIncomingMessage(mediaInbound());

      expect(r).toMatchObject({ ok: true, action: "ocr_unavailable" });
      const p = await pendings();
      expect(p.length).toBe(1);
      expect(p[0].dados.motorista.cnh_url).toContain("motorista_cnh"); // foto guardada
      expect(p[0].dados.motorista.cnh).toBeUndefined(); // sem OCR, sem campos
      expect(p[0].observacoes).toMatch(/OCR indispon/i);
      expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/Recebi sua CNH/);
    });

    it("flag ON + não é CNH (doc trocado): pede reenvio, NÃO cria pending, segue em ask_cnh", async () => {
      await setRepomCnhOcrEnabled({ enabled: true });
      extractMock.mockResolvedValue({ ok: true, fields: { placa: "ABC1D23", renavam: "123" } });
      await reachAskCnh("12345678901");
      const r = await handleRepomIncomingMessage(mediaInbound());

      expect(r).toMatchObject({ node: "ask_cnh", action: "not_a_cnh" });
      expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/não parece ser uma CNH/);
      expect((await pendings()).length).toBe(0);
      expect(uploadMock).not.toHaveBeenCalled(); // não estaciona documento trocado
    });

    it("flag ON + CPF da CNH diverge do informado: pending 'pendente' com observação de revisão", async () => {
      await setRepomCnhOcrEnabled({ enabled: true });
      extractMock.mockResolvedValue({
        ok: true,
        fields: { nome: "LUCAS CAVALHEIRO", cpf: "99999999999", numero_registro: "0731", categoria: "D", validade: "06/04/2032" },
      });
      await reachAskCnh("12345678901");
      await handleRepomIncomingMessage(mediaInbound());

      const p = await pendings();
      expect(p.length).toBe(1);
      expect(p[0].status).toBe("pendente");
      expect(p[0].observacoes).toMatch(/CPF da CNH difere/);
    });
  });
});
