import crypto from "node:crypto";

import { z } from "zod";
import { logger } from "../../../infrastructure/logger.js";
import { CANONICAL_VEHICLE_PROFILES, normalizeVehicleProfile } from "../../../domain/vehicle-profiles.js";
import { buildInternalErrorResponse, buildServiceErrorResponse } from "../error-mapping.js";
import { zodErrorToHttpResponse } from "../schemas/common.js";
import { loadIdParamsSchema, loadAndClaimParamsSchema, loadAndLeadParamsSchema } from "../schemas/load-claim-schemas.js";

import { requireDriverSession, registerDriverUser, requireOperatorSession, getAdminClient } from "../../../application/load-claims/auth.js";
import { getLoadClaimConfig } from "../../../domain/load-claims/config.js";
import { LoadClaimServiceError, NotFoundError, UnauthorizedError, ValidationError } from "../../../domain/load-claims/errors.js";
import { createCorrelationId } from "../../../application/load-claims/helpers.js";
import { assertOperatorPermission } from "../../../application/load-claims/operator-access.js";
import { upsertDriverProfile, getDriverProfileByUserId } from "../../../application/load-claims/profile-service.js";
import {
  getAuthorizationHeader,
  getHeaderValue,
  getQueryParam,
  getRequestIp,
  parseJsonBody,
} from "../http-utils.js";
import {
  approvePublicLoadLead,
  assertOperatorId,
  cancelPublicLoadLead,
  createDirectLeadAllocation,
  createPublicLoadLeadPreRegistration,
  listOperatorPublicLoadLeads,
  queuePublicLoadLeadViaWhatsApp,
  revalidateQueuedPublicLeads,
  revalidateQueuedPublicLeadsAspx,
} from "../../../application/load-claims/public-leads.js";
import { redactExpiredPublicLeadPii } from "../../../application/operator-admin/service.js";
import {
  cancelLoadClaim,
  confirmLoadClaim,
  createLoadClaim,
  getLoadClaimStatus,
  processExpiredLoadClaims,
} from "../../../application/load-claims/service.js";

// Per-IP rate limit for driver registration — state in Redis, shared across replicas.
const REGISTRATION_RATE_LIMIT = 5; // max registrations per IP per window
const REGISTRATION_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

async function checkRegistrationRateLimit(ip) {
  if (!ip) return; // can't rate-limit without IP
  const { checkRateLimit } = await import("../../../infrastructure/rate-limit-redis.js");
  const allowed = await checkRateLimit(`ratelimit:registration:${ip}`, REGISTRATION_RATE_LIMIT, REGISTRATION_RATE_WINDOW_MS);
  if (!allowed) {
    const rateLimitError = Object.assign(
      new Error("Too many registration attempts from this IP. Please try again later."),
      { statusCode: 429, code: "TOO_MANY_REQUESTS" },
    );
    throw rateLimitError;
  }
}

const canonicalVehicleProfileSchema = z
  .string()
  .trim()
  .transform((value) => normalizeVehicleProfile(value))
  .refine((value) => Boolean(value), {
    message: `Vehicle profile must be one of: ${CANONICAL_VEHICLE_PROFILES.join(", ")}`,
  });

const driverProfileSchema = z.object({
  full_name: z.string().trim().min(3),
  phone: z.string().trim().min(8),
  document_number: z.string().trim().min(5).optional().or(z.literal("")),
  vehicle_profile: canonicalVehicleProfileSchema,
  documents_valid: z.boolean().default(true),
  antt_valid: z.boolean().default(true),
  tracking_enabled: z.boolean().default(false),
  insurance_valid: z.boolean().default(false),
  monitoring_capable: z.boolean().default(false),
  allowed_regions: z.array(z.string().trim().min(2).max(2)).default([]),
  metadata: z.record(z.any()).optional().default({}),
});

const driverRegistrationSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().trim().min(6),
  profile: driverProfileSchema,
});

const publicLeadPreRegistrationSchema = z.object({
  cpf: z.string().trim().min(11),
  phone: z.string().trim().min(10),
  horsePlate: z.string().trim().min(7),
  trailerPlate: z.string().trim().max(7).optional().default(""),
  trailerPlate2: z.string().trim().max(7).optional().default(""),
  vehicleType: canonicalVehicleProfileSchema,
});

function getCorrelationId(request) {
  return (
    getHeaderValue(request, "X-Correlation-Id") ||
    createCorrelationId()
  );
}

function logUnexpectedError(error, correlationId, scope) {
  logger.error({
    scope,
    correlationId,
    err: error,
  }, "load-claims-handler: unexpected error");
}

function getUnexpectedUserMessage(scope) {
  switch (scope) {
    case "public-lead-pre-registration":
      return "Nao foi possivel salvar seu pre-cadastro agora. Tente novamente em alguns instantes.";
    case "public-lead-whatsapp":
      return "Nao foi possivel abrir o WhatsApp desta carga agora. Tente novamente em alguns instantes.";
    default:
      return "Nao foi possivel processar sua solicitacao agora. Tente novamente em alguns instantes.";
  }
}

