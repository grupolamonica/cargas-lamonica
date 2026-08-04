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
//
// Webhook do Evolution: com `base64: true` a mídia recebida (foto/PDF) vem
// EMBUTIDA no corpo do POST. Uma foto comprimida cabe em <1MB, mas um PDF de
// comprovante/conta (1–5MB) vira base64 e ESTOURA 1MB → o Express rejeitava com
// 413 e o documento era perdido (o motorista mandava o PDF e o bot ficava
// re-pedindo). Parser dedicado com limite maior SÓ nessa rota (autenticada por
// secret); teto ≈ máximo do bucket (8MB) + overhead do base64 (~33%) + envelope.
// TODO o resto segue em 1MB (anti-abuse — mutations do operador cabem em ~50KB).
app.use("/api/webhooks/evolution", express.json({ limit: "20mb" }));
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

  // 2c. Garantir tabela app_settings (idempotente) — key/value de toggles de
  //     runtime, ex.: interruptor da aprovação automática por vigência Angellira.
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.app_settings (
        key text PRIMARY KEY,
        value jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text
      )
    `);
    // Tabela backend-only: o acesso é via pg direto (bypassa RLS). Ligar RLS sem
    // policies mantém PostgREST/anon fora — mesmo padrão das outras tabelas.
    await pool.query(`ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY`);
    console.info("[lamonica-backend] app_settings: OK");
  } catch (err) {
    console.warn("[lamonica-backend] app_settings setup warning:", err?.message);
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

  // 4c. Auto-aprovação por vigência no Angellira — job periódico. Só age quando
  //     o interruptor no banco (app_settings.auto_approve_angellira.enabled)
  //     está LIGADO; por padrão vem DESLIGADO (nada aprova sozinho até o
  //     operador ligar no portal). AUTO_APPROVE_ANGELLIRA_JOB=false desliga até
  //     o próprio timer (kill-switch de infra).
  if (process.env.AUTO_APPROVE_ANGELLIRA_JOB !== "false") {
    let autoApproveRunning = false;
    const aaIntervalMin = Number(process.env.AUTO_APPROVE_ANGELLIRA_INTERVAL_MIN || 15);
    const aaIntervalMs = Math.max(1, aaIntervalMin) * 60 * 1000;
    const aaBatch = Math.max(1, Number(process.env.AUTO_APPROVE_ANGELLIRA_BATCH || 25));

    setInterval(async () => {
      if (autoApproveRunning) return;
      autoApproveRunning = true;
      try {
        const { getAutoApproveSetting, runAutoApproveAngelliraVigentes } = await import(
          "./application/operator-admin/use-cases/angellira/auto-approve-vigentes.js"
        );
        const { enabled } = await getAutoApproveSetting();
        if (!enabled) return; // interruptor desligado — no-op
        const summary = await runAutoApproveAngelliraVigentes({ limit: aaBatch, apply: true, trigger: "timer" });
        if (summary?.approved > 0) {
          console.info(`[auto-approve-angellira] aprovou ${summary.approved} de ${summary.scanned} consultado(s)`);
        }
      } catch (err) {
        console.error("[auto-approve-angellira] erro:", err?.message);
      } finally {
        autoApproveRunning = false;
      }
    }, aaIntervalMs);
  } else {
    console.info("[auto-approve-angellira] desabilitado (AUTO_APPROVE_ANGELLIRA_JOB=false)");
  }

  // 4c-bis. Poller de "apto" do SPX — job periódico. Reavalia cadastros com SPX
  //     em RASCUNHO (importado/request_pendente/completo) e promove p/ "apto"
  //     quando a Shopee aprova (precheck IS_MATCHED_NOSSA). Mesmo padrão do
  //     auto-approve: só age com o interruptor `app_settings.auto_apto_spx.enabled`
  //     LIGADO (default DESLIGADO). SPX_APTO_POLL_JOB=false desliga o timer.
  if (process.env.SPX_APTO_POLL_JOB !== "false") {
    let spxAptoPollRunning = false;
    const spxIntervalMin = Number(process.env.SPX_APTO_POLL_INTERVAL_MIN || 15);
    const spxIntervalMs = Math.max(1, spxIntervalMin) * 60 * 1000;
    const spxBatch = Math.max(1, Number(process.env.SPX_APTO_POLL_BATCH || 25));

    setInterval(async () => {
      if (spxAptoPollRunning) return;
      spxAptoPollRunning = true;
      try {
        const { getSpxAptoPollSetting, runSpxAptoPoll } = await import(
          "./application/operator-admin/use-cases/spx/apto-poller.js"
        );
        const { enabled } = await getSpxAptoPollSetting();
        if (!enabled) return; // interruptor desligado — no-op
        const summary = await runSpxAptoPoll({ limit: spxBatch, apply: true, trigger: "timer" });
        if (summary?.aptos > 0) {
          console.info(`[spx-apto-poll] promoveu ${summary.aptos} de ${summary.checked} rascunho(s) verificado(s)`);
        }
      } catch (err) {
        console.error("[spx-apto-poll] erro:", err?.message);
      } finally {
        spxAptoPollRunning = false;
      }
    }, spxIntervalMs);
  } else {
    console.info("[spx-apto-poll] desabilitado (SPX_APTO_POLL_JOB=false)");
  }

  // 4d. Driver-outreach — worker + scanner SEMPRE iniciados; ficam no-op quando
  //     o envio está desligado nas settings do banco (controladas pela tela do
  //     operador). Assim liga/desliga sem redeploy. Escape hatch:
  //     DRIVER_OUTREACH_DISABLE_WORKER=true não inicia os jobs. Envio real ainda
  //     exige Evolution pareado (QR); frios exigem cold_enabled nas settings.
  if (process.env.DRIVER_OUTREACH_DISABLE_WORKER !== "true") {
    const { getOutreachConfig } = await import("./application/driver-outreach/config.js");
    const outreachCfg = await getOutreachConfig(null); // timing (poll/scan) vem do env

    // Carrega os overrides das mensagens no boot + refresh periódico (pega
    // edições feitas em outra réplica dentro de ~2min; a mesma réplica já
    // atualiza na hora ao salvar via PATCH).
    try {
      const { refreshMessageTemplateCache } = await import(
        "./application/driver-outreach/message-templates.js"
      );
      await refreshMessageTemplateCache();
      setInterval(() => refreshMessageTemplateCache().catch(() => {}), 2 * 60 * 1000);
    } catch (err) {
      console.error("[message-templates] refresh inicial falhou:", err?.message);
    }

    let outreachSending = false;
    setInterval(async () => {
      if (outreachSending) return;
      outreachSending = true;
      try {
        const { processOutreachQueue } = await import("./application/driver-outreach/outreach-worker.js");
        await processOutreachQueue();
      } catch (err) {
        console.error("[driver-outreach-worker] erro:", err?.message);
      } finally {
        outreachSending = false;
      }
    }, Math.max(10, outreachCfg.pollSeconds) * 1000);

    let outreachScanning = false;
    setInterval(async () => {
      if (outreachScanning) return;
      outreachScanning = true;
      try {
        const { scanAndEnqueueOutreach } = await import("./application/driver-outreach/scan-and-enqueue.js");
        const r = await scanAndEnqueueOutreach();
        if (r.enqueued) console.info(`[driver-outreach-scan] ${r.enqueued} oportunidade(s) enfileirada(s)`);
      } catch (err) {
        console.error("[driver-outreach-scan] erro:", err?.message);
      } finally {
        outreachScanning = false;
      }
    }, Math.max(5, outreachCfg.scanIntervalMin) * 60 * 1000);

    // Job de expiração de reservas (2h sem confirmação → volta OPEN + notifica).
    let expiringReservations = false;
    setInterval(async () => {
      if (expiringReservations) return;
      expiringReservations = true;
      try {
        const { expireStaleReservations } = await import(
          "./application/driver-outreach/reservation-flow.js"
        );
        const r = await expireStaleReservations();
        if (r.expired) console.info(`[reservation-timeout] ${r.expired} reserva(s) expirada(s)`);
      } catch (err) {
        console.error("[reservation-timeout] erro:", err?.message);
      } finally {
        expiringReservations = false;
      }
    }, 60 * 1000);

    // Match de interesse de retorno: varre cargas OPEN recentes e avisa
    // motoristas que tinham registrado interesse na rota. Idempotente.
    let matchingInterests = false;
    setInterval(async () => {
      if (matchingInterests) return;
      matchingInterests = true;
      try {
        const { runReturnInterestSweep } = await import(
          "./application/driver-outreach/return-interest.js"
        );
        const r = await runReturnInterestSweep();
        if (r.total) console.info(`[return-interest-match] ${r.total} motorista(s) avisado(s)`);
      } catch (err) {
        console.error("[return-interest-match] erro:", err?.message);
      } finally {
        matchingInterests = false;
      }
    }, 5 * 60 * 1000);

    // Chamado automático de cargas órfãs (route-need): varre cargas OPEN sem
    // candidatura carregando em breve e chama motoristas da rota (ondas de 5).
    // Só age se route_need_enabled nas settings.
    let scanningRouteNeeds = false;
    setInterval(async () => {
      if (scanningRouteNeeds) return;
      scanningRouteNeeds = true;
      try {
        const { scanAndEnqueueRouteNeeds } = await import(
          "./application/driver-outreach/route-need.js"
        );
        const r = await scanAndEnqueueRouteNeeds();
        if (r.enqueued) console.info(`[route-need] ${r.enqueued} motorista(s) chamado(s) para ${r.cargas} carga(s)`);
      } catch (err) {
        console.error("[route-need] erro:", err?.message);
      } finally {
        scanningRouteNeeds = false;
      }
    }, 20 * 60 * 1000);

    console.info("[driver-outreach] worker + scanner + reservation-timeout + return-interest-match + route-need iniciados (envio controlado pela tela do operador)");
  } else {
    console.info("[driver-outreach] worker desabilitado (DRIVER_OUTREACH_DISABLE_WORKER=true)");
  }

  // 4d. DC-201 / Epic DC-183 — auto-lançamento de spots com rota cadastrada.
  //     Varre as viagens SPX Planejado e lança sozinho (sem intervenção do
  //     operador) as que já têm tabela de preço (rota) — elas aparecem no portal
  //     do motorista automaticamente. NÃO aceita no SPX (aceite segue manual).
  //     LIGADO por padrão (é o core da feature): a carga só fica visível ao
  //     motorista quando a rota já existe, e o launch é idempotente + com teto por
  //     ciclo, então o risco é baixo. Kill-switch: SPOT_AUTOLAUNCH_ENABLED=false.
  //     Intervalo em SPOT_AUTOLAUNCH_INTERVAL_MIN (default 5min). Também exposto
  //     como POST /api/operator/programacao/auto-launch ("rodar agora").
  if (process.env.SPOT_AUTOLAUNCH_ENABLED !== "false") {
    const intervalMin = Math.max(1, Number(process.env.SPOT_AUTOLAUNCH_INTERVAL_MIN || 5));
    let autoLaunching = false;
    setInterval(async () => {
      if (autoLaunching) return;
      autoLaunching = true;
      try {
        // Toggle em runtime pela tela do operador (tabela programacao_settings).
        // Desligado → pula o ciclo sem lançar (o timer segue vivo p/ religar na hora).
        const { isSpotAutolaunchEnabled } = await import(
          "./application/operator-admin/use-cases/programacao-settings.js"
        );
        if (!(await isSpotAutolaunchEnabled())) return;
        const { autoLaunchRoutedSpots } = await import(
          "./application/operator-admin/use-cases/auto-launch-routed-spots.js"
        );
        const r = await autoLaunchRoutedSpots({ correlationId: "spot-autolaunch" });
        if (r.launched || r.errors || r.deferred) {
          console.info(
            `[spot-autolaunch] lançados=${r.launched} (rota=${r.routed}, candidatos=${r.candidates}, já=${r.already}, erros=${r.errors}, adiados=${r.deferred})`,
          );
        }
        // A RAZÃO de cada falha era coletada (auto-launch-routed-spots grava `reason`
        // em cada item) e descartada aqui: o lançamento Nestlé ficou 2 dias quebrado
        // ("Cliente Nestle não encontrado", cliente renomeado na tela) com 288
        // tentativas/dia e nenhuma linha de diagnóstico. Agora cada erro aparece.
        for (const item of (r.results || []).filter((x) => x.state === "error")) {
          console.error(`[spot-autolaunch] falhou LH ${item.lh}: ${item.reason}`);
        }
      } catch (err) {
        console.error("[spot-autolaunch] erro:", err?.message);
      } finally {
        autoLaunching = false;
      }
    }, intervalMin * 60 * 1000);
    console.info(`[spot-autolaunch] timer ativo (intervalo ${intervalMin}min; liga/desliga pela tela do operador — programacao_settings)`);
  } else {
    console.info("[spot-autolaunch] desabilitado via kill-switch (SPOT_AUTOLAUNCH_ENABLED=false)");
  }

  // 4d-bis. DC-279 — Notificação de spot. Varre o feed da Programação e insere uma
  //     notificação `new_spot` quando surge uma carga spot numa ROTA que o operador
  //     marcou p/ alertar (programacao_settings.spot_alert_route_keys). O sino do
  //     operador (polling 30s, presente em toda tela) dispara som + notificação do
  //     navegador no cliente. Só busca o feed se houver rota marcada (inerte por
  //     padrão). Kill-switch: SPOT_ALERT_ENABLED=false. Intervalo:
  //     SPOT_ALERT_INTERVAL_MIN (default 3min — alerta ao vivo; o SPX muda ~10min).
  if (process.env.SPOT_ALERT_ENABLED !== "false") {
    const intervalMin = Math.max(1, Number(process.env.SPOT_ALERT_INTERVAL_MIN || 3));
    let notifyingSpots = false;
    setInterval(async () => {
      if (notifyingSpots) return;
      notifyingSpots = true;
      try {
        const { notifyNewSpots } = await import(
          "./application/operator-admin/use-cases/notify-new-spots.js"
        );
        const r = await notifyNewSpots({ correlationId: "spot-alert" });
        if (r.notified || r.deferred) {
          console.info(`[spot-alert] ${r.notified} nova(s) carga(s) spot notificada(s) (casaram=${r.matched}, repetidas=${r.skipped}, adiadas=${r.deferred})`);
        }
      } catch (err) {
        console.error("[spot-alert] erro:", err?.message);
      } finally {
        notifyingSpots = false;
      }
    }, intervalMin * 60 * 1000);
    console.info(`[spot-alert] timer ativo (intervalo ${intervalMin}min; rotas que alertam definidas na tela de Programação)`);
  } else {
    console.info("[spot-alert] desabilitado via kill-switch (SPOT_ALERT_ENABLED=false)");
  }

  // 4d-ter. DC-299 — Alerta de novo motorista na FILA. Varre a fila do operador e insere
  //     uma notificação `new_queue_driver` quando um motorista ENTRA na fila (lead QUEUED
  //     recém-criado). O sino (polling 30s, toda tela) dispara bip + 1 aviso de voz +
  //     notificação do navegador + toast, e leva à Fila. Kill-switch: QUEUE_ALERT_ENABLED=false.
  //     Intervalo: QUEUE_ALERT_INTERVAL_MIN (default 3min — o read model da fila é pesado
  //     (6 JOINs, cache de só 3s); 3min mantém a carga comparável ao próprio polling da tela).
  if (process.env.QUEUE_ALERT_ENABLED !== "false") {
    const intervalMin = Math.max(1, Number(process.env.QUEUE_ALERT_INTERVAL_MIN || 3));
    let notifyingQueue = false;
    setInterval(async () => {
      if (notifyingQueue) return;
      notifyingQueue = true;
      try {
        const { notifyNewQueueDrivers } = await import(
          "./application/operator-admin/use-cases/notify-new-queue-drivers.js"
        );
        const r = await notifyNewQueueDrivers({ correlationId: "queue-alert" });
        if (r.notified) {
          console.info(`[queue-alert] ${r.notified} novo(s) motorista(s) na fila notificado(s) (candidatos=${r.candidates}, repetidos=${r.skipped})`);
        }
      } catch (err) {
        console.error("[queue-alert] erro:", err?.message);
      } finally {
        notifyingQueue = false;
      }
    }, intervalMin * 60 * 1000);
    console.info(`[queue-alert] timer ativo (intervalo ${intervalMin}min)`);
  } else {
    console.info("[queue-alert] desabilitado via kill-switch (QUEUE_ALERT_ENABLED=false)");
  }

  // 4e. Expiração de cargas passadas (OPEN → EXPIRED). Sem isso, cargas cujo
  //     carregamento já venceu ficam OPEN no painel do operador (poluindo "ativas"
  //     e criando a impressão de "cargas que não aparecem para o motorista"), embora
  //     o filtro de runtime já as esconda do portal. Respeita a exceção de carga
  //     lançada (visível o dia todo). Kill-switch: EXPIRE_PAST_CARGAS_ENABLED=false.
  //     Intervalo: EXPIRE_PAST_CARGAS_INTERVAL_MIN (default 15min).
  if (process.env.EXPIRE_PAST_CARGAS_ENABLED !== "false") {
    const intervalMin = Math.max(1, Number(process.env.EXPIRE_PAST_CARGAS_INTERVAL_MIN || 15));
    let expiringCargas = false;
    setInterval(async () => {
      if (expiringCargas) return;
      expiringCargas = true;
      try {
        const { expirePastCargas } = await import(
          "./application/operator-admin/use-cases/expire-past-cargas.js"
        );
        const r = await expirePastCargas();
        if (r.expired) console.info(`[expire-past-cargas] ${r.expired} carga(s) OPEN → EXPIRED`);
      } catch (err) {
        console.error("[expire-past-cargas] erro:", err?.message);
      } finally {
        expiringCargas = false;
      }
    }, intervalMin * 60 * 1000);
    console.info(`[expire-past-cargas] timer ativo (intervalo ${intervalMin}min)`);
  }

  // 4f. Sync ASPX → sistema/planilha (DC-316 no backend). Puxa da Torre /api/spx/asp
  //     por LH: status (regras DC-316 — CTE da planilha, resto do ASPX), motorista,
  //     cavalo, carreta e datas de carregamento/descarga (sob os gates do DC-316).
  //     Grava os espelhos em cargas.sheet_* + escreve de volta na planilha (write-back).
  //     OPT-IN (default DESLIGADO): só liga com ASPX_STATUS_RECONCILE_ENABLED=true —
  //     depende do Apps Script de write-back gravar a coluna STATUS (col L) e do
  //     congelamento Shopee (DC-308) estar liberado. Intervalo:
  //     ASPX_STATUS_RECONCILE_INTERVAL_MIN (default 3min).
  if (process.env.ASPX_STATUS_RECONCILE_ENABLED === "true") {
    const intervalMin = Math.max(1, Number(process.env.ASPX_STATUS_RECONCILE_INTERVAL_MIN || 3));
    let reconcilingAspx = false;
    setInterval(async () => {
      if (reconcilingAspx) return;
      reconcilingAspx = true;
      try {
        const { reconcileAspxStatus } = await import(
          "./application/operator-admin/use-cases/reconcile-aspx-status.js"
        );
        const r = await reconcileAspxStatus();
        if (r.updated) {
          console.info(
            `[reconcile-aspx-status] ${r.updated} carga(s) sincronizada(s) com o ASPX (${r.sheetWrites} na planilha; ${r.checked} verificada(s))`,
          );
        }

        // Mesma cadência, conjunto complementar: carga LANÇADA (lh_manual) — o sync
        // acima casa só por sheet_lh. Gate próprio (ASPX_STATUS_LAUNCHED=off|dry|on).
        const { reconcileAspxStatusForLaunched } = await import(
          "./application/operator-admin/use-cases/reconcile-aspx-status-launched.js"
        );
        const rl = await reconcileAspxStatusForLaunched();
        if (rl.updated || rl.ignoradasNaPlanilha) {
          console.info(
            `[aspx-status-launched] modo ${rl.mode}: ${rl.updated} carga(s) lançada(s) ${rl.mode === "dry" ? "MUDARIAM" : "sincronizada(s)"} (${rl.sheetWrites} na planilha; ${rl.checked} verificada(s); ${rl.ignoradasNaPlanilha ?? 0} fora por já estar na planilha)`,
          );
        }
      } catch (err) {
        console.error("[reconcile-aspx-status] erro:", err?.message);
      } finally {
        reconcilingAspx = false;
      }
    }, intervalMin * 60 * 1000);
    console.info(`[reconcile-aspx-status] timer ativo (intervalo ${intervalMin}min)`);
  } else {
    console.info("[reconcile-aspx-status] desabilitado (defina ASPX_STATUS_RECONCILE_ENABLED=true para ligar)");
  }

  // 4f-ter. AGENDA da carga LANÇADA (lh_manual) em dia com a fonte da viagem: portal
  //     SPX (Shopee) e Galileu (Nestlé). O overlay do Monitor já mostra o horário ao
  //     vivo, mas `cargas.data`/`horario` — que governam o PORTAL DO MOTORISTA, a
  //     expiração e a ordenação — só eram gravados no lançamento e nunca revisitados
  //     (o auto-lançamento descarta o que já está lançado). Timer PRÓPRIO, gate
  //     próprio: LAUNCHED_SCHEDULE_SYNC = off (default) | dry | on. Como isto move a
  //     agenda que o motorista vê, o caminho é ligar em "dry", conferir o log
  //     `launched-schedule-sync.dry-run` e só então passar para "on".
  //     Intervalo: LAUNCHED_SCHEDULE_SYNC_INTERVAL_MIN (default 5min).
  {
    const { launchedScheduleSyncMode } = await import(
      "./application/operator-admin/use-cases/reconcile-launched-cargo-schedule.js"
    );
    const scheduleMode = launchedScheduleSyncMode();
    if (scheduleMode === "off") {
      console.info("[launched-schedule-sync] desabilitado (LAUNCHED_SCHEDULE_SYNC=dry|on para ligar)");
    } else {
      const intervalMin = Math.max(1, Number(process.env.LAUNCHED_SCHEDULE_SYNC_INTERVAL_MIN || 5));
      let syncingSchedule = false;
      setInterval(async () => {
        if (syncingSchedule) return;
        syncingSchedule = true;
        try {
          const { reconcileLaunchedCargoSchedule } = await import(
            "./application/operator-admin/use-cases/reconcile-launched-cargo-schedule.js"
          );
          const r = await reconcileLaunchedCargoSchedule();
          if (r.updated) {
            console.info(
              `[launched-schedule-sync] modo ${r.mode}: ${r.updated} agenda(s) ${r.mode === "dry" ? "MUDARIAM" : "sincronizada(s)"} (${r.checked} verificada(s))`,
            );
          }
        } catch (err) {
          console.error("[launched-schedule-sync] erro:", err?.message);
        } finally {
          syncingSchedule = false;
        }
      }, intervalMin * 60 * 1000);
      console.info(`[launched-schedule-sync] timer ativo em modo ${scheduleMode} (intervalo ${intervalMin}min)`);
    }
  }

  // 4f-bis. Vigia as cargas LANÇADAS (Programação, lh_manual "LT…") e avisa quando a
  //     VIAGEM SAIU DO ASPX (Shopee cancelou/removeu do portal depois do lançamento).
  //     A carga NUNCA é apagada: sai do Monitor, fica em /cargas com o selo "Fora do
  //     ASPX" e o operador é avisado no sino — com re-aviso a cada
  //     ASPX_MISSING_REALERT_HOURS (default 6h) enquanto a viagem não voltar. Se
  //     voltar ao portal, a marca é limpa (volta ao Monitor) e o sino avisa.
  //     LIGADO por padrão (kill-switch ASPX_MISSING_DETECT_ENABLED=false).
  //     Intervalo: ASPX_MISSING_DETECT_INTERVAL_MIN (default 10min).
  if (process.env.ASPX_MISSING_DETECT_ENABLED !== "false") {
    const intervalMin = Math.max(1, Number(process.env.ASPX_MISSING_DETECT_INTERVAL_MIN || 10));
    let detectingAspxMissing = false;
    setInterval(async () => {
      if (detectingAspxMissing) return;
      detectingAspxMissing = true;
      try {
        const { detectAspxMissingTrips } = await import(
          "./application/operator-admin/use-cases/detect-aspx-missing-trips.js"
        );
        const r = await detectAspxMissingTrips({ correlationId: "aspx-missing-scan" });
        if (r.marked || r.cleared || r.renotified) {
          console.info(
            `[detect-aspx-missing-trips] ${r.marked} carga(s) fora do ASPX, ${r.cleared} de volta, ${r.renotified} re-aviso(s) (${r.checked} verificada(s), ${r.notified} aviso(s))`,
          );
        }
      } catch (err) {
        console.error("[detect-aspx-missing-trips] erro:", err?.message);
      } finally {
        detectingAspxMissing = false;
      }
    }, intervalMin * 60 * 1000);
    console.info(`[detect-aspx-missing-trips] timer ativo (intervalo ${intervalMin}min)`);
  } else {
    console.info("[detect-aspx-missing-trips] desabilitado (ASPX_MISSING_DETECT_ENABLED=false)");
  }

  // 4g. Revalida a vigência Angellira dos motoristas (motoristas_historico) AO VIVO,
  //     em ROTAÇÃO: a cada tick pega os N mais defasados (nunca consultados / mais
  //     vencidos / não tocados há > staleHours), reconsulta e grava limit_date
  //     fresco. Conserta o snapshot congelado (a tabela era 1 import manual → ~55%
  //     dos motoristas em prod ficaram "vencidos" mesmo renovados). Só grava com
  //     availability OK (nunca rebaixa por falha); NOT_FOUND zera a vigência.
  //     OPT-IN (default DESLIGADO): ANGELLIRA_DRIVER_REVALIDATE_ENABLED=true.
  //     Intervalo: ANGELLIRA_DRIVER_REVALIDATE_INTERVAL_MIN (default 30min);
  //     teto/rodada: ANGELLIRA_DRIVER_REVALIDATE_BATCH (default 100).
  if (process.env.ANGELLIRA_DRIVER_REVALIDATE_ENABLED === "true") {
    const intervalMin = Math.max(1, Number(process.env.ANGELLIRA_DRIVER_REVALIDATE_INTERVAL_MIN || 30));
    const batch = Math.max(1, Number(process.env.ANGELLIRA_DRIVER_REVALIDATE_BATCH || 100));
    const concurrency = Math.max(1, Number(process.env.ANGELLIRA_DRIVER_REVALIDATE_CONCURRENCY || 3));
    const delayMs = Math.max(0, Number(process.env.ANGELLIRA_DRIVER_REVALIDATE_DELAY_MS || 250));
    let revalidatingDrivers = false;
    setInterval(async () => {
      if (revalidatingDrivers) return;
      revalidatingDrivers = true;
      try {
        const { revalidateDriversAngellira } = await import(
          "./application/operator-admin/use-cases/revalidate-drivers-angellira.js"
        );
        const r = await revalidateDriversAngellira({ limit: batch, concurrency, delayMs });
        if (r.checked) {
          console.info(
            `[revalidate-drivers-angellira] ${r.checked} verificado(s): ${r.found} vigente(s), ${r.notFound} sem cadastro, ${r.unavailable} indisponível(is)`,
          );
        }
      } catch (err) {
        console.error("[revalidate-drivers-angellira] erro:", err?.message);
      } finally {
        revalidatingDrivers = false;
      }
    }, intervalMin * 60 * 1000);
    console.info(
      `[revalidate-drivers-angellira] timer ativo (intervalo ${intervalMin}min, lote ${batch}, conc ${concurrency}, delay ${delayMs}ms)`,
    );
  } else {
    console.info("[revalidate-drivers-angellira] desabilitado (defina ANGELLIRA_DRIVER_REVALIDATE_ENABLED=true para ligar)");
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
