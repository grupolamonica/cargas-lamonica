import { describe, expect, it } from "vitest";

import { collectDocPaths, docPathWasAdded } from "./useDriverRegistrationDraft";

// Blindagem do bug da selfie/CRLV que "sumia": um upload adiciona um
// storage_path ao draft de forma assíncrona; se cair na janela do debounce e o
// wizard avançar/fechar, o path se perdia → submit acusava "Anexe o documento"
// falso. O setData usa docPathWasAdded p/ salvar NA HORA quando isso acontece.

describe("collectDocPaths — coleta storage_paths de documento (shape do wizard)", () => {
  it("acha selfie/CNH/comprovante/CRLV cavalo/CRLV carreta nas fatias", () => {
    const data = {
      stepA: {
        a1: { storage_path: "cpf/x/motorista_cnh.pdf", nome: "GLAUBERT" },
        a1b: { fileName: "selfie.jpg", storageUrl: "cpf/x/motorista_selfie_cnh.jpg" },
        a3: { comprovanteUrl: "cpf/x/motorista_comprovante.pdf", cep: "70000000" },
      },
      stepB: { crlvStoragePath: "cpf/x/cavalo_crlv.pdf" },
      stepD: { carretas: [{ crlvStoragePath: "cpf/x/carreta_crlv_0.pdf" }] },
    };
    const paths = collectDocPaths(data, new Set());
    expect(paths).toContain("cpf/x/motorista_cnh.pdf");
    expect(paths).toContain("cpf/x/motorista_selfie_cnh.jpg");
    expect(paths).toContain("cpf/x/motorista_comprovante.pdf");
    expect(paths).toContain("cpf/x/cavalo_crlv.pdf");
    expect(paths).toContain("cpf/x/carreta_crlv_0.pdf");
    // não coleta valores que não são path de documento
    expect(paths).not.toContain("GLAUBERT");
    expect(paths).not.toContain("70000000");
    expect(paths).not.toContain("selfie.jpg"); // fileName não é storage_path
  });
});

describe("docPathWasAdded — dispara o save imediato só quando entra doc novo", () => {
  const withSelfie = (url: string | null) => ({
    stepA: { a1b: { fileName: "selfie.jpg", storageUrl: url } },
  });

  it("true quando a selfie ganha storageUrl (fileName já existia)", () => {
    expect(docPathWasAdded(withSelfie(null), withSelfie("cpf/x/selfie.jpg"))).toBe(true);
  });

  it("true quando a CRLV da carreta é anexada", () => {
    const prev = { stepD: { carretas: [{ placa: "SBZ3C81" }] } };
    const next = { stepD: { carretas: [{ placa: "SBZ3C81", crlvStoragePath: "cpf/x/carreta.pdf" }] } };
    expect(docPathWasAdded(prev, next)).toBe(true);
  });

  it("true quando um path é TROCADO por outro (re-anexo)", () => {
    expect(docPathWasAdded(withSelfie("cpf/x/old.jpg"), withSelfie("cpf/x/new.jpg"))).toBe(true);
  });

  it("false ao digitar um campo comum (sem doc novo)", () => {
    const prev = { stepA: { a1: { nome: "GLAU", storage_path: "cpf/x/cnh.pdf" } } };
    const next = { stepA: { a1: { nome: "GLAUBERT", storage_path: "cpf/x/cnh.pdf" } } };
    expect(docPathWasAdded(prev, next)).toBe(false);
  });

  it("false quando nada muda", () => {
    expect(docPathWasAdded(withSelfie("cpf/x/selfie.jpg"), withSelfie("cpf/x/selfie.jpg"))).toBe(false);
  });

  it("false quando um path é REMOVIDO (só nos importa adição)", () => {
    expect(docPathWasAdded(withSelfie("cpf/x/selfie.jpg"), withSelfie(null))).toBe(false);
  });

  it("robusto a prev/next vazios ou nulos", () => {
    expect(docPathWasAdded(null, withSelfie("cpf/x/selfie.jpg"))).toBe(true);
    expect(docPathWasAdded({}, {})).toBe(false);
    expect(docPathWasAdded(withSelfie("cpf/x/selfie.jpg"), {})).toBe(false);
  });
});
