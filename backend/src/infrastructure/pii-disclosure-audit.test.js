import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Trilha de auditoria das DIVULGACOES de dado pessoal (DC-283 / BX-5).
 *
 * Dois caminhos mandavam PII pra fora sem deixar rastro nenhum:
 *   - consulta BRK: CPF + placas vao pro robo da BrasilRisk;
 *   - outreach: mensagem vai pro telefone do motorista, via Meta (EUA).
 *
 * Sem registro nao ha como responder "quais dados de quem foram compartilhados,
 * com quem e quando" -- que e o que o art.37 exige poder demonstrar.
 *
 * O que estes testes travam: que o evento SAI, e que ele NAO carrega o dado
 * divulgado. Trilha que repete a PII multiplicaria a exposicao em vez de
 * documenta-la.
 */

const auditEvents = [];
vi.mock("./security-audit.js", () => ({
  recordSecurityAuditEvent: async (event) => {
    auditEvents.push(event);
  },
}));

const { consultarBrkPainel, resetBrkClientStateForTests } = await import("./brk/brk-client.js");
const { sendWhatsappText } = await import("./whatsapp/evolution-client.js");

const CPF = "12345678901";
const TELEFONE = "5571988887777";

describe("auditoria de divulgacao de PII a terceiros", () => {
  const envBackup = {};

  beforeEach(() => {
    auditEvents.length = 0;
    resetBrkClientStateForTests();
    for (const key of ["BRK_BASE_URL", "BRK_API_KEY", "EVOLUTION_API_URL", "EVOLUTION_API_TOKEN", "DRIVER_OUTREACH_TEST_ALLOWLIST"]) {
      envBackup[key] = process.env[key];
    }
    process.env.BRK_BASE_URL = "https://brk.invalid";
    process.env.BRK_API_KEY = "chave-de-teste";
    process.env.EVOLUTION_API_URL = "https://evolution.invalid";
    process.env.EVOLUTION_API_TOKEN = "token-de-teste";
    delete process.env.DRIVER_OUTREACH_TEST_ALLOWLIST;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
  });

  it("consulta BRK registra a divulgacao com CPF mascarado e sem placa crua", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true, status: "ok", conjunto_apto: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const r = await consultarBrkPainel({
      cpf: CPF,
      placas: ["ABC1D23", "DEF4G56"],
      correlationId: "corr-brk",
    });
    expect(r.availability).toBe("OK");

    const evento = auditEvents.find((e) => e.eventType === "driver-validation.brk.disclosure");
    expect(evento).toBeTruthy();
    expect(evento.action).toBe("disclose-to-third-party");
    expect(evento.metadata.destino).toBe("BRK/BrasilRisk");
    expect(evento.metadata.cpf_masked).toBe("123***");
    // Conta as placas, nao as repete.
    expect(evento.metadata.placas_enviadas).toBe(2);

    const serializado = JSON.stringify(evento);
    expect(serializado).not.toContain(CPF);
    expect(serializado).not.toContain("ABC1D23");
    expect(serializado).not.toContain("DEF4G56");
  });

  it("consulta BRK que FALHA nao registra divulgacao", async () => {
    // Nada saiu do lado de la -> nao ha divulgacao a documentar. Registrar
    // aqui inflaria a trilha com contatos que nao aconteceram.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("erro", { status: 500 })));

    const r = await consultarBrkPainel({ cpf: CPF, placas: [], correlationId: "corr-fail" });
    expect(r.availability).toBe("UNAVAILABLE");
    expect(auditEvents.filter((e) => e.eventType === "driver-validation.brk.disclosure")).toHaveLength(0);
  });

  it("envio de WhatsApp registra o contato sem telefone nem texto em claro", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ key: { id: "msg-1" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const texto = "Ola Joao, temos uma carga de Salvador para Feira de Santana.";
    await sendWhatsappText({ to: TELEFONE, text: texto, correlationId: "corr-wa" });

    const evento = auditEvents.find((e) => e.eventType === "driver-outreach.message.sent");
    expect(evento).toBeTruthy();
    expect(evento.action).toBe("contact-driver");
    expect(evento.metadata.canal).toBe("whatsapp");
    // Mesmo mascaramento do log: so os 2 ultimos digitos.
    expect(evento.metadata.telefone_masked).toBe("**77");
    expect(evento.metadata.tamanho_texto).toBe(texto.length);

    const serializado = JSON.stringify(evento);
    expect(serializado).not.toContain(TELEFONE);
    expect(serializado).not.toContain("Joao");
    expect(serializado).not.toContain("Salvador");
  });
});
