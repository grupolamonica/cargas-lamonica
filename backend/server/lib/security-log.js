const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_KEY_PATTERN =
  /(authorization|token|secret|password|cookie|cpf|phone|plate|document|email|whatsapp|set-cookie|idempotency|request_hash|fingerprint)/i;
const MAX_DEPTH = 4;
const MAX_STRING_LENGTH = 500;
const INLINE_SECRET_PATTERN =
  /(bearer\s+[a-z0-9\-._~+/]+=*|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+|sbp?_[a-z0-9_-]{16,}|[A-Za-z0-9+/=_-]{32,})/gi;

function truncateString(value) {
  if (typeof value !== "string") {
    return value;
  }

  const sanitizedValue = value.replace(INLINE_SECRET_PATTERN, REDACTED_VALUE);
  return sanitizedValue.length > MAX_STRING_LENGTH ? `${sanitizedValue.slice(0, MAX_STRING_LENGTH)}...` : sanitizedValue;
}

function sanitizeLogValue(value, key = "", depth = 0) {
  if (depth > MAX_DEPTH) {
    return "[TRUNCATED]";
  }

  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return REDACTED_VALUE;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeLogValue(entry, key, depth + 1));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeLogValue(entryValue, entryKey, depth + 1)]),
    );
  }

  return truncateString(value);
}

export function sanitizeLogPayload(payload) {
  return sanitizeLogValue(payload);
}

export function logStructuredEvent(level, eventName, payload = {}) {
  const logger = level === "error" ? console.error : level === "warn" ? console.warn : console.log;

  logger(`[security-event] ${eventName}`, sanitizeLogPayload(payload));
}
