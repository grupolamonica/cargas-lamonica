import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GeradorMockError,
  __resetCircuitForTests,
  gerarPdfMock,
  health,
} from "./gerador-mock-client.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.GERADOR_MOCK_URL = "http://gerador-mock-angellira:8000";
  process.env.GERADOR_MOCK_TIMEOUT_MS = "5000";
  process.env.GERADOR_MOCK_CIRCUIT_THRESHOLD = "3";
  delete process.env.GERADOR_MOCK_API_KEY;
  __resetCircuitForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = originalEnv;
});

function mockJsonOnce(httpStatus, body) {
  const response = new Response(
    body == null ? null : JSON.stringify(body),
    { status: httpStatus, headers: { "Content-Type": "application/json" } },
  );
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
}

function okRenderBody(overrides = {}) {
  return {
    ok: true,
    filename: "DOSSIE - FULANO.pdf",
    components: { motorista: { found: true, status: "Conforme" } },
    warnings: [],
    pdf_base64: Buffer.from("%PDF-1.4 fake-dossie").toString("base64"),
    ...overrides,
  };
}

const DADOS = {
  motorista: { cpf: "53018634870", nome: "FULANO" },
  cavalo: { placa: "ABC1D23" },
};

describe("gerador-mock-client / health", () => {
  it("retorna ok:true quando sidecar responde 200", async () => {
    mockJsonOnce(200, { ok: true, service: "gerador-mock-angellira", auth: false });
    const r = await health();
    expect(r.ok).toBe(true);
    expect(r.body.service).toMatch(/gerador-mock/);
  });
  it("retorna ok:false em ECONNREFUSED", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await health();
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(0);
  });
});

describe("gerador-mock-client / gerarPdfMock", () => {
  it("retorna o PDF (Buffer) + filename/components em caso de sucesso 200", async () => {
    mockJsonOnce(200, okRenderBody());
    const r = await gerarPdfMock({ dados: DADOS });
    expect(r.ok).toBe(true);
    expect(Buffer.isBuffer(r.pdf)).toBe(true);
    expect(r.pdf.toString()).toBe("%PDF-1.4 fake-dossie");
    expect(r.filename).toBe("DOSSIE - FULANO.pdf");
    expect(r.components.motorista.found).toBe(true);
  });

  it("rejeita SEM fazer fetch quando não há motorista nem veículo", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(gerarPdfMock({ dados: {} })).rejects.toMatchObject({
      code: "GERADOR_MOCK_BAD_REQUEST",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("normaliza CNH do topo (dados.cnh) para motorista.cnh no body enviado", async () => {
    const fetchSpy = mockJsonOnce(200, okRenderBody());
    await gerarPdfMock({
      dados: { motorista: { cpf: "1" }, cnh: { registro: "999" }, cavalo: { placa: "X" } },
    });
    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(sentBody.motorista.cnh.registro).toBe("999");
  });

  it("envia X-API-Key quando GERADOR_MOCK_API_KEY setado", async () => {
    process.env.GERADOR_MOCK_API_KEY = "segredo";
    const fetchSpy = mockJsonOnce(200, okRenderBody());
    await gerarPdfMock({ dados: DADOS });
    expect(fetchSpy.mock.calls[0][1].headers["X-API-Key"]).toBe("segredo");
  });

  it("mapeia 422 → GERADOR_MOCK_SEM_COMPONENTE", async () => {
    mockJsonOnce(422, { ok: false, components: {}, warnings: ["nenhum componente"] });
    await expect(gerarPdfMock({ dados: DADOS })).rejects.toMatchObject({
      code: "GERADOR_MOCK_SEM_COMPONENTE", httpStatus: 422,
    });
  });

  it("mapeia 401 → GERADOR_MOCK_UNAUTHORIZED", async () => {
    mockJsonOnce(401, { detail: "API key invalida" });
    await expect(gerarPdfMock({ dados: DADOS })).rejects.toBeInstanceOf(GeradorMockError);
  });
});
