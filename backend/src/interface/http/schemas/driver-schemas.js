import { z } from "zod";
import { uuidSchema } from "./common.js";

/** Route params for /api/operator/motoristas/:driverId */
export const driverIdParamsSchema = z.object({
  driverId: uuidSchema,
});
