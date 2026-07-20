import { describe, expect, it } from "vitest";
import express from "express";

import { registerRoutes } from "../routes.js";

// Regressão do wiring do driver-outreach: a entrega original exportava 29
// handlers mas só registrava ~13 no routes.js — Chat, Envio em massa,
// Templates, Notificações e a Fila (detalhe/criar/enviar/revalidar)
// respondiam 404 mesmo com a tela chamando os endpoints. Este teste trava a
// lista completa de rotas que o frontend (readModels.ts) consome.

function collectRoutes(app) {
  const found = new Set();
  for (const layer of app._router.stack) {
    const stack = layer.handle?.stack;
    if (!Array.isArray(stack)) continue;
    for (const l of stack) {
      if (!l.route) continue;
      for (const method of Object.keys(l.route.methods)) {
        found.add(`${method.toUpperCase()} ${l.route.path}`);
      }
    }
  }
  return found;
}

describe("driver-outreach — wiring completo das rotas", () => {
  const app = express();
  registerRoutes(app);
  const routes = collectRoutes(app);

  const expected = [
    // Fila de envio
    "POST /api/operator/outreach/queue",
    "POST /api/operator/outreach/queue/revalidate",
    "GET /api/operator/outreach/queue/:id",
    "PATCH /api/operator/outreach/queue/:id",
    "POST /api/operator/outreach/queue/:id/send",
    "POST /api/operator/outreach/queue/:id/cancel",
    // Templates + reconciliação
    "GET /api/operator/outreach/message-templates",
    "PATCH /api/operator/outreach/message-templates",
    "POST /api/operator/outreach/reconcile-registrations",
    // Notificações do operador
    "GET /api/operator/notifications",
    "POST /api/operator/notifications/seen",
    "POST /api/operator/notifications/clear",
    // Chat
    "GET /api/operator/chat/conversations",
    "GET /api/operator/chat/messages",
    "POST /api/operator/chat/send",
    // Disparo em massa
    "GET /api/operator/mass-outreach/routes",
    "POST /api/operator/mass-outreach/preview",
    "POST /api/operator/mass-outreach/enqueue",
    // Já existentes (não regredir)
    "GET /api/operator/outreach/overview",
    "PATCH /api/operator/outreach/settings",
    "POST /api/webhooks/evolution",
    // WhatsApp do Repom (número dedicado ao cadastro — Fase 2b)
    "GET /api/operator/repom/whatsapp/status",
    "POST /api/operator/repom/whatsapp/connect",
    "POST /api/operator/repom/whatsapp/disconnect",
  ];

  for (const route of expected) {
    it(`registra ${route}`, () => {
      expect(routes.has(route)).toBe(true);
    });
  }
});
