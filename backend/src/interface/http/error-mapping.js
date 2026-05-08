// Helpers compartilhados para construir respostas HTTP de erro.
// Cada handler tem regras próprias de quais erros mapeia (ZodError, ValidationError,
// LoadClaimServiceError, etc.); este módulo só padroniza o **shape** do payload
// e três casos universais (validação, serviço, fallback interno).

export function buildHttpErrorResponse(statusCode, { error, code, message }, correlationId, extras = {}) {
  return {
    statusCode,
    payload: {
      error,
      code,
      message,
      ...extras,
      meta: { correlationId },
    },
  };
}

export function buildValidationErrorResponse(error, correlationId) {
  return buildHttpErrorResponse(
    400,
    { error: error.name, code: error.code, message: error.message },
    correlationId,
  );
}

export function buildServiceErrorResponse(error, correlationId, { includeDetails = false } = {}) {
  const extras = includeDetails ? { details: error.details ?? null } : {};
  return buildHttpErrorResponse(
    error.statusCode,
    { error: error.name, code: error.code, message: error.message },
    correlationId,
    extras,
  );
}

export function buildInternalErrorResponse(correlationId, message) {
  return buildHttpErrorResponse(
    500,
    {
      error: "InternalServerError",
      code: "INTERNAL_SERVER_ERROR",
      message,
    },
    correlationId,
  );
}
