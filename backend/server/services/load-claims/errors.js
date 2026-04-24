export class LoadClaimServiceError extends Error {
  constructor(message, { code = "LOAD_CLAIM_ERROR", statusCode = 500, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details ?? null;
  }
}

export class ValidationError extends LoadClaimServiceError {
  constructor(message, details) {
    super(message, {
      code: "VALIDATION_ERROR",
      statusCode: 400,
      details,
    });
  }
}

export class UnauthorizedError extends LoadClaimServiceError {
  constructor(message = "Authorization header is required.") {
    super(message, {
      code: "UNAUTHORIZED",
      statusCode: 401,
    });
  }
}

export class ForbiddenError extends LoadClaimServiceError {
  constructor(message = "You are not allowed to perform this operation.") {
    super(message, {
      code: "FORBIDDEN",
      statusCode: 403,
    });
  }
}

export class NotFoundError extends LoadClaimServiceError {
  constructor(message = "Resource not found.") {
    super(message, {
      code: "NOT_FOUND",
      statusCode: 404,
    });
  }
}

export class ConflictError extends LoadClaimServiceError {
  constructor(message, details) {
    super(message, {
      code: "CONFLICT",
      statusCode: 409,
      details,
    });
  }
}

export class FeatureDisabledError extends LoadClaimServiceError {
  constructor(message = "The claim flow is currently disabled.") {
    super(message, {
      code: "FEATURE_DISABLED",
      statusCode: 503,
    });
  }
}

export class TooManyRequestsError extends LoadClaimServiceError {
  constructor(message = "Too many requests. Please try again later.", details) {
    super(message, {
      code: "RATE_LIMITED",
      statusCode: 429,
      details,
    });
  }
}
