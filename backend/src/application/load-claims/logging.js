import { sanitizeLogPayload } from "../../infrastructure/security-log.js";
import { logger } from "../../infrastructure/logger.js";

export function logLoadClaimEvent(level, message, payload = {}) {
  const sanitized = sanitizeLogPayload(payload);
  const data = { scope: "load-claims", ...sanitized };

  if (level === "error") {
    logger.error(data, message);
    return;
  }

  if (level === "warn") {
    logger.warn(data, message);
    return;
  }

  logger.info(data, message);
}
