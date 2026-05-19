// backend/src/main.js
// Entry point do servidor Express — Lamonica Cargas Backend
// Bootstrap: load-env → pg Pool → register routes → listen(PORT)

import "./infrastructure/config/load-env.js"; // side-effect: popula process.env
import crypto from "node:crypto";
import express from "express";
import { getPostgresPool } from "./infrastructure/pg/postgres.js";
import { closeRedisClient } from "./infrastructure/redis.js";
import { registerRoutes } from "./interface/http/routes.js";
import { logger } from "./infrastructure/logger.js";

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

// Retry pg connection with exponential backoff. Returns true if connected.
// Never throws — on exhaustion the server starts degraded (routes fail with 500).
async function waitForPg(pool, maxAttempts = 8) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await pool.query("SELECT 1");
      return true;
    } catch (err) {
      const delayMs = Math.min(5_000 * 2 ** i, 60_000);
      logger.warn({ attempt: i + 1, maxAttempts, delayMs, err }, "pg connection attempt failed — retrying");
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  logger.error({}, "Could not connect to pg after all attempts — starting in degraded mode");
  return false;
}

// Bootstrap sequencial: valida env vars → aguarda pg (com retry) → registra rotas → listen.
async function bootstrap() {
  // 1. Verificar pg Pool (com retry — não mata o processo em falha transitória)
  const pool = getPostgresPool();
  await waitForPg(pool);

  // 2. Verificar Supabase (config mínima)
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios no .env"
    );
  }

  // 2b. Garantir tabela analytics_events (idempotente — cria se não existir)
  //     Isso evita dependência de migração manual no Supabase para analytics.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.analytics_events (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        event_type text NOT NULL,
        data jsonb DEFAULT '{}',
        created_at timestamptz DEFAULT now() NOT NULL
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_events_type_created
        ON public.analytics_events(event_type, created_at DESC)
    `);
    logger.info({}, "analytics_events: OK");
  } catch (err) {
    // Não bloqueia o startup — tabela pode já existir com permissões diferentes
    logger.warn({ err }, "analytics_events setup warning");
  }

  // 3. Registrar rotas de negócio (43 endpoints)
  registerRoutes(app);

  // 4. Periodic sheet sync — every 5 min, no-op if GOOGLE_SHEET_ID not set
  {
    let sheetSyncRunning = false;
    setInterval(async () => {
      if (sheetSyncRunning || !process.env.GOOGLE_SHEET_ID) return;
      sheetSyncRunning = true;
      try {
        const { syncGoogleSheetLoads, createSupabaseAdminClient } = await import("./application/google-sheets/google-sheet-loads.js");
        await syncGoogleSheetLoads({ supabaseClient: createSupabaseAdminClient() });
        logger.info({}, "sheet-sync-periodic: sync concluído");
      } catch (err) {
        logger.error({ err }, "sheet-sync-periodic: erro");
      } finally {
        sheetSyncRunning = false;
      }
    }, 5 * 60 * 1000);
  }

  // 4b. Sheet sync job worker — processes operator-triggered async syncs every 30s
  {
    setInterval(async () => {
      if (!process.env.GOOGLE_SHEET_ID) return;
      try {
        const { processNextSheetSyncJob } = await import("./application/operator-admin/use-cases/sheet-sync-queue.js");
        await processNextSheetSyncJob();
      } catch (err) {
        logger.error({ err }, "sheet-sync-worker: erro");
      }
    }, 30_000);
  }

  // 5. Iniciar HTTP server
  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "Servidor ouvindo");
    logger.info({}, "GET /health disponível");
  });

  // ─── Graceful shutdown ──────────────────────────────────────────────────────
  // SIGTERM: enviado pelo Docker / orquestrador durante deploy/parada controlada.
  // SIGINT:  Ctrl+C em desenvolvimento.

  async function gracefulShutdown(signal) {
    logger.info({ signal }, "sinal recebido — iniciando graceful shutdown");

    // Parar de aceitar novas conexões (closeAllConnections fecha keep-alive pendentes)
    server.closeAllConnections?.();
    server.close(async () => {
      logger.info({}, "HTTP server fechado");

      try {
        await getPostgresPool().end();
        logger.info({}, "pg Pool drenado");
      } catch (err) {
        logger.error({ err }, "Erro ao drenar pg Pool");
      }

      try {
        await closeRedisClient();
        logger.info({}, "Redis desconectado");
      } catch (err) {
        logger.error({ err }, "Erro ao fechar Redis");
      }

      logger.info({}, "Shutdown completo");
      process.exit(0);
    });

    // Timeout de segurança: força saída se shutdown demorar > 10s
    setTimeout(() => {
      logger.error({}, "Timeout no shutdown — forçando saída");
      process.exit(1);
    }, 10_000);
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

bootstrap().catch((err) => {
  logger.error({ err }, "Falha no bootstrap");
  process.exit(1);
});
