#!/usr/bin/env node
/**
 * Aplica migration 20260507000001 em prod/dev.
 * Uso: node --env-file=.env src/scripts/apply-m1-prod.mjs
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '../../..');
const SQL_FILE = path.join(ROOT, 'backend/supabase/migrations/20260507000001_route_metrics_cache_bonus_exigencias.sql');

const rawUrl = process.env.SUPABASE_DB_URL?.trim();
if (!rawUrl) throw new Error('SUPABASE_DB_URL não configurado');

const url = rawUrl.replace('?pgbouncer=true', '').replace(':6543/', ':5432/');
console.log('Connecting to:', new URL(url).host);

const pool = new Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000 });
const client = await pool.connect();

try {
  // Disable statement timeout for DDL
  await client.query('SET statement_timeout = 0');

  const sql = readFileSync(SQL_FILE, 'utf8');
  console.log('Applying:', SQL_FILE);
  await client.query(sql);

  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='route_metrics_cache' AND column_name='bonus_exigencias'`
  );
  console.log('Result: bonus_exigencias', rows.length > 0 ? 'EXISTS ✓' : 'MISSING ✗');
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}
