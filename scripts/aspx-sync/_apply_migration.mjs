// One-shot: aplica a migration 20260420120000_create_aspx_drivers.sql no
// Supabase Postgres via SUPABASE_DB_URL. Script descartavel — nao e chamado
// em prod, so usado uma vez para bootstrap da tabela aspx_drivers.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  here,
  "../../supabase/migrations/20260420120000_create_aspx_drivers.sql",
);

const sql = readFileSync(migrationPath, "utf8");
const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  console.error("SUPABASE_DB_URL ausente");
  process.exit(1);
}

const client = new pg.Client({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  console.log("Conectado. Aplicando migration...");
  await client.query(sql);

  const tablesCheck = await client.query(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename IN ('aspx_drivers', 'aspx_credentials')
     ORDER BY tablename`,
  );
  console.log("Tabelas criadas:", tablesCheck.rows.map((r) => r.tablename));

  const credCheck = await client.query(
    "SELECT id, email, length(password) AS pwd_len, device_id FROM public.aspx_credentials",
  );
  console.log("aspx_credentials:", credCheck.rows);
  console.log("OK");
} catch (error) {
  console.error("FALHA:", error.message);
  process.exit(1);
} finally {
  await client.end();
}
