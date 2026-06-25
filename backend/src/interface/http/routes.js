// backend/src/interface/http/routes.js
// Registra todos os 49 route registrations (43 endpoints únicos) no Express Router.
// Importa handlers existentes — sem reescrever lógica de negócio.

import { Router } from "express";

import {
  resolveAspxSyncHealthResponse,
  resolveAspxSyncStatusResponse,
  resolveAspxSyncTriggerResponse,
} from "./aspx-admin/handlers.js";

import { resolveClientLogoResponse } from "./client-logo.handler.js";

import {
  resolveApprovePublicLoadLeadResponse,
  resolveCancelLoadClaimResponse,
  resolveCancelPublicLoadLeadResponse,
  resolveClaimMaintenanceResponse,
  resolveConfirmLoadClaimResponse,
  resolveCreateLoadClaimResponse,
  resolveCreatePublicLoadLeadPreRegistrationResponse,
  resolveDirectAllocationResponse,
  resolveDriverProfileResponse,
  resolveGetLoadClaimStatusResponse,
  resolveOperatorPublicLoadLeadsResponse,
  resolveQueuePublicLoadLeadViaWhatsAppResponse,
  resolveRegisterDriverResponse,
  resolveRevalidateQueuedPublicLeadsResponse,
  resolveRevalidateQueuedPublicLeadsAspxResponse,
} from "./load-claims/handlers.js";

import {
  resolveCreateOperatorCargoResponse,
  resolveAttachClienteRotaResponse,
  resolveCreateOperatorClienteResponse,
  resolveCreateOperatorRouteResponse,
  resolveDeleteOperatorCargoResponse,
  resolveDeleteOperatorClienteResponse,
  resolveDetachClienteRotaResponse,
  resolveDuplicateOperatorCargoResponse,
  resolveListClienteRotasResponse,
  resolveOperatorAuditLogsResponse,
  resolveOperatorCargoListReadModelResponse,
  resolveOperatorClientesListReadModelResponse,
  resolveOperatorDashboardReadModelResponse,
  resolveOperatorDriverFlowMetricsResponse,
  resolveOperatorDriversListReadModelResponse,
  resolveOperatorRoutesListReadModelResponse,
  resolveOperatorSheetSyncResponse,
  resolveOperatorVehiclesListReadModelResponse,
  resolveRedactPublicLeadPiiResponse,
  resolveRevalidateAllVehiclesResponse,
  resolveSheetMonitorEnrichResponse,
  resolveSheetMonitorResponse,
  resolveSheetMonitorRowDetailResponse,
  resolveToggleOperatorCargoStatusResponse,
  resolveUpdateOperatorCargoResponse,
  resolveUpdateOperatorClienteResponse,
  resolveUpdateOperatorDriverProfileResponse,
  resolveUpdateOperatorRouteResponse,
  resolveDriverSponsorClicksResponse,
  resolveOperatorOverviewDigestResponse,
  resolveOperatorCadastrosPendentesResponse,
  resolveOperatorListDraftRegistrationsResponse,
  resolveOperatorSubmitDraftResponse,
  resolveOperatorCadastroFileUrlResponse,
  resolveOperatorCadastroDocsMigradosResponse,
  resolveOperatorCadastroDocMigradoResponse,
  resolveOperatorAprovarCadastroResponse,
  resolveOperatorRejeitarCadastroResponse,
  resolveOperatorAngelliraPrecheckResponse,
  resolveOperatorAngelliraCheckOwnerResponse,
  resolveOperatorAngelliraCadastrarResponse,
  resolveOperatorAngelliraCadastrarStepResponse,
  resolveOperatorListExternalJobsResponse,
  resolveOperatorSpxPrecheckResponse,
  resolveOperatorSpxCadastrarResponse,
  resolveOperatorUnificadaGerarPdfResponse,
  resolveOperatorGetCadastroResponse,
  resolveOperatorPatchCadastroDadosResponse,
  resolveOperatorDeleteCadastroResponse,
  resolveOperatorCadastrarMotoristaResponse,
} from "./operator-admin/handlers.js";

import {
  resolveDriverLoadFacetsResponse,
  resolveDriverLoadsDigestResponse,
  resolveDriverLoadsReadModelResponse,
  resolveDriverPortalVisitResponse,
  resolveDriverSponsorClickResponse,
  resolveGetPublicPacoteResponse,
} from "./public-loads/handlers.js";

