// backend/src/main.js
// Entry point do servidor Express — Lamonica Cargas Backend
// Bootstrap: load-env → pg Pool → register routes → listen(PORT)

import "./infrastructure/config/load-env.js"; // side-effect: popula process.env
import crypto from "node:crypto";
import express from "express";
import compression from "compression";
import helmet from "helmet";
import { getPostgresPool, getPostgresPoolStats } from "./infrastructure/pg/postgres.js";
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

// ── Security headers (helmet) ───────────────────────────────────────────────
// Antes de tudo: HSTS, X-Frame-Options, X-Content-Type-Options, etc.
// CSP desativado por enquanto — frontend é servido por nginx separado e CSP
// estrita aqui poderia quebrar páginas servidas em mesmo origin durante deploys.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

// ── Compression (gzip/brotli via accept-encoding negotiation) ───────────────
// Comprime respostas >1KB. Threshold default razoável; payloads menores que
// 1KB não pagam o custo do gzip. Reduz JSON de listagens (cargas, leads) em
// 60-80%. Skipping bytes pequenos evita CPU overhead em healthcheck.
app.use(
  compression({
    threshold: 1024,
    // Compressão padrão para JSON; pula respostas já comprimidas (imagens, etc.)
    filter: (req, res) => {
      if (req.headers["x-no-compression"]) return false;
      return compression.filter(req, res);
    },
  }),
);

// Body parsing — express.json() pré-parseia req.body; http-utils.parseJsonBody
// já faz short-circuit quando req.body é objeto, então é compatível.
// Limite de 1MB previne abuse via payloads gigantes (mutations operator-admin
// hoje cabem em ~50KB; OCR usa endpoint próprio com multer).
app.use(express.json({ limit: "1mb" }));

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
// Docker healthcheck — deve ser rápido e determinístico.
// "shallow" (default): apenas valida config (sem round-trip pg) — ~1ms.
// "deep" (`?deep=1`): faz SELECT 1 contra pg — útil em monitoring externo.
// O healthcheck do Docker (interval 30s) usa shallow; pollings externos podem
// solicitar deep periodicamente sem sobrecarregar pool.

app.get("/health", async (req, res) => {
  const wantDeep = req.query.deep === "1" || req.query.deep === "true";
  const supabaseStatus = process.env.SUPABASE_SERVICE_ROLE_KEY ? "ok" : "error";
  let pgStatus = "ok";

  if (wantDeep) {
    try {
      await getPostgresPool().query("SELECT 1");
    } catch {
      pgStatus = "error";
    }
  }

  const isOk = pgStatus === "ok" && supabaseStatus === "ok";
  return res.status(isOk ? 200 : 503).json({
    status: isOk ? "ok" : "degraded",
    pg: pgStatus,
    supabase: supabaseStatus,
    deep: wantDeep,
  });
});

