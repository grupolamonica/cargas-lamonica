import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../infrastructure/cadastro-bots/angellira-bot-client.js", () => ({
  AngelliraBotError: class extends Error {
    constructor({ code, message, etapa, acao, httpStatus, raw }) {
      super(message);
      this.code = code;
      this.etapa = etapa ?? null;
      this.acao = acao ?? null;
      this.httpStatus = httpStatus ?? null;
      this.raw = raw ?? null;
    }
    toJSON() {
      return { code: this.code, message: this.message, etapa: this.etapa, acao: this.acao };
    }
  },
  cadastrarMotorista: vi.fn(),
  cadastrarProprietario: vi.fn(),
  cadastrarVeiculo: vi.fn(),
}));

vi.mock("../../../../infrastructure/security-audit.js", () => ({
  insertSecurityAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../../infrastructure/security-log.js", () => ({
  logStructuredEvent: vi.fn(),
}));

import {
  cadastrarMotorista,
  cadastrarProprietario,
  cadastrarVeiculo,
} from "../../../../infrastructure/cadastro-bots/angellira-bot-client.js";
import { runAngelliraPipeline } from "./dispatch-pipeline.js";

function makeFakeClient() {
  // Cliente PG fake — armazena os jobs em memória + driver_profiles
  const jobs = new Map();
  let driverProfile = null;

  const client = {
    query: vi.fn(async (sql, params = []) => {
      const sqlNorm = sql.replace(/\s+/g, " ").trim();

      // SELECT existing OK job — params: [cadastroId, target, step]
      if (/SELECT id, status, external_id, response, finished_at FROM public.external_registration_jobs/.test(sqlNorm)) {
        const [cadastroId, , step] = params;
        const found = [...jobs.values()].find(
          (j) => j.cadastro_id === cadastroId && j.step === step && j.status === "OK",
        );
        return { rows: found ? [found] : [] };
      }

      // SELECT FOR UPDATE pending/error — params: [cadastroId, target, step]
      if (/SELECT id FROM public.external_registration_jobs WHERE cadastro_id = \$1 AND target = \$2 AND step = \$3 AND status IN \('PENDING', 'ERROR'\) ORDER BY created_at DESC LIMIT 1 FOR UPDATE/.test(sqlNorm)) {
        const [cadastroId, , step] = params;
        const found = [...jobs.values()].find(
          (j) => j.cadastro_id === cadastroId && j.step === step && ["PENDING", "ERROR"].includes(j.status),
        );
        return { rows: found ? [{ id: found.id }] : [] };
      }

      // UPDATE in_progress
      if (/UPDATE public.external_registration_jobs SET status = 'IN_PROGRESS'/.test(sqlNorm)) {
        const [payload, jobId] = params;
        const job = jobs.get(jobId);
        if (job) { job.status = "IN_PROGRESS"; job.attempts += 1; job.payload = payload; }
        return { rows: [] };
      }

      // INSERT IN_PROGRESS (sem PENDING prévio) — params: [cadastroId, target, step, payload]
      if (/INSERT INTO public.external_registration_jobs \(cadastro_id, target, step, status, payload, attempts, started_at\)/.test(sqlNorm)) {
        const [cadastroId, , step, payload] = params;
        const id = `job-${jobs.size + 1}`;
        const row = { id, cadastro_id: cadastroId, step, status: "IN_PROGRESS", payload, attempts: 1 };
        jobs.set(id, row);
        return { rows: [{ id }] };
      }

      // INSERT pending
      if (/INSERT INTO public.external_registration_jobs \(cadastro_id, driver_user_id, target, step, status, created_by\)/.test(sqlNorm)) {
        const [cadastroId, driverUserId, step] = params;
        const id = `job-${jobs.size + 1}`;
        const row = { id, cadastro_id: cadastroId, driver_user_id: driverUserId, step, status: "PENDING", attempts: 0 };
        jobs.set(id, row);
        return { rows: [{ id, step, status: "PENDING" }] };
      }

      // UPDATE OK
      if (/UPDATE public.external_registration_jobs SET status = 'OK'/.test(sqlNorm)) {
        const [response, externalId, jobId] = params;
        const job = jobs.get(jobId);
        if (job) { job.status = "OK"; job.response = response; job.external_id = externalId; }
        return { rows: [] };
      }

      // UPDATE ERROR
      if (/UPDATE public.external_registration_jobs SET status = 'ERROR'/.test(sqlNorm)) {
        const [error, jobId] = params;
        const job = jobs.get(jobId);
        if (job) { job.status = "ERROR"; job.error = error; }
        return { rows: [] };
      }

      // UPDATE driver_profiles
      if (/UPDATE public.driver_profiles SET angellira_registration_status/.test(sqlNorm)) {
        driverProfile = { params };
        return { rows: [] };
      }

      return { rows: [] };
    }),
    _getJobs: () => [...jobs.values()],
    _getDriverProfile: () => driverProfile,
  };
  return client;
}

