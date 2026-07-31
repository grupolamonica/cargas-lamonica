import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../security-log.js", () => ({ logStructuredEvent: vi.fn() }));
vi.mock("../metrics.js", () => ({ recordDriverValidationIntegrationResult: vi.fn() }));

import {
  mapAngelliraRecord,
  lookupAngelliraDriverByCpf,
  resetAngelliraClientStateForTests,
} from "./angellira-client.js";

beforeEach(() => {
  resetAngelliraClientStateForTests();
});
afterEach(() => {
  vi.clearAllMocks();
});

// DC-329: a consulta por CPF NÃO pode adotar cegamente o primeiro registro —
// tem que casar o driverCPF com o CPF consultado (senão volta motorista errado).
describe("mapAngelliraRecord / CPF — seleção pelo driverCPF (DC-329)", () => {
  it("retorna o registro cujo driverCPF bate — mesmo que NÃO seja o primeiro", () => {
    const payload = {
      data: [
        // data[0] é OUTRA pessoa (mais recente por -sentDate) — a armadilha antiga.
        { id: 1, history: { driverName: "PESSOA ERRADA", driverCPF: "99999999999" }, status: { description: "Conforme" } },
        { id: 2, history: { driverName: "PESSOA CERTA", driverCPF: "12345678901" }, status: { description: "Conforme" } },
      ],
    };
    const r = mapAngelliraRecord("cpf", "12345678901", payload);
    expect(r.found).toBe(true);
    expect(r.status).toBe("FOUND");
    expect(r.displayName).toBe("PESSOA CERTA");
    expect(r.driverDetails?.cpf).toBe("12345678901");
  });

  it("NÃO retorna motorista quando nenhum driverCPF bate → NOT_FOUND", () => {
    const payload = {
      data: [
        { id: 1, history: { driverName: "PESSOA ERRADA", driverCPF: "99999999999" }, status: { description: "Conforme" } },
      ],
    };
    const r = mapAngelliraRecord("cpf", "12345678901", payload);
    expect(r.found).toBe(false);
    expect(r.status).toBe("NOT_FOUND");
    expect(r.displayName).toBeNull();
  });

  it("casa mesmo com máscara/formatação no driverCPF do registro", () => {
    const payload = {
      data: [{ id: 3, history: { driverName: "FULANO", driverCPF: "123.456.789-01" }, status: { description: "Conforme" } }],
    };
    const r = mapAngelliraRecord("cpf", "12345678901", payload);
    expect(r.found).toBe(true);
    expect(r.displayName).toBe("FULANO");
  });

  it("data vazio → NOT_FOUND", () => {
    expect(mapAngelliraRecord("cpf", "12345678901", { data: [] }).found).toBe(false);
    expect(mapAngelliraRecord("cpf", "12345678901", {}).status).toBe("NOT_FOUND");
  });
});

describe("mapAngelliraRecord / placa — mantém o primeiro resultado", () => {
  it("placa usa data[0] (comportamento inalterado)", () => {
    const payload = {
      data: [{ id: 9, history: { cabPlate: "ABC1D23", cabBrand: "SCANIA" }, status: { description: "Conforme" } }],
    };
    const r = mapAngelliraRecord("plate", "ABC1D23", payload);
    expect(r.found).toBe(true);
    expect(r.vehicleDetails?.plate).toBe("ABC1D23");
    expect(r.vehicleDetails?.classification).toBe("cavalo");
  });
});

// DC-329: CPF com != 11 dígitos (ex.: zero à esquerda perdido) é barrado ANTES
// de consultar — evita o match parcial que devolvia outra pessoa.
describe("lookupAngelliraDriverByCpf / guarda de 11 dígitos (DC-329)", () => {
  it("CPF com 10 dígitos → NOT_FOUND sem consultar (não UNAVAILABLE)", async () => {
    const r = await lookupAngelliraDriverByCpf("0123456789"); // 10 dígitos
    expect(r.status).toBe("NOT_FOUND");
    expect(r.found).toBe(false);
  });

  it("CPF mascarado que normaliza p/ 10 dígitos → NOT_FOUND", async () => {
    const r = await lookupAngelliraDriverByCpf("123.456.789-0");
    expect(r.status).toBe("NOT_FOUND");
    expect(r.found).toBe(false);
  });
});
