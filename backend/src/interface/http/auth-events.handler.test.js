import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Beacon do ciclo de autenticacao (DC-283 / ALTO-16).
 *
 * A garantia que importa: o ATOR sai do Bearer token, nunca do corpo. Se o
 * corpo pudesse dizer de quem e o login, o endpoint viraria uma forma de
 * plantar entrada falsa na trilha em nome de outra pessoa — e a auditoria
 * passaria a valer menos do que nao ter auditoria.
 */

const auditEvents = [];
vi.mock("../../infrastructure/security-audit.js", () => ({
  recordSecurityAuditEvent: async (event) => {
    auditEvents.push(event);
  },
}));

const { mockResolveActor } = vi.hoisted(() => ({ mockResolveActor: vi.fn() }));
vi.mock("../../application/load-claims/candidatura-actor.js", () => ({
  resolveCandidaturaActor: mockResolveActor,
}));

const { resolveAuthSessionEventResponse, resetAuthEventsRateLimitForTests } = await import(
  "./auth-events.handler.js"
);

function request(body, { ip = "203.0.113.7", token = "token-valido" } = {}) {
  return {
    method: "POST",
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "x-forwarded-for": ip },
  };
}

describe("POST /api/auth/session-event", () => {
  beforeEach(() => {
    auditEvents.length = 0;
    mockResolveActor.mockReset();
    resetAuthEventsRateLimitForTests();
  });

  it("registra a entrada com o ator vindo do TOKEN, ignorando o corpo", async () => {
    mockResolveActor.mockResolvedValueOnce({
      actor: { type: "operator", user: { id: "operador-real" } },
    });

    const r = await resolveAuthSessionEventResponse(
      // O corpo tenta se passar por outra pessoa...
      request({ event: "signed_in", actorUserId: "vitima-999", actor_role: "admin" }),
    );

    expect(r.statusCode).toBe(204);
    expect(auditEvents).toHaveLength(1);
    // ...e o registro sai com quem o TOKEN diz.
    expect(auditEvents[0].actorUserId).toBe("operador-real");
    expect(auditEvents[0].actorRole).toBe("operator");
    expect(auditEvents[0].eventType).toBe("auth.session.signed_in");
    expect(auditEvents[0].requestIp).toBe("203.0.113.7");
    // Nada do corpo forjado vazou pro evento.
    expect(JSON.stringify(auditEvents[0])).not.toContain("vitima-999");
  });

  it("registra a saida", async () => {
    mockResolveActor.mockResolvedValueOnce({
      actor: { type: "driver", user: { id: "motorista-1" } },
    });

    const r = await resolveAuthSessionEventResponse(request({ event: "signed_out" }));

    expect(r.statusCode).toBe(204);
    expect(auditEvents[0].eventType).toBe("auth.session.signed_out");
    expect(auditEvents[0].actorRole).toBe("driver");
  });

  it("sem sessao valida nao grava nada", async () => {
    mockResolveActor.mockResolvedValueOnce({ actor: { type: "public" } });

    const r = await resolveAuthSessionEventResponse(request({ event: "signed_in" }));

    expect(r.statusCode).toBe(401);
    expect(auditEvents).toHaveLength(0);
  });

  it("propaga o erro do resolvedor de sessao (token invalido)", async () => {
    mockResolveActor.mockResolvedValueOnce({
      errorResponse: { statusCode: 401, payload: { error: "Unauthorized" } },
    });

    const r = await resolveAuthSessionEventResponse(request({ event: "signed_in" }));

    expect(r.statusCode).toBe(401);
    expect(auditEvents).toHaveLength(0);
  });

  it("recusa tipo de evento fora do enum", async () => {
    mockResolveActor.mockResolvedValue({ actor: { type: "operator", user: { id: "op" } } });

    const r = await resolveAuthSessionEventResponse(request({ event: "virou_admin" }));

    // 422 e a convencao do codebase pra payload invalido (zodErrorToHttpResponse).
    expect(r.statusCode).toBe(422);
    expect(auditEvents).toHaveLength(0);
  });

  it("corta rajada por IP — a trilha nao pode ser inundada por quem tem sessao", async () => {
    mockResolveActor.mockResolvedValue({ actor: { type: "operator", user: { id: "op" } } });

    for (let i = 0; i < 10; i += 1) {
      const ok = await resolveAuthSessionEventResponse(request({ event: "signed_in" }));
      expect(ok.statusCode).toBe(204);
    }

    const bloqueado = await resolveAuthSessionEventResponse(request({ event: "signed_in" }));
    expect(bloqueado.statusCode).toBe(429);
    expect(auditEvents).toHaveLength(10);
  });
});
