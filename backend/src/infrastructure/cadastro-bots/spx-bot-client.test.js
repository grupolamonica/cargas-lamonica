import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SpxBotError,
  __resetCircuitForTests,
  cadastrarMotorista,
  importarMatched,
  lookupMotorista,
  status,
} from "./spx-bot-client.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.SPX_BOT_URL = "http://spx-bot:8766";
  process.env.SPX_BOT_TIMEOUT_MS = "5000";
  process.env.SPX_BOT_CIRCUIT_THRESHOLD = "3";
  __resetCircuitForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = originalEnv;
});

function mockFetchOnce(httpStatus, body) {
  const response = new Response(
    body == null ? null : JSON.stringify(body),
    { status: httpStatus, headers: { "Content-Type": "application/json" } },
  );
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
}

/** Mock que retorna o mesmo body em 5xx — cliente retenta 1x, então precisamos
 * 2 respostas idênticas pro retry consumir antes de cair no erro final. */
function mockFetchTwice(httpStatus, body) {
  const make = () => new Response(
    body == null ? null : JSON.stringify(body),
    { status: httpStatus, headers: { "Content-Type": "application/json" } },
  );
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockResolvedValueOnce(make());
  spy.mockResolvedValueOnce(make());
}

describe("spx-bot-client / status", () => {
  it("retorna ok:true quando sidecar responde 200", async () => {
    mockFetchOnce(200, { ok: true, service: "spx-bot", supabase: true });
    const r = await status();
    expect(r.ok).toBe(true);
    expect(r.body.supabase).toBe(true);
  });
  it("retorna ok:false em ECONNREFUSED", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const r = await status();
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(0);
  });
});

describe("spx-bot-client / lookupMotorista", () => {
  it("retorna encontrado:true + driver_info quando is_matched", async () => {
    mockFetchOnce(200, {
      ok: true, encontrado: true, is_matched: true,
      driver_info: { driver_id: 5001 },
      na_minha_agencia: false,
    });
    const r = await lookupMotorista({ cpf: "53018634870" });
    expect(r.encontrado).toBe(true);
    expect(r.is_matched).toBe(true);
    expect(r.driver_info.driver_id).toBe(5001);
  });
  it("retorna encontrado:false quando CPF não existe", async () => {
    mockFetchOnce(200, { ok: true, encontrado: false, is_matched: false });
    const r = await lookupMotorista({ cpf: "00000000000" });
    expect(r.encontrado).toBe(false);
  });
});

describe("spx-bot-client / cadastrarMotorista — error mapping", () => {
  it("REQUEST_IN_PROGRESS (271605028) → erro estruturado", async () => {
    // 502 = 5xx → cliente retenta 1x; precisamos 2 respostas no mock
    mockFetchTwice(502, {
      detail: {
        etapa: "request_pendente",
        retcode: 271605028,
        existing_request_id: 322675,
        erro: "Ja existe solicitacao aberta",
      },
    });
    await expect(cadastrarMotorista({
      payload: { cpf: "53018634870", driver_name: "GILSON" },
    })).rejects.toMatchObject({
      code: "SPX_REQUEST_IN_PROGRESS",
      retcode: 271605028,
    });
  });

  it("DRIVER_REPEAT (271627140) → erro estruturado", async () => {
    mockFetchTwice(502, {
      detail: { retcode: 271627140, erro: "CPF ja cadastrado" },
    });
    await expect(cadastrarMotorista({
      payload: { cpf: "53018634870", driver_name: "GILSON" },
    })).rejects.toMatchObject({
      code: "SPX_DRIVER_REPEAT",
      retcode: 271627140,
    });
  });

  it("Sessão expirada (401) → SPX_SESSAO_EXPIRADA", async () => {
    // 401 não retenta (4xx)
    mockFetchOnce(401, { detail: "Sessao expirada: cookies invalidos" });
    await expect(cadastrarMotorista({
      payload: { cpf: "53018634870", driver_name: "GILSON" },
    })).rejects.toMatchObject({
      code: "SPX_SESSAO_EXPIRADA",
      httpStatus: 401,
    });
  });
});

describe("spx-bot-client / importarMatched — cnh_remarks fallback", () => {
  function bodyOfLastFetch(spy) {
    return JSON.parse(spy.mock.calls.at(-1)[1].body);
  }

  it("envia cnh_remarks quando o cadastro tem EAR (perfil importado sem remarks)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockResolvedValueOnce(new Response(
      JSON.stringify({ ok: true, request_id: 999 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const r = await importarMatched({
      cpf: "04641182396",
      driverInfo: { driver_id: 5001, driver_name: "LEANDRO", license_number: "123" },
      cnhRemarks: ["EAR"],
      idempotencyKey: "cad-1:spx_motorista",
    });
    expect(r.ok).toBe(true);
    expect(bodyOfLastFetch(spy).cnh_remarks).toEqual(["EAR"]);
  });

  it("manda cnh_remarks:null quando o cadastro não tem observação (sem sobrescrever locked)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockResolvedValueOnce(new Response(
      JSON.stringify({ ok: true, request_id: 1000 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    await importarMatched({
      cpf: "04641182396",
      driverInfo: { driver_id: 5001, driver_name: "LEANDRO", license_number: "123" },
      cnhRemarks: [],
      idempotencyKey: "cad-2:spx_motorista",
    });
    expect(bodyOfLastFetch(spy).cnh_remarks).toBeNull();
  });
});
