import { z } from "zod";

export const uuidSchema = z.string().uuid("Must be a valid UUID");

export const positiveIntSchema = z.coerce.number().int().positive();

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
});

export const dateRangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/**
 * Format ZodError → HTTP 422 payload.
 * Maintains `details` (compat with existing consumers) and adds `issues` (new format).
 */
export function zodErrorToHttpResponse(error, correlationId) {
  const issues = error.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message,
  }));

  return {
    statusCode: 422,
    payload: {
      error: "ValidationError",
      code: "VALIDATION_ERROR",
      message: "Payload invalido para a operacao solicitada.",
      issues,
      details: issues, // compat alias
      meta: { correlationId },
    },
  };
}

/**
 * safeParse a schema and return data, or throw ZodError for handler-level catch.
 */
export function parseOrThrow(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw result.error;
  return result.data;
}
