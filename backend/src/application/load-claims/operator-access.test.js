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

  it("falha FECHADO quando o operador nao tem access_level provisionado", () => {
    // Antes caia em "advanced": operador criado fora do registerOperatorUser
    // (seed, convite manual, insert direto) nascia com privilegio maximo.
    const accessLevel = getOperatorAccessLevel({
      app_metadata: {
        role: "operator",
      },
      user_metadata: {},
    });

    expect(accessLevel).toBe("intermediate");

    const semNivel = { app_metadata: { role: "operator" } };
    // Continua operando o dia a dia...
    expect(hasOperatorPermission(semNivel, "operator:read")).toBe(true);
    expect(hasOperatorPermission(semNivel, "cargos:write")).toBe(true);
    // ...mas nao herda as permissoes exclusivas do nivel avancado.
    expect(hasOperatorPermission(semNivel, "clientes:write")).toBe(false);
    expect(hasOperatorPermission(semNivel, "routes:write")).toBe(false);
    expect(hasOperatorPermission(semNivel, "cargos:write_values")).toBe(false);
  });

  it("ignora access_level vindo de user_metadata (gravavel pelo proprio usuario)", () => {
    const accessLevel = getOperatorAccessLevel({
      app_metadata: { role: "operator" },
      user_metadata: { access_level: "advanced" },
    });

    expect(accessLevel).toBe("intermediate");
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
