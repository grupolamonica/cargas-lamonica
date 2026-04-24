// backend/src/main.js
// Entry point do servidor Express — Lamonica Cargas Backend
// Bootstrap: load-env → pg Pool → register routes → listen(PORT)

import "./infrastructure/config/load-env.js"; // side-effect: popula process.env
import crypto from "node:crypto";
import express from "express";
import { getPostgresPool } from "./infrastructure/pg/postgres.js";
import { registerRoutes } from "./interface/http/routes.js";

// ─── Constantes de middleware ─────────────────────────────────────────────────

const DEFAULT_ALLOWED_HEADERS =
  "Authorization,Content-Type,Idempotency-Key,X-Correlation-Id";
const GENERIC_ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";

// ─── CORS helper (porta lógica exata de api/[...route].mjs) ──────────────────

function resolveAllowedOrigin(requestOrigin) {
  const raw = process.env.ALLOWED_ORIGINS?.trim() || "";
  if (!raw) return null; // fail closed — sem wildcard implícito
  const allowed = raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return requestOrigin && allowed.includes(requestOrigin)
    ? requestOrigin
    : null;
}

// ─── App Express ─────────────────────────────────────────────────────────────

const app = express();

// Trust proxy — deve ser configurado antes de qualquer middleware que leia IP
if (process.env.TRUST_PROXY_HEADERS === "true") {
  app.set("trust proxy", 1);
}

// Body parsing — express.json() pré-parseia req.body; http-utils.parseJsonBody
// já faz short-circuit quando req.body é objeto, então é compatível.
app.use(express.json());

// Middleware CORS manual (porta fiel de api/[...route].mjs)
app.use((req, res, next) => {
  const requestOrigin = req.headers["origin"];
  const allowedOrigin = resolveAllowedOrigin(requestOrigin);

  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", DEFAULT_ALLOWED_HEADERS);
    res.setHeader("Access-Control-Allow-Methods", GENERIC_ALLOWED_METHODS);
  }

  // OPTIONS preflight — responde 204 e encerra
  if (req.method === "OPTIONS") {
    if (!allowedOrigin) return res.status(403).end();
    return res.status(204).end();
  }

  next();
});

// Middleware X-Correlation-Id — lê da request ou gera, ecoa na response
app.use((req, res, next) => {
  const incoming = req.headers["x-correlation-id"];
  const correlationId =
    incoming && /^[\w\-]{1,64}$/.test(incoming)
      ? incoming
      : crypto.randomUUID();
  req.correlationId = correlationId; // disponível para handlers via req
  res.setHeader("X-Correlation-Id", correlationId);
  next();
});

// ─── Endpoint /health ─────────────────────────────────────────────────────────
// Usado como Docker healthcheck na Phase 3.
// Verifica pg Pool com query leve; verifica Supabase via presença da service key
// (evita round-trip externo no healthcheck — Supabase é serviço gerenciado externo).

app.get("/health", async (req, res) => {
  let pgStatus = "ok";
  let supabaseStatus = "ok";

  try {
    const pool = getPostgresPool();
    await pool.query("SELECT 1");
  } catch {
    pgStatus = "error";
  }

  // Supabase: verificação de config (service role key presente = cliente configurado)
  // Para healthcheck Docker não queremos latência de round-trip para Supabase Auth.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    supabaseStatus = "error";
  }

  const isOk = pgStatus === "ok" && supabaseStatus === "ok";
  const httpStatus = isOk ? 200 : 503;

  return res.status(httpStatus).json({
    status: isOk ? "ok" : "degraded",
    pg: pgStatus,
    supabase: supabaseStatus,
  });
});

// ─── Rotas de negócio ─────────────────────────────────────────────────────────
// Chamada via Plano 02 — registra os 43 endpoints no Express Router.
// Posicionado após middlewares globais, antes de app.listen().

// ─── Inicialização ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3001", 10);

// Bootstrap sequencial: pg Pool é inicializado antes de começar a escutar.
// Falha ruidosamente se deps não inicializarem — sem fallback silencioso.
async function bootstrap() {
  // 1. Verificar pg Pool
  const pool = getPostgresPool();
  await pool.query("SELECT 1"); // falha aqui se DATABASE_URL inválida

  // 2. Verificar Supabase (config mínima)
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios no .env"
    );
  }

  // 3. Registrar rotas de negócio (43 endpoints)
  registerRoutes(app);

  // 4. Iniciar HTTP server
  const server = app.listen(PORT, () => {
    console.log(`[lamonica-backend] Servidor ouvindo em http://localhost:${PORT}`);
    console.log(`[lamonica-backend] GET /health disponível`);
  });

  // ─── Graceful shutdown ──────────────────────────────────────────────────────
  // SIGTERM: enviado pelo Docker / orquestrador durante deploy/parada controlada.
  // SIGINT:  Ctrl+C em desenvolvimento.

  async function gracefulShutdown(signal) {
    console.log(`[lamonica-backend] ${signal} recebido — iniciando graceful shutdown`);

    // Parar de aceitar novas conexões
    server.close(async () => {
      console.log("[lamonica-backend] HTTP server fechado");

      try {
        await getPostgresPool().end();
        console.log("[lamonica-backend] pg Pool drenado");
      } catch (err) {
        console.error("[lamonica-backend] Erro ao drenar pg Pool:", err);
      }

      console.log("[lamonica-backend] Shutdown completo");
      process.exit(0);
    });

    // Timeout de segurança: força saída se shutdown demorar > 10s
    setTimeout(() => {
      console.error("[lamonica-backend] Timeout no shutdown — forçando saída");
      process.exit(1);
    }, 10_000);
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

bootstrap().catch((err) => {
  console.error("[lamonica-backend] Falha no bootstrap:", err);
  process.exit(1);
});
