import { sanitizeLogPayload } from "../../lib/security-log.js";

export function logLoadClaimEvent(level, message, payload = {}) {
  const logEntry = {
    scope: "load-claims",
    level,
    message,
    timestamp: new Date().toISOString(),
    ...sanitizeLogPayload(payload),
  };

  const serializedLogEntry = JSON.stringify(logEntry);

  if (level === "error") {
    console.error(serializedLogEntry);
    return;
  }

  console.log(serializedLogEntry);
}
