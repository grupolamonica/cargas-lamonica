import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consultaCep } from "./cadastroApi";

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/**
 * consultaCep tem dois passos:
 *   1) endpoint local (Infosimples via FastAPI) — POST /api/consulta/cep
 *   2) fallback ViaCEP (GET viacep.com.br) quando o local não traz uf+cidade
 * (2026-05-27 — teste atualizado: a versão antiga "ViaCEP direto + cache"
 *  foi substituída por este fluxo local-first; sem cache module-level.)
 */
describe("consultaCep (local-first + ViaCEP)", () => {
  const fetchMock = vi.fn();
  const isLocal = (u: string) => u.includes("/api/consulta/cep");
  const isViaCep = (u: string) => u.startsWith("https://viacep.com.br/");

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("rejeita CEP com menos de 8 digitos sem chamar fetch", async () => {
    await expect(consultaCep("123")).rejects.toThrow(/8 digitos/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("usa o endpoint local (Infosimples) quando ele traz uf+cidade — sem cair pro ViaCEP", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      if (isLocal(String(url))) {
        return Promise.resolve(
          jsonResponse({ data: [{ uf: "SP", cidade: "São Paulo", bairro: "Sé", logradouro: "Praça da Sé" }] }),
        );
      }
      return Promise.reject(new Error("não deveria chamar o ViaCEP"));
    });

    const result = await consultaCep("01001-000");

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(1);
    expect(isLocal(urls[0])).toBe(true);
    expect(result).toEqual({
      cep: "01001000",
      uf: "SP",
      cidade: "São Paulo",
      bairro: "Sé",
      logradouro: "Praça da Sé",
    });
  });

  it("cai pro ViaCEP quando o local não traz uf/cidade (mapeia localidade -> cidade)", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      if (isLocal(String(url))) return Promise.resolve(jsonResponse({ data: [] }));
      if (isViaCep(String(url))) {
        return Promise.resolve(
          jsonResponse({ localidade: "Rio de Janeiro", uf: "RJ", bairro: "Centro", logradouro: "Av. Rio Branco" }),
        );
      }
      return Promise.reject(new Error("url inesperada"));
    });

    const result = await consultaCep("20040-020");

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some(isLocal)).toBe(true);
    expect(urls.some(isViaCep)).toBe(true);
    expect(result).toEqual({
      cep: "20040020",
      uf: "RJ",
      cidade: "Rio de Janeiro",
      bairro: "Centro",
      logradouro: "Av. Rio Branco",
    });
  });

  it("se o local falha (throw), ainda resolve via ViaCEP", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      if (isLocal(String(url))) return Promise.reject(new Error("local indisponível"));
      if (isViaCep(String(url))) return Promise.resolve(jsonResponse({ localidade: "Curitiba", uf: "PR" }));
      return Promise.reject(new Error("url inesperada"));
    });

    const result = await consultaCep("80010-000");
    expect(result.cidade).toBe("Curitiba");
    expect(result.uf).toBe("PR");
  });

  it("lança 'CEP nao encontrado' quando local e ViaCEP não resolvem (erro: true)", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      if (isLocal(String(url))) return Promise.resolve(jsonResponse({ data: [] }));
      if (isViaCep(String(url))) return Promise.resolve(jsonResponse({ erro: true }));
      return Promise.reject(new Error("url inesperada"));
    });

    await expect(consultaCep("99999-999")).rejects.toThrow(/CEP nao encontrado/i);
  });

  it("resposta vazia em ambos lança 'CEP nao encontrado'", async () => {
    fetchMock.mockImplementation((url: unknown) => {
      if (isLocal(String(url))) return Promise.resolve(jsonResponse({ data: [] }));
      if (isViaCep(String(url))) return Promise.resolve(jsonResponse({}));
      return Promise.reject(new Error("url inesperada"));
    });

    await expect(consultaCep("01001-000")).rejects.toThrow(/CEP nao encontrado/i);
  });
});
