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

// Nível aplicado quando o operador não tem access_level provisionado. Espelha
// OPERATOR_DEFAULT_ACCESS_LEVEL do backend (operator-access.js) — se divergirem,
// a UI promete um botão que a API recusa.
const DEFAULT_ACCESS_LEVEL: OperatorAccessLevel = "intermediate";

export function getUserRole(user: AuthUserLike) {
  // Só app_metadata. user_metadata é gravável pelo próprio usuário, então o
  // fallback que existia aqui deixava qualquer conta se declarar "operator" e
  // destravar a UI do operador. A API sempre barrou, mas a tela abria.
  const appRole = user?.app_metadata?.role;
  if (typeof appRole === "string") return appRole;
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

  // Falha fechado, igual ao backend: sem access_level provisionado, menor
  // privilégio — não acesso avançado.
  return DEFAULT_ACCESS_LEVEL;
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
