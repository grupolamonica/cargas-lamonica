import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callOcrSidecar, extractCnhFromMedia, extractComprovanteFromMedia, flattenOcrCampos } from "./ocr-sidecar-client.js";

const okEnvelope = (campos, extra = {}) => ({
  code: 200,
  code_message: "ok",
  header: { provider: "infosimples" },
  data: [{ campos }],
  ...extra,
});

function mockFetchOnce({ ok = true, status = 200, json = {}, throwErr = null } = {}) {
  const fn = vi.fn(async () => {
    if (throwErr) throw throwErr;
    return {
      ok,
      status,
      json: async () => json,
      text: async () => (typeof json === "string" ? json : JSON.stringify(json)),
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("repom ocr-sidecar-client", () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    delete process.env.OCR_SIDECAR_TOKEN;
    delete process.env.REPOM_COMPROVANTE_CONCESSIONARIA; // default 'neoenergia' testado de forma hermética
    process.env.CADASTRO_OCR_URL = "http://cadastro-ocr:8765";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    process.env = { ...ENV };
  });

  describe("flattenOcrCampos", () => {
    it("achata { valor } e valor cru; ignora vazios/nulos e faz trim", () => {
      const flat = flattenOcrCampos({
        data: [
          {
            campos: {
              nome: { valor: "  FULANO DE TAL " },
              cpf: "12345678901",
              categoria: { valor: "AE" },
              rg: { valor: "" }, // vazio → ignora
              nada: { valor: null }, // nulo → ignora
              solto: undefined, // ignora
            },
          },
        ],
      });
      expect(flat).toEqual({ nome: "FULANO DE TAL", cpf: "12345678901", categoria: "AE" });
    });

    it("envelope sem data/campos → objeto vazio", () => {
      expect(flattenOcrCampos({})).toEqual({});
      expect(flattenOcrCampos({ data: [] })).toEqual({});
      expect(flattenOcrCampos({ data: [{}] })).toEqual({});
    });
  });

  describe("callOcrSidecar", () => {
    it("monta URL/corpo/headers corretos e devolve o envelope; sem token não manda header", async () => {
      const fetchMock = mockFetchOnce({ json: okEnvelope({ nome: { valor: "X" } }) });
      const env = await callOcrSidecar({ docType: "cnh", imagemBase64: "BASE64", idCadastro: "abc-1" });

      expect(env.code).toBe(200);
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("http://cadastro-ocr:8765/api/ocr/cnh");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({ imagem: "BASE64", id_cadastro: "abc-1" });
      expect(opts.headers["X-OCR-Sidecar-Token"]).toBeUndefined();
      expect(opts.headers["Content-Type"]).toBe("application/json");
    });

    it("inclui X-OCR-Sidecar-Token quando OCR_SIDECAR_TOKEN está setado", async () => {
      process.env.OCR_SIDECAR_TOKEN = "s3cr3t";
      const fetchMock = mockFetchOnce({ json: okEnvelope({}) });
      await callOcrSidecar({ docType: "cnh", imagemBase64: "B", idCadastro: "id" });
      expect(fetchMock.mock.calls[0][1].headers["X-OCR-Sidecar-Token"]).toBe("s3cr3t");
    });

    it("HTTP != 2xx lança com statusCode", async () => {
      mockFetchOnce({ ok: false, status: 502, json: "bad gateway" });
      await expect(
        callOcrSidecar({ docType: "cnh", imagemBase64: "B", idCadastro: "id" }),
      ).rejects.toMatchObject({ statusCode: 502 });
    });

    it("extraBody entra no corpo (ex.: comprovante → concessionaria)", async () => {
      const fetchMock = mockFetchOnce({ json: okEnvelope({}) });
      await callOcrSidecar({ docType: "comprovante-residencia", imagemBase64: "B", idCadastro: "id", extraBody: { concessionaria: "enel" } });
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("http://cadastro-ocr:8765/api/ocr/comprovante-residencia");
      expect(JSON.parse(opts.body)).toEqual({ imagem: "B", id_cadastro: "id", concessionaria: "enel" });
    });
  });

  describe("extractCnhFromMedia", () => {
    it("sucesso (code 200): ok=true com fields achatados e provider", async () => {
      mockFetchOnce({
        json: okEnvelope({ nome: { valor: "FULANO" }, cpf: { valor: "12345678901" }, categoria: { valor: "AE" } }),
      });
      const r = await extractCnhFromMedia({ imagemBase64: "B", idCadastro: "id", correlationId: "c1" });
      expect(r.ok).toBe(true);
      expect(r.fields).toMatchObject({ nome: "FULANO", cpf: "12345678901", categoria: "AE" });
      expect(r.provider).toBe("infosimples");
    });

    it("code != 200 (não leu): ok=false, requiresUpload, com code/codeMessage — NÃO reprova por infra", async () => {
      mockFetchOnce({ json: { code: 612, code_message: "não parece uma CNH", data: [], header: { provider: "fallback-both-failed" } } });
      const r = await extractCnhFromMedia({ imagemBase64: "B", idCadastro: "id" });
      expect(r).toMatchObject({ ok: false, requiresUpload: true, code: 612, codeMessage: "não parece uma CNH" });
    });

    it("erro de rede (fetch rejeita): ok=false, requiresUpload, error capturado", async () => {
      mockFetchOnce({ throwErr: new Error("ECONNREFUSED") });
      const r = await extractCnhFromMedia({ imagemBase64: "B", idCadastro: "id" });
      expect(r).toMatchObject({ ok: false, requiresUpload: true });
      expect(r.error).toMatch(/ECONNREFUSED/);
    });

    it("HTTP 500 do sidecar vira degradação suave (requiresUpload), não lança", async () => {
      mockFetchOnce({ ok: false, status: 500, json: "boom" });
      const r = await extractCnhFromMedia({ imagemBase64: "B", idCadastro: "id" });
      expect(r).toMatchObject({ ok: false, requiresUpload: true });
    });

    it("sem imagem/id não chama o sidecar", async () => {
      const fetchMock = mockFetchOnce({ json: okEnvelope({}) });
      const r = await extractCnhFromMedia({ imagemBase64: "", idCadastro: "" });
      expect(r).toMatchObject({ ok: false, requiresUpload: true, error: "MISSING_IMAGE_OR_ID" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("extractComprovanteFromMedia (Vision)", () => {
    it("chama /api/ocr/comprovante-residencia com concessionaria e devolve fields achatados", async () => {
      const fetchMock = mockFetchOnce({
        json: okEnvelope(
          { logradouro: { valor: "Rua A" }, cep: { valor: "40000-000" }, municipio_uf: { valor: "Salvador - BA" } },
          { header: { provider: "openai-vision" } },
        ),
      });
      const r = await extractComprovanteFromMedia({ imagemBase64: "B", idCadastro: "repom-1", correlationId: "c1" });
      expect(r.ok).toBe(true);
      expect(r.fields).toMatchObject({ logradouro: "Rua A", cep: "40000-000", municipio_uf: "Salvador - BA" });
      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("http://cadastro-ocr:8765/api/ocr/comprovante-residencia");
      expect(JSON.parse(opts.body).concessionaria).toBe("neoenergia"); // default
    });

    it("respeita REPOM_COMPROVANTE_CONCESSIONARIA", async () => {
      process.env.REPOM_COMPROVANTE_CONCESSIONARIA = "cemig";
      const fetchMock = mockFetchOnce({ json: okEnvelope({}) });
      await extractComprovanteFromMedia({ imagemBase64: "B", idCadastro: "repom-1" });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).concessionaria).toBe("cemig");
    });

    it("degradação suave: erro de rede → ok=false (nunca lança)", async () => {
      mockFetchOnce({ throwErr: new Error("ETIMEDOUT") });
      const r = await extractComprovanteFromMedia({ imagemBase64: "B", idCadastro: "repom-1" });
      expect(r).toMatchObject({ ok: false, requiresUpload: true });
    });
  });
});
