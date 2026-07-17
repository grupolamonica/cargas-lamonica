// Auto-aprovação de cadastros PENDENTES quando o motorista está vigente no
// Angellira. É a versão "produto" do que foi feito em lote manualmente:
// consulta a vigência do motorista (por CPF) via o cliente Angellira e, para
// os vigentes (status FOUND + validade >= hoje), muda SÓ o status para
// 'aprovado' (fluxo leve — NÃO cria login/driver_profile). Reversível pelo
// marcador `reviewed_by_id = AUTO_APPROVE_MARKER`.
//
// É session-independent de propósito: pode ser chamado tanto pelo endpoint do
// operador (botão "rodar agora") quanto pelo job em background no main.js.
import { withPgClient } from "../../../../infrastructure/pg/postgres.js";
import { lookupAngelliraDriverByCpf, lookupAngelliraPlate } from "../../../../infrastructure/angellira/angellira-client.js";
import { insertSecurityAuditEvent } from "../../../../infrastructure/security-audit.js";
import { logStructuredEvent } from "../../../../infrastructure/security-log.js";

export const AUTO_APPROVE_SETTING_KEY = "auto_approve_angellira";
// Mesmo marcador usado na aprovação em lote de 09/07/2026 — permite reverter
// filtrando por reviewed_by_id.
export const AUTO_APPROVE_MARKER = "auto:angellira-vigencia";

const DEFAULT_BATCH = 25;
const PACING_MS = 250;

