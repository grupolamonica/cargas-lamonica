import { describe, expect, it } from "vitest";

import { sanitizeLogPayload } from "./security-log.js";

describe("security-log", () => {
  it("redige chaves sensiveis e segredos inline antes de serializar logs", () => {
    const payload = sanitizeLogPayload({
      authorization: "Bearer super-secret-token",
      idempotency_key: "idem-1234567890",
      nested: {
        phone: "71999999999",
        message: "SUPABASE_SERVICE_ROLE_KEY=sbp_super_secret_value_1234567890123456",
      },
    });

    expect(payload).toEqual({
      authorization: "[REDACTED]",
      idempotency_key: "[REDACTED]",
      nested: {
        phone: "[REDACTED]",
        message: expect.stringContaining("[REDACTED]"),
      },
    });
  });

  it("preserva uuid sob chave 'algoId'/'algo_id' (identificador interno, não segredo)", () => {
    // Um uuid (36 chars) casa por completo o padrão de segredo inline (32+ chars
    // alfanuméricos/hífen) — sem esta exceção, todo cargoId/winnerId gravado em
    // audit metadata (ex.: reassign-monitor-allocations.js) virava "[REDACTED]" e
    // o revert nunca mais achava a carga certa.
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const payload = sanitizeLogPayload({
      cargoId: uuid,
      winner_id: uuid,
      moves: [{ cargoId: uuid, motorista: "JOAO" }],
    });
    expect(payload).toEqual({
      cargoId: uuid,
      winner_id: uuid,
      moves: [{ cargoId: uuid, motorista: "JOAO" }],
    });
  });

  it("redige nome de pessoa e documentos, mas preserva as chaves operacionais *Name", () => {
    const payload = sanitizeLogPayload({
      full_name: "JOAO DA SILVA",
      driver_name: "JOAO DA SILVA",
      cnh: "12345678900",
      rg: "1234567",
      cep_origem: "40000000",
      endereco: "Rua X, 100",
      // Operacionais: sustentam o debug do Monitor, não são dado pessoal.
      statusName: "CARREGADO",
      clientName: "Nestle",
      filename: "planilha.csv",
    });

    expect(payload.full_name).toBe("[REDACTED]");
    expect(payload.driver_name).toBe("[REDACTED]");
    expect(payload.cnh).toBe("[REDACTED]");
    expect(payload.rg).toBe("[REDACTED]");
    expect(payload.cep_origem).toBe("[REDACTED]");
    expect(payload.endereco).toBe("[REDACTED]");
    expect(payload.statusName).toBe("CARREGADO");
    expect(payload.clientName).toBe("Nestle");
    expect(payload.filename).toBe("planilha.csv");
  });

  it("preserva 'motorista' — o botão Reverter lê esse campo do metadata pra desfazer", () => {
    // A alocação grava só o NOME; se o sanitizador redigir 'motorista' dentro de
    // metadata->'moves', o desfazer perde o valor que precisa restaurar.
    const payload = sanitizeLogPayload({ moves: [{ motorista: "JOAO DA SILVA" }] });
    expect(payload.moves[0].motorista).toBe("JOAO DA SILVA");
  });

  it("ainda redige uma string longa sob chave 'algoId' quando ela NÃO tem formato de uuid", () => {
    // A exceção é estrita: só um uuid de verdade escapa. Um token/segredo que por
    // acaso viva sob uma chave terminada em "Id" continua caindo na regra geral.
    const payload = sanitizeLogPayload({ sessionId: "sbp_super_secret_value_1234567890123456" });
    expect(payload.sessionId).toBe("[REDACTED]");
  });
});
