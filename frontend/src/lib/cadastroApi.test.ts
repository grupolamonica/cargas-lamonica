import { afterEach, describe, expect, it, vi } from "vitest";

import { consultaCnpj, ocrCrlv } from "@/lib/cadastroApi";

function stubFileReader(base64 = "ZmFrZQ==") {
  class MockFileReader {
    result: string | null = null;
    error: Error | null = null;
    onload: null | (() => void) = null;
    onerror: null | (() => void) = null;

    readAsDataURL() {
      this.result = `data:image/png;base64,${base64}`;
      this.onload?.();
    }
  }

  vi.stubGlobal("FileReader", MockFileReader);
}

describe("consultaCnpj", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("mapeia os campos endereco_* retornados pela consulta da Receita", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 200,
            data: [
              {
                razao_social: "J. MELGACO TRANSPORTES E SERVICOS LTDA",
                cnpj: "58.341.766/0001-10 ",
                endereco_cep: "29.166-024",
                endereco_uf: "ES",
                endereco_municipio: "SERRA",
                endereco_bairro: "BARCELONA",
                endereco_logradouro: "R ARCO VERDE",
                endereco_numero: "78",
                telefone: "(27) 9707-0063/ (0000) 0000-0000",
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      ),
    );

    await expect(consultaCnpj("58.341.766/0001-10")).resolves.toEqual({
      nome: "J. MELGACO TRANSPORTES E SERVICOS LTDA",
      cnpj: "58.341.766/0001-10",
      cep: "29.166-024",
      uf: "ES",
      cidade: "SERRA",
      bairro: "BARCELONA",
      logradouro: "R ARCO VERDE",
      numero: "78",
      telefones: ["(27) 9707-0063"],
    });
  });
});

describe("ocrCrlv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("mapeia aliases atuais do CRLV para os campos do formulario", async () => {
    stubFileReader();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 200,
            data: [
              {
                campos: {
                  placa: { valor: "OYF6J36" },
                  marca_modelo_versao: { valor: "VOLVO/FH 460 6X2T" },
                  especie_tipo: { valor: "CAVALO MECANICO" },
                  carroceria: { valor: "NAO APLICAVEL" },
                  nome: { valor: "J. MELGACO TRANSPORTES E SERVICOS LTDA" },
                  ano_fabricacao: { valor: "2014" },
                  ano_modelo: { valor: "2014" },
                  cor_predominante: { valor: "BRANCA" },
                  local: { valor: "SERRA / ES" },
                  renavam: { valor: "01009898652" },
                  chassi: { valor: "9BVAG20C0EE818874" },
                  numero_eixos: { valor: "3" },
                  numero_antt: { valor: "12345678" },
                  data: { valor: "09/09/2025" },
                  exercicio: { valor: "2025" },
                  data_assinatura: { valor: "23/03/2026" },
                  cnpj: { valor: "58.341.766/0001-10" },
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      ),
    );

    const result = await ocrCrlv(new File(["fake"], "crlv.png", { type: "image/png" }));

    expect(result).toEqual({
      veiculo: {
        placa: "OYF6J36",
        tipo: "CAVALO MECANICO",
        carroceria: "NAO APLICAVEL",
        proprietario: "J. MELGACO TRANSPORTES E SERVICOS LTDA",
        marca: "VOLVO",
        modelo: "FH 460 6X2T",
        ano_fabricacao: "2014",
        ano_modelo: "2014",
        cor: "BRANCA",
        uf_emplacamento: "ES",
        cidade_emplacamento: "SERRA",
        renavam: "01009898652",
        chassi: "9BVAG20C0EE818874",
        eixos: "3",
        antt: "12345678",
        ultimo_licenciamento: "23/03/2026",
      },
      proprietario: {
        documento: "58341766000110",
        tipo: "PJ",
        nome: "J. MELGACO TRANSPORTES E SERVICOS LTDA",
      },
    });
  });
});
