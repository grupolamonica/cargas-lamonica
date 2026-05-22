/**
 * Phase 10 / Plan 10-08 — Playwright config root-level
 *
 * Cobre a suite E2E de Cargas Casadas em `tests/e2e/cargas-casadas/`.
 *
 * Setup:
 *   npm install --save-dev @playwright/test pg @types/pg
 *   npx playwright install --with-deps chromium
 *
 * Rodar (NUNCA contra producao — ver `tests/e2e/cargas-casadas/fixtures.ts`):
 *   npx playwright test --config=playwright.config.ts --reporter=list --workers=1
 *
 * O config do frontend (`frontend/playwright.config.ts`) cobre wizard cadastro v2
 * e e separado deste — ambos podem coexistir.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e/cargas-casadas",
  testMatch: /.*\.spec\.ts/,
  // Specs criam/destroem dados reais em DB compartilhada — workers=1 evita
  // interferencia de fixtures entre tests rodando em paralelo.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Sem webServer: stack precisa ser subida explicitamente antes (npm run dev
  // ou docker compose up). Specs E2E exigem backend real + DB local/staging.
});
