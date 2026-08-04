const REDACTED_VALUE = "[REDACTED]";
const SENSITIVE_KEY_PATTERN =
  /(authorization|token|secret|password|cookie|cpf|phone|plate|document|email|whatsapp|set-cookie|idempotency|request_hash|fingerprint)/i;
const MAX_DEPTH = 4;
const MAX_STRING_LENGTH = 500;
const INLINE_SECRET_PATTERN =
  /(bearer\s+[a-z0-9\-._~+/]+=*|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+|sbp?_[a-z0-9_-]{16,}|[A-Za-z0-9+/=_-]{32,})/gi;
// Chave termina em "id" (camelCase "cargoId"/"winnerId" ou snake_case "resource_id"):
// convenção deste codebase para identificadores internos, nunca segredo.
const ID_LIKE_KEY_PATTERN = /(^id$|_id$|[a-z0-9]id$)/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function truncateString(value, key = "") {
  if (typeof value !== "string") {
    return value;
  }

  // Um uuid inteiro (36 chars) casa por completo `[A-Za-z0-9+/=_-]{32,}` — sem esta
  // exceção, QUALQUER id de carga gravado em metadata (ex.: `cargoId` dentro de
  // `moves`/`beforeMoves` em reassign-monitor-allocations.js) vira "[REDACTED]" na
  // gravação, e o revert nunca mais encontra a carga certa (bug real, achado
  // testando reverter uma gêmea mergeada por cargoId — não um token vazando, só um
  // identificador interno sob uma chave "...Id"/"..._id").
  if (ID_LIKE_KEY_PATTERN.test(key) && UUID_PATTERN.test(value)) {
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

  return truncateString(value, key);
}

export function sanitizeLogPayload(payload) {
  return sanitizeLogValue(payload);
}

export function logStructuredEvent(level, eventName, payload = {}) {
  const logger = level === "error" ? console.error : level === "warn" ? console.warn : console.log;

  logger(`[security-event] ${eventName}`, sanitizeLogPayload(payload));
}
