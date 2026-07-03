import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storageMock = {
  upload: vi.fn(),
  createSignedUrl: vi.fn(),
};

vi.mock("../../../../infrastructure/cadastro-bots/unificada-bot-client.js", () => ({
  UnificadaBotError: class extends Error {
    constructor({ code, message, httpStatus, acao, raw }) {
      super(message);
      this.code = code;
      this.httpStatus = httpStatus ?? null;
      this.acao = acao ?? null;
      this.raw = raw ?? null;
    }
    toJSON() {
      return { code: this.code, message: this.message, httpStatus: this.httpStatus, acao: this.acao };
    }
  },
  gerarPdfUnificado: vi.fn(),
}));

vi.mock("../../../../infrastructure/security-audit.js", () => ({
  insertSecurityAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../../infrastructure/security-log.js", () => ({
  logStructuredEvent: vi.fn(),
}));

vi.mock("../../../load-claims/auth.js", () => ({
  getAdminClient: vi.fn(() => ({ storage: { from: () => storageMock } })),
}));

import {
  UnificadaBotError,
  gerarPdfUnificado,
} from "../../../../infrastructure/cadastro-bots/unificada-bot-client.js";
import { generateDossie } from "./generate-dossie.js";

function makeFakeClient() {
  const jobs = new Map();
  const client = {
    query: vi.fn(async (sql, params = []) => {
      const sqlNorm = sql.replace(/\s+/g, " ").trim();

      // findExistingOkJob — params: [cadastroId, target, step]
      if (/SELECT id, status, external_id, response, finished_at FROM public.external_registration_jobs/.test(sqlNorm)) {
        const [cadastroId, , step] = params;
        const found = [...jobs.values()].find(
          (j) => j.cadastro_id === cadastroId && j.step === step && j.status === "OK",
        );
        return { rows: found ? [found] : [] };
      }
      // markJobInProgress SELECT FOR UPDATE — params: [cadastroId, target, step]
      if (/SELECT id FROM public.external_registration_jobs WHERE cadastro_id = \$1 AND target = \$2 AND step = \$3 AND status IN \('PENDING', 'ERROR'\)/.test(sqlNorm)) {
        const [cadastroId, , step] = params;
        const found = [...jobs.values()].find(
          (j) => j.cadastro_id === cadastroId && j.step === step && ["PENDING", "ERROR"].includes(j.status),
        );
        return { rows: found ? [{ id: found.id }] : [] };
      }
      // markJobInProgress UPDATE
      if (/UPDATE public.external_registration_jobs SET status = 'IN_PROGRESS'/.test(sqlNorm)) {
        const [payload, jobId] = params;
        const job = jobs.get(jobId);
        if (job) { job.status = "IN_PROGRESS"; job.attempts += 1; job.payload = payload; }
        return { rows: [] };
      }
      // markJobInProgress INSERT — params: [cadastroId, target, step, payload]
      if (/INSERT INTO public.external_registration_jobs \(cadastro_id, target, step, status, payload, attempts, started_at\)/.test(sqlNorm)) {
        const [cadastroId, target, step, payload] = params;
        const id = `job-${jobs.size + 1}`;
        jobs.set(id, { id, cadastro_id: cadastroId, target, step, status: "IN_PROGRESS", payload, attempts: 1 });
        return { rows: [{ id }] };
      }
      // markJobOk — params: [response, externalId, jobId]
      if (/UPDATE public.external_registration_jobs SET status = 'OK'/.test(sqlNorm)) {
        const [response, externalId, jobId] = params;
        const job = jobs.get(jobId);
        if (job) { job.status = "OK"; job.response = response; job.external_id = externalId; job.finished_at = new Date().toISOString(); }
        return { rows: [] };
      }
      // markJobError — params: [error, jobId]
      if (/UPDATE public.external_registration_jobs SET status = 'ERROR'/.test(sqlNorm)) {
        const [error, jobId] = params;
        const job = jobs.get(jobId);
        if (job) { job.status = "ERROR"; job.error = error; job.finished_at = new Date().toISOString(); }
        return { rows: [] };
      }
      return { rows: [] };
    }),
    _getJobs: () => [...jobs.values()],
    _seedJob: (job) => { jobs.set(job.id, job); },
  };
  return client;
}

