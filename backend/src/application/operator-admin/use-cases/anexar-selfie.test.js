import { describe, expect, it, vi } from "vitest";

import { anexarSelfieToCadastro } from "./anexar-selfie.js";

const CPF = "11144477735";

// client fake: registra as queries; SELECT devolve a row dada, UPDATE só registra.
function makeClient(selectRows) {
  const calls = [];
  const client = {
    calls,
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (/^SELECT/i.test(sql.trim())) return { rows: selectRows };
      return { rows: [] };
    }),
  };
  return client;
}

function baseArgs(overrides = {}) {
  return {
    id: "cad-1",
    file: Buffer.from("%PDF-1.4 fake selfie"),
    size: 1234,
    contentType: "image/jpeg",
    originalFilename: "selfie.jpg",
    correlationId: "corr-1",
    requestIp: "1.2.3.4",
    operatorId: "op-1",
    auditFn: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("anexarSelfieToCadastro", () => {
  it("sobe a selfie e grava dados.motorista.selfie_cnh_url", async () => {
    const client = makeClient([
      { id: "cad-1", status: "aprovado", carga_id: "carga-9", dados: { motorista: { cpf: CPF, nome: "JOSE" } } },
    ]);
    const uploadFn = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: { storage_path: `${CPF}/carga-9/motorista_selfie_cnh_123.jpg` },
    });

    const res = await anexarSelfieToCadastro(
      baseArgs({ runWithClient: (fn) => fn(client), uploadFn }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.payload.selfie_cnh_url).toBe(`${CPF}/carga-9/motorista_selfie_cnh_123.jpg`);

    // Upload escopado por CPF+carga do cadastro (nunca do cliente) e no slot certo.
    expect(uploadFn).toHaveBeenCalledWith(
      expect.objectContaining({ ownerKey: CPF, cargaId: "carga-9", slot: "motorista_selfie_cnh" }),
    );

    // UPDATE gravou o selfie_cnh_url preservando o resto do motorista.
    const update = client.calls.find((c) => /^UPDATE/i.test(c.sql.trim()));
    expect(update).toBeTruthy();
    const dadosGravado = JSON.parse(update.params[0]);
    expect(dadosGravado.motorista.selfie_cnh_url).toBe(`${CPF}/carga-9/motorista_selfie_cnh_123.jpg`);
    expect(dadosGravado.motorista.nome).toBe("JOSE"); // preserva
  });

  it("cai pra carga_id = id quando a row não tem carga_id", async () => {
    const client = makeClient([
      { id: "cad-1", status: "pendente", carga_id: null, dados: { motorista: { cpf: CPF } } },
    ]);
    const uploadFn = vi.fn().mockResolvedValue({ statusCode: 200, payload: { storage_path: "p" } });
    await anexarSelfieToCadastro(baseArgs({ runWithClient: (fn) => fn(client), uploadFn }));
    expect(uploadFn).toHaveBeenCalledWith(expect.objectContaining({ cargaId: "cad-1" }));
  });

  it("404 quando o cadastro não existe", async () => {
    const client = makeClient([]);
    const uploadFn = vi.fn();
    const res = await anexarSelfieToCadastro(baseArgs({ runWithClient: (fn) => fn(client), uploadFn }));
    expect(res.statusCode).toBe(404);
    expect(uploadFn).not.toHaveBeenCalled();
  });

  it("409 quando o cadastro não tem CPF de motorista válido", async () => {
    const client = makeClient([{ id: "cad-1", status: "pendente", carga_id: "c", dados: { motorista: { cpf: "123" } } }]);
    const uploadFn = vi.fn();
    const res = await anexarSelfieToCadastro(baseArgs({ runWithClient: (fn) => fn(client), uploadFn }));
    expect(res.statusCode).toBe(409);
    expect(uploadFn).not.toHaveBeenCalled();
  });

  it("propaga erro do upload (ex.: 502) sem tocar no cadastro", async () => {
    const client = makeClient([{ id: "cad-1", status: "pendente", carga_id: "c", dados: { motorista: { cpf: CPF } } }]);
    const uploadFn = vi.fn().mockResolvedValue({ statusCode: 502, payload: { error: "STORAGE_UNAVAILABLE" } });
    const res = await anexarSelfieToCadastro(baseArgs({ runWithClient: (fn) => fn(client), uploadFn }));
    expect(res.statusCode).toBe(502);
    const update = client.calls.find((c) => /^UPDATE/i.test(c.sql.trim()));
    expect(update).toBeUndefined(); // não persistiu
  });

  it("400 quando falta o arquivo", async () => {
    const client = makeClient([]);
    const res = await anexarSelfieToCadastro(baseArgs({ file: undefined, runWithClient: (fn) => fn(client), uploadFn: vi.fn() }));
    expect(res.statusCode).toBe(400);
  });
});
