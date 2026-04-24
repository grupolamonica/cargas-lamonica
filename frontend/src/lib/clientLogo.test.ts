import {
  buildClientLogoSourceCandidates,
  buildClientLogoSourceUrl,
  isProblematicClientLogoUrl,
  removeLightNeutralBackground,
  shouldApplyWhiteSurfaceTreatmentForClientLogo,
  shouldProxyClientLogoUrl,
  shouldUseAnonymousCrossOriginForClientLogo,
} from "@/lib/clientLogo";

describe("client logo helpers", () => {
  it("detects external logo urls that should be proxied and cleaned", () => {
    expect(isProblematicClientLogoUrl("https://w7.pngwing.com/pngs/650/828/png-transparent-shopee-logo.png")).toBe(true);
    expect(shouldProxyClientLogoUrl("https://example.com/logo.png")).toBe(true);
    expect(shouldProxyClientLogoUrl("/logos/cliente.png")).toBe(false);
  });

  it("builds a proxied logo url for external hosts", () => {
    expect(
      buildClientLogoSourceUrl(
        "https://example.com/logo.png",
        "https://lamonica-cargas-platform-git-main-antoniocesar-devs-projects.vercel.app",
      ),
    ).toContain(
      "https://lamonica-cargas-platform.vercel.app/api/client-logo?url=",
    );
    expect(buildClientLogoSourceUrl("https://w7.pngwing.com/pngs/650/828/png-transparent-shopee-logo.png")).toContain("/api/client-logo?url=");
    expect(buildClientLogoSourceUrl("/logos/cliente.png")).toBe("/logos/cliente.png");
  });

  it("tries the proxied logo first and falls back to the original public url when needed", () => {
    expect(buildClientLogoSourceCandidates("https://example.com/logo.png")).toEqual([
      expect.stringContaining("/api/client-logo?url="),
      "https://example.com/logo.png",
    ]);
    expect(buildClientLogoSourceCandidates("/logos/cliente.png")).toEqual(["/logos/cliente.png"]);
  });

  it("only requests anonymous cross origin for same-origin or proxied logos", () => {
    expect(
      shouldUseAnonymousCrossOriginForClientLogo(
        "https://lamonica-cargas-platform.vercel.app/api/client-logo?url=https%3A%2F%2Fexample.com%2Flogo.png",
      ),
    ).toBe(true);
    expect(shouldUseAnonymousCrossOriginForClientLogo("https://example.com/logo.png")).toBe(false);
    expect(shouldUseAnonymousCrossOriginForClientLogo("data:image/png;base64,abc")).toBe(false);
  });

  it("applies a white surface treatment when the logo falls back to a raw external url", () => {
    expect(shouldApplyWhiteSurfaceTreatmentForClientLogo("https://example.com/logo.png")).toBe(true);
    expect(
      shouldApplyWhiteSurfaceTreatmentForClientLogo(
        "https://lamonica-cargas-platform.vercel.app/api/client-logo?url=https%3A%2F%2Fexample.com%2Flogo.png",
      ),
    ).toBe(false);
    expect(shouldApplyWhiteSurfaceTreatmentForClientLogo("data:image/png;base64,abc")).toBe(false);
  });

  it("removes light neutral background pixels and keeps colored pixels", () => {
    const pixels = new Uint8ClampedArray([
      240,
      240,
      240,
      255,
      208,
      208,
      208,
      255,
      245,
      80,
      45,
      255,
      255,
      255,
      255,
      255,
    ]);

    const cleanedPixels = removeLightNeutralBackground(pixels);

    expect(cleanedPixels[3]).toBe(0);
    expect(cleanedPixels[7]).toBe(0);
    expect(cleanedPixels[11]).toBe(255);
    expect(cleanedPixels[15]).toBe(0);
  });

  it("removes edge-connected checkerboard backgrounds without deleting the logo body", () => {
    const width = 3;
    const height = 3;
    const centerOffset = ((1 * width) + 1) * 4;
    const pixels = new Uint8ClampedArray([
      232, 232, 232, 255, 214, 214, 214, 255, 232, 232, 232, 255,
      214, 214, 214, 255, 20, 93, 210, 255, 232, 232, 232, 255,
      232, 232, 232, 255, 214, 214, 214, 255, 232, 232, 232, 255,
    ]);

    const cleanedPixels = removeLightNeutralBackground(pixels, width, height);

    expect(cleanedPixels[3]).toBe(0);
    expect(cleanedPixels[7]).toBe(0);
    expect(cleanedPixels[15]).toBe(0);
    expect(cleanedPixels[centerOffset]).toBe(20);
    expect(cleanedPixels[centerOffset + 1]).toBe(93);
    expect(cleanedPixels[centerOffset + 2]).toBe(210);
    expect(cleanedPixels[centerOffset + 3]).toBe(255);
  });

  it("preserves bright interior pixels when they are enclosed by the logo", () => {
    const width = 5;
    const height = 5;
    const blue = [18, 92, 209, 255];
    const checkerA = [238, 238, 238, 255];
    const checkerB = [214, 214, 214, 255];
    const whiteCore = [252, 252, 252, 255];
    const pixels = new Uint8ClampedArray([
      ...checkerA, ...checkerB, ...checkerA, ...checkerB, ...checkerA,
      ...checkerB, ...blue, ...blue, ...blue, ...checkerB,
      ...checkerA, ...blue, ...whiteCore, ...blue, ...checkerA,
      ...checkerB, ...blue, ...blue, ...blue, ...checkerB,
      ...checkerA, ...checkerB, ...checkerA, ...checkerB, ...checkerA,
    ]);

    const cleanedPixels = removeLightNeutralBackground(pixels, width, height);
    const centerOffset = ((2 * width) + 2) * 4;

    expect(cleanedPixels[3]).toBe(0);
    expect(cleanedPixels[7]).toBe(0);
    expect(cleanedPixels[centerOffset + 3]).toBe(255);
    expect(cleanedPixels[centerOffset]).toBe(252);
    expect(cleanedPixels[centerOffset + 1]).toBe(252);
    expect(cleanedPixels[centerOffset + 2]).toBe(252);
  });
});
