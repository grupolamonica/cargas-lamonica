import { beforeEach, describe, expect, it, vi } from "vitest";

// Estado controlável dos mocks de infra. As funções PURAS não tocam nada disto;
// os testes de runRevertNonConformeAutoApproved configuram linhas + respostas.
const canned = {
  approvedRows: [],
  updateParams: [],
  driver: new Map(),
  plate: new Map(),
};

vi.mock("../../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) =>
    cb({
      query: async (sql, params) => {
        const s = String(sql);
        if (s.includes("SELECT id, dados") && s.includes("status = 'aprovado'")) {
          return { rows: canned.approvedRows };
        }
        if (s.includes("UPDATE public.pending_driver_registrations") && s.includes("status = 'pendente'")) {
          canned.updateParams.push(params);
          const ids = params[2];
          return { rows: ids.map((id) => ({ id })) };
        }
        return { rows: [] };
      },
    }),
}));
vi.mock("../../../../infrastructure/angellira/angellira-client.js", () => ({
  lookupAngelliraDriverByCpf: async (cpf) => canned.driver.get(cpf) || { status: "NOT_FOUND" },
  lookupAngelliraPlate: async (placa) => canned.plate.get(placa) || { status: "NOT_FOUND" },
}));
vi.mock("../../../../infrastructure/security-audit.js", () => ({ insertSecurityAuditEvent: async () => {} }));
vi.mock("../../../../infrastructure/security-log.js", () => ({ logStructuredEvent: () => {} }));

import {
  isAngelliraVigente,
  extractConjuntoPlacas,
  evaluateConjuntoConforme,
  runRevertNonConformeAutoApproved,
} from "./auto-approve-vigentes.js";

const TODAY = "2026-07-17";
const VIGENTE = { status: "FOUND", validUntil: "2026-11-03" }; // Conforme + validade futura
const VIGENTE_HOJE = { status: "FOUND", validUntil: "2026-07-17" }; // validade == hoje (>=)
const VENCIDO = { status: "FOUND", validUntil: "2026-01-01" }; // Conforme porém vencido
const SEM_VALIDADE = { status: "FOUND", validUntil: null };
const NAO_CADASTRADO = { status: "NOT_FOUND" };
const INDISPONIVEL = { status: "UNAVAILABLE" };

describe("isAngelliraVigente", () => {
  it("vigente quando FOUND e validade >= hoje", () => {
    expect(isAngelliraVigente(VIGENTE, TODAY)).toBe(true);
    expect(isAngelliraVigente(VIGENTE_HOJE, TODAY)).toBe(true);
  });

  it("não vigente quando vencido, sem validade, não cadastrado, indisponível ou nulo", () => {
    expect(isAngelliraVigente(VENCIDO, TODAY)).toBe(false);
    expect(isAngelliraVigente(SEM_VALIDADE, TODAY)).toBe(false);
    expect(isAngelliraVigente(NAO_CADASTRADO, TODAY)).toBe(false);
    expect(isAngelliraVigente(INDISPONIVEL, TODAY)).toBe(false);
    expect(isAngelliraVigente(null, TODAY)).toBe(false);
    expect(isAngelliraVigente(undefined, TODAY)).toBe(false);
  });
});

describe("extractConjuntoPlacas", () => {
  it("extrai cavalo + todas as carretas (bitrem = 2), em UPPERCASE", () => {
    const { cavalo, carretas } = extractConjuntoPlacas({
      cavalo: { placa: "abc1d23" },
      carretas: [{ placa: "def4g56" }, { placa: "ghi7j89" }],
    });
    expect(cavalo).toBe("ABC1D23");
    expect(carretas).toEqual(["DEF4G56", "GHI7J89"]);
  });

  it("suporta o formato legado (carreta objeto único)", () => {
    const { cavalo, carretas } = extractConjuntoPlacas({ cavalo: { placa: "AAA1234" }, carreta: { placa: "BBB2345" } });
    expect(cavalo).toBe("AAA1234");
    expect(carretas).toEqual(["BBB2345"]);
  });

  it("truck: sem carretas", () => {
    const { cavalo, carretas } = extractConjuntoPlacas({ cavalo: { placa: "AAA1234" }, carretas: [] });
    expect(cavalo).toBe("AAA1234");
    expect(carretas).toEqual([]);
  });

  it("cavalo ausente → string vazia", () => {
    expect(extractConjuntoPlacas({ carretas: [] }).cavalo).toBe("");
    expect(extractConjuntoPlacas(null).cavalo).toBe("");
  });
});