// Guard de reentrância compartilhado (módulo ESM é singleton no processo):
// impede que o job periódico e o botão "rodar agora" rodem ao mesmo tempo.
let running = false;
export function isAutoApproveRunning() {
  return running;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** Data de hoje (YYYY-MM-DD) no fuso de São Paulo — mesma régua da vigência. */
function todaySaoPaulo() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * Um resultado do Angellira (motorista OU placa) está VIGENTE?
 * Regra canônica: status FOUND + validade (validUntil) >= hoje (fuso SP).
 * NOT_FOUND ("não cadastrado"), vencido e UNAVAILABLE ⇒ NÃO vigente.
 */
export function isAngelliraVigente(rec, today) {
  if (!rec || rec.status !== "FOUND") return false;
  const validUntil = rec.validUntil ? String(rec.validUntil).slice(0, 10) : null;
  return Boolean(validUntil && validUntil >= today);
}

/** Placas do conjunto de um `dados` de cadastro: cavalo + TODAS as carretas (bitrem = 2). */
export function extractConjuntoPlacas(dados) {
  const cavalo = dados?.cavalo?.placa ? String(dados.cavalo.placa).toUpperCase().trim() : "";
  const carretas = [];
  if (Array.isArray(dados?.carretas)) {
    for (const c of dados.carretas) {
      if (c?.placa) carretas.push(String(c.placa).toUpperCase().trim());
    }
  } else if (dados?.carreta?.placa) {
    carretas.push(String(dados.carreta.placa).toUpperCase().trim());
  }
  return { cavalo, carretas };
}

/**
 * O CONJUNTO todo está conforme p/ auto-aprovar? Exige (bug DC — antes só olhava o motorista):
 *  - motorista (CPF) vigente;
 *  - cavalo presente E vigente (todo conjunto tem tração — sem cavalo = cadastro incompleto, não aprova);
 *  - cada carreta declarada vigente (inclui as 2 do bitrem).
 * Basta UM componente NÃO CADASTRADO/vencido para NÃO aprovar.
 *
 * @param {{motorista:object, cavalo:{placa:string,rec:object}|null, carretas:{placa:string,rec:object}[]}} components
 * @returns {{conforme:boolean, motivo:string|null}}
 */
export function evaluateConjuntoConforme(components, today) {
  const { motorista, cavalo, carretas = [] } = components || {};
  if (!isAngelliraVigente(motorista, today)) return { conforme: false, motivo: "motorista" };
  if (!cavalo || !cavalo.placa) return { conforme: false, motivo: "cavalo_ausente" };
  if (!isAngelliraVigente(cavalo.rec, today)) return { conforme: false, motivo: "cavalo" };
  for (const carreta of carretas) {
    if (!isAngelliraVigente(carreta?.rec, today)) return { conforme: false, motivo: "carreta" };
  }
  return { conforme: true, motivo: null };
}

/** Fábrica de lookups Angellira memoizados por execução (não reconsulta o mesmo CPF/placa). */
function makeAngelliraLookups(correlationId) {
  const lookupOpts = {
    correlationId: correlationId || "auto-approve-angellira",
    sourceEvent: "operator.cadastro.auto_approve_angellira",
  };
  const cpfMemo = new Map();
  const plateMemo = new Map();
  const lookupCpf = (cpf) => {
    if (!cpf || cpf.length !== 11) return Promise.resolve({ status: "NOT_FOUND" });
    if (!cpfMemo.has(cpf)) cpfMemo.set(cpf, lookupAngelliraDriverByCpf(cpf, lookupOpts));
    return cpfMemo.get(cpf);
  };
  const lookupPlate = (placa) => {
    if (!placa) return Promise.resolve(null);
    if (!plateMemo.has(placa)) plateMemo.set(placa, lookupAngelliraPlate(placa, lookupOpts));
    return plateMemo.get(placa);
  };
  return { lookupCpf, lookupPlate };
}

/**
 * Consulta o CONJUNTO de um cadastro (motorista + cavalo + carretas) no Angellira,
 * em paralelo, e devolve o veredito. Compartilhado pela aprovação e pela reversão.
 *  - { circuitOpen: true }            → circuit-breaker aberto (encerrar a leva)
 *  - { indisponivel: true }           → algum componente UNAVAILABLE (não decidir agora)
 *  - { verdict: {conforme, motivo} }  → decisão do conjunto
 */
async function checkCadastroConjunto(dados, { today, lookupCpf, lookupPlate }) {
  const cpf = digitsOnly(dados?.motorista?.cpf);
  const { cavalo: cavaloPlaca, carretas: carretaPlacas } = extractConjuntoPlacas(dados);

  const specs = [{ kind: "motorista", p: lookupCpf(cpf) }];
  if (cavaloPlaca) specs.push({ kind: "cavalo", p: lookupPlate(cavaloPlaca) });
  carretaPlacas.forEach((placa, i) => specs.push({ kind: `carreta${i}`, p: lookupPlate(placa) }));

  const settled = await Promise.allSettled(specs.map((s) => s.p));

  let circuitOpen = false;
  const recByKind = {};
  settled.forEach((s, idx) => {
    const { kind } = specs[idx];
    if (s.status === "fulfilled") {
      recByKind[kind] = s.value;
    } else {
      const msg = String(s.reason?.message || s.reason);
      if (msg.includes("CIRCUIT_OPEN")) circuitOpen = true;
      recByKind[kind] = { status: "UNAVAILABLE", error: msg };
    }
  });
  if (circuitOpen) return { circuitOpen: true };

  const components = {
    motorista: recByKind.motorista,
    cavalo: cavaloPlaca ? { placa: cavaloPlaca, rec: recByKind.cavalo } : null,
    carretas: carretaPlacas.map((placa, i) => ({ placa, rec: recByKind[`carreta${i}`] })),
  };
  const recs = [components.motorista, components.cavalo?.rec, ...components.carretas.map((c) => c.rec)];
  if (recs.some((r) => r && r.status === "UNAVAILABLE")) return { indisponivel: true };

  return { verdict: evaluateConjuntoConforme(components, today) };
}

/** Cria a tabela de settings se não existir (idempotente; espelha analytics_events no bootstrap). */
export async function ensureAppSettingsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.app_settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    )
  `);
}

/** Lê o setting do auto-approve. Default: desligado, sem última execução. */
export async function getAutoApproveSetting() {
  return withPgClient(async (client) => {
    await ensureAppSettingsTable(client);
    const { rows } = await client.query(
      `SELECT value FROM public.app_settings WHERE key = $1`,
      [AUTO_APPROVE_SETTING_KEY],
    );
    const value = rows[0]?.value || {};
    return {
      enabled: Boolean(value.enabled),
      lastRun: value.lastRun || null,
    };
  });
}

/** Liga/desliga o job automático (o botão "rodar agora" independe disto). */
export async function setAutoApproveEnabled({ enabled, actorId = null }) {
  return withPgClient(async (client) => {
    await ensureAppSettingsTable(client);
    await client.query(
      `
      INSERT INTO public.app_settings (key, value, updated_by)
      VALUES ($1, jsonb_build_object('enabled', $2::boolean), $3)
      ON CONFLICT (key) DO UPDATE SET
        value = jsonb_set(COALESCE(public.app_settings.value, '{}'::jsonb), '{enabled}', to_jsonb($2::boolean)),
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
      `,
      [AUTO_APPROVE_SETTING_KEY, Boolean(enabled), actorId],
    );
    return { enabled: Boolean(enabled) };
  });
}

/** Conta pendentes com CPF de 11 dígitos (o universo consultável). */
export async function countPendingWithCpf() {
  return withPgClient(async (client) => {
    const { rows } = await client.query(`
      SELECT count(*)::int AS n
      FROM public.pending_driver_registrations
      WHERE status = 'pendente'
        AND length(regexp_replace(COALESCE(dados->'motorista'->>'cpf',''), '\\D', '', 'g')) = 11
    `);
    return rows[0]?.n ?? 0;
  });
}

async function persistLastRun(summary) {
  await withPgClient(async (client) => {
    await ensureAppSettingsTable(client);
    await client.query(
      `
      INSERT INTO public.app_settings (key, value)
      VALUES ($1, jsonb_build_object('lastRun', $2::jsonb))
      ON CONFLICT (key) DO UPDATE SET
        value = jsonb_set(COALESCE(public.app_settings.value, '{}'::jsonb), '{lastRun}', $2::jsonb),
        updated_at = now()
      `,
      [AUTO_APPROVE_SETTING_KEY, JSON.stringify(summary)],
    );
  });
}

/**
 * Varre até `limit` pendentes (mais antigos primeiro), consulta o Angellira do
 * motorista e — se `apply` — aprova (só status) os vigentes.
 *
 * @param {object} opts
 * @param {number} [opts.limit=25]      máximo de CPFs consultados por execução
 * @param {boolean} [opts.apply=true]   false = simulação (não grava)
 * @param {string|null} [opts.actorUserId=null]  uuid do operador (audit); null no job
 * @param {"timer"|"manual"} [opts.trigger="manual"]
 * @param {string|null} [opts.correlationId]
 * @returns {Promise<object>} resumo { skipped?, scanned, vigentes, approved, notFound, vencidos, errors, applied, trigger }
 */
export async function runAutoApproveAngelliraVigentes({
  limit = DEFAULT_BATCH,
  apply = true,
  actorUserId = null,
  trigger = "manual",
  correlationId = null,
} = {}) {
  if (running) {
    return { skipped: true, reason: "already_running" };
  }
  running = true;
  const startedAt = Date.now();
  const today = todaySaoPaulo();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || DEFAULT_BATCH));

  try {
    // 1. Pega os pendentes (com CPF válido) COM o `dados` completo — precisamos
    //    das placas do conjunto (cavalo + carretas), não só do CPF do motorista.
    let rows = [];
    await withPgClient(async (client) => {
      const res = await client.query(
        `
        SELECT id, dados
        FROM public.pending_driver_registrations
        WHERE status = 'pendente'
          AND length(regexp_replace(COALESCE(dados->'motorista'->>'cpf',''), '\\D', '', 'g')) = 11
        ORDER BY created_at ASC
        LIMIT $1
        `,
        [safeLimit],
      );
      rows = res.rows;
    });

    const { lookupCpf, lookupPlate } = makeAngelliraLookups(correlationId);

    const conformeIds = [];
    let vigentes = 0; // cadastros com o CONJUNTO todo conforme
    let bloqueados = 0; // conjunto incompleto/não conforme (NÃO CADASTRADO/vencido) → não aprova
    let indisponiveis = 0; // Angellira indisponível p/ algum componente → reavalia na próxima leva

    // 2. Para cada cadastro, consulta o CONJUNTO (motorista + cavalo + carretas)
    //    e só marca p/ aprovar quando TODOS estiverem vigentes.
    for (const row of rows) {
      const check = await checkCadastroConjunto(row.dados || {}, { today, lookupCpf, lookupPlate });
      if (check.circuitOpen) {
        logStructuredEvent("warn", "auto-approve-angellira.circuit_open", { correlationId, processed: rows.indexOf(row) });
        break;
      }
      if (check.indisponivel) {
        indisponiveis += 1;
        await sleep(PACING_MS);
        continue;
      }
      if (check.verdict.conforme) {
        vigentes += 1;
        conformeIds.push(row.id);
      } else {
        bloqueados += 1;
      }
      await sleep(PACING_MS);
    }

    // 3. Aplica (só status) nos cadastros com o CONJUNTO conforme.
    let approved = 0;
    if (apply && conformeIds.length) {
      await withPgClient(async (client) => {
        const { rows: updated } = await client.query(
          `
          UPDATE public.pending_driver_registrations
          SET status = 'aprovado',
              reviewed_at = now(),
              reviewed_by_id = $1,
              observacoes = $2
          WHERE status = 'pendente' AND id = ANY($3::uuid[])
          RETURNING id
          `,
          [
            AUTO_APPROVE_MARKER,
            `Aprovado automaticamente (${trigger}): conjunto completo (motorista + cavalo + carretas) Conforme e vigente no Angellira em ${today}.`,
            conformeIds,
          ],
        );
        approved = updated.length;

        // Audit best-effort — nunca deixa uma falha de auditoria quebrar a aprovação.
        try {
          await insertSecurityAuditEvent(client, {
            eventType: "operator.cadastro.auto_approved_angellira",
            actorUserId: actorUserId,
            actorRole: actorUserId ? "operator" : "system",
            resourceType: "pending_driver_registration",
            resourceId: null,
            action: "auto-approve-angellira-batch",
            outcome: "success",
            requestIp: null,
            correlationId,
            metadata: { trigger, approved, vigentes, scanned: rows.length, bloqueados, indisponiveis, ids: updated.map((r) => r.id) },
          });
        } catch (auditErr) {
          logStructuredEvent("warn", "auto-approve-angellira.audit_failed", { correlationId, message: String(auditErr?.message || auditErr) });
        }
      });
    }

    const summary = {
      at: new Date().toISOString(),
      trigger,
      applied: Boolean(apply),
      scanned: rows.length,
      vigentes,
      approved,
      bloqueados,
      indisponiveis,
      durationMs: Date.now() - startedAt,
    };

    if (apply) {
      await persistLastRun(summary);
    }
    logStructuredEvent("info", "auto-approve-angellira.run", { correlationId, ...summary });
    return summary;
  } finally {
    running = false;
  }
}

/**
 * Remediação retroativa: re-checa os cadastros JÁ auto-aprovados (marcador
 * AUTO_APPROVE_MARKER) e reverte para 'pendente' SÓ aqueles cujo CONJUNTO
 * (motorista + cavalo + carretas) NÃO está conforme no Angellira — corrige as
 * aprovações feitas pela regra antiga (que só olhava o motorista).
 *
 * Os que continuam conformes permanecem aprovados. Indisponibilidade transitória
 * do Angellira NÃO reverte (incerteza — reavalia numa próxima execução).
 * Reutiliza o guard de reentrância `running` para não colidir com o job de aprovação.
 *
 * @param {object} opts
 * @param {boolean} [opts.apply=false]   false = simulação (não grava; só conta o que reverteria)
 * @param {number}  [opts.limit=1000]    máximo de cadastros re-checados
 * @param {string|null} [opts.actorUserId=null]
 * @param {string|null} [opts.correlationId]
 * @returns {Promise<object>} { skipped?, applied, scanned, conformes, aRevertar, reverted, indisponiveis, durationMs, at }
 */
export async function runRevertNonConformeAutoApproved({
  apply = false,
  limit = 1000,
  actorUserId = null,
  correlationId = null,
} = {}) {
  if (running) {
    return { skipped: true, reason: "already_running" };
  }
  running = true;
  const startedAt = Date.now();
  const today = todaySaoPaulo();
  const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 1000));

  try {
    // 1. Pega os cadastros já auto-aprovados (marcador), com o `dados` completo.
    let rows = [];
    await withPgClient(async (client) => {
      const res = await client.query(
        `
        SELECT id, dados
        FROM public.pending_driver_registrations
        WHERE status = 'aprovado' AND reviewed_by_id = $1
        ORDER BY reviewed_at ASC NULLS FIRST
        LIMIT $2
        `,
        [AUTO_APPROVE_MARKER, safeLimit],
      );
      rows = res.rows;
    });

    // 2. Re-checa o conjunto de cada um e separa os que devem voltar p/ pendente.
    const { lookupCpf, lookupPlate } = makeAngelliraLookups(correlationId || "revert-nonconforme-autoapprove");
    const revertIds = [];
    let conformes = 0;
    let indisponiveis = 0;

    for (const row of rows) {
      const check = await checkCadastroConjunto(row.dados || {}, { today, lookupCpf, lookupPlate });
      if (check.circuitOpen) {
        logStructuredEvent("warn", "revert-nonconforme.circuit_open", { correlationId, processed: rows.indexOf(row) });
        break;
      }
      if (check.indisponivel) {
        indisponiveis += 1; // incerteza → não reverte
        await sleep(PACING_MS);
        continue;
      }
      if (check.verdict.conforme) {
        conformes += 1;
      } else {
        revertIds.push(row.id);
      }
      await sleep(PACING_MS);
    }

    // 3. Aplica a reversão (volta p/ pendente, limpa o marcador) só nos não-conformes.
    let reverted = 0;
    if (apply && revertIds.length) {
      await withPgClient(async (client) => {
        const { rows: updated } = await client.query(
          `
          UPDATE public.pending_driver_registrations
          SET status = 'pendente',
              reviewed_at = NULL,
              reviewed_by_id = NULL,
              observacoes = $2
          WHERE status = 'aprovado' AND reviewed_by_id = $1 AND id = ANY($3::uuid[])
          RETURNING id
          `,
          [
            AUTO_APPROVE_MARKER,
            "Revertido para pendente: conjunto (motorista + cavalo + carretas) nao esta conforme no Angellira (correcao da auto-aprovacao que so olhava o motorista).",
            revertIds,
          ],
        );
        reverted = updated.length;

        try {
          await insertSecurityAuditEvent(client, {
            eventType: "operator.cadastro.auto_approve_reverted_nonconforme",
            actorUserId,
            actorRole: actorUserId ? "operator" : "system",
            resourceType: "pending_driver_registration",
            resourceId: null,
            action: "revert-nonconforme-autoapprove",
            outcome: "success",
            requestIp: null,
            correlationId,
            metadata: { reverted, conformes, scanned: rows.length, indisponiveis, ids: updated.map((r) => r.id) },
          });
        } catch (auditErr) {
          logStructuredEvent("warn", "revert-nonconforme.audit_failed", { correlationId, message: String(auditErr?.message || auditErr) });
        }
      });
    }

    const summary = {
      at: new Date().toISOString(),
      applied: Boolean(apply),
      scanned: rows.length,
      conformes,
      aRevertar: revertIds.length,
      reverted,
      indisponiveis,
      durationMs: Date.now() - startedAt,
    };
    logStructuredEvent("info", "revert-nonconforme.run", { correlationId, ...summary });
    return summary;
  } finally {
    running = false;
  }
}
