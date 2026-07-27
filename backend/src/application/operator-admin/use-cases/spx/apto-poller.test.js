import { beforeEach, describe, expect, it, vi } from "vitest";

// Estado controlável do mock de pg.
const canned = { draftRows: [], updates: [] };

vi.mock("../../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) =>
    cb({
      query: async (sql, params) => {
        const s = String(sql);
        if (s.includes("WITH latest") && s.includes("external_registration_jobs")) {
          return { rows: canned.draftRows };
        }
        if (s.includes("UPDATE public.external_registration_jobs")) {
          canned.updates.push(params);
          return { rowCount: 1 };
        }
        return { rows: [], rowCount: 0 }; // ensureAppSettingsTable / persistLastRun
      },
    }),
}));

const { spxPrecheckMock } = vi.hoisted(() => ({ spxPrecheckMock: vi.fn() }));
vi.mock("./precheck.js", () => ({ performSpxPrecheck: spxPrecheckMock }));
vi.mock("../angellira/auto-approve-vigentes.js", () => ({ ensureAppSettingsTable: async () => {} }));
vi.mock("../../../../infrastructure/security-log.js", () => ({ logStructuredEvent: () => {} }));

import { runSpxAptoPoll } from "./apto-poller.js";

const draft = (id, cpf, etapa = "completo") => ({
  id,
  cadastro_id: `c-${id}`,
  driver_user_id: `u-${id}`,
  etapa,
  dados: { motorista: { cpf } },
});

describe("runSpxAptoPoll", () => {
  beforeEach(() => {
    canned.draftRows = [];
    canned.updates = [];
    spxPrecheckMock.mockReset();
  });

  it("promove p/ apto o rascunho que a Shopee aprovou (IS_MATCHED_NOSSA)", async () => {
    canned.draftRows = [draft("j1", "11111111111", "completo")];
    spxPrecheckMock.mockResolvedValue({ status: "IS_MATCHED_NOSSA" });

    const s = await runSpxAptoPoll({ apply: true });

    expect(spxPrecheckMock).toHaveBeenCalledWith(expect.objectContaining({ skipCache: true }));
    expect(s.checked).toBe(1);
    expect(s.aptos).toBe(1);
    expect(s.updated).toBe(1);
    expect(canned.updates).toHaveLength(1);
    // params: [jobId, APTO_ETAPA, etapaAnterior, nowIso]
    expect(canned.updates[0][0]).toBe("j1");
    expect(canned.updates[0][1]).toBe("ja_cadastrado_nossa_agencia");
    expect(canned.updates[0][2]).toBe("completo");
  });

  it("mantém rascunho quando ainda pendente na Shopee (REQUEST_PENDENTE)", async () => {
    canned.draftRows = [draft("j1", "11111111111", "importado")];
    spxPrecheckMock.mockResolvedValue({ status: "REQUEST_PENDENTE" });

    const s = await runSpxAptoPoll({ apply: true });

    expect(s.aptos).toBe(0);
    expect(s.aindaRascunho).toBe(1);
    expect(canned.updates).toHaveLength(0);
  });

  it("UNAVAILABLE (bot fora) não promove — reavalia na próxima leva", async () => {
    canned.draftRows = [draft("j1", "11111111111")];
    spxPrecheckMock.mockResolvedValue({ status: "UNAVAILABLE" });

    const s = await runSpxAptoPoll({ apply: true });

    expect(s.unavailable).toBe(1);
    expect(s.aptos).toBe(0);
    expect(canned.updates).toHaveLength(0);
  });

  it("apply:false (simulação) NÃO grava", async () => {
    canned.draftRows = [draft("j1", "11111111111")];
    spxPrecheckMock.mockResolvedValue({ status: "IS_MATCHED_NOSSA" });

    const s = await runSpxAptoPoll({ apply: false });

    expect(s.aptos).toBe(0);
    expect(canned.updates).toHaveLength(0);
  });

  it("pula cadastro sem CPF válido (não consulta o bot)", async () => {
    canned.draftRows = [draft("j1", "123")];
    spxPrecheckMock.mockResolvedValue({ status: "IS_MATCHED_NOSSA" });

    const s = await runSpxAptoPoll({ apply: true });

    expect(spxPrecheckMock).not.toHaveBeenCalled();
    expect(s.checked).toBe(0);
    expect(canned.updates).toHaveLength(0);
  });
});
