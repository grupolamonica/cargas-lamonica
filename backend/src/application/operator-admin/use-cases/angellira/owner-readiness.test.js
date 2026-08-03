import { describe, expect, it } from "vitest";

import { checkOwnerAngelliraReadiness } from "./owner-readiness.js";

const base = (over = {}) => ({
  motorista: { nome: "JOAO", cpf: "12345678909", data_nascimento: "01/01/1990" },
  cavalo: { placa: "ABC1D23", owner_doc: "03144986569", owner_doc_type: "cpf" },
  cavalo_owner: { doc: "03144986569", nome: "WASHINGTON SILVA MUNIZ", data_nascimento: "03/04/1987" },
  ...over,
});

describe("checkOwnerAngelliraReadiness", () => {
  it("owner PF do cavalo COM data de nascimento → null (pronto)", () => {
    expect(checkOwnerAngelliraReadiness(base())).toBeNull();
  });

  it("owner PF do cavalo SEM data de nascimento → BLOQUEIA (caso Fhilipe/WASHINGTON)", () => {
    const dados = base({ cavalo_owner: { doc: "03144986569", nome: "WASHINGTON SILVA MUNIZ" } });
    const b = checkOwnerAngelliraReadiness(dados);
    expect(b).toMatchObject({
      code: "OWNER_SEM_DATA_NASCIMENTO",
      blocked_by: "owner_birth",
      step: "proprietario_cavalo",
    });
    expect(b.message).toContain("WASHINGTON SILVA MUNIZ");
    expect(b.message.toLowerCase()).toContain("data de nascimento");
  });

  it("owner PJ (sem birth) → null (PJ não exige data de nascimento)", () => {
    const dados = base({
      cavalo: { placa: "ABC1D23", owner_doc: "12345678000199", owner_doc_type: "cnpj" },
      cavalo_owner: { doc: "12345678000199", razao_social: "TRANSPORTES LTDA" },
    });
    expect(checkOwnerAngelliraReadiness(dados)).toBeNull();
  });

  it("motorista é o dono do cavalo (herda nascimento do motorista) → null", () => {
    const dados = {
      motorista: { nome: "JOAO", cpf: "12345678909", data_nascimento: "01/01/1990" },
      cavalo: { placa: "ABC1D23", owner_doc: "12345678909", owner_doc_type: "cpf" },
    };
    expect(checkOwnerAngelliraReadiness(dados)).toBeNull();
  });

  it("carreta com owner PF próprio SEM nascimento (não reusa cavalo) → bloqueia", () => {
    const dados = base({
      carretas: [{ placa: "DEF4G56", owner_doc: "98765432100", owner_doc_type: "cpf" }],
      carreta_owners: [{ doc: "98765432100", nome: "MARIA" }],
    });
    const b = checkOwnerAngelliraReadiness(dados);
    expect(b?.code).toBe("OWNER_SEM_DATA_NASCIMENTO");
    expect(b.owners.some((o) => o.papel.includes("carreta"))).toBe(true);
  });

  it("carreta que REAPROVEITA o owner do cavalo → não bloqueia pela carreta", () => {
    const dados = base({
      carretas: [{ placa: "DEF4G56", owner_doc: "03144986569", owner_doc_type: "cpf" }],
      carreta_owners: [{ doc: "03144986569", nome: "WASHINGTON SILVA MUNIZ" }],
    });
    expect(checkOwnerAngelliraReadiness(dados)).toBeNull();
  });

  it("dados vazio/nulo → null", () => {
    expect(checkOwnerAngelliraReadiness(null)).toBeNull();
    expect(checkOwnerAngelliraReadiness({})).toBeNull();
  });
});
