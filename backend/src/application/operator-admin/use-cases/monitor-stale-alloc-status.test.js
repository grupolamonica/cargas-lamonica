import { describe, it, expect } from "vitest";
import { releaseStaleAllocStatusOverrides } from "./monitor-stale-alloc-status.js";

const row = (over = {}) => ({ lh: "LT1", status: "DESCARREGADO", motoristas: "JOAO", ...over });
const alloc = (status, over = {}) => ({ sheet_lh: "LT1", alloc_status: status, alloc_motorista: null, ...over });

describe("releaseStaleAllocStatusOverrides", () => {
  it("solta o override VAZIO que mascara o status da planilha (carga COM motorista)", () => {
    const { allocByLh, released } = releaseStaleAllocStatusOverrides({
      baseRows: [row()],
      allocByLh: { LT1: alloc("") },
    });
    expect(allocByLh.LT1.alloc_status).toBeNull();
    expect(released).toEqual([{ lh: "LT1", de: "(vazio)", para: "DESCARREGADO" }]);
  });

  it("é o caso da produção: planilha em CTE ENVIADO exibida como CARREGADO pelo SPX", () => {
    // Override "" na carga LANÇADA (gêmea) zerava o status efetivo e o overlay ao
    // vivo do SPX preenchia a linha. Soltando o override, o CTE ENVIADO volta.
    const { allocByLh } = releaseStaleAllocStatusOverrides({
      baseRows: [row({ lh: "LT1Q8302D4IK2", status: "CTE ENVIADO", motoristas: "Paulo Erivaldo Rosa Costa" })],
      allocByLh: { LT1Q8302D4IK2: alloc("", { sheet_lh: "LT1Q8302D4IK2" }) },
    });
    expect(allocByLh.LT1Q8302D4IK2.alloc_status).toBeNull();
  });

  it("solta o override ATRASADO no pipeline (planilha à frente)", () => {
    const { allocByLh, released } = releaseStaleAllocStatusOverrides({
      baseRows: [row()],
      allocByLh: { LT1: alloc("AGUARDANDO CHEGAR NO CLIENTE") },
    });
    expect(allocByLh.LT1.alloc_status).toBeNull();
    expect(released[0].de).toBe("AGUARDANDO CHEGAR NO CLIENTE");
  });

  it("PRESERVA override deliberado que a planilha ainda não alcançou", () => {
    for (const [override, planilha] of [
      ["CTE EM EMISSÃO", "CARREGADO"],
      ["CTE ENVIADO", "CARREGADO"],
      ["NO SHOW", "DESCARREGADO"],
      ["CANCELADO", "DESCARREGADO"],
    ]) {
      const { allocByLh, released } = releaseStaleAllocStatusOverrides({
        baseRows: [row({ status: planilha })],
        allocByLh: { LT1: alloc(override) },
      });
      expect(allocByLh.LT1.alloc_status, `${override} × ${planilha}`).toBe(override);
      expect(released).toHaveLength(0);
    }
  });

  it("PRESERVA o vazio deliberado (Disponível) em carga SEM motorista", () => {
    const { allocByLh, released } = releaseStaleAllocStatusOverrides({
      baseRows: [row({ motoristas: "" })],
      allocByLh: { LT1: alloc("") },
    });
    expect(allocByLh.LT1.alloc_status).toBe("");
    expect(released).toHaveLength(0);
  });

  it("NÃO assume cancelamento/NO SHOW da planilha a partir do vazio (cascata retroativa)", () => {
    for (const planilha of ["CANCELADO", "NO SHOW"]) {
      const { released } = releaseStaleAllocStatusOverrides({
        baseRows: [row({ status: planilha })],
        allocByLh: { LT1: alloc("") },
      });
      expect(released, planilha).toHaveLength(0);
    }
  });

  it("não mexe quando não há override, quando é null, ou quando a planilha está sem status", () => {
    expect(releaseStaleAllocStatusOverrides({ baseRows: [row()], allocByLh: {} }).released).toHaveLength(0);
    expect(
      releaseStaleAllocStatusOverrides({ baseRows: [row()], allocByLh: { LT1: alloc(null) } }).released,
    ).toHaveLength(0);
    expect(
      releaseStaleAllocStatusOverrides({ baseRows: [row({ status: "" })], allocByLh: { LT1: alloc("") } }).released,
    ).toHaveLength(0);
  });

  it("usa o motorista do OVERRIDE quando ele existe (não o da planilha)", () => {
    // Override esvaziou o motorista ("") → sem motorista efetivo → o "" de status é
    // decisão deliberada e fica.
    const { released } = releaseStaleAllocStatusOverrides({
      baseRows: [row()],
      allocByLh: { LT1: alloc("", { alloc_motorista: "" }) },
    });
    expect(released).toHaveLength(0);
  });

  it("devolve o MESMO objeto quando nada muda (leitura quente do Monitor)", () => {
    const original = { LT1: alloc("CTE EM EMISSÃO") };
    const { allocByLh } = releaseStaleAllocStatusOverrides({
      baseRows: [row({ status: "CARREGADO" })],
      allocByLh: original,
    });
    expect(allocByLh).toBe(original);
  });

  it("não muta o mapa recebido ao soltar", () => {
    const original = { LT1: alloc("") };
    const { allocByLh } = releaseStaleAllocStatusOverrides({ baseRows: [row()], allocByLh: original });
    expect(original.LT1.alloc_status).toBe("");
    expect(allocByLh).not.toBe(original);
  });

  it("ignora linhas sem LH e aceita entradas vazias", () => {
    expect(releaseStaleAllocStatusOverrides().released).toHaveLength(0);
    expect(
      releaseStaleAllocStatusOverrides({ baseRows: [row({ lh: "" })], allocByLh: { "": alloc("") } }).released,
    ).toHaveLength(0);
  });
});
