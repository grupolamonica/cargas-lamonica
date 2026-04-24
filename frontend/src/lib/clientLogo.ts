import { resolveCanonicalApiRequestUrl } from "@/lib/runtimeOrigin";

const NEUTRAL_SPREAD_THRESHOLD = 24;
const NEUTRAL_BRIGHTNESS_THRESHOLD = 168;
const OPAQUE_ALPHA_THRESHOLD = 12;
const EDGE_COLOR_DISTANCE_THRESHOLD = 52;
const MAX_BACKGROUND_SWATCHES = 6;

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

function getPixelOffset(width: number, x: number, y: number) {
  return (y * width + x) * 4;
}

function getPixelColor(pixels: Uint8ClampedArray, offset: number): RgbColor {
  return {
    red: pixels[offset],
    green: pixels[offset + 1],
    blue: pixels[offset + 2],
  };
}

function getColorDistance(first: RgbColor, second: RgbColor) {
  return Math.max(
    Math.abs(first.red - second.red),
    Math.abs(first.green - second.green),
    Math.abs(first.blue - second.blue),
  );
}

function isLightNeutralPixel(red: number, green: number, blue: number, alpha: number) {
  if (alpha <= OPAQUE_ALPHA_THRESHOLD) {
    return false;
  }

  const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
  const brightness = (red + green + blue) / 3;

  return spread <= NEUTRAL_SPREAD_THRESHOLD && brightness >= NEUTRAL_BRIGHTNESS_THRESHOLD;
}

function collectBackgroundSwatches(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const swatches: Array<RgbColor & { count: number }> = [];
  const visitedOffsets = new Set<number>();

  const registerOffset = (offset: number) => {
    if (visitedOffsets.has(offset)) {
      return;
    }

    visitedOffsets.add(offset);
    const { red, green, blue } = getPixelColor(pixels, offset);
    const alpha = pixels[offset + 3];

    if (!isLightNeutralPixel(red, green, blue, alpha)) {
      return;
    }

    const existingSwatch = swatches.find((swatch) => (
      getColorDistance(swatch, { red, green, blue }) <= EDGE_COLOR_DISTANCE_THRESHOLD / 2
    ));

    if (existingSwatch) {
      existingSwatch.count += 1;
      existingSwatch.red = Math.round((existingSwatch.red + red) / 2);
      existingSwatch.green = Math.round((existingSwatch.green + green) / 2);
      existingSwatch.blue = Math.round((existingSwatch.blue + blue) / 2);
      return;
    }

    swatches.push({
      red,
      green,
      blue,
      count: 1,
    });
  };

  for (let x = 0; x < width; x += 1) {
    registerOffset(getPixelOffset(width, x, 0));
    registerOffset(getPixelOffset(width, x, height - 1));
  }

  for (let y = 0; y < height; y += 1) {
    registerOffset(getPixelOffset(width, 0, y));
    registerOffset(getPixelOffset(width, width - 1, y));
  }

  return swatches
    .sort((first, second) => second.count - first.count)
    .slice(0, MAX_BACKGROUND_SWATCHES)
    .map(({ red, green, blue }) => ({ red, green, blue }));
}

function matchesBackgroundSwatch(
  red: number,
  green: number,
  blue: number,
  swatches: RgbColor[],
) {
  if (!swatches.length) {
    return true;
  }

  return swatches.some((swatch) => (
    getColorDistance(swatch, { red, green, blue }) <= EDGE_COLOR_DISTANCE_THRESHOLD
  ));
}

function clearEdgeConnectedNeutralBackground(
  cleanedPixels: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const backgroundSwatches = collectBackgroundSwatches(cleanedPixels, width, height);

  if (!backgroundSwatches.length) {
    return false;
  }

  const queue: Array<[number, number]> = [];
  const visited = new Uint8Array(width * height);
  let removedPixels = 0;

  const tryQueue = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) {
      return;
    }

    const pixelIndex = y * width + x;

    if (visited[pixelIndex]) {
      return;
    }

    const offset = getPixelOffset(width, x, y);
    const red = cleanedPixels[offset];
    const green = cleanedPixels[offset + 1];
    const blue = cleanedPixels[offset + 2];
    const alpha = cleanedPixels[offset + 3];

    if (
      alpha > OPAQUE_ALPHA_THRESHOLD
      && (!isLightNeutralPixel(red, green, blue, alpha) || !matchesBackgroundSwatch(red, green, blue, backgroundSwatches))
    ) {
      return;
    }

    visited[pixelIndex] = 1;
    queue.push([x, y]);
  };

  for (let x = 0; x < width; x += 1) {
    tryQueue(x, 0);
    tryQueue(x, height - 1);
  }

  for (let y = 0; y < height; y += 1) {
    tryQueue(0, y);
    tryQueue(width - 1, y);
  }

  while (queue.length) {
    const [x, y] = queue.shift()!;
    const offset = getPixelOffset(width, x, y);
    const alpha = cleanedPixels[offset + 3];

    if (alpha > OPAQUE_ALPHA_THRESHOLD) {
      cleanedPixels[offset + 3] = 0;
      removedPixels += 1;
    }

    tryQueue(x + 1, y);
    tryQueue(x - 1, y);
    tryQueue(x, y + 1);
    tryQueue(x, y - 1);
  }

  return removedPixels > 0;
}

