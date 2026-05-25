/**
 * Phase 10 / Plan 10-08 — Task 1
 *
 * Fixtures Playwright para a suite E2E de Cargas Casadas.
 *
 * Estrategia:
 *  - Setup/teardown direto na DB via `pg` (NUNCA contra producao).
 *  - Helpers de auth assumem credenciais via env vars (E2E_OPERATOR_*, E2E_DRIVER_A_*, E2E_DRIVER_B_*).
 *  - `pgClient` worker-scoped (1 conexao por test file) para evitar starvation do pool.
 *  - `cleanupPacote` + `cleanupCargas` chamados em `afterEach` para garantir DB limpa.
 *
 * Pre-requisitos para rodar localmente:
 *  - Stack local rodando: `npm run dev` (frontend :3000 + backend :3000? — ver scripts root)
 *  - Env vars (exemplo `.env.e2e`):
 *      SUPABASE_DB_URL=postgresql://postgres:...@127.0.0.1:54322/postgres   # staging/local — NUNCA producao
 *      E2E_BASE_URL=http://localhost:3000
 *      E2E_OPERATOR_EMAIL=...
 *      E2E_OPERATOR_PASSWORD=...
 *      E2E_OPERATOR_USER_ID=<uuid do operador no auth.users>
 *      E2E_DRIVER_A_EMAIL=...
 *      E2E_DRIVER_A_PASSWORD=...
 *      E2E_DRIVER_B_EMAIL=...
 *      E2E_DRIVER_B_PASSWORD=...
 *
 * Execucao:
 *   npx playwright test tests/e2e/cargas-casadas/ --reporter=list --workers=1
 *
 * **NUNCA** apontar `SUPABASE_DB_URL` para producao — specs criam/destroem registros reais.
 */
import { test as base, expect, type Page } from "@playwright/test";
import pg from "pg";

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  // Nao lanca aqui — Playwright avalia o modulo ao listar specs (npx playwright test --list).
  // O fixture pgClient lanca em runtime se realmente for usado sem DB_URL.
  // eslint-disable-next-line no-console
  console.warn(
    "[fixtures] SUPABASE_DB_URL nao definida — fixture pgClient lancara em runtime se acionada.",
  );
}

// Guarda contra producao: se a URL apontar para `*.supabase.co` (Supabase hosted/managed)
// abortar imediatamente. Specs sempre rodam contra DB local/staging.
if (DB_URL && /\bsupabase\.co\b/i.test(DB_URL)) {
  throw new Error(
    "[fixtures] SUPABASE_DB_URL aponta para Supabase hosted (.supabase.co). " +
      "Specs E2E devem rodar contra DB local ou staging dedicado. Abortando.",
  );
}

type PacoteFixtures = {
  pgClient: pg.Client;
  operatorLogin: { email: string; password: string };
  driverALogin: { email: string; password: string };
  driverBLogin: { email: string; password: string };
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[fixtures] env var ${name} obrigatoria mas nao definida`);
  return v;
}

export const test = base.extend<PacoteFixtures>({
  pgClient: async ({}, use) => {
    if (!DB_URL) {
      throw new Error(
        "[fixtures] pgClient acionado sem SUPABASE_DB_URL definida — configure .env.e2e antes de rodar.",
      );
    }
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    try {
      await use(client);
    } finally {
      try {
        await client.end();
      } catch {
        // ignora — conexao ja pode estar fechada
      }
    }
  },
  operatorLogin: async ({}, use) => {
    await use({
      email: requireEnv("E2E_OPERATOR_EMAIL"),
      password: requireEnv("E2E_OPERATOR_PASSWORD"),
    });
  },
  driverALogin: async ({}, use) => {
    await use({
      email: requireEnv("E2E_DRIVER_A_EMAIL"),
      password: requireEnv("E2E_DRIVER_A_PASSWORD"),
    });
  },
  driverBLogin: async ({}, use) => {
    await use({
      email: requireEnv("E2E_DRIVER_B_EMAIL"),
      password: requireEnv("E2E_DRIVER_B_PASSWORD"),
    });
  },
});

export { expect };

// ──────────────────────────────────────────────────────────────────────────────
// DB helpers — setup
// ──────────────────────────────────────────────────────────────────────────────

interface CargaSeedOpts {
  origem: string;
  destino: string;
  perfil?: string;
  valor?: number;
  driverVisibility?: "PUBLIC" | "PREMIUM";
}

/**
 * Cria carga PREMIUM + OPEN com data futura. Retorna o id UUID gerado.
 */
export async function createTestCarga(
  client: pg.Client,
  opts: CargaSeedOpts,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.cargas (
       origem, destino, perfil, valor, status, driver_visibility, data, horario
     ) VALUES ($1, $2, $3, $4, 'OPEN', $5, current_date + 1, '08:00')
     RETURNING id`,
    [
      opts.origem,
      opts.destino,
      opts.perfil ?? "CARRETA",
      opts.valor ?? 1500,
      opts.driverVisibility ?? "PREMIUM",
    ],
  );
  return rows[0].id;
}

