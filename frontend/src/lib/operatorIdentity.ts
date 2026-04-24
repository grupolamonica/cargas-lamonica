const FALLBACK_NAME = "Equipe Lamonica";

export function getOperatorDisplayName(email?: string | null) {
  if (!email) {
    return FALLBACK_NAME;
  }

  const [localPart] = email.split("@");
  const cleaned = localPart.replace(/[._-]+/g, " ").trim();

  if (!cleaned) {
    return FALLBACK_NAME;
  }

  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getOperatorInitials(name?: string | null) {
  if (!name) {
    return "LM";
  }

  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  return initials || "LM";
}