function parseClientLogoUrl(value?: string | null) {
  const normalizedValue = value?.trim();

  if (!normalizedValue) {
    return null;
  }

  try {
    return new URL(normalizedValue);
  } catch {
    return null;
  }
}

export function shouldProxyClientLogoUrl(value?: string | null) {
  const parsedUrl = parseClientLogoUrl(value);

  if (!parsedUrl) {
    return false;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return false;
  }

  if (typeof window !== "undefined" && parsedUrl.origin === window.location.origin) {
    return false;
  }

  return true;
}

export function isProblematicClientLogoUrl(value?: string | null) {
  return shouldProxyClientLogoUrl(value);
}

export function buildClientLogoSourceUrl(
  value?: string | null,
  origin = typeof window !== "undefined" ? window.location.origin : undefined,
) {
  const normalizedValue = value?.trim();

  if (!normalizedValue) {
    return "";
  }

  if (!shouldProxyClientLogoUrl(normalizedValue)) {
    return normalizedValue;
  }

  return resolveCanonicalApiRequestUrl(`/api/client-logo?url=${encodeURIComponent(normalizedValue)}`, origin);
}

export function buildClientLogoSourceCandidates(value?: string | null) {
  const normalizedValue = value?.trim();

  if (!normalizedValue) {
    return [];
  }

  const proxiedSource = buildClientLogoSourceUrl(normalizedValue);
  return Array.from(new Set([proxiedSource, normalizedValue].filter(Boolean)));
}

export function shouldApplyWhiteSurfaceTreatmentForClientLogo(value?: string | null) {
  const normalizedValue = value?.trim();

  if (!normalizedValue || normalizedValue.startsWith("data:")) {
    return false;
  }

  try {
    const baseOrigin = typeof window !== "undefined" ? window.location.origin : "https://lamonica-cargas-platform.vercel.app";
    const parsedUrl = new URL(normalizedValue, baseOrigin);

    if (parsedUrl.pathname === "/api/client-logo") {
      return false;
    }

    if (typeof window === "undefined") {
      return parsedUrl.protocol === "https:" || parsedUrl.protocol === "http:";
    }

    return parsedUrl.origin !== window.location.origin;
  } catch {
    return false;
  }
}

export function shouldUseAnonymousCrossOriginForClientLogo(value?: string | null) {
  const normalizedValue = value?.trim();

  if (!normalizedValue || normalizedValue.startsWith("data:")) {
    return false;
  }

  try {
    const baseOrigin = typeof window !== "undefined" ? window.location.origin : "https://lamonica-cargas-platform.vercel.app";
    const parsedUrl = new URL(normalizedValue, baseOrigin);

    if (parsedUrl.pathname === "/api/client-logo") {
      return true;
    }

    if (typeof window === "undefined") {
      return false;
    }

    return parsedUrl.origin === window.location.origin;
  } catch {
    return false;
  }
}

export function removeLightNeutralBackground(
  pixels: Uint8ClampedArray,
  width?: number,
  height?: number,
) {
  const cleanedPixels = new Uint8ClampedArray(pixels);

  if (width && height && clearEdgeConnectedNeutralBackground(cleanedPixels, width, height)) {
    return cleanedPixels;
  }

  for (let index = 0; index < cleanedPixels.length; index += 4) {
    const red = cleanedPixels[index];
    const green = cleanedPixels[index + 1];
    const blue = cleanedPixels[index + 2];
    const alpha = cleanedPixels[index + 3];

    if (!isLightNeutralPixel(red, green, blue, alpha)) {
      continue;
    }

    cleanedPixels[index + 3] = 0;
  }

  return cleanedPixels;
}

export function findVisibleClientLogoBounds(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = pixels[(y * width + x) * 4 + 3];

      if (alpha <= OPAQUE_ALPHA_THRESHOLD) {
        continue;
      }

      if (x < minX) {
        minX = x;
      }

      if (y < minY) {
        minY = y;
      }

      if (x > maxX) {
        maxX = x;
      }

      if (y > maxY) {
        maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return null;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}
