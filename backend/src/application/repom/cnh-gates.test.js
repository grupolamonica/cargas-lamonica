import { describe, expect, it } from "vitest";

import {
  detectSuspiciousNumericFields,
  evaluateCnhExtraction,
  hasMinimalCnhSignal,
  pickField,
  SIGNATURE_MIN_CNH,
} from "./cnh-gates.js";

// CNH "boa" (chaves do schema Vision).
const goodCnh = (over = {}) => ({
  nome: "FULANO DE TAL SILVA",
  cpf: "12345678901",
  numero_registro: "01234567890",
  categoria: "AE",
  validade: "30/05/2035",
  data_nascimento: "01/01/1985",
  ...over,
});

const NOW = new Date(2026, 6, 21); // 21/07/2026 (determinístico)

describe("repom cnh-gates", () => {
  describe("pickField (tolerante a apelidos)", () => {
    it("acha pelo nome canônico do Vision e por apelido do Infosimples", () => {
      expect(pickField({ numero_registro: "999" }, "numero_registro")).toBe("999");
      expect(pickField({ registro: "888" }, "numero_registro")).toBe("888"); // apelido
      expect(pickField({ data_validade: "30/05/2030" }, "validade")).toBe("30/05/2030"); // apelido
      expect(pickField({ nome: "  X  " }, "nome")).toBe("X"); // trim
      expect(pickField({ cpf: "" }, "cpf")).toBeNull(); // vazio
    });
  });

  describe("hasMinimalCnhSignal", () => {
    it(`≥ ${SIGNATURE_MIN_CNH} âncoras → é CNH; menos → não`, () => {
      expect(hasMinimalCnhSignal(goodCnh())).toBe(true);
      expect(hasMinimalCnhSignal({ cpf: "12345678901", nome: "FULANO" })).toBe(true); // 2
      expect(hasMinimalCnhSignal({ nome: "FULANO" })).toBe(false); // 1
      expect(hasMinimalCnhSignal({ placa: "ABC1D23", renavam: "123" })).toBe(false); // doc trocado
    });
  });

  describe("detectSuspiciousNumericFields", () => {
    it("letra em cpf/numero_registro = suspeito; máscara não; RG nunca", () => {
      expect(detectSuspiciousNumericFields({ cpf: "1234S678901" })).toEqual(["cpf"]); // S↔5
      expect(detectSuspiciousNumericFields({ numero_registro: "O1234567" })).toEqual(["numero_registro"]); // O↔0
      expect(detectSuspiciousNumericFields({ cpf: "123.456.789-01" })).toEqual([]); // máscara ok
      expect(detectSuspiciousNumericFields({ cpf: "12345678901" })).toEqual([]);
      // RG alfanumérico NÃO é checado (lição do loop de 91 fotos)
      expect(detectSuspiciousNumericFields({ rg: "MG9014856", rg_numero: "MG9014856" })).toEqual([]);
    });
  });

  describe("evaluateCnhExtraction", () => {
    it("CNH boa + CPF batendo com a sessão → accepted, status 'pendente', sem issues", () => {
      const r = evaluateCnhExtraction(goodCnh(), { sessionCpf: "123.456.789-01", now: NOW });
      expect(r).toMatchObject({ accepted: true, status: "pendente", cpfMatchesSession: true });
      expect(r.issues).toEqual([]);
    });

    it("doc trocado (sinal < mínimo) → accepted:false, not_a_cnh", () => {
      const r = evaluateCnhExtraction({ placa: "ABC1D23" }, { sessionCpf: "12345678901", now: NOW });
      expect(r).toMatchObject({ accepted: false, reason: "not_a_cnh" });
    });

    it("validade vencida → em_revisao com cnh_vencida (não recusa)", () => {
      const r = evaluateCnhExtraction(goodCnh({ validade: "30/05/2020" }), { sessionCpf: "12345678901", now: NOW });
      expect(r.accepted).toBe(true);
      expect(r.status).toBe("em_revisao");
      expect(r.issues.map((i) => i.code)).toContain("cnh_vencida");
    });

    it("CPF da CNH diferente do da sessão → em_revisao + cpf_diverge_sessao (decisão do Samuel)", () => {
      const r = evaluateCnhExtraction(goodCnh({ cpf: "99999999999" }), { sessionCpf: "12345678901", now: NOW });
      expect(r.status).toBe("em_revisao");
      expect(r.cpfMatchesSession).toBe(false);
      expect(r.issues.map((i) => i.code)).toContain("cpf_diverge_sessao");
    });

    it("OCR suspeito no CPF → em_revisao + ocr_suspeito (mas segue aceito p/ revisão)", () => {
      const r = evaluateCnhExtraction(goodCnh({ cpf: "1234S678901" }), { sessionCpf: "12345678901", now: NOW });
      expect(r.accepted).toBe(true);
      expect(r.status).toBe("em_revisao");
      const codes = r.issues.map((i) => i.code);
      expect(codes).toContain("ocr_suspeito");
      expect(codes).toContain("cpf_invalido"); // "1234S678901" não tem 11 dígitos
    });

    it("funciona com chaves do Infosimples (apelidos) — registro/data_validade", () => {
      const infosimples = { nome: "FULANO DE TAL", cpf: "12345678901", registro: "01234567890", data_validade: "30/05/2035" };
      const r = evaluateCnhExtraction(infosimples, { sessionCpf: "12345678901", now: NOW });
      expect(r).toMatchObject({ accepted: true, status: "pendente" });
    });

    it("sem sessionCpf → não gera issue de divergência (cross-check só quando há os dois)", () => {
      const r = evaluateCnhExtraction(goodCnh(), { now: NOW });
      expect(r.issues.map((i) => i.code)).not.toContain("cpf_diverge_sessao");
    });
  });
});
