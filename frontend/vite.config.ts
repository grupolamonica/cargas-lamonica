import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import basicSsl from "@vitejs/plugin-basic-ssl";
import path from "path";

// ─── Validação de envs em build de produção ─────────────────────────────────
// Em build (npm run build), exige VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY
// presentes. Se vierem vazios, o bundle gera createClient("","") e quebra em runtime
// com "supabaseUrl is required" — falha cedo, com mensagem clara.
function assertProdEnv(mode: string, cwd: string) {
  if (mode !== "production") return;
  const env = { ...loadEnv(mode, cwd, ""), ...process.env };
  const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"];
  const missing = required.filter((k) => !env[k] || String(env[k]).trim() === "");
  if (missing.length > 0) {
    throw new Error(
      `[vite build] Variáveis obrigatórias ausentes em build de produção: ${missing.join(", ")}. ` +
        `Configure GitHub secrets e os build-args do Dockerfile.`,
    );
  }
}

// ─── HTTPS LOCAL (desenvolvimento) ───────────────────────────────────────────
//
// Para rodar com HTTPS na rede local (acessar de outro dispositivo):
//
//   npm run dev:https
//   Acesso: https://10.100.101.7:3000
//
// O navegador vai alertar "certificado não confiável" — clique em "Avançado →
// Prosseguir assim mesmo". Isso é normal com certificado auto-assinado local.
//
// Para rodar sem HTTPS (padrão, ferramenta de preview interna):
//
//   npm run dev
//   Acesso: http://localhost:3000
//
// ─── PRODUÇÃO ────────────────────────────────────────────────────────────────
//
// NÃO altere este arquivo para produção. O HTTPS em produção é gerenciado
// pelo Traefik (docker-compose.yml) via Let's Encrypt — certificado real,
// automático. O basicSsl() abaixo SÓ é ativado quando VITE_HTTPS=true,
// ou seja, nunca no build de produção (npm run build não usa dev server).
//
// ─────────────────────────────────────────────────────────────────────────────

export default defineConfig(({ mode }) => {
  assertProdEnv(mode, process.cwd());
  return {
  // basicSsl() ativado APENAS com: npm run dev:https (VITE_HTTPS=true)
  // Em produção (npm run build) este plugin é ignorado automaticamente.
  plugins: [react(), ...(process.env.VITE_HTTPS === "true" ? [basicSsl()] : [])],

  server: {
    host: "0.0.0.0", // aceita conexões de qualquer IP na rede local
    port: 3000,
    allowedHosts: true,
    proxy: {
      "/api": "http://localhost:3007",
      "/ocr-api": {
        target: "http://localhost:8765",
        rewrite: (path) => path.replace(/^\/ocr-api/, ""),
      },
    },
  },
  preview: {
    proxy: {
      "/api": "http://localhost:3007",
      "/ocr-api": {
        target: "http://localhost:8765",
        rewrite: (path) => path.replace(/^\/ocr-api/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 700,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  };
});