const SAMPLE_DADOS = {
  motorista: {
    nome: "João da Silva",
    cpf: "12345678909",
    telefones: ["85999999999"],
    telefone_primario: "85999999999",
    rg: "1234567",
    rg_uf: "CE",
    nascimento: "1990-01-15",
    mae: "Maria da Silva",
  },
  cnh: {
    numero: "12345678901",
    categoria: "AB",
    validade: "2030-01-01",
    primeira_cnh: "2010-01-01",
    registro: "12345678901",
  },
  endereco: {
    cep: "60150160",
    logradouro: "Rua das Palmeiras",
    numero: "100",
    bairro: "Aldeota",
    cidade: "Fortaleza",
    uf: "CE",
  },
  cavalo: {
    placa: "ABC1234",
    owner_doc: "12345678000199",
    owner_doc_type: "cnpj",
    renavam: "12345678901",
    chassi: "9BWZZZ377VT004251",
    marca_modelo: "VOLKSWAGEN/CONSTELLATION",
    ano_fab: 2020,
    cor: "BRANCO",
    carroceria: "ABERTA",
  },
  cavalo_owner: {
    doc: "12345678000199",
    razao_social: "TRANSPORTES LTDA",
    telefone: "8533334444",
    endereco: { cep: "60150160", cidade: "Fortaleza", uf: "CE" },
  },
};

const SAMPLE_CADASTRO = {
  id: "11111111-1111-1111-1111-111111111111",
  dados: SAMPLE_DADOS,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAngelliraPipeline / happy path", () => {
  it("cadastra proprietario_cavalo → motorista → cavalo quando só cavalo presente", async () => {
    cadastrarProprietario.mockResolvedValue({ ok: true, ownerId: 9001, raw: {} });
    cadastrarVeiculo.mockResolvedValue({ ok: true, vehicleId: 7001, raw: {} });
    cadastrarMotorista.mockResolvedValue({ ok: true, driverId: 5001, raw: {} });

    const client = makeFakeClient();
    const result = await runAngelliraPipeline({
      client,
      cadastro: SAMPLE_CADASTRO,
      driverUserId: "22222222-2222-2222-2222-222222222222",
      operatorId: "33333333-3333-3333-3333-333333333333",
    });

    expect(result.ok).toBe(true);
    const steps = result.results.map((r) => r.step);
    // Ordem de cadastro (DC reorder): proprietários + motorista PRIMEIRO,
    // veículos POR ÚLTIMO (cadastro de veículo depende de owner + driver).
    expect(steps).toEqual(["proprietario_cavalo", "motorista", "cavalo"]);

    // Bot client invocado exatamente uma vez por etapa
    expect(cadastrarProprietario).toHaveBeenCalledOnce();
    expect(cadastrarVeiculo).toHaveBeenCalledOnce();
    expect(cadastrarMotorista).toHaveBeenCalledOnce();

    // driver_profiles atualizado com status OK
    const dp = client._getDriverProfile();
    expect(dp).toBeTruthy();
    expect(dp.params[0]).toBe("OK"); // angellira_registration_status
    expect(dp.params[1]).toBe("5001"); // angellira_driver_id
    expect(dp.params[2]).toBe("9001"); // angellira_owner_id
  });
});

describe("runAngelliraPipeline / proprietário do cavalo lê dados.cavalo_owner (DC — caso LEANDRO)", () => {
  it("dono PF terceiro: usa nome/nascimento/rg de dados.cavalo_owner, não o embutido vazio", async () => {
    cadastrarProprietario.mockResolvedValue({ ok: true, ownerId: 9001, raw: {} });
    cadastrarVeiculo.mockResolvedValue({ ok: true, vehicleId: 7001, raw: {} });
    cadastrarMotorista.mockResolvedValue({ ok: true, driverId: 5001, raw: {} });

    const dados = {
      ...SAMPLE_DADOS,
      // cavalo traz só o DOC embutido do dono (owner_doc), SEM owner_nome —
      // como o wizard v2 grava (o dono rico vai em dados.cavalo_owner).
      cavalo: { ...SAMPLE_DADOS.cavalo, owner_doc: "77231457304", owner_doc_type: "cpf" },
      cavalo_owner: {
        tipo: "pf",
        doc: "77231457304",
        nome: "MARIA ROSINETE CHAVES MAIA",
        data_nascimento: "10/05/1980",
        rg: "20150379123",
        rg_orgao: "SSPDS",
        rg_uf: "CE",
        nome_mae: "MARIA CHAVES DO MONTE",
        endereco: { cep: "62961136", logradouro: "Av X", numero: "3900", cidade: "Tabuleiro do Norte", uf: "CE" },
      },
    };

    const client = makeFakeClient();
    await runAngelliraPipeline({
      client,
      cadastro: { id: SAMPLE_CADASTRO.id, dados },
      driverUserId: "22222222-2222-2222-2222-222222222222",
      operatorId: "33333333-3333-3333-3333-333333333333",
    });

    const arg = cadastrarProprietario.mock.calls[0][0];
    expect(arg.tipo).toBe("PF");
    expect(arg.payload.cpf).toBe("77231457304");
    expect(arg.payload.nome).toBe("MARIA ROSINETE CHAVES MAIA"); // <- do cavalo_owner, não ""
    expect(arg.payload.data_nascimento).toBe("10/05/1980"); // birth presente (evita 422 "birth is required")
  });
});

