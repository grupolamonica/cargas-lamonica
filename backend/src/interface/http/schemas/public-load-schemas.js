import { z } from "zod";
import { uuidSchema } from "./common.js";

/** Query params for GET /api/driver/loads */
export const driverLoadsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
  origem: z.string().optional(),
  destino: z.string().optional(),
  perfil: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
}).passthrough(); // allow extra fields (driver-facing, relaxed)

/** Route params for /api/loads/:loadId/leads/:leadId/... */
export const leadIdParamsSchema = z.object({
  leadId: uuidSchema,
});
