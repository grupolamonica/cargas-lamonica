import { describe, expect, it } from "vitest";

import { getCadastroProblemas, isCadastroIncompleto } from "./pending-registration-problemas.js";

const HOJE = new Date(Date.UTC(2026, 6, 11)); // 2026-07-11

function motoristaCompleto(overrides = {}) {
  return {
    nome: "Fulano de Tal",
    cpf: "12345678901",
    cnh: { categoria: "E", validade: "31/12/2030" },
    cnh_url: "p/motorista_cnh.pdf",
    selfie_cnh_url: "p/motorista_selfie.jpg",
    comprovante_url: "p/motorista_comprovante.pdf",
    ...overrides,
  };
}
const motivos = (dados) => getCadastroProblemas(dados, { hoje: HOJE }).map((p) => p.motivo);

describe("getCadastroProblemas — aba Dados incompletos", () => {
  it("cadastro só-motorista completo → sem problemas", () => {
    expect(getCadastroProblemas({ motorista: motoristaCompleto() }, { hoje: HOJE })).toEqual([]);
    expect(isCadastroIncompleto({ motorista: motoristaCompleto() }, { hoje: HOJE })).toBe(false);
  });

  it("motorista sem CNH/selfie → 2 problemas (comprovante NÃO conta)", () => {
    const dados = {
      motorista: motoristaCompleto({ cnh_url: "", selfie_cnh_url: undefined, comprovante_url: null }),
    };
    expect(motivos(dados)).toEqual([
      "CNH do motorista não anexada.",
      "Selfie com a CNH não anexada.",
    ]);
  });

  it("motorista só sem comprovante de residência → NÃO migra (decisão do operador)", () => {
    const dados = { motorista: motoristaCompleto({ comprovante_url: undefined }) };
    expect(getCadastroProblemas(dados, { hoje: HOJE })).toEqual([]);
  });

  it("CNH vencida → não conforme; CNH futura → ok", () => {
    const vencida = { motorista: motoristaCompleto({ cnh: { validade: "01/01/2020" } }) };
    const probs = getCadastroProblemas(vencida, { hoje: HOJE });
    expect(probs.some((p) => p.tipo === "nao_conforme" && /vencida/.test(p.motivo))).toBe(true);

    const ok = { motorista: motoristaCompleto({ cnh: { validade: "2030-01-01" } }) };
    expect(getCadastroProblemas(ok, { hoje: HOJE })).toEqual([]);
  });

  it("validade ilegível não vira falso 'vencida'", () => {
    const dados = { motorista: motoristaCompleto({ cnh: { validade: "sem data" } }) };
    expect(getCadastroProblemas(dados, { hoje: HOJE })).toEqual([]);
  });

  it("motorista PARCIAL (só cpf, sem nome) → não penaliza", () => {
    expect(getCadastroProblemas({ motorista: { cpf: "12345678901" } }, { hoje: HOJE })).toEqual([]);
  });

  it("cavalo sem placa/CRLV → flaga; cavalo ausente → não flaga", () => {
    const dados = { motorista: motoristaCompleto(), cavalo: { owner_doc: "123" } };
    expect(motivos(dados)).toEqual(["Cavalo sem placa.", "CRLV do cavalo não anexado."]);
    // Cadastro só-motorista (cavalo ausente) não é penalizado.
    expect(getCadastroProblemas({ motorista: motoristaCompleto() }, { hoje: HOJE })).toEqual([]);
  });

  it("proprietário e carretas sem documento → flaga por índice", () => {
    const dados = {
      motorista: motoristaCompleto(),
      cavalo: { placa: "ABC1D23", crlv_url: "p/crlv.pdf" },
      cavalo_owner: { tipo: "pf", doc: "1", nome: "Dono" },
      carretas: [{ placa: "CAR1R11", crlv_url: "p/c1.pdf" }, { placa: "" }],
      carreta_owners: [{ tipo: "pf", doc: "2", nome: "Dono2" }],
    };
    expect(motivos(dados)).toEqual([
      "Documento do proprietário do cavalo não anexado.",
      "Carreta 2 sem placa.",
      "CRLV da carreta 2 não anexado.",
      "Documento do proprietário da carreta 1 não anexado.",
    ]);
  });

  it("defensivo: dados nulo/vazio → sem problemas", () => {
    expect(getCadastroProblemas(null)).toEqual([]);
    expect(getCadastroProblemas({})).toEqual([]);
  });
});
