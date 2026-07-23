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
const { extractMock, extractComprovanteMock, uploadMock } = vi.hoisted(() => ({
  extractMock: vi.fn(),
  extractComprovanteMock: vi.fn(),
  uploadMock: vi.fn(),
}));
vi.mock("./ocr-sidecar-client.js", () => ({
  extractCnhFromMedia: extractMock,
  extractComprovanteFromMedia: extractComprovanteMock,
}));
vi.mock("../candidatura/use-cases/upload-draft-file.js", () => ({ uploadDraftFile: uploadMock }));

const {
  handleRepomIncomingMessage,
  setRepomFlowEnabled,
  setRepomCnhOcrEnabled,
  setRepomContinuacaoEnabled,
  setRepomComprovanteOcrEnabled,
  extractCpfFromText,
} = await import("./flow-engine.js");
const { setRepomAgentEnabled, resetRepomAgentRateLimitForTests } = await import("./agent-orientador.js");
const { tryReserveCnhCall, resetRepomCnhRateLimitForTests } = await import("./cnh-media.js");

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
    resetRepomCnhRateLimitForTests();
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

    it("flag ON + áudio (não-mídia-CNH) no ask_cnh: pede foto/PDF explicitamente (não a msg enganosa)", async () => {
      await setRepomCnhOcrEnabled({ enabled: true });
      await reachAskCnh("12345678901");
      const r = await handleRepomIncomingMessage({ ...mediaInbound(), messageType: "audio", text: "[audio]" });
      expect(r).toMatchObject({ node: "ask_cnh", action: "await_media" });
      expect(extractMock).not.toHaveBeenCalled();
      const txt = sendMock.mock.calls.at(-1)[0].text;
      expect(txt).toMatch(/foto/i);
      expect(txt).not.toMatch(/leitura automática/); // não é o cnhParked enganoso
    });

    it("flag ON + rate limit estourado: responde 'aguarde' e NÃO chama OCR/download (freio de custo)", async () => {
      await setRepomCnhOcrEnabled({ enabled: true });
      await reachAskCnh("12345678901");
      while (tryReserveCnhCall("5571988887777")) {
        /* exaure o cap por telefone (agnóstico ao valor do teto) */
      }
      const r = await handleRepomIncomingMessage(mediaInbound());
      expect(r).toMatchObject({ node: "ask_cnh", action: "rate_limited" });
      expect(getMediaMock).not.toHaveBeenCalled();
      expect(extractMock).not.toHaveBeenCalled();
    });

    it("flag ON + falha ao guardar/gravar: avisa o operador e confirma recebimento (nunca lança)", async () => {
      await setRepomCnhOcrEnabled({ enabled: true });
      uploadMock.mockRejectedValue(new Error("STORAGE_BOOM")); // stageCnhMedia lança
      await reachAskCnh("12345678901");
      const r = await handleRepomIncomingMessage(mediaInbound());
      expect(r).toMatchObject({ ok: true, action: "persist_failed" });
      const { rows } = await query(`SELECT count(*)::int AS n FROM public.operator_notifications WHERE kind='cnh_persist_failed'`);
      expect(rows[0].n).toBe(1);
      expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/Recebi sua CNH/);
      expect((await pendings()).length).toBe(0); // falhou antes de gravar
    });

    it("flag OFF + agente ON + mídia: NÃO gasta chamada de LLM (gate por messageType)", async () => {
      await setRepomAgentEnabled({ enabled: true });
      configuredMock.mockReturnValue(true);
      await reachAskCnh("12345678901");
      const r = await handleRepomIncomingMessage(mediaInbound());
      expect(r).toMatchObject({ node: "ask_cnh", action: "parked" });
      expect(chatMock).not.toHaveBeenCalled(); // "[image]" não vira chamada de agente
    });
  });

  describe("Fase 3d — continuação da coleta (selfie → comprovante → telefone)", () => {
    beforeEach(async () => {
      await setRepomFlowEnabled({ enabled: true });
    });

    // Upload por slot: devolve um path coerente com o slot pedido (selfie/comprovante).
    const slotAwareUpload = () =>
      uploadMock.mockImplementation(async ({ slot }) => ({
        statusCode: 200,
        payload: { storage_path: `12345678901/repom/${slot}_1.jpg` },
      }));

    // Liga OCR + continuação e leva até 'coletando' na selfie (CNH já enviada/gravada).
    async function reachColetaSelfie(phone = "5571988887777") {
      await setRepomCnhOcrEnabled({ enabled: true });
      await setRepomContinuacaoEnabled({ enabled: true });
      slotAwareUpload();
      await reachAskCnh("12345678901", phone);
      return handleRepomIncomingMessage(mediaInbound(phone));
    }

    // Leva até o passo do comprovante (CNH ok → selfie enviada → espera comprovante).
    async function reachColetaComprovante(phone = "5571988887777") {
      await reachColetaSelfie(phone);
      await handleRepomIncomingMessage(mediaInbound(phone)); // selfie → pede comprovante
    }

    describe("comprovante → OpenAI Vision (extrai endereço; flag própria, best-effort)", () => {
      it("flag ON: extrai o endereço e grava em dados.motorista.endereco", async () => {
        await reachColetaComprovante();
        await setRepomComprovanteOcrEnabled({ enabled: true });
        extractComprovanteMock.mockResolvedValue({
          ok: true,
          fields: { logradouro: "Rua A", numero: "10", bairro: "Centro", cep: "40000-000", municipio_uf: "Salvador - BA" },
        });
        const r = await handleRepomIncomingMessage(mediaInbound()); // comprovante
        expect(r).toMatchObject({ node: "coletando", action: "ask_telefone" });
        expect(extractComprovanteMock).toHaveBeenCalledTimes(1);
        const [p] = await pendings();
        expect(p.dados.motorista.comprovante_url).toBeTruthy();
        expect(p.dados.motorista.endereco).toMatchObject({ logradouro: "Rua A", cidade: "Salvador", uf: "BA", cep: "40000-000" });
      });

      it("flag OFF (default): NÃO chama a Vision e não grava endereço (só guarda o comprovante)", async () => {
        await reachColetaComprovante();
        const r = await handleRepomIncomingMessage(mediaInbound());
        expect(r).toMatchObject({ node: "coletando", action: "ask_telefone" });
        expect(extractComprovanteMock).not.toHaveBeenCalled();
        const [p] = await pendings();
        expect(p.dados.motorista.comprovante_url).toBeTruthy();
        expect(p.dados.motorista.endereco).toBeUndefined();
      });

      it("flag ON mas Vision falha: guarda o comprovante e AVANÇA (best-effort, nunca trava)", async () => {
        await reachColetaComprovante();
        await setRepomComprovanteOcrEnabled({ enabled: true });
        extractComprovanteMock.mockResolvedValue({ ok: false, requiresUpload: true });
        const r = await handleRepomIncomingMessage(mediaInbound());
        expect(r).toMatchObject({ node: "coletando", action: "ask_telefone" });
        const [p] = await pendings();
        expect(p.dados.motorista.comprovante_url).toBeTruthy();
        expect(p.dados.motorista.endereco).toBeUndefined();
      });

      it("flag ON + Vision ok mas sem campos de endereço: NÃO grava endereco:{} e avança", async () => {
        await reachColetaComprovante();
        await setRepomComprovanteOcrEnabled({ enabled: true });
        extractComprovanteMock.mockResolvedValue({ ok: true, fields: {} }); // leu, mas nada mapeável
        const r = await handleRepomIncomingMessage(mediaInbound());
        expect(r).toMatchObject({ node: "coletando", action: "ask_telefone" });
        const [p] = await pendings();
        expect(p.dados.motorista.comprovante_url).toBeTruthy();
        expect(p.dados.motorista.endereco).toBeUndefined(); // guard Object.keys().length
      });
    });

    it("continuação OFF: CNH boa encerra em 'submitted' (comportamento da Fase 3b, intacto)", async () => {
      await setRepomCnhOcrEnabled({ enabled: true }); // continuação fica OFF (default)
      await reachAskCnh("12345678901");
      const r = await handleRepomIncomingMessage(mediaInbound());
      expect(r).toMatchObject({ node: "submitted", action: "submitted" });
      expect(await session()).toMatchObject({ current_node: "submitted", status: "done" });
    });

    it("continuação ON: após a CNH NÃO encerra — pede a selfie e fica em 'coletando'", async () => {
      const r = await reachColetaSelfie();
      expect(r).toMatchObject({ ok: true, node: "coletando", action: "ask_selfie_cnh" });
      expect(await session()).toMatchObject({ current_node: "coletando", status: "active" });
      expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/selfie/i);
      const [p] = await pendings();
      expect(p.dados.repom).toMatchObject({ coleta_status: "coletando", etapa_atual: "selfie_cnh" });
    });

    it("caminho feliz completo: CNH→selfie→comprovante→telefone grava tudo e conclui", async () => {
      await reachColetaSelfie(); // CNH ok → pediu selfie
      const rSelfie = await handleRepomIncomingMessage(mediaInbound()); // selfie
      expect(rSelfie).toMatchObject({ node: "coletando", action: "ask_comprovante" });
      const rCompr = await handleRepomIncomingMessage(mediaInbound()); // comprovante
      expect(rCompr).toMatchObject({ node: "coletando", action: "ask_telefone" });
      const rTel = await handleRepomIncomingMessage(inbound("(71) 99999-8888")); // telefone
      expect(rTel).toMatchObject({ node: "complete", action: "coleta_completa" });

      expect(await session()).toMatchObject({ current_node: "complete", status: "done" });
      expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/Recebi todos os seus documentos/i);

      const [p] = await pendings();
      expect(p.dados.motorista).toMatchObject({
        cnh_url: expect.stringContaining("motorista_cnh"),
        selfie_cnh_url: expect.stringContaining("motorista_selfie_cnh"),
        comprovante_url: expect.stringContaining("motorista_comprovante"),
        telefone: "71999998888",
      });
      expect(p.dados.repom).toMatchObject({ coleta_status: "concluida", etapa_atual: null });
      expect(p.status).toBe("pendente"); // nunca muda de status (não some da fila do operador)
    });

    it("preserva a observação de revisão da CNH ao mesclar a selfie (COALESCE)", async () => {
      // CNH com CPF divergente → observação de revisão gravada na CNH.
      extractMock.mockResolvedValue({
        ok: true,
        provider: "infosimples",
        fields: { nome: "LUCAS CAVALHEIRO", cpf: "99999999999", numero_registro: "07314868241", categoria: "D", validade: "06/04/2032" },
      });
      await reachColetaSelfie();
      const antes = (await pendings())[0].observacoes;
      expect(antes).toMatch(/Revisar/);
      await handleRepomIncomingMessage(mediaInbound()); // selfie (observacoes: null)
      expect((await pendings())[0].observacoes).toBe(antes); // preservada
    });

    it("telefone inválido: repede (mensagem específica), não conclui", async () => {
      await reachColetaSelfie();
      await handleRepomIncomingMessage(mediaInbound()); // selfie → comprovante
      await handleRepomIncomingMessage(mediaInbound()); // comprovante → telefone
      const r = await handleRepomIncomingMessage(inbound("não sei"));
      expect(r).toMatchObject({ node: "coletando", action: "invalid_telefone" });
      expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/DDD/);
      expect(await session()).toMatchObject({ current_node: "coletando", status: "active" });
    });

    it("doc esperado mas veio texto: reconduz; após 3 tentativas avisa o operador (uma vez)", async () => {
      await reachColetaSelfie(); // espera selfie (doc)
      await handleRepomIncomingMessage(inbound("como faço?")); // 1
      await handleRepomIncomingMessage(inbound("não entendi")); // 2
      const r = await handleRepomIncomingMessage(inbound("me ajuda")); // 3 → escala
      expect(r).toMatchObject({ node: "coletando", action: "await_selfie_cnh" });
      const { rows } = await query(`SELECT count(*)::int AS n FROM public.operator_notifications WHERE kind='repom_coleta_travada'`);
      expect(rows[0].n).toBe(1);
      // 4ª tentativa não duplica a notificação (coleta_escalada)
      await handleRepomIncomingMessage(inbound("alô"));
      const { rows: r2 } = await query(`SELECT count(*)::int AS n FROM public.operator_notifications WHERE kind='repom_coleta_travada'`);
      expect(r2[0].n).toBe(1);
    });

    it("kill switch: sessão em 'coletando' e continuação desligada → encerra gentil", async () => {
      await reachColetaSelfie();
      await setRepomContinuacaoEnabled({ enabled: false });
      const r = await handleRepomIncomingMessage(mediaInbound());
      expect(r).toMatchObject({ node: "submitted", action: "continuacao_off" });
      expect(await session()).toMatchObject({ current_node: "submitted", status: "done" });
    });

    it("idempotência por message-id: reenvio da MESMA mensagem (mesmo id) é ignorado e não reprocessa", async () => {
      await reachColetaSelfie();
      const selfie = mediaInbound();
      await handleRepomIncomingMessage(selfie); // 1ª → grava selfie, avança p/ comprovante
      const uploadsApos1a = uploadMock.mock.calls.length;
      const r = await handleRepomIncomingMessage(selfie); // reenvio do MESMO externalId
      // dedup é GLOBAL por external_id (claimMessageOnce), não por passo — a 2ª
      // chamada é barrada e NÃO dispara novo download/upload.
      expect(r).toMatchObject({ skipped: "duplicate_media", node: "coletando" });
      expect(uploadMock.mock.calls.length).toBe(uploadsApos1a); // não reprocessou
    });

    it("OCR indisponível + continuação ON: salva a foto da CNH e AVANÇA p/ a selfie", async () => {
      await setRepomCnhOcrEnabled({ enabled: true });
      await setRepomContinuacaoEnabled({ enabled: true });
      slotAwareUpload();
      extractMock.mockResolvedValue({ ok: false, requiresUpload: true }); // OCR fora do ar
      await reachAskCnh("12345678901");
      const r = await handleRepomIncomingMessage(mediaInbound());
      expect(r).toMatchObject({ ok: true, node: "coletando", action: "ask_selfie_cnh" });
      expect(await session()).toMatchObject({ current_node: "coletando", status: "active" });
      const [p] = await pendings();
      expect(p.dados.motorista.cnh_url).toContain("motorista_cnh");
      expect(p.observacoes).toMatch(/OCR indispon/i);
      expect(p.dados.repom).toMatchObject({ coleta_status: "coletando", etapa_atual: "selfie_cnh" });
    });

    it("falha de staging no passo (upload 415): pede o MESMO passo, não grava nem avança", async () => {
      await reachColetaSelfie(); // espera selfie
      uploadMock.mockResolvedValueOnce({ statusCode: 415, payload: null }); // stageRepomMedia → {ok:false}
      const r = await handleRepomIncomingMessage(mediaInbound());
      expect(r).toMatchObject({ ok: true, node: "coletando", action: "stage_failed" });
      const [p] = await pendings();
      expect(p.dados.motorista.selfie_cnh_url).toBeUndefined(); // não gravou
      expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/selfie/i); // repetiu o pedido
    });

    it("rate-limit estourado DURANTE a coleta: responde 'aguarde' sem baixar/subir", async () => {
      await reachColetaSelfie();
      while (tryReserveCnhCall("5571988887777")) {
        /* exaure o cap por telefone */
      }
      getMediaMock.mockClear();
      uploadMock.mockClear();
      const r = await handleRepomIncomingMessage(mediaInbound());
      expect(r).toMatchObject({ ok: true, node: "coletando", action: "rate_limited" });
      expect(getMediaMock).not.toHaveBeenCalled();
      expect(uploadMock).not.toHaveBeenCalled();
      expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/processando|instante/i);
    });

    it("falha ao gravar doc na coleta: notifica 'repom_coleta_persist_failed' e confirma recebimento", async () => {
      await reachColetaSelfie();
      uploadMock.mockRejectedValueOnce(new Error("STORAGE_BOOM")); // stageRepomMedia lança no passo selfie
      const r = await handleRepomIncomingMessage(mediaInbound());
      expect(r).toMatchObject({ ok: true, action: "persist_failed" });
      const { rows } = await query(`SELECT count(*)::int AS n FROM public.operator_notifications WHERE kind='repom_coleta_persist_failed'`);
      expect(rows[0].n).toBe(1);
      expect(sendMock.mock.calls.at(-1)[0].text).toMatch(/Recebi/i);
    });
  });
});
