import { ForbiddenError } from "../../domain/load-claims/errors.js";

export const OPERATOR_ACCESS_LEVELS = ["advanced", "intermediate"];

// Nível aplicado quando o operador não tem access_level provisionado. Menor
// privilégio da lista: um provisionamento incompleto não pode virar acesso total.
export const OPERATOR_DEFAULT_ACCESS_LEVEL = "intermediate";

const OPERATOR_PERMISSION_MATRIX = {
  advanced: new Set([
    "operator:read",
    "cargos:write",
    "cargos:write_values",
    "clientes:write",
    "routes:write",
    "leads:write",
  ]),
  intermediate: new Set([
    "operator:read",
    "cargos:write",
    "leads:write",
  ]),
};

export function getUserRole(user) {
  // Only trust app_metadata — user_metadata is writable by the user themselves
  // and must never be used for authorization decisions.
  return user?.app_metadata?.role || null;
}

export function normalizeOperatorAccessLevel(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalizedValue = value.trim().toLowerCase();
  return OPERATOR_ACCESS_LEVELS.includes(normalizedValue) ? normalizedValue : null;
}

export function getOperatorAccessLevel(user) {
  if (getUserRole(user) !== "operator") {
    return null;
  }

  const appAccessLevel = normalizeOperatorAccessLevel(user?.app_metadata?.access_level);

  if (appAccessLevel) {
    return appAccessLevel;
  }

  // Falha FECHADO. Antes retornava "advanced": qualquer operador criado fora do
  // registerOperatorUser (seed, convite manual, insert direto no Supabase) nascia
  // com privilégio máximo — inclusive escrita de valores de carga e de clientes.
  return OPERATOR_DEFAULT_ACCESS_LEVEL;
}

export function hasOperatorPermission(user, permission) {
  const accessLevel = getOperatorAccessLevel(user);

  if (!accessLevel) {
    return false;
  }

  return OPERATOR_PERMISSION_MATRIX[accessLevel]?.has(permission) || false;
}

export function assertOperatorPermission(user, permission, message) {
  if (hasOperatorPermission(user, permission)) {
    return;
  }

  throw new ForbiddenError(message || "Operator session does not have the required permission.");
}

export function assertOperatorAccessLevel(user, requiredLevel, message) {
  const userLevel = getOperatorAccessLevel(user);
  const allowed =
    requiredLevel === "advanced"
      ? userLevel === "advanced"
      : userLevel === "advanced" || userLevel === requiredLevel;
  if (allowed) {
    return;
  }
  throw new ForbiddenError(message || `Operator session requires access level '${requiredLevel}'.`);
}
