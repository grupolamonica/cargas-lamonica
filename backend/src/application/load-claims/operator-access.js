import { ForbiddenError } from "../../domain/load-claims/errors.js";

export const OPERATOR_ACCESS_LEVELS = ["advanced", "intermediate"];

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

  return "advanced";
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
