import { z } from "zod";
import { uuidSchema } from "./common.js";

/** Route params for /api/operator/cargas/:cargoId */
export const cargoIdParamsSchema = z.object({
  cargoId: uuidSchema,
});

/** Query for GET /api/operator/cargas/lookup/codigo-viagem?codigo_viagem= */
export const cargoCodigoViagemQuerySchema = z.object({
  codigo_viagem: z.string().trim().min(1).max(255),
});
