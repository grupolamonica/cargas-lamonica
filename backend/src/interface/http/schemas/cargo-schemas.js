import { z } from "zod";
import { uuidSchema } from "./common.js";

/** Route params for /api/operator/cargas/:cargoId */
export const cargoIdParamsSchema = z.object({
  cargoId: uuidSchema,
});
