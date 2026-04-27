import { z } from "zod";

/**
 * Query params for GET /api/operator/aspx/status.
 * This endpoint accepts no query parameters. Strict empty schema is intentional:
 * any extra params are rejected, documenting that they are not expected or processed.
 */
export const aspxStatusQuerySchema = z.object({});

/**
 * Body for POST /api/operator/aspx/sync.
 * This endpoint requires no request body. Strict empty schema is intentional:
 * any body content is rejected, documenting that it is not expected or processed.
 */
export const aspxSyncBodySchema = z.object({});
