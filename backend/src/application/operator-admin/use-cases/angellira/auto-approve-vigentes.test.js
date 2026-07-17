import { describe, expect, it, vi } from "vitest";

// Mocks de infra só para o módulo carregar sem efeito colateral (pool pg / env
// Angellira). Os testes exercitam apenas as funções PURAS da regra de conjunto.
vi.mock("../../../../infrastructure/pg/postgres.js", () => ({ withPgClient: vi.fn() }));
vi.mock("../../../../infrastructure/angellira/angellira-client.js", () => ({
  lookupAngelliraDriverByCpf: vi.fn(),
  lookupAngelliraPlate: vi.fn(),
}));
vi.mock("../../../../infrastructure/security-audit.js", () => ({ insertSecurityAuditEvent: vi.fn() }));
vi.mock("../../../../infrastructure/security-log.js", () => ({ logStructuredEvent: vi.fn() }));

import {
  isAngelliraVigente,
  extractConjuntoPlacas,
  evaluateConjuntoConforme,
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
    const v = evaluateConjuntoConforme(
      { motorista: NAO_CADASTRADO, cavalo: cavalo(VIGENTE), carretas: [] },
      TODAY,
    );
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
    const v = evaluateConjuntoConforme(
      { motorista: VIGENTE, cavalo: cavalo(INDISPONIVEL), carretas: [] },
      TODAY,
    );
    expect(v.conforme).toBe(false);
    expect(v.motivo).toBe("cavalo");
  });
});
