import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [path.resolve(__dirname, "src/test/setup.ts")],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Default do vitest = 5000ms. Sob a carga da suíte completa (vários arquivos
    // em paralelo disputando CPU no runner), testes pesados como DriverPortal
    // (render + QueryClient + waits) estouram 5s de forma NÃO-determinística —
    // passam isolados (~1.7s) mas fazem flake no `npm run test` do CI e, pior, no
    // "Test + Lint" do DEPLOY (bloqueando o deploy inteiro). Timeout maior remove
    // o flake sem mascarar hang real (teste travado ainda falha, só que em 15s).
    testTimeout: 15000,
    hookTimeout: 15000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