interface PacoteSeedOpts {
  valorTotal: number;
  operatorId: string;
}

/**
 * Cria pacote vazio em status='rascunho'. Cargas precisam ser linkadas via
 * `linkCargasToPacote` antes de publicar.
 */
export async function createTestPacote(
  client: pg.Client,
  opts: PacoteSeedOpts,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.cargas_casadas (valor_total, status, created_by)
     VALUES ($1, 'rascunho', $2)
     RETURNING id`,
    [opts.valorTotal, opts.operatorId],
  );
  return rows[0].id;
}

/**
 * Linka cargas existentes ao pacote, preservando a ordem do array (1-indexed).
 */
export async function linkCargasToPacote(
  client: pg.Client,
  pacoteId: string,
  cargaIds: string[],
): Promise<void> {
  for (let i = 0; i < cargaIds.length; i++) {
    await client.query(
      `UPDATE public.cargas
         SET viagem_id = $1, ordem_viagem = $2
       WHERE id = $3`,
      [pacoteId, i + 1, cargaIds[i]],
    );
  }
}

/**
 * Publica pacote (status='publicado' + published_at). Pre-condicao: cargas
 * ja linkadas devem ser todas PREMIUM+OPEN (validacao no service do backend).
 */
export async function publishTestPacote(
  client: pg.Client,
  pacoteId: string,
): Promise<void> {
  await client.query(
    `UPDATE public.cargas_casadas
       SET status = 'publicado', published_at = now()
     WHERE id = $1`,
    [pacoteId],
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// DB helpers — cleanup
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Limpa pacote + cargas-membros + load_claims associados. Idempotente.
 */
export async function cleanupPacote(
  client: pg.Client,
  pacoteId: string,
): Promise<void> {
  // 1) Desvincula cargas (viagem_id = NULL)
  await client.query(
    `UPDATE public.cargas
       SET viagem_id = NULL, ordem_viagem = NULL
     WHERE viagem_id = $1`,
    [pacoteId],
  );
  // 2) Apaga load_claims das cargas que pertenciam ao pacote
  await client.query(
    `DELETE FROM public.load_claims
     WHERE load_id IN (
       SELECT id FROM public.cargas WHERE viagem_id = $1
     )`,
    [pacoteId],
  );
  // 3) Apaga o pacote
  await client.query(`DELETE FROM public.cargas_casadas WHERE id = $1`, [pacoteId]);
}

/**
 * Apaga cargas + load_claims associados. Idempotente.
 */
export async function cleanupCargas(
  client: pg.Client,
  cargaIds: string[],
): Promise<void> {
  if (cargaIds.length === 0) return;
  await client.query(
    `DELETE FROM public.load_claims WHERE load_id = ANY($1::uuid[])`,
    [cargaIds],
  );
  await client.query(`DELETE FROM public.cargas WHERE id = ANY($1::uuid[])`, [cargaIds]);
}

// ──────────────────────────────────────────────────────────────────────────────
// Auth helpers — login via UI
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Login operador via /painel-x7k9m2 (rota de admin login).
 */
export async function loginAsOperator(
  page: Page,
  creds: { email: string; password: string },
): Promise<void> {
  await page.goto("/painel-x7k9m2");
  await page.fill('input[type="email"]', creds.email);
  await page.fill('input[type="password"]', creds.password);
  await page.click('button[type="submit"]');
  // /painel = overview do operador; aceitar qualquer URL dentro do dashboard.
  await page.waitForURL((url) => url.pathname.startsWith("/painel"), {
    timeout: 15_000,
  });
}

/**
 * Login motorista via /motorista/login.
 *
 * Nota: o portal driver tambem aceita login via OTP/SMS; aqui usamos email+senha
 * (motoristas de teste devem ser provisionados com password seed).
 */
export async function loginAsDriver(
  page: Page,
  creds: { email: string; password: string },
): Promise<void> {
  await page.goto("/motorista/login");
  // Heuristica: pagina pode ter abas (email vs phone); preencher email+password
  // assume aba email ativa por default.
  await page.fill('input[type="email"]', creds.email);
  await page.fill('input[type="password"]', creds.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => url.pathname.startsWith("/motorista"), {
    timeout: 15_000,
  });
}