// ─── Endpoint /metrics ────────────────────────────────────────────────────────
// Métricas mínimas para Prometheus / observabilidade externa: pool pg, memory,
// uptime. Formato Prometheus text exposition (text/plain). Não exposto via
// Traefik por padrão (path /metrics não roteado externamente — usar exec ou
// monitoramento interno via network platform_monitoring).
app.get("/metrics", (req, res) => {
  const poolStats = getPostgresPoolStats();
  const mem = process.memoryUsage();
  const lines = [
    "# HELP lamonica_pg_pool_total Total pg connections (idle+active)",
    "# TYPE lamonica_pg_pool_total gauge",
    `lamonica_pg_pool_total ${poolStats.total}`,
    "# HELP lamonica_pg_pool_idle Idle pg connections available",
    "# TYPE lamonica_pg_pool_idle gauge",
    `lamonica_pg_pool_idle ${poolStats.idle}`,
    "# HELP lamonica_pg_pool_waiting Requests queued waiting for a connection",
    "# TYPE lamonica_pg_pool_waiting gauge",
    `lamonica_pg_pool_waiting ${poolStats.waiting}`,
    "# HELP lamonica_pg_pool_max Configured pg pool ceiling",
    "# TYPE lamonica_pg_pool_max gauge",
    `lamonica_pg_pool_max ${poolStats.max}`,
    "# HELP lamonica_process_memory_rss_bytes Resident set size",
    "# TYPE lamonica_process_memory_rss_bytes gauge",
    `lamonica_process_memory_rss_bytes ${mem.rss}`,
    "# HELP lamonica_process_memory_heap_used_bytes V8 heap used",
    "# TYPE lamonica_process_memory_heap_used_bytes gauge",
    `lamonica_process_memory_heap_used_bytes ${mem.heapUsed}`,
    "# HELP lamonica_process_uptime_seconds Process uptime",
    "# TYPE lamonica_process_uptime_seconds counter",
    `lamonica_process_uptime_seconds ${process.uptime()}`,
    "",
  ];
  res.setHeader("Content-Type", "text/plain; version=0.0.4");
  res.status(200).send(lines.join("\n"));
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
      console.warn(
        `[lamonica-backend] pg connection attempt ${i + 1}/${maxAttempts} failed (${err.message}) — retrying in ${delayMs / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.error(
    "[lamonica-backend] Could not connect to pg after all attempts — starting in degraded mode",
  );
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
    console.info("[lamonica-backend] analytics_events: OK");
  } catch (err) {
    // Não bloqueia o startup — tabela pode já existir com permissões diferentes
    console.warn("[lamonica-backend] analytics_events setup warning:", err?.message);
  }

  // 3. Registrar rotas de negócio (43 endpoints)
  registerRoutes(app);

  // 4. Periodic sheet sync — every SHEET_SYNC_INTERVAL_MIN (default 5min).
  //    No-op se GOOGLE_SHEET_ID ausente OU SHEET_SYNC_INLINE=false (off-load
  //    para cron / job worker externo em deploys multi-replica). Jitter ±30s
  //    evita thundering herd em deploys com várias replicas inicializando
  //    simultaneamente.
  if (process.env.SHEET_SYNC_INLINE !== "false") {
    let sheetSyncRunning = false;
    const intervalMin = Number(process.env.SHEET_SYNC_INTERVAL_MIN || 5);
    const intervalMs = Math.max(1, intervalMin) * 60 * 1000;
    const jitterMs = Math.floor(Math.random() * 30_000) - 15_000; // ±15s

    setInterval(async () => {
      if (sheetSyncRunning || !process.env.GOOGLE_SHEET_ID) return;
      sheetSyncRunning = true;
      const startedAt = Date.now();
      try {
        const { syncAllSheetSources } = await import("./application/google-sheets/google-sheet-loads.js");
        const { createSupabaseAdminClient } = await import("./infrastructure/supabase/admin-client.js");
        const adminClient = createSupabaseAdminClient();
        // Sincroniza TODAS as fontes (Shopee + Nestlé) em sequência, cada uma
        // isolada: uma falha (ex.: cliente Nestlé ausente) não aborta a Shopee.
        await syncAllSheetSources({ supabaseClient: adminClient });
        // Sync da aba "Vinculo" (motorista -> vínculo) em paralelo lógico ao de
        // cargas. Não-fatal: uma falha aqui não deve abortar o ciclo de cargas.
        try {
          const { syncDriverVinculos } = await import("./application/google-sheets/driver-vinculos.js");
          await syncDriverVinculos({ supabaseClient: adminClient });
        } catch (vinculoErr) {
          console.error("[sheet-sync-periodic] erro no sync de vinculos:", vinculoErr?.message);
        }
        const durationMs = Date.now() - startedAt;
        console.info(`[sheet-sync-periodic] sync concluído em ${durationMs}ms`);
        if (durationMs > 30_000) {
          console.warn(
            `[sheet-sync-periodic] duração elevada (${durationMs}ms) — considerar mover para worker dedicado (SHEET_SYNC_INLINE=false + cron)`,
          );
        }
      } catch (err) {
        console.error("[sheet-sync-periodic] erro:", err?.message);
      } finally {
        sheetSyncRunning = false;
      }
    }, intervalMs + jitterMs);
  } else {
    console.info("[sheet-sync-periodic] desabilitado (SHEET_SYNC_INLINE=false) — esperando cron externo");
  }

  // 4b. Auto-avanço de cargas recorrentes — move a data para a próxima
  //     ocorrência quando o horário passa, mantendo a carga sempre na fila sem
  //     o operador recriar. No-op quando não há cargas recorrentes abertas.
  //     RECURRING_CARGO_ADVANCE_INLINE=false desliga o job inline (deixa para o
  //     endpoint POST /api/cargas/advance-recurring via cron externo).
  if (process.env.RECURRING_CARGO_ADVANCE_INLINE !== "false") {
    let advancingRecurring = false;
    const recurIntervalMin = Number(process.env.RECURRING_CARGO_ADVANCE_INTERVAL_MIN || 5);
    const recurIntervalMs = Math.max(1, recurIntervalMin) * 60 * 1000;

    setInterval(async () => {
      if (advancingRecurring) return;
      advancingRecurring = true;
      try {
        const { advanceRecurringCargas } = await import(
          "./application/operator-admin/use-cases/advance-recurring-cargas.js"
        );
        const { advanced } = await advanceRecurringCargas();
        if (advanced > 0) {
          console.info(`[recurring-cargo-advance] ${advanced} carga(s) recorrente(s) avançada(s)`);
        }
      } catch (err) {
        console.error("[recurring-cargo-advance] erro:", err?.message);
      } finally {
        advancingRecurring = false;
      }
    }, recurIntervalMs);
  } else {
    console.info("[recurring-cargo-advance] desabilitado (RECURRING_CARGO_ADVANCE_INLINE=false) — esperando cron externo");
  }

  // 5. Iniciar HTTP server
  const server = app.listen(PORT, () => {
    console.log(`[lamonica-backend] Servidor ouvindo em http://localhost:${PORT}`);
    console.log(`[lamonica-backend] GET /health disponível`);
  });

  // ─── Graceful shutdown ──────────────────────────────────────────────────────
  // SIGTERM: enviado pelo Docker / orquestrador durante deploy/parada controlada.
  // SIGINT:  Ctrl+C em desenvolvimento.

  async function gracefulShutdown(signal) {
    console.log(`[lamonica-backend] ${signal} recebido — iniciando graceful shutdown`);

    // Parar de aceitar novas conexões (closeAllConnections fecha keep-alive pendentes)
    server.closeAllConnections?.();
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
