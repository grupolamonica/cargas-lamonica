import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetCepCacheForTests, consultaCep } from "./cadastroApi";

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("consultaCep (ViaCEP)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    __resetCepCacheForTests();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("chama ViaCEP direto e mapeia localidade -> cidade", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        cep: "01001-000",
        logradouro: "Praça da Sé",
        complemento: "lado ímpar",
        bairro: "Sé",
        localidade: "São Paulo",
        uf: "SP",
      }),
    );

    const result = await consultaCep("01001-000");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://viacep.com.br/ws/01001000/json/");
    expect(result).toEqual({
      cep: "01001000",
      uf: "SP",
      cidade: "São Paulo",
      bairro: "Sé",
      logradouro: "Praça da Sé",
    });
  });

  it("nao chama InfoSimples nem nenhum endpoint /api/consulta/cep", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ localidade: "São Paulo", uf: "SP" }),
    );

    await consultaCep("01001000");

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\/viacep\.com\.br\//);
    expect(urls.some((u) => u.includes("/api/consulta/cep"))).toBe(false);
  });

  it("lanca erro amigavel quando ViaCEP devolve { erro: true }", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ erro: true }));
    await expect(consultaCep("99999999")).rejects.toThrow(/CEP nao encontrado/i);
  });

  it("trata erro como string 'true' (compat com versoes antigas do ViaCEP)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ erro: "true" }));
    await expect(consultaCep("99999999")).rejects.toThrow(/CEP nao encontrado/i);
  });

  it("rejeita CEP com menos de 8 digitos sem chamar fetch", async () => {
    await expect(consultaCep("123")).rejects.toThrow(/8 digitos/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cache module-level: 2a chamada do mesmo CEP nao dispara novo fetch", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ localidade: "Rio de Janeiro", uf: "RJ", bairro: "Centro", logradouro: "Rua Teste" }),
    );

    const first = await consultaCep("20040020");
    const second = await consultaCep("20040020");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("cache nao mistura CEPs diferentes", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ localidade: "São Paulo", uf: "SP" }))
      .mockResolvedValueOnce(jsonResponse({ localidade: "Rio de Janeiro", uf: "RJ" }));

    const sp = await consultaCep("01001000");
    const rj = await consultaCep("20040020");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sp.cidade).toBe("São Paulo");
    expect(rj.cidade).toBe("Rio de Janeiro");
  });

  it("HTTP nao-ok lanca erro generico (sem fallback InfoSimples)", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 502 }));
    await expect(consultaCep("01001000")).rejects.toThrow(/CEP/);
  });

  it("AbortError vira mensagem de timeout amigavel", async () => {
    fetchMock.mockRejectedValue(
      new DOMException("aborted", "AbortError"),
    );
    await expect(consultaCep("01001000")).rejects.toThrow(/demorou demais/i);
  });

  it("erro de rede vira mensagem amigavel de conexao", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(consultaCep("01001000")).rejects.toThrow(/conexao/i);
  });

  it("resposta vazia (sem uf nem cidade) lanca CEP nao encontrado", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await expect(consultaCep("01001000")).rejects.toThrow(/CEP nao encontrado/i);
  });
});
