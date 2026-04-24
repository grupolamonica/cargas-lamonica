import { describe, expect, it } from "vitest";

import {
  assertOperatorPermission,
  getOperatorAccessLevel,
  getUserRole,
  hasOperatorPermission,
} from "./operator-access.js";

describe("operator access", () => {
  it("prioritizes app_metadata role over user_metadata role", () => {
    const role = getUserRole({
      app_metadata: {
        role: "operator",
      },
      user_metadata: {
        role: "driver",
      },
    });

    expect(role).toBe("operator");
  });

  it("defaults legacy operators without access_level to advanced", () => {
    const accessLevel = getOperatorAccessLevel({
      app_metadata: {
        role: "operator",
      },
      user_metadata: {},
    });

    expect(accessLevel).toBe("advanced");
    expect(hasOperatorPermission({ app_metadata: { role: "operator" } }, "clientes:write")).toBe(true);
  });

  it("restricts intermediate operators to cargos and leads mutations", () => {
    const intermediateOperator = {
      app_metadata: {
        role: "operator",
        access_level: "intermediate",
      },
    };

    expect(getOperatorAccessLevel(intermediateOperator)).toBe("intermediate");
    expect(hasOperatorPermission(intermediateOperator, "cargos:write")).toBe(true);
    expect(hasOperatorPermission(intermediateOperator, "leads:write")).toBe(true);
    expect(hasOperatorPermission(intermediateOperator, "clientes:write")).toBe(false);
    expect(hasOperatorPermission(intermediateOperator, "routes:write")).toBe(false);
  });

  it("throws when the operator does not have the requested permission", () => {
    expect(() =>
      assertOperatorPermission(
        {
          app_metadata: {
            role: "operator",
            access_level: "intermediate",
          },
        },
        "clientes:write",
        "Somente operadores com acesso avancado podem alterar embarcadores.",
      ),
    ).toThrow("Somente operadores com acesso avancado podem alterar embarcadores.");
  });
});
