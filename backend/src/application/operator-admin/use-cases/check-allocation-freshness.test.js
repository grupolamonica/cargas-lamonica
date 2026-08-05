import { afterEach, describe, expect, it } from "vitest";

import {
  alocacaoDesatualizada,
  carimboMs,
  concurrentEditWarnEnabled,
  descreverAlteracaoConcorrente,
} from "./check-allocation-freshness.js";

describe("carimboMs", () => {
  it("aceita Date (pg), string ISO (front) e trata ausente como null", () => {
    const d = new Date("2026-08-05T12:14:30.477Z");
    expect(carimboMs(d)).toBe(d.getTime());
    expect(carimboMs("2026-08-05T12:14:30.477Z")).toBe(d.getTime());
    expect(carimboMs(null)).toBeNull();
    expect(carimboMs(undefined)).toBeNull();
    expect(carimboMs("")).toBeNull();
    expect(carimboMs("nao-e-data")).toBeNull();
  });
});

describe("alocacaoDesatualizada", () => {
  const iso = "2026-08-05T12:14:30.477Z";

  it("mesmo carimbo → NÃO desatualizada", () => {
    expect(alocacaoDesatualizada({ atualUpdatedAt: new Date(iso), esperadoUpdatedAt: iso })).toBe(false);
  });

  it("ambos nulos (ninguém nunca mexeu) → NÃO desatualizada", () => {
    expect(alocacaoDesatualizada({ atualUpdatedAt: null, esperadoUpdatedAt: null })).toBe(false);
  });

  it("carimbo diferente → desatualizada", () => {
    expect(alocacaoDesatualizada({
      atualUpdatedAt: new Date("2026-08-05T12:20:00Z"),
      esperadoUpdatedAt: iso,
    })).toBe(true);
  });

  it("tela sem baseline mas banco já alterado → desatualizada", () => {
    expect(alocacaoDesatualizada({ atualUpdatedAt: new Date(iso), esperadoUpdatedAt: null })).toBe(true);
  });

  it("tolera diferença de arredondamento sub-segundo (microssegundos do timestamptz)", () => {
    // O timestamptz do Postgres tem microssegundos; o ISO do JS trunca em ms. O
    // round-trip do PRÓPRIO carimbo não pode ser lido como "outra pessoa mexeu".
    expect(alocacaoDesatualizada({
      atualUpdatedAt: new Date("2026-08-05T12:14:30.900Z"),
      esperadoUpdatedAt: "2026-08-05T12:14:30.477Z",
    })).toBe(false);
  });

  it("diferença de mais de 1s → desatualizada (edição real da colega)", () => {
    expect(alocacaoDesatualizada({
      atualUpdatedAt: new Date("2026-08-05T12:14:32.000Z"),
      esperadoUpdatedAt: "2026-08-05T12:14:30.477Z",
    })).toBe(true);
  });
});

describe("concurrentEditWarnEnabled", () => {
  afterEach(() => { delete process.env.CONCURRENT_EDIT_WARN; });

  it("default ligado; só 'off' desliga", () => {
    delete process.env.CONCURRENT_EDIT_WARN;
    expect(concurrentEditWarnEnabled()).toBe(true);
    process.env.CONCURRENT_EDIT_WARN = "off";
    expect(concurrentEditWarnEnabled()).toBe(false);
    process.env.CONCURRENT_EDIT_WARN = "OFF";
    expect(concurrentEditWarnEnabled()).toBe(false);
    process.env.CONCURRENT_EDIT_WARN = "on";
    expect(concurrentEditWarnEnabled()).toBe(true);
  });
});

describe("descreverAlteracaoConcorrente", () => {
  it("descreve em português do operador, com o estado atual e sem jargão", async () => {
    const info = await descreverAlteracaoConcorrente({
      row: {
        alloc_updated_by: null,
        alloc_updated_at: new Date("2026-08-05T12:13:12Z"), // 09:13 BRT
        alloc_motorista: "ELEONALDO LOPES DA SILVA",
        alloc_cavalo: "PFG0J22",
        alloc_status: "AGUARDANDO CARREGAMENTO",
      },
    });

    expect(info.mensagem).toContain("alterou esta carga");
    expect(info.mensagem).toContain("09:13"); // hora de parede em São Paulo
    expect(info.mensagem).toContain("ELEONALDO LOPES DA SILVA");
    expect(info.mensagem).not.toMatch(/alloc_|uuid|cargo_id/i);
    expect(info.alteradoEm).toBe("2026-08-05T12:13:12.000Z");
    expect(info.atual).toMatchObject({ motorista: "ELEONALDO LOPES DA SILVA", cavalo: "PFG0J22" });
  });

  it("sem diretório de operadores, cai em 'Outra pessoa' (não quebra o aviso)", async () => {
    const info = await descreverAlteracaoConcorrente({
      row: { alloc_updated_by: "00000000-0000-0000-0000-000000000000", alloc_updated_at: null, alloc_motorista: "CLOVIS" },
    });
    expect(info.alteradoPor).toBe("Outra pessoa");
    expect(info.mensagem).toContain("CLOVIS");
  });

  it("carga que ficou SEM motorista é dita explicitamente", async () => {
    const info = await descreverAlteracaoConcorrente({
      row: { alloc_updated_by: null, alloc_updated_at: new Date("2026-08-05T12:00:00Z"), alloc_motorista: "" },
    });
    expect(info.mensagem).toContain("sem motorista agora");
  });

  it("cai para o valor da PLANILHA quando não há override", async () => {
    const info = await descreverAlteracaoConcorrente({
      row: { alloc_updated_at: null, alloc_motorista: null, sheet_motorista: "MOTORISTA DA PLANILHA" },
    });
    expect(info.atual.motorista).toBe("MOTORISTA DA PLANILHA");
  });
});
