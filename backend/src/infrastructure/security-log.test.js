import { describe, expect, it } from "vitest";

import { sanitizeLogPayload } from "./security-log.js";

describe("security-log", () => {
  it("redige chaves sensiveis e segredos inline antes de serializar logs", () => {
    const payload = sanitizeLogPayload({
      authorization: "Bearer super-secret-token",
      idempotency_key: "idem-1234567890",
      nested: {
        phone: "71999999999",
        message: "SUPABASE_SERVICE_ROLE_KEY=sbp_super_secret_value_1234567890123456",
      },
    });

    expect(payload).toEqual({
      authorization: "[REDACTED]",
      idempotency_key: "[REDACTED]",
      nested: {
        phone: "[REDACTED]",
        message: expect.stringContaining("[REDACTED]"),
      },
    });
  });
});