describe("runAngelliraPipeline / falha intermediária", () => {
  it("registra ERROR em cavalo mas tenta motorista mesmo assim", async () => {
    cadastrarProprietario.mockResolvedValue({ ok: true, ownerId: 9001, raw: {} });
    cadastrarVeiculo.mockRejectedValueOnce(
      Object.assign(new Error("FEDERAL TRANSPORTES já cadastrado"), {
        code: "OWNER_NAO_CADASTRADO",
        etapa: "owner_nao_cadastrado",
        toJSON() { return { code: this.code, etapa: this.etapa, message: this.message }; },
      }),
    );
    cadastrarMotorista.mockResolvedValue({ ok: true, driverId: 5001, raw: {} });

    const client = makeFakeClient();
    const result = await runAngelliraPipeline({
      client,
      cadastro: SAMPLE_CADASTRO,
    });

    expect(result.ok).toBe(false);
    const cavaloResult = result.results.find((r) => r.step === "cavalo");
    const motoristaResult = result.results.find((r) => r.step === "motorista");
    expect(cavaloResult.ok).toBe(false);
    expect(motoristaResult.ok).toBe(true);
  });
});

describe("runAngelliraPipeline / idempotência", () => {
  it("pula step já OK", async () => {
    const client = makeFakeClient();
    // Pré-popula um job OK pra proprietario_cavalo
    await client.query(
      `INSERT INTO public.external_registration_jobs (cadastro_id, driver_user_id, target, step, status, created_by) VALUES ($1,$2,'angellira',$3,'PENDING',$4) RETURNING id, step, status`,
      [SAMPLE_CADASTRO.id, null, "proprietario_cavalo", null],
    );
    const job = client._getJobs()[0];
    job.status = "OK";
    job.external_id = "9001";

    cadastrarProprietario.mockResolvedValue({ ok: true, ownerId: 9999, raw: {} });
    cadastrarVeiculo.mockResolvedValue({ ok: true, vehicleId: 7001, raw: {} });
    cadastrarMotorista.mockResolvedValue({ ok: true, driverId: 5001, raw: {} });

    const result = await runAngelliraPipeline({ client, cadastro: SAMPLE_CADASTRO });
    expect(result.ok).toBe(true);

    // proprietario_cavalo não deve ter sido invocado de novo
    expect(cadastrarProprietario).not.toHaveBeenCalled();
    expect(cadastrarVeiculo).toHaveBeenCalledOnce();
    expect(cadastrarMotorista).toHaveBeenCalledOnce();

    // status no result vem como OK_CACHED
    const propResult = result.results.find((r) => r.step === "proprietario_cavalo");
    expect(propResult.status).toBe("OK_CACHED");
  });
});

describe("runAngelliraPipeline / RNTRC do owner → antt do veículo (DC-128)", () => {
  it("injeta o rntrc do cavalo_owner no payload.antt do cavalo quando o veículo não tem antt próprio", async () => {
    cadastrarProprietario.mockResolvedValue({ ok: true, ownerId: 9001, raw: {} });
    cadastrarVeiculo.mockResolvedValue({ ok: true, vehicleId: 7001, raw: {} });
    cadastrarMotorista.mockResolvedValue({ ok: true, driverId: 5001, raw: {} });

    const client = makeFakeClient();
    const dadosComRntrc = {
      ...SAMPLE_DADOS,
      cavalo: { ...SAMPLE_DADOS.cavalo, antt: undefined },
      cavalo_owner: { ...SAMPLE_DADOS.cavalo_owner, rntrc: "057.984.877" },
    };
    await runAngelliraPipeline({
      client,
      cadastro: { ...SAMPLE_CADASTRO, dados: dadosComRntrc },
    });

    expect(cadastrarVeiculo).toHaveBeenCalledOnce();
    const arg = cadastrarVeiculo.mock.calls[0][0];
    expect(arg.sub).toBe("cavalo");
    expect(arg.payload.antt).toBe("057984877"); // só-dígitos, vindo do owner
  });
});

describe("runAngelliraPipeline / onlySteps", () => {
  it("executa apenas o step pedido", async () => {
    cadastrarMotorista.mockResolvedValue({ ok: true, driverId: 5001, raw: {} });
    const client = makeFakeClient();
    const result = await runAngelliraPipeline({
      client,
      cadastro: SAMPLE_CADASTRO,
      onlySteps: ["motorista"],
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].step).toBe("motorista");
    expect(cadastrarProprietario).not.toHaveBeenCalled();
    expect(cadastrarVeiculo).not.toHaveBeenCalled();
  });
});
