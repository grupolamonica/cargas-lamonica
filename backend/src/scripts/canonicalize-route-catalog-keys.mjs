// backend/src/scripts/canonicalize-route-catalog-keys.mjs
//
// Migração de dados (idempotente) que alinha as chaves do catálogo de rotas
// (public.route_metrics_cache) à normalização CANÔNICA usada pelo matching
// carga→rota (canonicalizeRouteLookupLocation). Complementa o fix de código que
// passou create-route / update-route / save-route-trecho a gravar chave canônica
// (buildRouteCatalogKeys) — sem canonicalizar as linhas já existentes, uma nova
// gravação (chave canônica) não colide com a linha antiga (chave "/UF") e volta a
// duplicar. Ver a correção de rotas duplicadas.
//
// Segurança:
//   - DRY-RUN por padrão (só relata). Grava apenas com APPLY=1.
//   - ABORTA se a canonicalização gerar colisão na unique
//     (origin_key, destination_key, perfil_padrao, eixos) — nunca viola a constraint.
//     (Duplicatas reais devem ser resolvidas ANTES, manualmente.)
//   - Transacional; só UPDATE nas linhas cuja chave muda.
//
// Uso (no container do backend, com SUPABASE_DB_URL no ambiente):
//   node src/scripts/canonicalize-route-catalog-keys.mjs         # dry-run
//   APPLY=1 node src/scripts/canonicalize-route-catalog-keys.mjs # aplica

import pg from "pg";
import { canonicalizeRouteLookupLocation } from "../domain/operator-admin/route-utils.js";

const APPLY = process.env.APPLY === "1";

function connectionString() {
  const cs = process.env.SUPABASE_DB_URL?.trim();
  if (!cs) throw new Error("SUPABASE_DB_URL ausente.");
  return cs;
}

async function main() {
  const client = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, origem, destino, origin_key, destination_key, perfil_padrao, eixos
         FROM public.route_metrics_cache`,
    );

    // Alvo canônico por linha + detecção de colisão na unique.
    const identity = new Map(); // "co|cd|perfil|eixos" -> [ids]
    const changes = [];
    for (const r of rows) {
      const co = canonicalizeRouteLookupLocation(r.origem);
      const cd = canonicalizeRouteLookupLocation(r.destino);
      const idKey = `${co}|${cd}|${r.perfil_padrao ?? ""}|${r.eixos ?? 0}`;
      if (!identity.has(idKey)) identity.set(idKey, []);
      identity.get(idKey).push(r.id);
      if (co !== r.origin_key || cd !== r.destination_key) {
        changes.push({ id: r.id, from: `${r.origin_key}|${r.destination_key}`, to: `${co}|${cd}`, co, cd });
      }
    }

    const collisions = [...identity.entries()].filter(([, ids]) => ids.length > 1);
    console.log(`linhas=${rows.length} | mudariam=${changes.length} | colisões=${collisions.length}`);
    if (collisions.length > 0) {
      console.log("ABORTADO — canonicalização geraria duplicata na unique. Resolva manualmente antes:");
      for (const [k, ids] of collisions) console.log(`  ${k}  -> ids ${ids.map((i) => i.slice(0, 8)).join(", ")}`);
      process.exitCode = 1;
      return;
    }

    for (const ch of changes) console.log(`  ${ch.id.slice(0, 8)}: '${ch.from}' -> '${ch.to}'`);
    if (changes.length === 0) {
      console.log("Nada a fazer (já canônico).");
      return;
    }

    await client.query("BEGIN");
    let updated = 0;
    for (const ch of changes) {
      const r = await client.query(
        `UPDATE public.route_metrics_cache SET origin_key = $2, destination_key = $3, updated_at = now() WHERE id = $1`,
        [ch.id, ch.co, ch.cd],
      );
      updated += r.rowCount;
    }
    if (APPLY) {
      await client.query("COMMIT");
      console.log(`== COMMIT — ${updated} linhas canonicalizadas ==`);
    } else {
      await client.query("ROLLBACK");
      console.log(`== DRY-RUN (ROLLBACK) — ${updated} linhas seriam canonicalizadas ==`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