function toErrorResponse(error, correlationId, scope = "load-claims") {
  if (error instanceof z.ZodError) {
    return zodErrorToHttpResponse(error, correlationId);
  }
  if (error instanceof LoadClaimServiceError) {
    return buildServiceErrorResponse(error, correlationId, { includeDetails: true });
  }
  logUnexpectedError(error, correlationId, scope);
  return buildInternalErrorResponse(correlationId, getUnexpectedUserMessage(scope));
}

export async function resolveCreateLoadClaimResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const { user } = await requireDriverSession(getAuthorizationHeader(request));
    const { loadId } = loadIdParamsSchema.parse({ loadId: getQueryParam(request, "loadId") });
    const idempotencyKey = getHeaderValue(request, "Idempotency-Key");

    return await createLoadClaim({
      loadId,
      driverId: user.id,
      idempotencyKey,
      correlationId,
      requestPayload: {},
    });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveConfirmLoadClaimResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const { user } = await requireDriverSession(getAuthorizationHeader(request));
    const { loadId, claimId } = loadAndClaimParamsSchema.parse({
      loadId: getQueryParam(request, "loadId"),
      claimId: getQueryParam(request, "claimId"),
    });
    const idempotencyKey = getHeaderValue(request, "Idempotency-Key");

    return await confirmLoadClaim({
      loadId,
      claimId,
      driverId: user.id,
      idempotencyKey,
      correlationId,
    });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveCancelLoadClaimResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const { user } = await requireDriverSession(getAuthorizationHeader(request));
    const { loadId, claimId } = loadAndClaimParamsSchema.parse({
      loadId: getQueryParam(request, "loadId"),
      claimId: getQueryParam(request, "claimId"),
    });
    const idempotencyKey = getHeaderValue(request, "Idempotency-Key");

    return await cancelLoadClaim({
      loadId,
      claimId,
      driverId: user.id,
      idempotencyKey,
      correlationId,
    });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveGetLoadClaimStatusResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const { loadId } = loadIdParamsSchema.parse({ loadId: getQueryParam(request, "loadId") });
    const leadId = getQueryParam(request, "leadId");

    // Session is optional — public drivers can check status via leadId alone.
    let driverId = null;
    const authHeader = getAuthorizationHeader(request);
    if (authHeader) {
      const session = await requireDriverSession(authHeader);
      driverId = session.user.id;
    }

    return await getLoadClaimStatus({
      loadId,
      driverId,
      publicLeadId: leadId,
      correlationId,
    });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveRegisterDriverResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    await checkRegistrationRateLimit(getRequestIp(request));
    const payload = driverRegistrationSchema.parse(await parseJsonBody(request));
    const user = await registerDriverUser(payload);
    let profileResponse;
    try {
      profileResponse = await upsertDriverProfile({
        userId: user.id,
        profile: payload.profile,
        correlationId,
      });
    } catch (profileError) {
      // Compensating action: delete the auth user to avoid orphan accounts
      try {
        await getAdminClient().auth.admin.deleteUser(user.id);
      } catch (deleteError) {
        logger.error({ userId: user.id, err: deleteError }, "register-driver: Failed to rollback auth user after profile creation failure");
      }
      throw profileError;
    }

    return {
      statusCode: 201,
      payload: {
        ok: true,
        userId: user.id,
        email: user.email,
        profile: profileResponse.payload.profile,
        meta: {
          correlationId,
        },
      },
    };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveDriverProfileResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const { user } = await requireDriverSession(getAuthorizationHeader(request));

    if (request.method === "GET") {
      return await getDriverProfileByUserId({
        userId: user.id,
        correlationId,
      });
    }

    if (request.method !== "PUT") {
      throw new ValidationError("Use GET or PUT on /api/drivers/me.");
    }

    const payload = driverProfileSchema.parse(await parseJsonBody(request));
    return await upsertDriverProfile({
      userId: user.id,
      profile: payload,
      correlationId,
    });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveRegisterOperatorResponse() {
  return {
    statusCode: 404,
    payload: {
      code: "NOT_FOUND",
      message: "Resource not found.",
    },
  };
}

export async function resolveClaimMaintenanceResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const cronSecret = process.env.CRON_SECRET?.trim();
    const authorizationHeader = getAuthorizationHeader(request) ?? "";

    // Fail closed: sem CRON_SECRET configurado, endpoint de manutencao nao pode ser acessado
    if (!cronSecret) {
      throw new UnauthorizedError("CRON_SECRET nao configurado. Endpoint de manutencao indisponivel.");
    }

    const expected = Buffer.from(`Bearer ${cronSecret}`);
    const actual = Buffer.from(authorizationHeader);
    const authorized =
      actual.length === expected.length && crypto.timingSafeEqual(actual, expected);

    if (!authorized) {
      throw new UnauthorizedError("Use the configured CRON_SECRET authorization header.");
    }

    const config = getLoadClaimConfig();
    const batchSize = Number.parseInt(getQueryParam(request, "batchSize") || "", 10) || config.maintenance_batch_size;
    const publicLeadRetentionDays =
      Number.parseInt(getQueryParam(request, "publicLeadRetentionDays") || "", 10) ||
      Number.parseInt(process.env.PUBLIC_LEAD_PII_RETENTION_DAYS || "", 10) ||
      30;
    const publicLeadRedactionBatchSize =
      Number.parseInt(getQueryParam(request, "publicLeadBatchSize") || "", 10) ||
      Number.parseInt(process.env.PUBLIC_LEAD_PII_REDACTION_BATCH_SIZE || "", 10) ||
      50;
    const claimsMaintenance = await processExpiredLoadClaims({
      batchSize,
      correlationId,
    });
    const publicLeadPiiMaintenance = await redactExpiredPublicLeadPii({
      batchSize: publicLeadRedactionBatchSize,
      retentionDays: publicLeadRetentionDays,
      correlationId,
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        ...claimsMaintenance,
        publicLeadPiiMaintenance,
      },
    };
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveCreatePublicLoadLeadPreRegistrationResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const { loadId } = loadIdParamsSchema.parse({ loadId: getQueryParam(request, "loadId") });
    const payload = publicLeadPreRegistrationSchema.parse(await parseJsonBody(request));

    return await createPublicLoadLeadPreRegistration({
      loadId,
      payload,
      correlationId,
      requestContext: {
        clientIp: getRequestIp(request),
      },
    });
  } catch (error) {
    return toErrorResponse(error, correlationId, "public-lead-pre-registration");
  }
}

export async function resolveQueuePublicLoadLeadViaWhatsAppResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const { loadId, leadId } = loadAndLeadParamsSchema.parse({
      loadId: getQueryParam(request, "loadId"),
      leadId: getQueryParam(request, "leadId"),
    });

    return await queuePublicLoadLeadViaWhatsApp({
      loadId,
      leadId,
      correlationId,
      requestContext: {
        clientIp: getRequestIp(request),
      },
    });
  } catch (error) {
    return toErrorResponse(error, correlationId, "public-lead-whatsapp");
  }
}

export async function resolveOperatorPublicLoadLeadsResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    await requireOperatorSession(getAuthorizationHeader(request));

    return await listOperatorPublicLoadLeads({
      correlationId,
    });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

function parseRevalidateScope(request) {
  const raw = (getQueryParam(request, "scope") || "").toLowerCase();
  return raw === "historico" ? "historico" : "fila";
}

export async function resolveRevalidateQueuedPublicLeadsResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(
      user,
      "leads:write",
      "Somente operadores com acesso intermediario ou avancado podem revalidar leads.",
    );

    return await revalidateQueuedPublicLeads({
      correlationId,
      scope: parseRevalidateScope(request),
    });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveRevalidateQueuedPublicLeadsAspxResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(
      user,
      "leads:write",
      "Somente operadores com acesso intermediario ou avancado podem revalidar leads.",
    );

    return await revalidateQueuedPublicLeadsAspx({
      correlationId,
      scope: parseRevalidateScope(request),
    });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveDirectAllocationResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(
      user,
      "leads:write",
      "Somente operadores com acesso intermediario ou avancado podem alocar motoristas.",
    );
    const { loadId } = loadIdParamsSchema.parse({ loadId: getQueryParam(request, "loadId") });
    assertOperatorId(user.id);

    const payload = publicLeadPreRegistrationSchema.parse(await parseJsonBody(request));

    return await createDirectLeadAllocation({
      loadId,
      payload,
      operatorId: user.id,
      correlationId,
    });
  } catch (error) {
    return toErrorResponse(error, correlationId, "direct-allocation");
  }
}

export async function resolveApprovePublicLoadLeadResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(
      user,
      "leads:write",
      "Somente operadores com acesso intermediario ou avancado podem alterar leads.",
    );
    const { loadId, leadId } = loadAndLeadParamsSchema.parse({
      loadId: getQueryParam(request, "loadId"),
      leadId: getQueryParam(request, "leadId"),
    });

    assertOperatorId(user.id);

    return await approvePublicLoadLead({
      loadId,
      leadId,
      operatorId: user.id,
      correlationId,
    });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}

export async function resolveCancelPublicLoadLeadResponse(request) {
  const correlationId = getCorrelationId(request);

  try {
    const { user } = await requireOperatorSession(getAuthorizationHeader(request));
    assertOperatorPermission(
      user,
      "leads:write",
      "Somente operadores com acesso intermediario ou avancado podem alterar leads.",
    );
    const { loadId, leadId } = loadAndLeadParamsSchema.parse({
      loadId: getQueryParam(request, "loadId"),
      leadId: getQueryParam(request, "leadId"),
    });

    assertOperatorId(user.id);

    return await cancelPublicLoadLead({
      loadId,
      leadId,
      operatorId: user.id,
      correlationId,
    });
  } catch (error) {
    return toErrorResponse(error, correlationId);
  }
}
