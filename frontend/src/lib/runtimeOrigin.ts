const DEFAULT_CANONICAL_WEB_ORIGIN =
  import.meta.env.VITE_CANONICAL_ORIGIN || "https://lamonica-cargas-platform.vercel.app";
const TEAM_ALIAS_HOSTNAME = "lamonica-cargas-platform-antoniocesar-devs-projects.vercel.app";
const DEPLOYMENT_HOSTNAME_PATTERN = /^lamonica-cargas-platform-[a-z0-9]+-antoniocesar-devs-projects\.vercel\.app$/i;
const BRANCH_ALIAS_HOSTNAME_PATTERN = /^lamonica-cargas-platform-git-[a-z0-9-]+-antoniocesar-devs-projects\.vercel\.app$/i;

export interface LocationLike {
  origin: string;
  pathname: string;
  search: string;
  hash: string;
  replace: (url: string) => void;
}

function safeParseUrl(origin: string) {
  try {
    return new URL(origin);
  } catch {
    return null;
  }
}

function isProjectManagedVercelHostname(hostname: string) {
  return (
    hostname === TEAM_ALIAS_HOSTNAME ||
    DEPLOYMENT_HOSTNAME_PATTERN.test(hostname) ||
    BRANCH_ALIAS_HOSTNAME_PATTERN.test(hostname)
  );
}

export function resolveCanonicalWebOrigin(origin: string) {
  const parsedUrl = safeParseUrl(origin);

  if (!parsedUrl) {
    return DEFAULT_CANONICAL_WEB_ORIGIN;
  }

  if (isProjectManagedVercelHostname(parsedUrl.hostname)) {
    return DEFAULT_CANONICAL_WEB_ORIGIN;
  }

  return parsedUrl.origin;
}

export function shouldRedirectLegacyDeploymentOrigin(origin: string) {
  const parsedUrl = safeParseUrl(origin);

  if (!parsedUrl) {
    return false;
  }

  return DEPLOYMENT_HOSTNAME_PATTERN.test(parsedUrl.hostname);
}

export function buildCanonicalNavigationUrl(location: Pick<LocationLike, "origin" | "pathname" | "search" | "hash">) {
  const canonicalOrigin = resolveCanonicalWebOrigin(location.origin);
  return `${canonicalOrigin}${location.pathname}${location.search}${location.hash}`;
}

export function resolveCanonicalApiRequestUrl(
  url: string,
  origin = typeof window !== "undefined" ? window.location.origin : DEFAULT_CANONICAL_WEB_ORIGIN,
) {
  const normalizedUrl = String(url || "").trim();

  if (!normalizedUrl) {
    return resolveCanonicalWebOrigin(origin);
  }

  const absoluteUrl = safeParseUrl(normalizedUrl);

  if (absoluteUrl) {
    return `${resolveCanonicalWebOrigin(absoluteUrl.origin)}${absoluteUrl.pathname}${absoluteUrl.search}${absoluteUrl.hash}`;
  }

  const canonicalOrigin = resolveCanonicalWebOrigin(origin).replace(/\/$/, "");

  if (normalizedUrl.startsWith("/")) {
    return `${canonicalOrigin}${normalizedUrl}`;
  }

  return `${canonicalOrigin}/${normalizedUrl.replace(/^\.?\//, "")}`;
}

export function redirectLegacyDeploymentToCanonicalOrigin(location: LocationLike) {
  if (!shouldRedirectLegacyDeploymentOrigin(location.origin)) {
    return false;
  }

  location.replace(buildCanonicalNavigationUrl(location));
  return true;
}