import {
  resolveAddCargaPacoteResponse,
  resolveCancelPacoteResponse,
  resolveCreatePacoteResponse,
  resolveGetPacoteResponse,
  resolveListPacotesResponse,
  resolvePublishPacoteResponse,
  resolveRemoveCargaPacoteResponse,
  resolveReorderCargasPacoteResponse,
  resolveUpdatePacoteResponse,
} from "./cargas-casadas/handlers.js";

import { resolveFinalizarCadastroResponse } from "./cadastro/handlers.js";
import { resolveLookupPisResponse } from "./cadastro/lookup-pis.handler.js";

import {
  resolveCandidaturaAnttPrecheckResponse,
  resolveCandidaturaDraftGetResponse,
  resolveCandidaturaDraftSaveResponse,
  resolveCandidaturaPreCheckResponse,
  resolveCandidaturaSubmitResponse,
  resolveCandidaturaVerifyDocumentResponse,
  resolveListIncompleteCadastrosResponse,
} from "./candidatura/handlers.js";
import { resolveUploadDraftFileResponse } from "./candidatura/upload-draft-file.handler.js";
import { draftFileUpload } from "./upload-middleware.js";

import { resolveRouteInfoResponse } from "./route-info.handler.js";
import { resolveSheetSyncResponse } from "./sheet-sync.handler.js";
import { resolveAdvanceRecurringCargasResponse } from "./recurring-cargo.handler.js";

// Adapter: mescla req.params em req.query para handlers que usam getQueryParam(req, name).
// getQueryParam lê req.query[name]; params de URL chegam em req.params.
// req.params sobrescreve req.query — previne injeção de :param via query string (T-02-06).
function withParams(req) {
  const safeParams = Object.fromEntries(
    Object.entries(req.params).filter(
      ([k]) => k !== "__proto__" && k !== "constructor" && k !== "prototype"
    )
  );
  req.query = { ...req.query, ...safeParams };
  return req;
}

// Wrapper padrão: resolve(request) → { statusCode, payload }
function wrap(handler) {
  return async (req, res) => {
    try {
      const { statusCode, payload } = await handler(withParams(req));
      return res.status(statusCode).json(payload);
    } catch (err) {
      console.error("[routes] Erro não tratado:", err.message);
      return res.status(500).json({ error: "InternalServerError" });
    }
  };
}

