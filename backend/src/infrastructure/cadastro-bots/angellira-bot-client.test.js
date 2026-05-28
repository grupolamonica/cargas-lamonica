import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AngelliraBotError,
  __resetCircuitForTests,
  cadastrarMotorista,
  cadastrarProprietario,
  cadastrarVeiculo,
  checkOwner,
  health,
} from "./angellira-bot-client.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.ANGELLIRA_BOT_URL = "http://angelira-bot:8765";
  process.env.ANGELLIRA_BOT_TIMEOUT_MS = "5000";
  process.env.ANGELLIRA_BOT_CIRCUIT_THRESHOLD = "3";
  process.env.ANGELLIRA_BOT_CIRCUIT_COOLDOWN_MS = "60000";
  __resetCircuitForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = originalEnv;
});

function mockFetchOnce(httpStatus, body) {
  const response = new Response(
    body == null ? null : (typeof body === "string" ? body : JSON.stringify(body)),
    { status: httpStatus, headers: { "Content-Type": "application/json" } },
  );
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
}

function mockFetchSequence(...responses) {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const r of responses) {
    const body = r.body == null ? null : (typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    spy.mockResolvedValueOnce(new Response(body, {
      status: r.httpStatus,
      headers: { "Content-Type": "application/json" },
    }));
  }
  return spy;
}

describe("angellira-bot-client / health", () => {
  it("retorna ok:true quando sidecar responde 200", async () => {
    mockFetchOnce(200, { ok: true, service: "angelira-robo" });
    const result = await health();
    expect(result.ok).toBe(true);
    expect(result.httpStatus).toBe(200);
  });

  it("retorna ok:false quando sidecar offline (connection refused)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await health();
    expect(result.ok).toBe(false);
    expect(result.httpStatus).toBe(0);
  });
});

describe("angellira-bot-client / cadastrarMotorista", () => {
  it("retorna driverId quando sidecar devolve ok:true", async () => {
    mockFetchOnce(200, { ok: true, driverId: "12345", queryId: "99" });
    const result = await cadastrarMotorista({
      idCadastro: "abc",
      payload: { motorista: { nome: "JOAO", cpf: "12345678909" } },
    });
    expect(result.ok).toBe(true);
    expect(result.driverId).toBe("12345");
  });

  it("inclui Idempotency-Key no header", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, driverId: "1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await cadastrarMotorista({
      idCadastro: "abc-uuid",
      payload: { motorista: { nome: "X", cpf: "12345678909" } },
    });
    const [, init] = spy.mock.calls[0];
    expect(init.headers["Idempotency-Key"]).toBe("abc-uuid:motorista");
  });

  it("lança BOT_INDISPONIVEL em 503", async () => {
    mockFetchSequence(
      { httpStatus: 503, body: { detail: "AngelLira indisponivel: creds ausentes" } },
      { httpStatus: 503, body: { detail: "AngelLira indisponivel: creds ausentes" } },
    );
    await expect(cadastrarMotorista({
      idCadastro: "x",
      payload: { motorista: { nome: "Y", cpf: "123" } },
    })).rejects.toMatchObject({
      code: "BOT_INDISPONIVEL",
      httpStatus: 503,
    });
  });
});

describe("angellira-bot-client / cadastrarVeiculo", () => {
  it("lança OWNER_NAO_CADASTRADO em 422 com etapa correta", async () => {
    mockFetchOnce(422, {
      detail: {
        etapa: "owner_nao_cadastrado",
        erro: "Proprietario com documento '12345678000199' nao foi encontrado",
        causa: "proprietario_nao_existe_no_angellira",
        owner_documento_buscado: "12345678000199",
        sub: "cavalo",
      },
    });
    await expect(cadastrarVeiculo({
      idCadastro: "x",
      sub: "cavalo",
      payload: { placa: "ABC1234" },
      ownerCnpj: "12345678000199",
    })).rejects.toMatchObject({
      code: "OWNER_NAO_CADASTRADO",
      etapa: "owner_nao_cadastrado",
      acao: expect.stringContaining("Cadastre o proprietário"),
    });
  });

  it("lança OWNER_NAO_INFORMADO em 400 com etapa correta", async () => {
    mockFetchOnce(400, {
      detail: {
        etapa: "owner_nao_informado",
        erro: "Veiculo exige proprietario: informe owner_cpf, owner_cnpj ou owner_id.",
      },
    });
    await expect(cadastrarVeiculo({
      idCadastro: "x",
      sub: "cavalo",
      payload: { placa: "ABC1234" },
    })).rejects.toMatchObject({
      code: "OWNER_NAO_INFORMADO",
      httpStatus: 400,
    });
  });
});

describe("angellira-bot-client / circuit breaker", () => {
  it("não retenta em 4xx (erro do payload)", async () => {
    const spy = mockFetchSequence({ httpStatus: 422, body: { detail: { etapa: "owner_nao_cadastrado" } } });
    await expect(cadastrarVeiculo({
      idCadastro: "x",
      sub: "cavalo",
      payload: { placa: "ABC1234" },
      ownerCnpj: "1",
    })).rejects.toBeInstanceOf(AngelliraBotError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("retenta 1x em 5xx", async () => {
    const spy = mockFetchSequence(
      { httpStatus: 502, body: { detail: { etapa: "x", erro: "downstream" } } },
      { httpStatus: 200, body: { ok: true, ownerId: 1 } },
    );
    const result = await cadastrarProprietario({
      idCadastro: "x",
      tipo: "PF",
      payload: { cpf: "12345678909" },
    });
    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("abre o circuito após threshold de falhas", async () => {
    process.env.ANGELLIRA_BOT_CIRCUIT_THRESHOLD = "2";
    // Cada cadastrarProprietario faz 2 chamadas (original + retry em 5xx) e
    // ambas falham -> conta como 1 falha no circuit (apenas o resultado final).
    // Precisamos de 2 chamadas dessa pra abrir.
    mockFetchSequence(
      { httpStatus: 502, body: { detail: { erro: "x" } } },
      { httpStatus: 502, body: { detail: { erro: "x" } } },
      { httpStatus: 502, body: { detail: { erro: "x" } } },
      { httpStatus: 502, body: { detail: { erro: "x" } } },
    );
    await expect(cadastrarProprietario({ idCadastro: "1", tipo: "PF", payload: { cpf: "1" } }))
      .rejects.toBeInstanceOf(AngelliraBotError);
    await expect(cadastrarProprietario({ idCadastro: "2", tipo: "PF", payload: { cpf: "2" } }))
      .rejects.toBeInstanceOf(AngelliraBotError);

    // Próxima chamada já deve falhar com BOT_CIRCUIT_OPEN sem fazer fetch
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockClear();
    await expect(cadastrarProprietario({ idCadastro: "3", tipo: "PF", payload: { cpf: "3" } }))
      .rejects.toMatchObject({ code: "BOT_CIRCUIT_OPEN" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("angellira-bot-client / checkOwner", () => {
  it("retorna body bruto em 200", async () => {
    mockFetchOnce(200, {
      ok: true,
      veiculo_existe: true,
      vehicle_id: 12345,
      divergencia: true,
      motivo: "Veiculo ja cadastrado com PJ 'FEDERAL'",
    });
    const result = await checkOwner({
      placa: "HFD4F53",
      expectedCpf: "11122233344",
      expectedTipo: "PF",
    });
    expect(result.divergencia).toBe(true);
    expect(result.motivo).toContain("FEDERAL");
  });
});
