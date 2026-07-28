import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPgClient, canned } = vi.hoisted(() => ({
  mockPgClient: { query: vi.fn() },
  canned: { row: null, lastUpdate: null },
}));

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) => cb(mockPgClient),
}));
vi.mock("../../../infrastructure/security-log.js", () => ({
  logStructuredEvent: vi.fn(),
}));
// getAdminClient nao deve ser chamado nos testes (injetamos supabaseClient),
// mas mockamos para evitar tocar env/rede caso algum caminho o alcance.
vi.mock("../../load-claims/auth.js", () => ({
  getAdminClient: () => storageWith([]),
}));

import { attachSelfieToCadastro } from "./attach-selfie.js";

const CPF = "12345678901";
const FILENAME = "motorista_selfie_cnh_1699999999.jpg";
const PATH = `${CPF}/carga-abc/${FILENAME}`;

/** Mock do Supabase admin client: storage.from(bucket).list(prefix) devolve `names`. */
function storageWith(names) {
  return {
    storage: {
      from: () => ({
        list: vi.fn(async () => ({ data: names.map((name) => ({ name })), error: null })),
      }),
    },
  };
}

const PRESENT = () => storageWith([FILENAME]);
const ABSENT = () => storageWith([]);

describe("attachSelfieToCadastro", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canned.row = { id: "cad-1", dados: { motorista: { cpf: CPF, nome: "JOSE EDUARDO" } } };
    canned.lastUpdate = null;
    mockPgClient.query.mockImplementation(async (sql, params) => {
      const s = String(sql);
      if (s.includes("SELECT id, dados")) {
        return canned.row ? { rows: [canned.row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (s.includes("UPDATE public.pending_driver_registrations")) {
        canned.lastUpdate = params;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  it("anexa a selfie ao cadastro aprovado e preserva os demais campos do motorista", async () => {
    const result = await attachSelfieToCadastro({
      cpf: CPF,
      selfieStoragePath: PATH,
      supabaseClient: PRESENT(),
    });

    expect(result).toMatchObject({ ok: true, cadastroId: "cad-1", selfie_cnh_url: PATH });
    expect(canned.lastUpdate).not.toBeNull();
    const [dadosJson, id] = canned.lastUpdate;
    expect(id).toBe("cad-1");
    const persisted = JSON.parse(dadosJson);
    expect(persisted.motorista.selfie_cnh_url).toBe(PATH);
    expect(persisted.motorista.nome).toBe("JOSE EDUARDO"); // preservado
    expect(persisted.motorista.cpf).toBe(CPF); // preservado
  });

  it("aceita CPF com pontuacao (normaliza para digitos)", async () => {
    const result = await attachSelfieToCadastro({
      cpf: "123.456.789-01",
      selfieStoragePath: PATH,
      supabaseClient: PRESENT(),
    });
    expect(result.ok).toBe(true);
  });

  it("FILE_NOT_FOUND quando o arquivo nao existe no storage (path fantasma)", async () => {
    const result = await attachSelfieToCadastro({
      cpf: CPF,
      selfieStoragePath: PATH,
      supabaseClient: ABSENT(),
    });
    expect(result).toEqual({ ok: false, code: "FILE_NOT_FOUND" });
    expect(canned.lastUpdate).toBeNull(); // nao escreve nada
  });

  it("404 (NOT_FOUND) quando nao ha cadastro aprovado/concluido para o CPF", async () => {
    canned.row = null;
    const result = await attachSelfieToCadastro({
      cpf: CPF,
      selfieStoragePath: PATH,
      supabaseClient: PRESENT(),
    });
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(canned.lastUpdate).toBeNull();
  });

  it("INVALID_CPF quando o CPF nao tem 11 digitos (sem tocar o banco)", async () => {
    const result = await attachSelfieToCadastro({
      cpf: "123",
      selfieStoragePath: PATH,
      supabaseClient: PRESENT(),
    });
    expect(result).toEqual({ ok: false, code: "INVALID_CPF" });
    expect(mockPgClient.query).not.toHaveBeenCalled();
  });

  it("INVALID_PATH quando o path nao esta sob a pasta do proprio CPF (anti-traversal)", async () => {
    const result = await attachSelfieToCadastro({
      cpf: CPF,
      selfieStoragePath: `99999999999/carga/${FILENAME}`, // outro CPF
      supabaseClient: PRESENT(),
    });
    expect(result).toEqual({ ok: false, code: "INVALID_PATH" });
    expect(mockPgClient.query).not.toHaveBeenCalled();
  });

  it("INVALID_PATH quando o path contem traversal (..)", async () => {
    const result = await attachSelfieToCadastro({
      cpf: CPF,
      selfieStoragePath: `${CPF}/../99999999999/${FILENAME}`,
      supabaseClient: PRESENT(),
    });
    expect(result).toEqual({ ok: false, code: "INVALID_PATH" });
  });

  it("INVALID_PATH quando o path nao e do slot da selfie", async () => {
    const result = await attachSelfieToCadastro({
      cpf: CPF,
      selfieStoragePath: `${CPF}/carga/motorista_cnh_frente_1.jpg`, // slot errado
      supabaseClient: PRESENT(),
    });
    expect(result).toEqual({ ok: false, code: "INVALID_PATH" });
  });

  it("cria o bloco motorista quando o dados persistido nao o tem", async () => {
    canned.row = { id: "cad-2", dados: {} };
    const result = await attachSelfieToCadastro({
      cpf: CPF,
      selfieStoragePath: PATH,
      supabaseClient: PRESENT(),
    });
    expect(result.ok).toBe(true);
    const persisted = JSON.parse(canned.lastUpdate[0]);
    expect(persisted.motorista.selfie_cnh_url).toBe(PATH);
  });
});
