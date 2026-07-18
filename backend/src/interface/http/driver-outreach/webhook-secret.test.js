import { afterEach, describe, expect, it } from "vitest";

import { resolveEvolutionWebhookResponse } from "./handlers.js";

// Guard de segredo do webhook público /api/webhooks/evolution: quando
// EVOLUTION_WEBHOOK_SECRET está definido, chamadas sem `?secret=` (ou header
// x-webhook-secret) correto são rejeitadas com 401 ANTES de qualquer efeito.
// Sem o env, mantém compatibilidade (aceita — módulo fica OFF por padrão).

const originalSecret = process.env.EVOLUTION_WEBHOOK_SECRET;

function webhookRequest({ query = {}, headers = {}, event = "unknown.event" } = {}) {
  return {
    body: JSON.stringify({ event }),
    headers,
    method: "POST",
    query,
    url: "/api/webhooks/evolution",
  };
}

afterEach(() => {
  if (originalSecret === undefined) delete process.env.EVOLUTION_WEBHOOK_SECRET;
  else process.env.EVOLUTION_WEBHOOK_SECRET = originalSecret;
});

describe("evolution webhook — segredo compartilhado", () => {
  it("rejeita com 401 quando o secret está configurado e não foi enviado", async () => {
    process.env.EVOLUTION_WEBHOOK_SECRET = "s3cr3t";
    const res = await resolveEvolutionWebhookResponse(webhookRequest());
    expect(res.statusCode).toBe(401);
    expect(res.payload).toMatchObject({ error: "UNAUTHORIZED" });
  });

  it("rejeita com 401 quando o secret enviado está incorreto", async () => {
    process.env.EVOLUTION_WEBHOOK_SECRET = "s3cr3t";
    const res = await resolveEvolutionWebhookResponse(webhookRequest({ query: { secret: "errado" } }));
    expect(res.statusCode).toBe(401);
  });

  it("aceita via querystring ?secret= (formato da EVOLUTION_WEBHOOK_URL)", async () => {
    process.env.EVOLUTION_WEBHOOK_SECRET = "s3cr3t";
    const res = await resolveEvolutionWebhookResponse(webhookRequest({ query: { secret: "s3cr3t" } }));
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ ok: true });
  });

  it("aceita via header x-webhook-secret", async () => {
    process.env.EVOLUTION_WEBHOOK_SECRET = "s3cr3t";
    const res = await resolveEvolutionWebhookResponse(
      webhookRequest({ headers: { "x-webhook-secret": "s3cr3t" } }),
    );
    expect(res.statusCode).toBe(200);
  });

  it("sem o env definido, mantém o comportamento anterior (aceita)", async () => {
    delete process.env.EVOLUTION_WEBHOOK_SECRET;
    const res = await resolveEvolutionWebhookResponse(webhookRequest());
    expect(res.statusCode).toBe(200);
  });
});
