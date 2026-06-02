type AuthUserLike = {
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
} | null;

export type OperatorAccessLevel = "advanced" | "intermediate";

function normalizeAccessLevel(value: unknown): OperatorAccessLevel | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === "advanced" || normalizedValue === "intermediate") {
    return normalizedValue;
  }

  return null;
}

export function getUserRole(user: AuthUserLike) {
  const appRole = user?.app_metadata?.role;
  const userRole = user?.user_metadata?.role;
  if (typeof appRole === "string") return appRole;
  if (typeof userRole === "string") return userRole;
  return null;
}

export function getOperatorAccessLevel(user: AuthUserLike): OperatorAccessLevel | null {
  if (getUserRole(user) !== "operator") {
    return null;
  }

  const appAccessLevel = normalizeAccessLevel(user?.app_metadata?.access_level);

  if (appAccessLevel) {
    return appAccessLevel;
  }

  const userAccessLevel = normalizeAccessLevel(user?.user_metadata?.access_level);

  if (userAccessLevel) {
    return userAccessLevel;
  }

  return "advanced";
}

export function getOperatorAccessLevelLabel(accessLevel: OperatorAccessLevel | null) {
  if (accessLevel === "intermediate") {
    return "Acesso intermediário";
  }

  if (accessLevel === "advanced") {
    return "Acesso avançado";
  }

  return "Sem acesso";
}

export function canWriteOperatorClientes(user: AuthUserLike) {
  return getOperatorAccessLevel(user) === "advanced";
}

export function canWriteOperatorRoutes(user: AuthUserLike) {
  return getOperatorAccessLevel(user) === "advanced";
}

export function canWriteMonetaryValues(user: AuthUserLike) {
  return getOperatorAccessLevel(user) === "advanced";
}
