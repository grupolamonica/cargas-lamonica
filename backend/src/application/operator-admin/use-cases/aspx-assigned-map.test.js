import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock do sidecar SPX: controla o índice de viagens (trip_number → { driver }).
const fetchTripIndex = vi.fn();
vi.mock("../../../infrastructure/spx/spx-allocation-client.js", () => ({ fetchTripIndex }));

const { buildAspxAssignedByLh, isSpxTripLh, resetAspxAssignedCacheForTests } = await import("./aspx-assigned-map.js");

function indexOf(pairs) {
  return { byNumber: new Map(pairs.map(([lh, driver]) => [lh, { status: 4, statusName: "x", driver }])) };
}

describe("isSpxTripLh", () => {
  it("só 'LT…' é viagem SPX", () => {
    expect(isSpxTripLh("LT0Q7G02AY851")).toBe(true);
    expect(isSpxTripLh("lt123")).toBe(true);
    expect(isSpxTripLh("B101")).toBe(false);   // Nestlé
    expect(isSpxTripLh("")).toBe(false);
    expect(isSpxTripLh(null)).toBe(false);
  });
});

describe("buildAspxAssignedByLh", () => {
  beforeEach(() => { vi.clearAllMocks(); resetAspxAssignedCacheForTests(); });
  afterEach(() => { resetAspxAssignedCacheForTests(); });

  it("verde (true) quando o motorista do sistema == o atribuído à viagem no SPX", async () => {
    fetchTripIndex.mockResolvedValue(indexOf([["LT1", "JOAO DA SILVA"]]));
    const out = await buildAspxAssignedByLh([{ lh: "LT1", motorista: "joão da silva" }]); // acento/caixa toleram
    expect(out).toEqual({ LT1: true });
  });

  it("vermelho (false) quando a viagem tem OUTRO motorista atribuído", async () => {
    fetchTripIndex.mockResolvedValue(indexOf([["LT1", "MARIA"]]));
    const out = await buildAspxAssignedByLh([{ lh: "LT1", motorista: "JOAO" }]);
    expect(out).toEqual({ LT1: false });
  });

  it("CINZA (omitido) quando a viagem não está no índice consultado — não sabemos, NÃO marca vermelho", async () => {
    // Viagem fora das abas consultadas (ex.: além da janela). Antes marcava false
    // (vermelho "não atribuído") — falso-negativo: motorista JÁ atribuído aparecia
    // como não-atribuído. Agora é omitida → selo cinza "não consultado".
    fetchTripIndex.mockResolvedValue(indexOf([]));
    const out = await buildAspxAssignedByLh([{ lh: "LT9", motorista: "JOAO" }]);
    expect("LT9" in out).toBe(false);
    expect(out).toEqual({});
  });

  it("consulta também o histórico (Concluído) — viagem atribuída já concluída fica verde", async () => {
    fetchTripIndex.mockResolvedValue(indexOf([["LT1", "JOAO"]]));
    const out = await buildAspxAssignedByLh([{ lh: "LT1", motorista: "JOAO" }]);
    expect(out).toEqual({ LT1: true });
    // O selo liga o índice com Concluído (includeConcluido) — accept/assign/preview não.
    expect(fetchTripIndex).toHaveBeenCalledWith(
      expect.objectContaining({ includeConcluido: true }),
      expect.anything(),
    );
  });

  it("vermelho (false) quando a carga não tem motorista", async () => {
    fetchTripIndex.mockResolvedValue(indexOf([["LT1", "JOAO"]]));
    const out = await buildAspxAssignedByLh([{ lh: "LT1", motorista: "" }]);
    expect(out).toEqual({ LT1: false });
  });

  it("cargas NÃO-SPX ficam fora do mapa (selo N/A)", async () => {
    fetchTripIndex.mockResolvedValue(indexOf([["LT1", "JOAO"]]));
    const out = await buildAspxAssignedByLh([{ lh: "B101", motorista: "JOAO" }, { lh: "LT1", motorista: "JOAO" }]);
    expect(out).toEqual({ LT1: true }); // B101 fora
    expect("B101" in out).toBe(false);
  });

  it("sidecar fora do ar → mapa vazio (selo 'não consultado')", async () => {
    fetchTripIndex.mockRejectedValue(new Error("SPX down"));
    const out = await buildAspxAssignedByLh([{ lh: "LT1", motorista: "JOAO" }]);
    expect(out).toEqual({});
  });

  it("sem cargas SPX → não chama o sidecar", async () => {
    const out = await buildAspxAssignedByLh([{ lh: "B101", motorista: "JOAO" }]);
    expect(out).toEqual({});
    expect(fetchTripIndex).not.toHaveBeenCalled();
  });

  it("cache: 2ª chamada dentro do TTL não re-consulta o sidecar", async () => {
    fetchTripIndex.mockResolvedValue(indexOf([["LT1", "JOAO"]]));
    await buildAspxAssignedByLh([{ lh: "LT1", motorista: "JOAO" }]);
    await buildAspxAssignedByLh([{ lh: "LT1", motorista: "JOAO" }]);
    expect(fetchTripIndex).toHaveBeenCalledTimes(1);
  });
});
