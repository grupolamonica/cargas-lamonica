import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for Lamonica Cargas frontend E2E.
 *
 * Plan 07-14: cobre 3 cenários do wizard de cadastro v2 com mocks via
 * `page.route()` — não depende de backend real ou serviços externos.
 *
 * Para rodar:
 *   cd frontend && npx playwright test
 *
 * O dev server precisa estar rodando em http://localhost:3000 (Vite default)
 * OU o `webServer` abaixo o sobe automaticamente quando a porta está livre.
 */
export default defineConfig({
  testDir: "./playwright",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000",
    trace: "retain-on-failure",
    actionTimeout: 5_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
