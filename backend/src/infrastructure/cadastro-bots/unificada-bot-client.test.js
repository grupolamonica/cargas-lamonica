import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UnificadaBotError,
  __resetCircuitForTests,
  consultarStatus,
  gerarPdfLamonica,
  gerarPdfUnificado,
  health,
} from "./unificada-bot-client.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.UNIFICADA_BOT_URL = "http://unificada-bot:8001";
  process.env.UNIFICADA_BOT_TIMEOUT_MS = "5000";
  process.env.UNIFICADA_BOT_CIRCUIT_THRESHOLD = "3";
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
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
}

function mockPdfOnce({ httpStatus = 200, bytes = "%PDF-1.4 fake-dossie", headers = {} } = {}) {
  const response = new Response(Buffer.from(bytes), {
    status: httpStatus,
    headers: { "Content-Type": "application/pdf", ...headers },
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
}

describe("unificada-bot-client / health", () => {
  it("retorna ok:true quando sidecar responde 200", async () => {
    mockJsonOnce(200, { ok: true, service: "unificada-robo (api-only)" });
    const r = await health();
    expect(r.ok).toBe(true);
    expect(r.body.service).toMatch(/unificada/);
  });
  it("retorna ok:false em ECONNREFUSED", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await health();
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(0);
  });
});

describe("unificada-bot-client / consultarStatus", () => {
  it("retorna status_description quando 200", async () => {
    mockJsonOnce(200, {
      ok: true, status: true, status_description: "Conforme",
      query_value: "53018634870", q_for: "cpf",
      item: { limitDate: "2026-09-01" }, erro: null,
    });
    const r = await consultarStatus({ queryValue: "53018634870", qFor: "cpf" });
    expect(r.ok).toBe(true);
    expect(r.status_description).toBe("Conforme");
    expect(r.item.limitDate).toBe("2026-09-01");
  });
  it("mapeia 502 → UNIFICADA_DOWNSTREAM_FAIL", async () => {
    mockJsonOnce(502, { detail: { erro: "AngelLira indisponível" } });
    await expect(
      consultarStatus({ queryValue: "53018634870", qFor: "cpf" }),
    ).rejects.toMatchObject({ code: "UNIFICADA_DOWNSTREAM_FAIL", httpStatus: 502 });
  });
});

describe("unificada-bot-client / gerarPdfUnificado", () => {
  it("retorna o PDF (Buffer) em caso de sucesso 200", async () => {
    mockPdfOnce({ headers: { "X-Components": "{'motorista': True}", "X-Warnings": "[]" } });
    const r = await gerarPdfUnificado({ cpf: "53018634870", placaCavalo: "ABC1D23" });
    expect(r.ok).toBe(true);
    expect(Buffer.isBuffer(r.pdf)).toBe(true);
    expect(r.pdf.length).toBeGreaterThan(0);
    expect(r.contentType).toMatch(/pdf/);
    expect(r.components).toContain("motorista");
  });

  it("rejeita SEM fazer fetch quando não há cpf nem placas", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(gerarPdfUnificado({})).rejects.toMatchObject({
      code: "UNIFICADA_BAD_REQUEST",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mapeia 502 (falha ao gerar) → UNIFICADA_DOWNSTREAM_FAIL", async () => {
    mockJsonOnce(502, { detail: { erro: "Falha ao gerar PDF", warnings: ["cpf não encontrado"] } });
    await expect(
      gerarPdfUnificado({ cpf: "00000000000" }),
    ).rejects.toBeInstanceOf(UnificadaBotError);
  });
});

describe("unificada-bot-client / gerarPdfLamonica", () => {
  const DADOS = { motorista: { cpf: "53018634870", nome: "FULANO" }, cavalo: { placa: "ABC1D23" } };

  it("retorna o PDF (Buffer) em caso de sucesso 200", async () => {
    mockPdfOnce({ headers: { "X-Components": "{'motorista': True}", "X-Warnings": "[]" } });
    const r = await gerarPdfLamonica({ dados: DADOS });
    expect(r.ok).toBe(true);
    expect(Buffer.isBuffer(r.pdf)).toBe(true);
    expect(r.pdf.length).toBeGreaterThan(0);
    expect(r.contentType).toMatch(/pdf/);
    expect(r.components).toContain("motorista");
  });

  it("posta { dados } no endpoint /relatorio/pdf_lamonica", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(Buffer.from("%PDF-1.4 x"), { status: 200, headers: { "Content-Type": "application/pdf" } }),
    );
    await gerarPdfLamonica({ dados: DADOS, protocolo: "2026-00023" });
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/relatorio/pdf_lamonica");
    const sent = JSON.parse(opts.body);
    expect(sent.dados).toEqual(DADOS);
    expect(sent.protocolo).toBe("2026-00023");
  });

  it("rejeita SEM fazer fetch quando não há dados/motorista", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(gerarPdfLamonica({ dados: {} })).rejects.toMatchObject({
      code: "UNIFICADA_BAD_REQUEST",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mapeia 502 (falha ao gerar) → UnificadaBotError", async () => {
    mockJsonOnce(502, { detail: { erro: "Falha ao gerar PDF" } });
    await expect(gerarPdfLamonica({ dados: DADOS })).rejects.toBeInstanceOf(UnificadaBotError);
  });
});
