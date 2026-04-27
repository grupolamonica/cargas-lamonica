import { z } from "zod";
import { uuidSchema } from "./common.js";

/** Route params for /api/operator/clientes/:clienteId */
export const clienteIdParamsSchema = z.object({
  clienteId: uuidSchema,
});
