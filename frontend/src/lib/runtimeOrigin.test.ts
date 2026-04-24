import {
  buildCanonicalNavigationUrl,
  redirectLegacyDeploymentToCanonicalOrigin,
  resolveCanonicalApiRequestUrl,
  resolveCanonicalWebOrigin,
  shouldRedirectLegacyDeploymentOrigin,
} from "@/lib/runtimeOrigin";

describe("runtimeOrigin", () => {
  it("keeps localhost origins untouched", () => {
    expect(resolveCanonicalWebOrigin("http://localhost:5173")).toBe("http://localhost:5173");
  });

  it("normalizes managed Vercel origins to the canonical production alias", () => {
    expect(resolveCanonicalWebOrigin("https://lamonica-cargas-platform-git-main-antoniocesar-devs-projects.vercel.app")).toBe(
      "https://lamonica-cargas-platform.vercel.app",
    );
  });

  it("marks legacy deployment origins for redirect", () => {
    expect(shouldRedirectLegacyDeploymentOrigin("https://lamonica-cargas-platform-8ee8toz8b-antoniocesar-devs-projects.vercel.app")).toBe(true);
    expect(shouldRedirectLegacyDeploymentOrigin("https://lamonica-cargas-platform.vercel.app")).toBe(false);
  });

  it("builds the canonical navigation url while preserving path, query and hash", () => {
    expect(
      buildCanonicalNavigationUrl({
        origin: "https://lamonica-cargas-platform-8ee8toz8b-antoniocesar-devs-projects.vercel.app",
        pathname: "/leads",
        search: "?page=2",
        hash: "#fila",
      }),
    ).toBe("https://lamonica-cargas-platform.vercel.app/leads?page=2#fila");
  });

  it("builds canonical api urls from relative paths", () => {
    expect(
      resolveCanonicalApiRequestUrl(
        "/api/operator/cargas?page=2",
        "https://lamonica-cargas-platform-git-main-antoniocesar-devs-projects.vercel.app",
      ),
    ).toBe("https://lamonica-cargas-platform.vercel.app/api/operator/cargas?page=2");
  });

  it("redirects only when the app is running on a legacy deployment origin", () => {
    const replace = vi.fn();

    expect(
      redirectLegacyDeploymentToCanonicalOrigin({
        origin: "https://lamonica-cargas-platform-8ee8toz8b-antoniocesar-devs-projects.vercel.app",
        pathname: "/leads",
        search: "",
        hash: "",
        replace,
      }),
    ).toBe(true);
    expect(replace).toHaveBeenCalledWith("https://lamonica-cargas-platform.vercel.app/leads");
  });
});
