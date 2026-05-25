import { describe, expect, it } from "vitest";

import {
  buildMissingFieldsMessage,
  mapSubmitPathToLabel,
} from "./candidatura-schemas.js";

describe("iter #7 — submit error mapping", () => {
  describe("mapSubmitPathToLabel", () => {
    it("mapeia campos do motorista", () => {
      expect(mapSubmitPathToLabel("dados.motorista.cnh_url")).toBe(
        "Motorista — CNH (upload)",
      );
      expect(mapSubmitPathToLabel("dados.motorista.endereco.numero")).toBe(
        "Motorista — Numero (endereco)",
      );
    });

    it("mapeia campos do proprietario do cavalo (Step C)", () => {
      expect(
        mapSubmitPathToLabel("dados.cavalo_owner.owner_doc_url"),
      ).toBe("Proprietario do cavalo — CNH ou cartao CNPJ");
      expect(
        mapSubmitPathToLabel(
          "dados.cavalo_owner.endereco.comprovante_storage_path",
        ),
      ).toBe("Proprietario do cavalo — Comprovante de residencia");
    });

    it("mapeia carretas com indice (1-based)", () => {
      expect(mapSubmitPathToLabel("dados.carretas.0.placa")).toBe("Carreta 1 — Placa");
      expect(mapSubmitPathToLabel("dados.carretas.1.crlv_url")).toBe(
        "Carreta 2 — CRLV (upload)",
      );
    });

    it("mapeia carreta_owners com indice", () => {
      expect(
        mapSubmitPathToLabel(
          "dados.carreta_owners.0.endereco.comprovante_storage_path",
        ),
      ).toBe("Proprietario da carreta 1 — Comprovante de residencia");
      expect(
        mapSubmitPathToLabel("dados.carreta_owners.1.owner_doc_url"),
      ).toBe("Proprietario da carreta 2 — CNH ou cartao CNPJ");
    });

    it("devolve o proprio path quando nao mapeado", () => {
      expect(mapSubmitPathToLabel("dados.foo.bar")).toBe("foo.bar");
    });
  });

  describe("buildMissingFieldsMessage", () => {
    it("retorna mensagem singular quando ha 1 issue", () => {
      const msg = buildMissingFieldsMessage([
        { path: "dados.cavalo_owner.endereco.comprovante_storage_path", message: "x" },
      ]);
      expect(msg).toBe(
        "Campo obrigatorio faltando: Proprietario do cavalo — Comprovante de residencia.",
      );
    });

    it("retorna lista quando ha N issues, citando cada secao", () => {
      const msg = buildMissingFieldsMessage([
        { path: "dados.motorista.cnh_url", message: "x" },
        {
          path: "dados.cavalo_owner.endereco.comprovante_storage_path",
          message: "x",
        },
        { path: "dados.carretas.0.crlv_url", message: "x" },
      ]);
      expect(msg).toContain("Campos obrigatorios faltando (3)");
      expect(msg).toContain("Motorista — CNH (upload)");
      expect(msg).toContain("Proprietario do cavalo — Comprovante de residencia");
      expect(msg).toContain("Carreta 1 — CRLV (upload)");
    });

    it("deduplica labels iguais (ex.: 2 issues no mesmo path)", () => {
      const msg = buildMissingFieldsMessage([
        { path: "dados.motorista.cnh_url", message: "a" },
        { path: "dados.motorista.cnh_url", message: "b" },
      ]);
      // 1 unico label, mensagem singular.
      expect(msg).toBe("Campo obrigatorio faltando: Motorista — CNH (upload).");
    });

    it("fallback quando issues vazio", () => {
      expect(buildMissingFieldsMessage([])).toBe(
        "Faltam campos obrigatorios. Revise as secoes do cadastro.",
      );
    });
  });
});