const SAMPLE_CADASTRO = {
  id: "11111111-1111-1111-1111-111111111111",
  dados: {
    motorista: { cpf: "12345678909", nome: "João da Silva" },
    cavalo: { placa: "ABC1234" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.upload.mockResolvedValue({ error: null });
  storageMock.createSignedUrl.mockResolvedValue({ data: { signedUrl: "http://signed/dossie.pdf" }, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateDossie / happy path", () => {
  it("gera o PDF, sobe no storage, marca job OK e retorna signedUrl", async () => {
    gerarPdfUnificado.mockResolvedValue({
      ok: true, pdf: Buffer.from("%PDF-1.4 fake-dossie"),
      components: "{'motorista': True}", warnings: "[]",
    });

    const client = makeFakeClient();
    const r = await generateDossie({ client, cadastro: SAMPLE_CADASTRO, operatorId: "op-1" });

    expect(r.ok).toBe(true);
    expect(r.reused).toBe(false);
    expect(r.storagePath).toMatch(/^risk-docs\/11111111-1111-1111-1111-111111111111\/dossie_\d+\.pdf$/);
    expect(r.signedUrl).toBe("http://signed/dossie.pdf");

    // gerarPdfUnificado recebeu cpf + placa do cavalo
    expect(gerarPdfUnificado).toHaveBeenCalledOnce();
    const callArg = gerarPdfUnificado.mock.calls[0][0];
    expect(callArg.cpf).toBe("12345678909");
    expect(callArg.placaCavalo).toBe("ABC1234");

    // upload com contentType pdf + buffer
    expect(storageMock.upload).toHaveBeenCalledOnce();
    const [, bufArg, optsArg] = storageMock.upload.mock.calls[0];
    expect(Buffer.isBuffer(bufArg)).toBe(true);
    expect(optsArg.contentType).toBe("application/pdf");

    // job persistido como OK com a referência do PDF
    const okJob = client._getJobs().find((j) => j.step === "unificada_pdf" && j.status === "OK");
    expect(okJob).toBeTruthy();
    expect(okJob.target).toBe("spx");
    expect(okJob.response.storage_path).toBe(r.storagePath);
  });
});

describe("generateDossie / reuso (<24h)", () => {
  it("não regenera quando há dossiê OK recente — devolve reused:true", async () => {
    const client = makeFakeClient();
    client._seedJob({
      id: "old", cadastro_id: SAMPLE_CADASTRO.id, target: "spx", step: "unificada_pdf",
      status: "OK", finished_at: new Date().toISOString(),
      response: { storage_path: "risk-docs/old/dossie_old.pdf", components: "{}", warnings: "[]" },
    });

    const r = await generateDossie({ client, cadastro: SAMPLE_CADASTRO });

    expect(r.ok).toBe(true);
    expect(r.reused).toBe(true);
    expect(r.storagePath).toBe("risk-docs/old/dossie_old.pdf");
    expect(gerarPdfUnificado).not.toHaveBeenCalled();
    expect(storageMock.upload).not.toHaveBeenCalled();
    expect(storageMock.createSignedUrl).toHaveBeenCalled(); // re-assina a URL
  });

  it("REGENERA quando force:true mesmo com dossiê recente", async () => {
    gerarPdfUnificado.mockResolvedValue({ ok: true, pdf: Buffer.from("%PDF novo"), components: "{}", warnings: "[]" });
    const client = makeFakeClient();
    client._seedJob({
      id: "old", cadastro_id: SAMPLE_CADASTRO.id, target: "spx", step: "unificada_pdf",
      status: "OK", finished_at: new Date().toISOString(),
      response: { storage_path: "risk-docs/old/dossie_old.pdf" },
    });

    const r = await generateDossie({ client, cadastro: SAMPLE_CADASTRO, force: true });

    expect(r.ok).toBe(true);
    expect(r.reused).toBe(false);
    expect(gerarPdfUnificado).toHaveBeenCalledOnce();
  });
});

describe("generateDossie / dados insuficientes", () => {
  it("retorna erro sem chamar o sidecar quando não há CPF nem placas", async () => {
    const client = makeFakeClient();
    const r = await generateDossie({ client, cadastro: { id: "x", dados: { motorista: {} } } });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("DADOS_INSUFICIENTES");
    expect(gerarPdfUnificado).not.toHaveBeenCalled();
  });
});

describe("generateDossie / falha no sidecar", () => {
  it("marca job ERROR e retorna erro estruturado", async () => {
    gerarPdfUnificado.mockRejectedValue(
      new UnificadaBotError({ code: "UNIFICADA_DOWNSTREAM_FAIL", message: "AngelLira fora" }),
    );
    const client = makeFakeClient();
    const r = await generateDossie({ client, cadastro: SAMPLE_CADASTRO });

    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("UNIFICADA_DOWNSTREAM_FAIL");
    const errJob = client._getJobs().find((j) => j.step === "unificada_pdf" && j.status === "ERROR");
    expect(errJob).toBeTruthy();
    expect(storageMock.upload).not.toHaveBeenCalled();
  });
});
