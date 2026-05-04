import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import basicSsl from "@vitejs/plugin-basic-ssl";
import path from "path";

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

export default defineConfig({
  // basicSsl() ativado APENAS com: npm run dev:https (VITE_HTTPS=true)
  // Em produção (npm run build) este plugin é ignorado automaticamente.
  plugins: [react(), ...(process.env.VITE_HTTPS === "true" ? [basicSsl()] : [])],

  server: {
    host: "0.0.0.0", // aceita conexões de qualquer IP na rede local
    port: 3000,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
  preview: {
    proxy: {
      "/api": "http://localhost:3001",
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
});
