import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

function extractCurrentAppRoleFunctionBody(sqlText) {
  const matchedFunction = sqlText.match(
    /CREATE OR REPLACE FUNCTION public\.current_app_role\(\)\s+RETURNS text\s+LANGUAGE sql\s+STABLE\s+AS \$\$([\s\S]*?)\$\$/i,
  );

  return matchedFunction?.[1] || "";
}

describe("bootstrap authorization hardening", () => {
  it("trusts only app_metadata.role and never falls back to user-writable user_metadata", () => {
    // Canonical bootstrap lives at backend/supabase/bootstrap.sql.
    // (A legacy copy at the repo root /supabase/bootstrap.sql is no longer
    // referenced by application code and is excluded from this regression guard.)
    const bootstrapPath = path.resolve(currentDirectory, "../../supabase/bootstrap.sql");
    const bootstrapSql = readFileSync(bootstrapPath, "utf8");
    const functionBody = extractCurrentAppRoleFunctionBody(bootstrapSql);

    expect(functionBody).toContain("auth.jwt() -> 'app_metadata' ->> 'role'");
    // Regression guard for the privilege-escalation vector closed in migration
    // 20260528000002_harden_current_app_role_v2.sql: user_metadata is writable
    // by the user via supabase.auth.updateUser and must not be read here.
    expect(functionBody).not.toContain("auth.jwt() -> 'user_metadata' ->> 'role'");
    expect(functionBody).not.toContain("'operator'");
    expect(functionBody).toContain("NULLIF");
  });
});
