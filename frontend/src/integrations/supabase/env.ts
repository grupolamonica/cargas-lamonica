// Centraliza leitura + validação das envs públicas do Supabase.
// Vite faz o bake destas variáveis no bundle em build time. Se vierem vazias
// (GitHub secret ausente / Dockerfile ARG vazio), o createClient() lança
// "supabaseUrl is required" — erro críptico. Aqui falhamos com mensagem útil.

const rawUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const rawKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

function assertEnv(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    const msg =
      `[supabase] ${name} ausente no bundle. ` +
      `Verifique se a GitHub secret ${name} está configurada e ` +
      `se o workflow de deploy passou como build-arg para o Dockerfile do frontend. ` +
      `Em dev local, confira frontend/.env.`;
    // eslint-disable-next-line no-console
    console.error(msg);
    throw new Error(msg);
  }
  return value;
}

export const SUPABASE_URL = assertEnv("VITE_SUPABASE_URL", rawUrl);
export const SUPABASE_PUBLISHABLE_KEY = assertEnv(
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  rawKey,
);
