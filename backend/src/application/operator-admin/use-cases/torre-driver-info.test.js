import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../infrastructure/torre/torre-client.js", () => ({
  lookupTorreDriverByCpf: vi.fn(),
}));

import { lookupTorreDriverByCpf } from "../../../infrastructure/torre/torre-client.js";
import { fetchTorreDriverInfo } from "./torre-driver-info.js";

const TORRE_DATA = {
  cpf: "04943235662",
  cadastroTorre: true,
  fonte: "torre",
  geradoEm: "2026-07-03T12:00:00.000Z",
  identidade: {
    name: "UBIRAJARA CARNEIRO",
    driverKind: "AGR",
    cidade: "SALVADOR",
    estado: "BA",
    shopeeDriverId: "383833",
  },
  conformidade: {
    operationalScore: 100,
    angelliraStatus: "Conforme",
    angelliraValidUntil: "2026-08-06",
    anttValid: true,
    documentsValid: true,
    insuranceValid: false,
    operationalBlocked: false,
  },
  ranking: { encontrado: true, posicao: 810, pontuacao: -1, vinculo: "TERCEIRO", status: "ATIVO" },
  viagens: { total: 12, completas: 10, canceladas: 1, emAndamento: 1, pctNoPrazo: 90, ultima: "2026-06-30" },
  ocorrencias: { total: 7, itens: [] },
  localizacao: { lat: -8.2, lng: -34.9, ultimaPosicao: { at: "2026-06-07", veiculo: "AUS2A24" } },
  veiculos: [{ plate: "AUS2A24" }],
  documentos: [{ tipo: "CNH" }],
};

describe("fetchTorreDriverInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("200 found:true com recorte enxuto (ranking + sinais)", async () => {
    lookupTorreDriverByCpf.mockResolvedValueOnce({ found: true, data: TORRE_DATA });

    const result = await fetchTorreDriverInfo({ cpf: "04943235662", correlationId: "c-1" });

    expect(result.statusCode).toBe(200);
    expect(result.payload.found).toBe(true);
    expect(result.payload.torre.ranking).toEqual({
      encontrado: true,
      posicao: 810,
      pontuacao: -1,
      vinculo: "TERCEIRO",
      status: "ATIVO",
    });
    expect(result.payload.torre.identidade.nome).toBe("UBIRAJARA CARNEIRO");
    expect(result.payload.torre.conformidade.operationalScore).toBe(100);
    expect(result.payload.torre.viagens.total).toBe(12);
    expect(result.payload.torre.ocorrencias).toEqual({ total: 7 });
    // Blocos pesados não vazam para a ficha.
    expect(result.payload.torre.veiculos).toBeUndefined();
    expect(result.payload.torre.documentos).toBeUndefined();
  });

  it("200 found:false quando CPF sem vestígio na Torre", async () => {
    lookupTorreDriverByCpf.mockResolvedValueOnce({ found: false, data: null });

    const result = await fetchTorreDriverInfo({ cpf: "04943235662", correlationId: "c-2" });

    expect(result.statusCode).toBe(200);
    expect(result.payload).toMatchObject({ ok: true, found: false, torre: null });
  });

  it("mapeia TORRE_INVALID_INPUT para 400", async () => {
    lookupTorreDriverByCpf.mockRejectedValueOnce(new Error("TORRE_INVALID_INPUT"));
    const result = await fetchTorreDriverInfo({ cpf: "123" });
    expect(result.statusCode).toBe(400);
  });

  it("mapeia TORRE_NOT_CONFIGURED para 503 TorreNotConfigured", async () => {
    lookupTorreDriverByCpf.mockRejectedValueOnce(new Error("TORRE_NOT_CONFIGURED"));
    const result = await fetchTorreDriverInfo({ cpf: "04943235662" });
    expect(result.statusCode).toBe(503);
    expect(result.payload.error).toBe("TorreNotConfigured");
  });

  it("mapeia TORRE_UNAUTHORIZED para 503 TorreNotConfigured", async () => {
    lookupTorreDriverByCpf.mockRejectedValueOnce(new Error("TORRE_UNAUTHORIZED"));
    const result = await fetchTorreDriverInfo({ cpf: "04943235662" });
    expect(result.statusCode).toBe(503);
    expect(result.payload.error).toBe("TorreNotConfigured");
  });

  it("mapeia TORRE_SOURCE_TIMEOUT para 504", async () => {
    lookupTorreDriverByCpf.mockRejectedValueOnce(new Error("TORRE_SOURCE_TIMEOUT"));
    const result = await fetchTorreDriverInfo({ cpf: "04943235662" });
    expect(result.statusCode).toBe(504);
    expect(result.payload.error).toBe("TorreTimeout");
  });

  it("mapeia TORRE_SOURCE_UNAVAILABLE para 503 TorreUnavailable", async () => {
    lookupTorreDriverByCpf.mockRejectedValueOnce(new Error("TORRE_SOURCE_UNAVAILABLE"));
    const result = await fetchTorreDriverInfo({ cpf: "04943235662" });
    expect(result.statusCode).toBe(503);
    expect(result.payload.error).toBe("TorreUnavailable");
  });

  it("mapeia erro desconhecido para 502", async () => {
    lookupTorreDriverByCpf.mockRejectedValueOnce(new Error("TORRE_API_ERROR:418"));
    const result = await fetchTorreDriverInfo({ cpf: "04943235662" });
    expect(result.statusCode).toBe(502);
  });
});
