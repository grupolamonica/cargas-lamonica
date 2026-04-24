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
  it("does not grant operator role by default when the JWT has no explicit role", () => {
    const bootstrapPath = path.resolve(currentDirectory, "../../../supabase/bootstrap.sql");
    const bootstrapSql = readFileSync(bootstrapPath, "utf8");
    const functionBody = extractCurrentAppRoleFunctionBody(bootstrapSql);

    expect(functionBody).toContain("auth.jwt() -> 'app_metadata' ->> 'role'");
    expect(functionBody).toContain("auth.jwt() -> 'user_metadata' ->> 'role'");
    expect(functionBody).not.toContain("'operator'");
    expect(functionBody).toContain("NULLIF");
  });
});
