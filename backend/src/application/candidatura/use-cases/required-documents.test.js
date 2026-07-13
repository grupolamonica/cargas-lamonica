import { describe, expect, it } from "vitest";

import { collectMissingRequiredDocuments } from "./required-documents.js";

// Helpers de fixture — payload mínimo aceito pelo dadosSchema, com/sem anexos.
function fullMotorista(overrides = {}) {
  return {
    nome: "Fulano de Tal",
    cnh_url: "cpf/carga/motorista_cnh_1.pdf",
    selfie_cnh_url: "cpf/carga/motorista_selfie_cnh_1.jpg",
    comprovante_url: "cpf/carga/motorista_comprovante_1.pdf",
    ...overrides,
  };
}
function fullCavalo(overrides = {}) {
  return { placa: "ABC1D23", owner_doc: "12345678901", owner_doc_type: "cpf", crlv_url: "cpf/carga/cavalo_crlv_1.pdf", ...overrides };
}
function fullOwner(overrides = {}) {
  return { tipo: "pf", doc: "12345678901", nome: "Dono", owner_doc_url: "cpf/carga/owner_doc_1.pdf", ...overrides };
}

const paths = (missing) => missing.map((m) => m.path.join("."));

describe("collectMissingRequiredDocuments (DC-195)", () => {
  it("cadastro completo com todos os anexos → nenhuma falta", () => {
    const dados = {
      motorista: fullMotorista(),
      cavalo: fullCavalo(),
      cavalo_owner: fullOwner(),
      carretas: [fullCavalo({ placa: "CAR1R11" })],
      carreta_owners: [fullOwner({ doc: "98765432100" })],
    };
    expect(collectMissingRequiredDocuments(dados)).toEqual([]);
  });

  it("motorista completo sem CNH → cobra a CNH", () => {
    const dados = { motorista: fullMotorista({ cnh_url: undefined }) };
    expect(paths(collectMissingRequiredDocuments(dados))).toEqual(["motorista.cnh_url"]);
  });

  it("motorista completo sem nenhum anexo → cobra os 3", () => {
    const dados = {
      motorista: fullMotorista({ cnh_url: undefined, selfie_cnh_url: "", comprovante_url: "   " }),
    };
    expect(paths(collectMissingRequiredDocuments(dados))).toEqual([
      "motorista.cnh_url",
      "motorista.selfie_cnh_url",
      "motorista.comprovante_url",
    ]);
  });

  it("motorista PARCIAL (Step A pulado / mesclado) sem docs → NÃO cobra", () => {
    const dados = { motorista: { nome: "Persistido", cpf: "12345678901" } };
    expect(collectMissingRequiredDocuments(dados, { motoristaWasPartial: true })).toEqual([]);
  });

  it("cavalo completo sem CRLV → cobra; cavalo parcial → não cobra", () => {
    const dados = { cavalo: fullCavalo({ crlv_url: undefined }) };
    expect(paths(collectMissingRequiredDocuments(dados))).toEqual(["cavalo.crlv_url"]);
    expect(collectMissingRequiredDocuments(dados, { cavaloWasPartial: true })).toEqual([]);
  });

  it("cavalo_owner enviado sem documento → cobra; reidratado → não cobra", () => {
    const dados = { cavalo_owner: fullOwner({ owner_doc_url: undefined }) };
    expect(paths(collectMissingRequiredDocuments(dados))).toEqual(["cavalo_owner.owner_doc_url"]);
    expect(collectMissingRequiredDocuments(dados, { cavaloOwnerWasRehydrated: true })).toEqual([]);
  });

  it("carretas: cobra CRLV por índice", () => {
    const dados = {
      carretas: [fullCavalo({ placa: "CAR1R11" }), fullCavalo({ placa: "CAR2R22", crlv_url: undefined })],
    };
    expect(paths(collectMissingRequiredDocuments(dados))).toEqual(["carretas.1.crlv_url"]);
  });

  it("carreta_owners: cobra documento por índice", () => {
    const dados = { carreta_owners: [fullOwner({ owner_doc_url: undefined })] };
    expect(paths(collectMissingRequiredDocuments(dados))).toEqual(["carreta_owners.0.owner_doc_url"]);
  });

  it("defensivo: dados vazio/nulo/arrays vazios → nenhuma falta", () => {
    expect(collectMissingRequiredDocuments(null)).toEqual([]);
    expect(collectMissingRequiredDocuments(undefined)).toEqual([]);
    expect(collectMissingRequiredDocuments({})).toEqual([]);
    expect(collectMissingRequiredDocuments({ carretas: [], carreta_owners: [] })).toEqual([]);
  });
});
