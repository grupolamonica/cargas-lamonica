import { z } from "zod";

/** Query params for GET /api/operator/aspx/status */
export const aspxStatusQuerySchema = z.object({}).passthrough();

/** Body for POST /api/operator/aspx/sync — currently no body required */
export const aspxSyncBodySchema = z.object({}).passthrough();
