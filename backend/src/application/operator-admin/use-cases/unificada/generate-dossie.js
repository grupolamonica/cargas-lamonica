/**
 * Gera o dossiê de gerenciamento de risco (Risk Assessment Document) unificado
 * para um cadastro e persiste no Supabase Storage.
 *
 * Espelha o que a produção faz (lib/spx_payload.gerarRiskDoc): chama o sidecar
 * unificada (API-only AngelLira) que monta o PDF Motorista+Cavalo+Carreta, e
 * guarda o resultado. Idempotente/reuso: um dossiê OK gerado há < 24h NÃO é
 * regenerado (igual ao reuseExisting da produção), evitando martelar a API
 * AngelLira a cada disparo.
 *
 * Registra um job em external_registration_jobs (target='spx', step='unificada_pdf')
 * — o dossiê é o passo de Risk Doc do fluxo SPX, e essa chave permite a Fase do
 * disparo SPX reaproveitar o PDF já gerado.
 *
 * Epic SPX (extensão Lamônica) — Fase 1 (unificada/dossiê).
 */

import { logStructuredEvent } from "../../../../infrastructure/security-log.js";
import { insertSecurityAuditEvent } from "../../../../infrastructure/security-audit.js";
import { getAdminClient } from "../../../load-claims/auth.js";

import { extractPlacas } from "../angellira/payload-mapper.js";
import { findExistingOkJob, markJobInProgress, markJobOk, markJobError } from "../angellira/jobs-repository.js";
import {
  UnificadaBotError,
  gerarPdfUnificado,
} from "../../../../infrastructure/cadastro-bots/unificada-bot-client.js";

const TARGET = "spx";
const STEP = "unificada_pdf";
// Reusa o bucket de drafts (privado) sob o prefixo risk-docs/. Trocável por um
// bucket dedicado via env sem mexer no código.
const RISK_DOC_BUCKET = process.env.RISK_DOC_BUCKET?.trim() || "cadastro-drafts";
const SIGNED_URL_TTL_SECONDS = 24 * 60 * 60; // 24h
const REUSE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // não regenera dossiê < 24h

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

async function signUrl(storage, path) {
  try {
    const { data, error } = await storage.createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (error) return null;
    return data?.signedUrl ?? data?.signedURL ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {object} args
 * @param {import('pg').PoolClient} args.client
 * @param {object} args.cadastro      pending_driver_registrations (com .id e .dados)
 * @param {string} [args.operatorId]
 * @param {string} [args.correlationId]
 * @param {boolean} [args.force]       ignora o reuso (<24h) e regenera
 * @returns {Promise<{ok:true, reused:boolean, storagePath:string, signedUrl:string|null, components, warnings}
 *                  | {ok:false, error:{code,message,acao?}}>}
 */
export async function generateDossie({
  client,
  cadastro,
  operatorId = null,
  correlationId = null,
  force = false,
}) {
  const cadastroId = cadastro?.id;
  if (!cadastroId) throw new Error("cadastro.id ausente — generateDossie abortado");

  const cpf = digitsOnly(cadastro?.dados?.motorista?.cpf);
  const { cavalo: placaCavalo, carreta: placaCarreta } = extractPlacas(cadastro?.dados || {});

  if (!cpf && !placaCavalo && !placaCarreta) {
    return {
      ok: false,
      error: {
        code: "DADOS_INSUFICIENTES",
        message: "Cadastro sem CPF nem placas — nada para consultar no gerenciamento de risco.",
        acao: "Confira CPF do motorista e placas do veículo no cadastro.",
      },
    };
  }

  logStructuredEvent("info", "unificada.dossie.start", { cadastroId, hasCpf: !!cpf, placaCavalo: !!placaCavalo, placaCarreta: !!placaCarreta, correlationId });

  const supabase = getAdminClient();
  const storage = supabase.storage.from(RISK_DOC_BUCKET);

  // ── Reuso: dossiê OK recente (< 24h) → não regenera ──────────────────────
  if (!force) {
    const existing = await findExistingOkJob({ client, cadastroId, step: STEP, target: TARGET });
    const storedPath = existing?.response?.storage_path;
    if (storedPath && existing.finished_at) {
      const ageMs = Date.now() - new Date(existing.finished_at).getTime();
      if (ageMs >= 0 && ageMs < REUSE_MAX_AGE_MS) {
        const signedUrl = await signUrl(storage, storedPath);
        logStructuredEvent("info", "unificada.dossie.reused", { cadastroId, ageMs, correlationId });
        return {
          ok: true,
          reused: true,
          storagePath: storedPath,
          signedUrl,
          components: existing.response?.components ?? null,
          warnings: existing.response?.warnings ?? null,
        };
      }
    }
  }

  const jobId = await markJobInProgress({
    client, cadastroId, step: STEP, target: TARGET,
    payload: { cpf, placa_cavalo: placaCavalo, placa_carreta: placaCarreta },
  });

  try {
    const result = await gerarPdfUnificado({
      cpf: cpf || null,
      placaCavalo: placaCavalo || null,
      placaCarreta: placaCarreta || null,
      correlationId,
    });

    const storagePath = `risk-docs/${cadastroId}/dossie_${Date.now()}.pdf`;
    const { error: upErr } = await storage.upload(storagePath, result.pdf, {
      contentType: "application/pdf",
      upsert: false,
    });
    if (upErr) {
      throw new UnificadaBotError({
        code: "RISK_DOC_STORAGE_FAIL",
        message: `Falha ao salvar o dossiê no storage: ${upErr.message || upErr}`,
        acao: "Verifique o bucket do Supabase Storage e as credenciais service-role.",
        httpStatus: 502,
      });
    }

    const signedUrl = await signUrl(storage, storagePath);

    const response = {
      storage_path: storagePath,
      bucket: RISK_DOC_BUCKET,
      bytes: result.pdf.length,
      components: result.components,
      warnings: result.warnings,
    };
    await markJobOk({ client, jobId, response, externalId: null });

    try {
      await insertSecurityAuditEvent(client, {
        eventType: "operator.cadastro.dossie_generated",
        actorUserId: operatorId, actorRole: "operator",
        resourceType: "pending_driver_registration", resourceId: cadastroId,
        action: "unificada_pdf", outcome: "success",
        correlationId,
        metadata: { bytes: result.pdf.length, storage_path: storagePath, bucket: RISK_DOC_BUCKET },
      });
    } catch (auditErr) {
      logStructuredEvent("warn", "unificada.dossie.audit_failed", { cadastroId, message: auditErr?.message || String(auditErr) });
    }

    logStructuredEvent("info", "unificada.dossie.generated", { cadastroId, bytes: result.pdf.length, correlationId });
    return { ok: true, reused: false, storagePath, signedUrl, components: result.components, warnings: result.warnings };
  } catch (err) {
    const errorPayload = err instanceof UnificadaBotError
      ? err.toJSON()
      : { code: "UNIFICADA_PIPELINE_UNEXPECTED", message: err?.message || String(err) };
    await markJobError({ client, jobId, error: errorPayload });
    try {
      await insertSecurityAuditEvent(client, {
        eventType: "operator.cadastro.dossie_failed",
        actorUserId: operatorId, actorRole: "operator",
        resourceType: "pending_driver_registration", resourceId: cadastroId,
        action: "unificada_pdf", outcome: "failure",
        correlationId,
        metadata: { code: errorPayload.code },
      });
    } catch { /* audit best-effort */ }
    logStructuredEvent("warn", "unificada.dossie.failed", { cadastroId, code: errorPayload.code, correlationId });
    return { ok: false, error: errorPayload };
  }
}