export function registerRoutes(app) {
  const router = Router();

  // Sheet sync
  router.get("/api/sheet-sync", wrap(resolveSheetSyncResponse));

  // Cargas recorrentes — avanço da data (fallback p/ cron externo; CRON_SECRET)
  router.post("/api/cargas/advance-recurring", wrap(resolveAdvanceRecurringCargasResponse));

  // Route info (cache headers em 200)
  router.get("/api/route-info", async (req, res) => {
    try {
      const origin = (req.query.origin || "").slice(0, 256);
      const destination = (req.query.destination || "").slice(0, 256);
      const { statusCode, payload } = await resolveRouteInfoResponse(origin, destination);
      if (statusCode === 200) {
        res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
      }
      return res.status(statusCode).json(payload);
    } catch (err) {
      console.error("[routes] route-info erro:", err.message);
      return res.status(500).json({ error: "InternalServerError" });
    }
  });

  // Client logo (resposta binária — não JSON)
  router.get("/api/client-logo", async (req, res) => {
    try {
      const rawUrl = req.query.url || "";
      const { statusCode, headers, body } = await resolveClientLogoResponse(rawUrl);
      Object.entries(headers || {}).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(statusCode).send(body);
    } catch (err) {
      console.error("[routes] client-logo erro:", err.message);
      return res.status(500).end();
    }
  });

  // Public cadastro (no auth)
  router.post("/api/public/cadastro/finalizar", wrap(resolveFinalizarCadastroResponse));

  // Cadastro v2 — driver-authenticated wizard endpoints
  router.post("/api/candidatura/pre-check", wrap(resolveCandidaturaPreCheckResponse));
  router.post("/api/candidatura/draft", wrap(resolveCandidaturaDraftSaveResponse));
  router.get("/api/candidatura/draft/me", wrap(resolveCandidaturaDraftGetResponse));
  router.post("/api/candidatura/antt-precheck", wrap(resolveCandidaturaAnttPrecheckResponse));
  router.post("/api/candidatura/submit", wrap(resolveCandidaturaSubmitResponse));
  // Iter #7: list drafts incompletos do motorista (1 entrada por carga).
  router.get("/api/driver/cadastros/incompletos", wrap(resolveListIncompleteCadastrosResponse));
  // Cadastro v2 — lookup-pis (driver-auth, plan 260515-loi).
  router.post("/api/cadastro/lookup-pis", wrap(resolveLookupPisResponse));
  // Cadastro v2 — verify-document (PUBLICO, rate limit 5/min/IP).
  router.post("/api/candidatura/verify-document", wrap(resolveCandidaturaVerifyDocumentResponse));

  // Cadastro v2 — upload-draft-file (multipart). Persiste arquivos do wizard
  // em Supabase Storage (bucket `cadastro-drafts`) antes do submit final.
  router.post(
    "/api/cadastro/upload-draft-file",
    (req, res, next) => {
      draftFileUpload.single("file")(req, res, (err) => {
        if (!err) return next();
        const correlationId = req.correlationId || null;
        if (err?.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({
            error: "FILE_TOO_LARGE",
            message: "Arquivo excede o limite de 8 MB.",
            meta: { correlationId },
          });
        }
        if (err?.code === "UNSUPPORTED_TYPE") {
          return res.status(415).json({
            error: "UNSUPPORTED_TYPE",
            message:
              "Tipo de arquivo nao suportado. Use JPEG, PNG, HEIC, HEIF ou PDF.",
            meta: { correlationId },
          });
        }
        console.warn("[upload-draft-file.multer]", {
          correlationId,
          code: err?.code,
          message: err?.message,
        });
        return res.status(400).json({
          error: "BadRequest",
          message: "Falha ao processar upload multipart.",
          meta: { correlationId },
        });
      });
    },
    wrap(resolveUploadDraftFileResponse),
  );

  // Driver / public loads
  router.get("/api/driver/loads", wrap(resolveDriverLoadsReadModelResponse));
  router.get("/api/driver/loads/facets", wrap(resolveDriverLoadFacetsResponse));
  router.get("/api/driver/loads/digest", wrap(resolveDriverLoadsDigestResponse));
  router.post("/api/driver/portal-view", wrap(resolveDriverPortalVisitResponse));
  router.post("/api/driver/sponsor-click", wrap(resolveDriverSponsorClickResponse));
  // Phase 10 (cargas-casadas): driver-facing anonimo, espelha /api/driver/loads
  router.get("/api/driver/pacotes/:pacoteId", wrap(resolveGetPublicPacoteResponse));

  // Driver registration & profile
  // resolveDriverProfileResponse despacha GET vs PUT via request.method internamente
  router.post("/api/drivers/register", wrap(resolveRegisterDriverResponse));
  router.get("/api/drivers/me", wrap(resolveDriverProfileResponse));
  router.put("/api/drivers/me", wrap(resolveDriverProfileResponse));

  // Load claims maintenance
  // resolveClaimMaintenanceResponse despacha GET vs POST via request.method internamente
  router.get("/api/load-claims/maintenance", wrap(resolveClaimMaintenanceResponse));
  router.post("/api/load-claims/maintenance", wrap(resolveClaimMaintenanceResponse));

  // Load claims (parametrizadas)
  router.get("/api/loads/:loadId/claim-status", wrap(resolveGetLoadClaimStatusResponse));
  router.post("/api/loads/:loadId/pre-registration", wrap(resolveCreatePublicLoadLeadPreRegistrationResponse));
  router.post("/api/loads/:loadId/claims", wrap(resolveCreateLoadClaimResponse));
  router.post("/api/loads/:loadId/claims/:claimId/confirm", wrap(resolveConfirmLoadClaimResponse));
  router.post("/api/loads/:loadId/claims/:claimId/cancel", wrap(resolveCancelLoadClaimResponse));

  // Public load leads
  router.post("/api/loads/:loadId/leads/:leadId/approve", wrap(resolveApprovePublicLoadLeadResponse));
  router.post("/api/loads/:loadId/leads/:leadId/cancel", wrap(resolveCancelPublicLoadLeadResponse));
  router.post("/api/loads/:loadId/leads/:leadId/whatsapp", wrap(resolveQueuePublicLoadLeadViaWhatsAppResponse));
  router.post("/api/operator/loads/:loadId/direct-allocation", wrap(resolveDirectAllocationResponse));

  // Operator dashboard & audit
  router.get("/api/operator/dashboard", wrap(resolveOperatorDashboardReadModelResponse));
  router.get("/api/operator/overview/digest", wrap(resolveOperatorOverviewDigestResponse));
  router.get("/api/operator/audit-logs", wrap(resolveOperatorAuditLogsResponse));
  router.get("/api/operator/driver-flow-metrics", wrap(resolveOperatorDriverFlowMetricsResponse));
  router.get("/api/operator/sponsor-clicks", wrap(resolveDriverSponsorClicksResponse));

  // Operator leads
  router.get("/api/operator/leads", wrap(resolveOperatorPublicLoadLeadsResponse));
  router.post("/api/operator/leads/revalidate-queued", wrap(resolveRevalidateQueuedPublicLeadsResponse));
  router.post("/api/operator/leads/revalidate-queued-aspx", wrap(resolveRevalidateQueuedPublicLeadsAspxResponse));

  // ASPX
  router.get("/api/operator/aspx/status", wrap(resolveAspxSyncStatusResponse));
  router.get("/api/admin/aspx-sync-health", wrap(resolveAspxSyncHealthResponse));
  router.post("/api/operator/aspx/sync", wrap(resolveAspxSyncTriggerResponse));

  // Motoristas
  router.get("/api/operator/motoristas", wrap(resolveOperatorDriversListReadModelResponse));
  router.patch("/api/operator/motoristas/:driverId", wrap(resolveUpdateOperatorDriverProfileResponse));
  // Cadastro rápido de motorista pelo operador (sem wizard público)
  router.post("/api/operator/motoristas/cadastrar", wrap(resolveOperatorCadastrarMotoristaResponse));

  // Cadastros pendentes de motoristas (rota fixa antes da parametrizada)
  router.get("/api/operator/cadastros/rascunhos", wrap(resolveOperatorListDraftRegistrationsResponse));
  router.get("/api/operator/cadastros-pendentes", wrap(resolveOperatorCadastrosPendentesResponse));
  router.post("/api/operator/cadastros/:id/aprovar", wrap(resolveOperatorAprovarCadastroResponse));
  router.post("/api/operator/cadastros/:id/rejeitar", wrap(resolveOperatorRejeitarCadastroResponse));
  // Resgate de rascunho: operador completa e submete em nome do motorista
  router.post("/api/operator/cadastros/:id/submeter", wrap(resolveOperatorSubmitDraftResponse));

  // Angellira automation (DC-111 / Sprint 1)
  router.post("/api/operator/cadastros/:id/angellira/precheck", wrap(resolveOperatorAngelliraPrecheckResponse));
  router.post("/api/operator/cadastros/:id/angellira/check-owner", wrap(resolveOperatorAngelliraCheckOwnerResponse));
  router.post("/api/operator/cadastros/:id/angellira/cadastrar", wrap(resolveOperatorAngelliraCadastrarResponse));
  router.post("/api/operator/cadastros/:id/angellira/cadastrar/:step", wrap(resolveOperatorAngelliraCadastrarStepResponse));
  router.get("/api/operator/cadastros/:id/external-jobs", wrap(resolveOperatorListExternalJobsResponse));

  // SPX automation (DC-111 / extensão SPX)
  router.post("/api/operator/cadastros/:id/spx/precheck", wrap(resolveOperatorSpxPrecheckResponse));
  router.post("/api/operator/cadastros/:id/spx/cadastrar", wrap(resolveOperatorSpxCadastrarResponse));

  // Unificada — dossiê de gerenciamento de risco (Fase 1 SPX)
  router.post("/api/operator/cadastros/:id/unificada/gerar-pdf", wrap(resolveOperatorUnificadaGerarPdfResponse));

  // Gerenciamento de cadastros (editar/excluir)
  router.get("/api/operator/cadastros/:id/arquivo", wrap(resolveOperatorCadastroFileUrlResponse));
  router.get("/api/operator/cadastros/:id/docs-migrados", wrap(resolveOperatorCadastroDocsMigradosResponse));
  router.get("/api/operator/cadastros/:id/doc-migrado", wrap(resolveOperatorCadastroDocMigradoResponse));
  router.get("/api/operator/cadastros/:id", wrap(resolveOperatorGetCadastroResponse));
  router.patch("/api/operator/cadastros/:id/dados", wrap(resolveOperatorPatchCadastroDadosResponse));
  router.delete("/api/operator/cadastros/:id", wrap(resolveOperatorDeleteCadastroResponse));

  // Veículos
  router.get("/api/operator/veiculos", wrap(resolveOperatorVehiclesListReadModelResponse));
  router.post("/api/operator/veiculos/revalidate", wrap(resolveRevalidateAllVehiclesResponse));

  // Sheet monitor
  router.get("/api/operator/sheet-monitor", wrap(resolveSheetMonitorResponse));
  router.get("/api/operator/sheet-monitor/row", wrap(resolveSheetMonitorRowDetailResponse));
  router.post("/api/operator/sheet-monitor/enrich", wrap(resolveSheetMonitorEnrichResponse));

  // PII Redaction
  router.post("/api/operator/pii-redaction", wrap(resolveRedactPublicLeadPiiResponse));

  // Cargas — CRÍTICO: rota fixa ANTES da parametrizada (T-02-07)
  // /api/operator/cargas/sync-sheet deve ser registrada antes de /api/operator/cargas/:cargoId
  // para que Express não interprete "sync-sheet" como valor de :cargoId.
  router.post("/api/operator/cargas/sync-sheet", wrap(resolveOperatorSheetSyncResponse));
  router.get("/api/operator/cargas", wrap(resolveOperatorCargoListReadModelResponse));
  router.post("/api/operator/cargas", wrap(resolveCreateOperatorCargoResponse));
  router.patch("/api/operator/cargas/:cargoId", wrap(resolveUpdateOperatorCargoResponse));
  router.delete("/api/operator/cargas/:cargoId", wrap(resolveDeleteOperatorCargoResponse));
  router.post("/api/operator/cargas/:cargoId/duplicate", wrap(resolveDuplicateOperatorCargoResponse));
  router.post("/api/operator/cargas/:cargoId/toggle-status", wrap(resolveToggleOperatorCargoStatusResponse));

  // Clientes
  router.get("/api/operator/clientes", wrap(resolveOperatorClientesListReadModelResponse));
  router.post("/api/operator/clientes", wrap(resolveCreateOperatorClienteResponse));
  router.patch("/api/operator/clientes/:clienteId", wrap(resolveUpdateOperatorClienteResponse));
  router.delete("/api/operator/clientes/:clienteId", wrap(resolveDeleteOperatorClienteResponse));
  // Cliente <-> rota associations (N:M via cliente_rotas table)
  router.get("/api/operator/clientes/:clienteId/rotas", wrap(resolveListClienteRotasResponse));
  router.post("/api/operator/clientes/:clienteId/rotas", wrap(resolveAttachClienteRotaResponse));
  router.delete("/api/operator/clientes/:clienteId/rotas/:rotaId", wrap(resolveDetachClienteRotaResponse));

  // Routes catalog
  router.get("/api/operator/routes", wrap(resolveOperatorRoutesListReadModelResponse));
  router.post("/api/operator/routes", wrap(resolveCreateOperatorRouteResponse));
  router.patch("/api/operator/routes/:routeId", wrap(resolveUpdateOperatorRouteResponse));

  // Cargas casadas (pacote de cargas) — Phase 10
  // CRITICAL T-02-07: rotas com sub-segmentos fixos (reorder/cargas/publish/cancel)
  // ANTES das parametrizadas, para o Express nao interpretar segmento como :pacoteId.
  router.get("/api/operator/cargas-casadas", wrap(resolveListPacotesResponse));
  router.post("/api/operator/cargas-casadas", wrap(resolveCreatePacoteResponse));
  router.put(
    "/api/operator/cargas-casadas/:pacoteId/cargas/reorder",
    wrap(resolveReorderCargasPacoteResponse),
  );
  router.post(
    "/api/operator/cargas-casadas/:pacoteId/cargas",
    wrap(resolveAddCargaPacoteResponse),
  );
  router.delete(
    "/api/operator/cargas-casadas/:pacoteId/cargas/:cargaId",
    wrap(resolveRemoveCargaPacoteResponse),
  );
  router.post(
    "/api/operator/cargas-casadas/:pacoteId/publish",
    wrap(resolvePublishPacoteResponse),
  );
  router.post(
    "/api/operator/cargas-casadas/:pacoteId/cancel",
    wrap(resolveCancelPacoteResponse),
  );
  router.get("/api/operator/cargas-casadas/:pacoteId", wrap(resolveGetPacoteResponse));
  router.put("/api/operator/cargas-casadas/:pacoteId", wrap(resolveUpdatePacoteResponse));

  app.use(router);
}
