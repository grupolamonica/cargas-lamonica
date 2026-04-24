import { buildCargoPublicPath, buildCargoShareUrl } from "@/lib/cargoLinks";

describe("cargoLinks", () => {
  it("builds the public path for a specific cargo", () => {
    expect(buildCargoPublicPath("88291")).toBe("/cargas/88291");
  });

  it("builds the full share url and trims trailing slash from origin", () => {
    expect(buildCargoShareUrl("http://localhost:8080/", "88291")).toBe("http://localhost:8080/cargas/88291");
  });

  it("forces share links to use the canonical production alias when copied from a Vercel-managed origin", () => {
    expect(
      buildCargoShareUrl(
        "https://lamonica-cargas-platform-git-main-antoniocesar-devs-projects.vercel.app",
        "88291",
      ),
    ).toBe("https://lamonica-cargas-platform.vercel.app/cargas/88291");
  });
});
