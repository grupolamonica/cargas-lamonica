import { describe, expect, it } from "vitest";

import { friendlyOutreachError } from "./outreach-errors";

describe("friendlyOutreachError", () => {
  it("retorna null para vazio/nulo", () => {
    expect(friendlyOutreachError(null)).toBeNull();
    expect(friendlyOutreachError(undefined)).toBeNull();
    expect(friendlyOutreachError("")).toBeNull();
    expect(friendlyOutreachError("   ")).toBeNull();
  });

  it("traduz o erro cru do print (Evolution 500 / Connection Closed) para desconexão", () => {
    const raw =
      'Error: EVOLUTION_HTTP_500:{"status":500,"error":"Internal Server Error","response":{"message":"Connection Closed"}}';
    const out = friendlyOutreachError(raw);
    expect(out).toContain("WhatsApp desconectado");
    expect(out).toContain("Automação");
    // Nunca vaza o texto técnico:
    expect(out).not.toContain("EVOLUTION_HTTP");
    expect(out).not.toContain("{");
  });

  it("mapeia códigos internos conhecidos", () => {
    expect(friendlyOutreachError("opted_out")).toContain("não perturbe");
    expect(friendlyOutreachError("cold_disabled")).toContain("Gatilho frio");
    expect(friendlyOutreachError("not_in_test_allowlist")).toContain(
      "lista permitida",
    );
  });

  it("mapeia autenticação, número inválido e rede", () => {
    expect(friendlyOutreachError("Error: EVOLUTION_HTTP_401")).toContain(
      "autenticação",
    );
    expect(friendlyOutreachError("EVOLUTION_HTTP_400: invalid number")).toContain(
      "número de telefone",
    );
    expect(friendlyOutreachError("FetchError: ECONNREFUSED 127.0.0.1")).toContain(
      "Tente novamente em instantes",
    );
  });

  it("deixa passar mensagens que já são legíveis", () => {
    expect(friendlyOutreachError("cancelado pelo operador")).toBe(
      "cancelado pelo operador",
    );
    const angellira = "já cadastrado no Angellira (vigente até 28/09/2026)";
    expect(friendlyOutreachError(angellira)).toBe(angellira);
  });

  it("usa fallback genérico para qualquer coisa técnica desconhecida", () => {
    const out = friendlyOutreachError("Error: TypeError undefined is not a function");
    expect(out).toContain("Não foi possível enviar agora");
    const code = friendlyOutreachError("algum_codigo_novo_qualquer");
    expect(code).toContain("Não foi possível enviar agora");
  });
});
