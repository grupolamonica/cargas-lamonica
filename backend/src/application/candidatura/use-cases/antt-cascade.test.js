import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Testes unitarios da cascata ANTT (plan 07-04).
 *
 * Estrategia: mock global do fetch para simular respostas do sidecar FastAPI
 * (POST /api/consulta/antt-veiculo). O sidecar Python ja implementa a cascade
 * dos 5 produtos; nosso use case interpreta o resultado e mapeia para o shape
 * esperado pelo submit-final + audit log.
 *
 * Cenarios cobertos:
 *   (a) cpf hit no produto 1 → return imediato com source = antt/transportador
 *   (b) cpf miss + cnpj hit no produto 2 — sidecar ja short-circuita; aqui
 *       validamos que o cliente Node consome o resultado certo
 *   (c) todos falham (code 612) → requiresUpload = true
 *   (d) timeout/erro de rede → requiresUpload = true (cascade tratada como falha total)
 *   (e) NOVO (W-05 — proxy): schema submit strip-a chaves __ — validacao em candidatura-schemas.test (cobertura indireta neste arquivo nao se aplica, mas garantimos shape correto)
 */

const fetchMock = vi.fn();

// Antes de importar o use case, mock global do fetch.
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

const { resolveAnttCascade } = await import("./antt-cascade.js");

function mockSidecarOk({ produto, dataItem, tentativas }) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    async json() {
      return {
        code: 200,
        data: [dataItem],
        _produto_usado: produto,
        tentativas: tentativas || [{ produto, code: 200 }],
      };
    },
    async text() {
      return "";
    },
  });
}

function mockSidecarMiss({ tentativas }) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    async json() {
      return {
        code: 612,
        code_message: "RNTRC nao localizado em nenhum produto.",
        data: [],
        tentativas: tentativas || [],
      };
    },
    async text() {
      return "";
    },
  });
}

function mockSidecarNetworkError(message) {
  fetchMock.mockRejectedValueOnce(new Error(message || "ECONNREFUSED"));
}

describe("resolveAnttCascade — cascata ANTT via sidecar FastAPI", () => {
  it("(a) cpf hit no produto 1 (antt/transportador) → retorno imediato + source", async () => {
    mockSidecarOk({
      produto: "antt/transportador",
      dataItem: {
        rntrc: "12345678",
        tipo: "TAC",
        situacao: "ATIVO",
        validade: "2027-12-31",
      },
      tentativas: [{ produto: "antt/transportador", code: 200 }],
    });

    const result = await resolveAnttCascade({
      docType: "cpf",
      doc: "111.222.333-44",
      placa: "ABC1D23",
      correlationId: "corr-a",
    });

    expect(result.rntrc).toBe("12345678");
    expect(result.tipo).toBe("TAC");
    expect(result.situacao).toBe("ATIVO");
    expect(result.validade).toBe("2027-12-31");
    expect(result.source).toBe("antt-cascade-antt/transportador");
    expect(result.requiresUpload).toBeUndefined();
    expect(result.attempts).toHaveLength(1);

    // Sidecar foi chamado uma vez com placa normalizada (sem hifen, uppercase) e cpf so digitos.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/consulta\/antt-veiculo$/);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.placa).toBe("ABC1D23");
    expect(body.cpf).toBe("11122233344");
    expect(body.cnpj).toBeUndefined();
  });

  it("(b) cnpj hit no produto 2 (antt/transportador via cnpj) — short-circuit ja feito no sidecar", async () => {
    mockSidecarOk({
      produto: "antt/transportador",
      dataItem: { rntrc: "87654321", tipo: "ETC" },
      tentativas: [
        { produto: "antt/transportador", code: 612 }, // cpf miss
        { produto: "antt/transportador", code: 200 }, // cnpj hit
      ],
    });

    const result = await resolveAnttCascade({
      docType: "cnpj",
      doc: "12.345.678/0001-99",
      placa: "XYZ9F87",
      correlationId: "corr-b",
    });

    expect(result.rntrc).toBe("87654321");
    expect(result.tipo).toBe("ETC");
    expect(result.attempts).toHaveLength(2);
    expect(result.source).toBe("antt-cascade-antt/transportador");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.cnpj).toBe("12345678000199");
  });

  it("(c) todos os produtos falham (code 612) → requiresUpload=true e rntrc=null", async () => {
    mockSidecarMiss({
      tentativas: [
        { produto: "antt/transportador", code: 612 },
        { produto: "antt/veiculo", code: 612 },
        { produto: "antt/registro-rntrc", code: 612 },
        { produto: "antt/consulta-rntrc", code: 612 },
      ],
    });

    const result = await resolveAnttCascade({
      docType: "cpf",
      doc: "99988877766",
      placa: "DEF4321",
      correlationId: "corr-c",
    });

    expect(result.rntrc).toBeNull();
    expect(result.requiresUpload).toBe(true);
    expect(result.source).toBeNull();
    expect(result.attempts).toHaveLength(4);
  });

  it("(d) timeout / erro de rede → cascade tratada como falha (requiresUpload=true) sem propagar exception", async () => {
    mockSidecarNetworkError("ETIMEDOUT");

    const result = await resolveAnttCascade({
      docType: "cpf",
      doc: "11122233344",
      placa: "GHI5678",
      correlationId: "corr-d",
    });

    expect(result.rntrc).toBeNull();
    expect(result.requiresUpload).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].produto).toBe("antt-cascade-network");
    expect(result.attempts[0].erro).toContain("ETIMEDOUT");
  });

  it("(e) placa invalida → throw imediato (sem chamar sidecar)", async () => {
    await expect(
      resolveAnttCascade({
        docType: "cpf",
        doc: "11122233344",
        placa: "ABC",
        correlationId: "corr-e",
      }),
    ).rejects.toThrow(/Placa invalida/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
