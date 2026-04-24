class GeoapifyServiceError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code;
    this.status = options.status;
    this.operation = options.operation;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export class ValidationError extends GeoapifyServiceError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? "VALIDATION_ERROR" });
  }
}

export class ConfigurationError extends GeoapifyServiceError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? "CONFIGURATION_ERROR" });
  }
}

export class TimeoutError extends GeoapifyServiceError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? "TIMEOUT_ERROR" });
  }
}

export class UpstreamApiError extends GeoapifyServiceError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? "UPSTREAM_API_ERROR" });
  }
}

export class RouteResolutionError extends GeoapifyServiceError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? "ROUTE_RESOLUTION_ERROR" });
  }
}

export { GeoapifyServiceError };
