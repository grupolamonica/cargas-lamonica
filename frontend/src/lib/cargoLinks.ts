import { resolveCanonicalWebOrigin } from "@/lib/runtimeOrigin";

export function buildCargoPublicPath(cargoId: string) {
  return `/cargas/${cargoId}`;
}

export function buildCargoShareUrl(origin: string, cargoId: string) {
  const normalizedOrigin = resolveCanonicalWebOrigin(origin).replace(/\/$/, "");

  return `${normalizedOrigin}${buildCargoPublicPath(cargoId)}`;
}