describe("evaluateConjuntoConforme", () => {
  const cavalo = (rec) => ({ placa: "ABC1D23", rec });
  const carreta = (rec) => ({ placa: "DEF4G56", rec });

  it("APROVA quando motorista + cavalo + carreta estão todos vigentes", () => {
    const v = evaluateConjuntoConforme(
      { motorista: VIGENTE, cavalo: cavalo(VIGENTE), carretas: [carreta(VIGENTE)] },
      TODAY,
    );
    expect(v.conforme).toBe(true);
    expect(v.motivo).toBeNull();
  });

  it("APROVA truck (motorista + cavalo vigentes, sem carretas)", () => {
    const v = evaluateConjuntoConforme({ motorista: VIGENTE, cavalo: cavalo(VIGENTE), carretas: [] }, TODAY);
    expect(v.conforme).toBe(true);
  });

  it("BLOQUEIA (caso Nelson) motorista conforme mas cavalo e carreta NÃO CADASTRADOS", () => {
    const v = evaluateConjuntoConforme(
      { motorista: VIGENTE, cavalo: cavalo(NAO_CADASTRADO), carretas: [carreta(NAO_CADASTRADO)] },
      TODAY,
    );
    expect(v.conforme).toBe(false);
    expect(v.motivo).toBe("cavalo");
  });

  it("BLOQUEIA quando só a carreta está não conforme", () => {
    const v = evaluateConjuntoConforme(
      { motorista: VIGENTE, cavalo: cavalo(VIGENTE), carretas: [carreta(NAO_CADASTRADO)] },
      TODAY,
    );
    expect(v.conforme).toBe(false);
    expect(v.motivo).toBe("carreta");
  });

  it("BLOQUEIA quando só o cavalo está conforme e o motorista nem tem cadastro", () => {
    const v = evaluateConjuntoConforme({ motorista: NAO_CADASTRADO, cavalo: cavalo(VIGENTE), carretas: [] }, TODAY);
    expect(v.conforme).toBe(false);
    expect(v.motivo).toBe("motorista");
  });

  it("BLOQUEIA bitrem quando a 2ª carreta está vencida", () => {
    const v = evaluateConjuntoConforme(
      { motorista: VIGENTE, cavalo: cavalo(VIGENTE), carretas: [carreta(VIGENTE), carreta(VENCIDO)] },
      TODAY,
    );
    expect(v.conforme).toBe(false);
    expect(v.motivo).toBe("carreta");
  });

  it("BLOQUEIA quando não há placa de cavalo (cadastro incompleto)", () => {
    const v = evaluateConjuntoConforme({ motorista: VIGENTE, cavalo: null, carretas: [] }, TODAY);
    expect(v.conforme).toBe(false);
    expect(v.motivo).toBe("cavalo_ausente");
  });

  it("BLOQUEIA quando o cavalo está indisponível (não decide como conforme)", () => {
    const v = evaluateConjuntoConforme({ motorista: VIGENTE, cavalo: cavalo(INDISPONIVEL), carretas: [] }, TODAY);
    expect(v.conforme).toBe(false);
    expect(v.motivo).toBe("cavalo");
  });
});

describe("runRevertNonConformeAutoApproved (remediação)", () => {
  const mkDados = (cpf, cavaloPlaca, carretaPlacas = []) => ({
    motorista: { cpf },
    cavalo: cavaloPlaca ? { placa: cavaloPlaca } : undefined,
    carretas: carretaPlacas.map((p) => ({ placa: p })),
  });

  beforeEach(() => {
    canned.approvedRows = [];
    canned.updateParams = [];
    canned.driver = new Map();
    canned.plate = new Map();
  });

  it("DRY-RUN conta os não-conformes sem gravar", async () => {
    canned.driver.set("11111111111", VIGENTE);
    canned.driver.set("22222222222", VIGENTE);
    canned.plate.set("CAV0001", VIGENTE);
    canned.plate.set("CAV0002", NAO_CADASTRADO); // cavalo não cadastrado → não conforme
    canned.approvedRows = [
      { id: "r1", dados: mkDados("11111111111", "CAV0001") },
      { id: "r2", dados: mkDados("22222222222", "CAV0002") },
    ];

    const s = await runRevertNonConformeAutoApproved({ apply: false });

    expect(s.scanned).toBe(2);
    expect(s.conformes).toBe(1);
    expect(s.aRevertar).toBe(1);
    expect(s.reverted).toBe(0);
    expect(canned.updateParams).toHaveLength(0); // não gravou
  });

  it("APPLY reverte SÓ os não-conformes, com os ids certos no UPDATE", async () => {
    canned.driver.set("11111111111", VIGENTE); // r1 conforme
    canned.driver.set("22222222222", VIGENTE); // r2: cavalo não cadastrado
    canned.driver.set("33333333333", NAO_CADASTRADO); // r3: motorista não cadastrado
    canned.plate.set("CAV0001", VIGENTE);
    canned.plate.set("CAV0002", NAO_CADASTRADO);
    canned.plate.set("CAV0003", VIGENTE);
    canned.approvedRows = [
      { id: "r1", dados: mkDados("11111111111", "CAV0001") },
      { id: "r2", dados: mkDados("22222222222", "CAV0002") },
      { id: "r3", dados: mkDados("33333333333", "CAV0003") },
    ];

    const s = await runRevertNonConformeAutoApproved({ apply: true });

    expect(s.conformes).toBe(1);
    expect(s.aRevertar).toBe(2);
    expect(s.reverted).toBe(2);
    expect(canned.updateParams).toHaveLength(1);
    expect([...canned.updateParams[0][2]].sort()).toEqual(["r2", "r3"]);
  });

  it("NÃO reverte quando um componente está indisponível (incerteza)", async () => {
    canned.driver.set("11111111111", VIGENTE);
    canned.plate.set("CAV0001", INDISPONIVEL);
    canned.approvedRows = [{ id: "r1", dados: mkDados("11111111111", "CAV0001") }];

    const s = await runRevertNonConformeAutoApproved({ apply: true });

    expect(s.indisponiveis).toBe(1);
    expect(s.aRevertar).toBe(0);
    expect(s.reverted).toBe(0);
    expect(canned.updateParams).toHaveLength(0);
  });
});
