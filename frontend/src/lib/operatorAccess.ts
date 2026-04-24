type AuthUserLike = {
  app_metadata?: {
    role?: string;
    access_level?: string;
  };
  user_metadata?: {
    role?: string;
    access_level?: string;
  };
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
  return user?.app_metadata?.role || user?.user_metadata?.role || null;
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
    return "Acesso intermediario";
  }

  if (accessLevel === "advanced") {
    return "Acesso avancado";
  }

  return "Sem acesso";
}

export function canWriteOperatorCargos(user: AuthUserLike) {
  return getOperatorAccessLevel(user) !== null;
}

export function canWriteOperatorLeads(user: AuthUserLike) {
  return getOperatorAccessLevel(user) !== null;
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
