import { z } from "zod";
import { uuidSchema } from "./common.js";

/** Route params for /api/operator/routes/:routeId */
export const routeIdParamsSchema = z.object({
  routeId: uuidSchema,
});
