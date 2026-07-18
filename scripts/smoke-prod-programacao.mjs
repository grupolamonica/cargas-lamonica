#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Smoke test de PRODUÇÃO — tela Programação (Shopee/SPX + Nestlé).
//
// Valida, contra o ambiente vivo:
//   1. App no ar (frontend 200, /health 200)
//   2. Endpoint /api/operator/programacao deployado e protegido (401 sem sessão)
//   3. Fonte Nestlé (nestle_ofertas) POPULADA — prova que o coletor Galileu
//      rodou e a tela Programação tem cargas Nestlé (equivalente às viagens SPX)
//
// Uso:
//   PROD_DB_URL="postgres://…lbpzkdec…" node scripts/smoke-prod-programacao.mjs
//   (PROD_BASE_URL default = https://cargas.grupolamonica.com; sem PROD_DB_URL
//    as checagens de banco são puladas — só as de HTTP rodam.)
//
// Sai com código != 0 se qualquer verificação obrigatória falhar.
// ─────────────────────────────────────────────────────────────────────────
import pg from "pg";

const BASE = process.env.PROD_BASE_URL || "https://cargas.grupolamonica.com";
const DB = process.env.PROD_DB_URL || "";
let failed = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };

async function checkHttp(path, expected) {
  try {
    const r = await fetch(`${BASE}${path}`, { redirect: "manual" });
    (r.status === expected ? ok : bad)(`GET ${path} -> ${r.status} (esperado ${expected})`);
  } catch (err) {
    bad(`GET ${path} falhou: ${err.message}`);
  }
}

console.log(`== HTTP (${BASE}) ==`);
await checkHttp("/", 200);
await checkHttp("/health", 200);
// Rota deployada e protegida por sessão de operador (não deve ser 404/500).
await checkHttp("/api/operator/programacao", 401);

if (DB) {
  console.log("== Nestlé (fonte da Programação: nestle_ofertas / nestle_embarques) ==");
  const c = new pg.Client({ connectionString: DB, ssl: { rejectUnauthorized: false } });
  try {
    await c.connect();
    const q = async (s) => (await c.query(s)).rows;
    const [{ n: ofertas }] = await q("select count(*)::int n from public.nestle_ofertas");
    const [{ n: embarques }] = await q("select count(*)::int n from public.nestle_embarques");
    const [{ last }] = await q("select max(created_at) as last from public.nestle_ofertas");
    // Obrigatório: sem ofertas, a tela Programação não mostra Nestlé.
    (ofertas > 0 ? ok : bad)(`nestle_ofertas = ${ofertas} linha(s) ${ofertas > 0 ? "(coletor OK)" : "(VAZIO — coletor não rodou)"}`);
    ok(`nestle_embarques = ${embarques} linha(s)`);
    ok(`oferta mais recente (created_at) = ${last ? new Date(last).toISOString() : "n/a"}`);
  } catch (err) {
    bad(`checagem de banco falhou: ${err.message}`);
  } finally {
    await c.end().catch(() => {});
  }
} else {
  console.log("(PROD_DB_URL não setado — pulando checagens de banco Nestlé)");
}

console.log(failed ? `\n✗ FALHOU (${failed} verificação(ões))` : "\n✓ TUDO OK");
process.exit(failed ? 1 : 0);
