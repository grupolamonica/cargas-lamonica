import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../infrastructure/angellira/angellira-client.js", () => ({
  lookupAngelliraDriverByCpf: vi.fn(),
}));
vi.mock("../../../infrastructure/aspx/aspx-directory.js", () => ({
  lookupAspxDriverByCpf: vi.fn(),
}));

import { lookupAngelliraDriverByCpf } from "../../../infrastructure/angellira/angellira-client.js";
import { lookupAspxDriverByCpf } from "../../../infrastructure/aspx/aspx-directory.js";
import { resolveExpectedDriverName } from "./resolve-expected-driver-name.js";

describe("resolveExpectedDriverName", () => {
  afterEach(() => vi.clearAllMocks());

  it("CPF sem 11 dígitos → '' sem consultar", async () => {
    expect(await resolveExpectedDriverName("123")).toBe("");
    expect(lookupAngelliraDriverByCpf).not.toHaveBeenCalled();
    expect(lookupAspxDriverByCpf).not.toHaveBeenCalled();
  });

  it("Angellira encontrou → devolve displayName (aparado), sem consultar ASPX", async () => {
    lookupAngelliraDriverByCpf.mockResolvedValue({ found: true, displayName: " BRUNA SILVA AMARAL " });
    expect(await resolveExpectedDriverName("030.703.005-96")).toBe("BRUNA SILVA AMARAL");
    expect(lookupAspxDriverByCpf).not.toHaveBeenCalled();
  });

  it("Angellira não encontrou → cai no ASPX", async () => {
    lookupAngelliraDriverByCpf.mockResolvedValue({ found: false, displayName: null });
    lookupAspxDriverByCpf.mockResolvedValue({ found: true, displayName: "JOSE EDUARDO" });
    expect(await resolveExpectedDriverName("03070300596")).toBe("JOSE EDUARDO");
  });

  it("nenhum dos dois tem o CPF → '' (fail-open, motorista novo)", async () => {
    lookupAngelliraDriverByCpf.mockResolvedValue({ found: false, displayName: null });
    lookupAspxDriverByCpf.mockResolvedValue({ found: false, displayName: null });
    expect(await resolveExpectedDriverName("03070300596")).toBe("");
  });

  it("erro nas duas consultas → '' (fail-open, indisponibilidade não trava)", async () => {
    lookupAngelliraDriverByCpf.mockRejectedValue(new Error("timeout"));
    lookupAspxDriverByCpf.mockRejectedValue(new Error("down"));
    expect(await resolveExpectedDriverName("03070300596")).toBe("");
  });
});
