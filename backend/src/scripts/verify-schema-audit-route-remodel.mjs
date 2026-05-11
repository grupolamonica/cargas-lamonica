#!/usr/bin/env node
/**
 * Verifica o estado do banco após a migration schema_audit_route_remodel.
 * Uso: node --env-file=.env.dev src/scripts/verify-schema-audit-route-remodel.mjs
 */
import { Pool } from "pg";

function buildDirectUrl(url) {
  return url.replace("?pgbouncer=true", "").replace(":6543/postgres", ":5432/postgres");
}

const pool = new Pool({
  connectionString: buildDirectUrl(process.env.SUPABASE_DB_URL),
  max: 1,
  ssl: { rejectUnauthorized: false },
});

async function q(client, label, sql, params = []) {
  const { rows } = await client.query(sql, params);
  console.log(`\n=== ${label} ===`);
  console.table(rows);
  return rows;
}

async function main() {
  const client = await pool.connect();
  try {
    // 1. Schema de clientes — confirmar colunas removidas
    await q(client, "clientes — colunas atuais",
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'clientes'
       ORDER BY ordinal_position`);

    // 2. Schema de cargas — confirmar rota_id presente
    await q(client, "cargas — colunas novas/relevantes",
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'cargas'
         AND column_name IN ('perfil','valor','bonus','rota_id','cliente_id')
       ORDER BY ordinal_position`);

    // 3. Rotas migradas
    await q(client, "rotas — amostra das 5 primeiras",
      `SELECT id, origem, destino, distancia_km, ativa
       FROM public.rotas
       ORDER BY distancia_km DESC NULLS LAST
       LIMIT 5`);

    // 4. Tarifas migradas
    await q(client, "rota_tarifas — todas as tarifas migradas",
      `SELECT r.origem, r.destino, rt.tipo_veiculo, rt.valor_frete, rt.bonus
       FROM public.rota_tarifas rt
       JOIN public.rotas r ON r.id = rt.rota_id
       ORDER BY r.origem, rt.tipo_veiculo`);

    // 5. Consistência: rotas em route_metrics_cache vs rotas
    await q(client, "consistência route_metrics_cache vs rotas",
      `SELECT
         COUNT(*) FILTER (WHERE r.id IS NULL) AS faltando_em_rotas,
         COUNT(*) FILTER (WHERE r.id IS NOT NULL) AS migradas_ok,
         COUNT(*) AS total_cache
       FROM public.route_metrics_cache rmc
       LEFT JOIN public.rotas r ON r.origem = rmc.origem AND r.destino = rmc.destino`);

    // 6. Constraints das novas tabelas
    await q(client, "constraints de rota_tarifas",
      `SELECT constraint_name, constraint_type
       FROM information_schema.table_constraints
       WHERE table_schema = 'public' AND table_name = 'rota_tarifas'`);

    // 7. RLS ativo nas novas tabelas
    await q(client, "RLS nas novas tabelas",
      `SELECT relname AS tabela, relrowsecurity AS rls_ativo
       FROM pg_class
       WHERE relname IN ('rotas','rota_tarifas','cliente_rotas')
         AND relkind = 'r'`);

    // 8. FK de cargas.rota_id
    await q(client, "FK de cargas.rota_id",
      `SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_col
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.referential_constraints rc
         ON kcu.constraint_name = rc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON rc.unique_constraint_name = ccu.constraint_name
       WHERE kcu.table_schema = 'public'
         AND kcu.table_name = 'cargas'
         AND kcu.column_name = 'rota_id'`);

    // 9. View de conveniência funciona
    await q(client, "v_rotas_com_tarifas — amostra",
      `SELECT origem, destino, tipo_veiculo, valor_frete
       FROM public.v_rotas_com_tarifas
       WHERE tarifa_ativa = true
       ORDER BY origem, tipo_veiculo
       LIMIT 8`);

    // 10. FK de vehicles.linked_driver_id (nova)
    await q(client, "FK vehicles.linked_driver_id",
      `SELECT kcu.column_name, ccu.table_name AS ref_table
       FROM information_schema.key_column_usage kcu
       JOIN information_schema.referential_constraints rc
         ON kcu.constraint_name = rc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON rc.unique_constraint_name = ccu.constraint_name
       WHERE kcu.table_schema = 'public'
         AND kcu.table_name = 'vehicles'
         AND kcu.column_name = 'linked_driver_id'`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
