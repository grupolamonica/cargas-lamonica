/**
 * driver-outreach — varredura que DETECTA oportunidades e ENFILEIRA envios
 * automáticos (Wave B/C). Reusa getDriverOpportunities (mesma detecção do
 * painel do operador) por candidato e enfileira as oportunidades acionáveis.
 *
 * Candidatos:
 *   - consent-implied (sempre): cadastros iniciados e não finalizados.
 *   - frios (só com DRIVER_OUTREACH_COLD_ENABLED): motoristas em churn (planilha).
 *
 * Nada é enviado aqui — só enfileira. O outreach-worker respeita opt-out, cap,
 * janela de horário e o gate de gatilho frio no momento do envio.
 */

import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../infrastructure/security-log.js";
import { getSaoPauloWallClock } from "../../domain/sao-paulo-time.js";
import { normalizeText } from "../../domain/driver-outreach/detection.js";
import { getDriverOpportunities } from "./get-driver-opportunities.js";
import { enqueueDriverOutreach } from "./enqueue.js";
import { checkAngelliraVigencia } from "./angellira-check.js";
import { COLD_TRIGGERS, getOutreachConfig, isTriggerAllowed } from "./config.js";

const digits = (v) => String(v || "").replace(/\D/g, "");

// Gatilhos que geram mensagem/envio (preferences é só exibição).
const SENDABLE_TRIGGERS = new Set(["lost_registration", "abandonment", "churn", "return_load"]);

async function collectCandidates(client, cfg) {
  const out = [];
  const seen = new Set();
  const add = (cpf, nome, phone) => {
    const key = digits(cpf) || normalizeText(nome);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ cpf: cpf || null, nome: nome || null, phone: phone || null });
  };

  // 1. Consent-implied — cadastros em andamento (não finalizados).
  const { rows: regs } = await client.query(
    `SELECT dados FROM public.pending_driver_registrations
      WHERE status NOT IN ('concluido', 'aprovado', 'rejeitado')
      ORDER BY created_at DESC
      LIMIT 200`,
  );
  for (const r of regs) {
    const m = r.dados?.motorista || {};
    add(m.cpf, m.nome, m.telefone);
  }

  // 2. Frios — motoristas em churn (só quando liberado).
  if (cfg.coldEnabled) {
    const { rows: snap } = await client.query(
      `SELECT rows_json FROM public.sheet_monitor_snapshot WHERE id = 1`,
    );
    const arr = Array.isArray(snap[0]?.rows_json) ? snap[0].rows_json : [];
    const { dateIso: todayIso } = getSaoPauloWallClock();
    const lastByName = new Map();
    const nameLabel = new Map();
    for (const e of arr) {
      const nome = (e?.motoristas || "").trim();
      const nm = normalizeText(nome);
      const d = String(e?.data || "").slice(0, 10);
      if (!nm || nm.length < 4 || !/^\d{4}-\d{2}-\d{2}$/.test(d) || d > todayIso) continue;
      if (!lastByName.has(nm) || d > lastByName.get(nm)) { lastByName.set(nm, d); nameLabel.set(nm, nome); }
    }
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const [nm, last] of lastByName) {
      if (last < cutoff) add(null, nameLabel.get(nm), null); // churned >30d
    }
  }

  return out.slice(0, cfg.scanMaxCandidates);
}

/**
 * Roda uma varredura e enfileira envios. No-op quando o envio está desligado.
 * @returns {Promise<{enqueued:number, candidates:number, reason?:string}>}
 */
export async function scanAndEnqueueOutreach() {
  const cfg = await withPgClient((client) => getOutreachConfig(client));
  if (!cfg.enabled) return { enqueued: 0, candidates: 0, reason: "disabled" };

  const candidates = await withPgClient((client) => collectCandidates(client, cfg));
  let enqueued = 0;

  for (const cand of candidates) {
    let result;
    try {
      result = await getDriverOpportunities({ cpf: cand.cpf, nome: cand.nome, phone: cand.phone });
    } catch {
      continue;
    }
    if (result.optedOut || !result.driver.phone) continue;

    for (const opp of result.opportunities) {
      if (!SENDABLE_TRIGGERS.has(opp.trigger)) continue;
      if (COLD_TRIGGERS.has(opp.trigger) && !isTriggerAllowed(opp.trigger, cfg)) continue;
      if (!opp.message) continue;
      // Não cobrar "finalize seu cadastro" de quem já tem cadastro VIGENTE no
      // Angellira (o status local não é confiável — ~94% dos falsos positivos).
      if (opp.trigger === "lost_registration" && result.driver.cpf) {
        const v = await checkAngelliraVigencia(result.driver.cpf);
        if (v.vigente) continue;
      }
      const driverKey = result.driver.cpf || normalizeText(result.driver.nome);
      if (!driverKey) continue;
      const id = await withPgClient((client) =>
        enqueueDriverOutreach(client, {
          driverKey,
          trigger: opp.trigger,
          phone: result.driver.phone,
          message: opp.message,
        }),
      );
      if (id) enqueued += 1;
    }
  }

  if (enqueued) {
    logStructuredEvent("info", "driver-outreach.scan.enqueued", { enqueued, candidates: candidates.length });
  }
  return { enqueued, candidates: candidates.length };
}
