import { z } from "zod";
import { uuidSchema } from "./common.js";

/** Route params for routes with :loadId */
export const loadIdParamsSchema = z.object({
  loadId: uuidSchema,
});

/** Route params for routes with :loadId + :claimId */
export const loadAndClaimParamsSchema = z.object({
  loadId: uuidSchema,
  claimId: uuidSchema,
});

/** Route params for routes with :loadId + :leadId */
export const loadAndLeadParamsSchema = z.object({
  loadId: uuidSchema,
  leadId: uuidSchema,
});

/** Query params for /api/load-claims/maintenance */
export const claimMaintenanceQuerySchema = z.object({
  batchSize: z.coerce.number().int().min(1).max(1000).optional(),
  publicLeadRetentionDays: z.coerce.number().int().min(1).max(365).optional(),
  publicLeadBatchSize: z.coerce.number().int().min(1).max(1000).optional(),
});
