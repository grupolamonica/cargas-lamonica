// backend/src/scripts/clear-orphan-cargo-prices.mjs
//
// PREÇO ÓRFÃO — limpeza pontual e idempotente.
//
// Contexto: até a correção da cascata (resolveCascadeTariff), o update-route e o
// save-route-trecho gravavam `valor = COALESCE(novo, atual)` nas cargas abertas do
// trecho. Consequência: quando o operador LIMPAVA o valor da tarifa ou DESATIVAVA a
// rota, a carga aberta continuava servindo o preço ANTIGO indefinidamente — a rota
// aparecia sem valor/desativada na tela de Rotas e a carga seguia no ar precificada.
//
// A correção impede novos casos, mas não desfaz os já gravados. Este script varre as
// cargas abertas e zera valor/bônus das que estão precificadas por uma tarifa que
// não existe mais (rota desativada, ou sem valor no catálogo).
//
// NÃO mexe em km/duração (fato físico do trecho) nem em status: quem tira a carga
// desativada do portal é o read model (dashboard-read-model filtra ativa=false).
//
// Usa o MESMO matcher da produção (createRouteLookupKeys), então respeita apelidos e
// sufixos de estação ("SJ Rio Preto-03/SP" → "sao jose do rio preto"). Duplicar essa
// canonicalização em SQL puro sairia da regra e divergiria com o tempo.
//
// Uso:
//   node src/scripts/clear-orphan-cargo-prices.mjs              # dry-run (só relatório)
//   node src/scripts/clear-orphan-cargo-prices.mjs --apply      # grava
//   node src/scripts/clear-orphan-cargo-prices.mjs --apply --lh LT1Q8402D5831,LT0Q...
//
// Idempotente: rodar de novo não encontra nada (as cargas já ficam com valor NULL).

import "../infrastructure/config/load-env.js";

import { withPgTransaction } from "../infrastructure/pg/postgres.js";
import { createRouteLookupKeys } from "../domain/operator-admin/route-utils.js";

process.on("unhandledRejection", (reason) => {
  console.error("[clear-orphan-cargo-prices] Unhandled promise rejection:", reason);
  process.exit(1);
});

const APPLY = process.argv.includes("--apply");

// --lh A,B,C restringe a limpeza a LHs específicos (lh_manual OU sheet_lh).
function parseLhFilter() {
  const flagIndex = process.argv.indexOf("--lh");
  if (flagIndex === -1) return null;
  const raw = process.argv[flagIndex + 1];
  if (!raw || raw.startsWith("--")) return null;
  const list = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Uma carga está com preço órfão quando tem valor gravado e NENHUMA tarifa do
 * catálogo que case (trecho + perfil, com fallback pro trecho) está apta a
 * precificá-la: ou todas as linhas do trecho estão desativadas, ou nenhuma tem
 * valor. `ativa` NULL = ativa (schema legado).
 */
function findPricingTariff(cargo, routesByLocationKey) {
  const locationKey = createRouteLookupKeys(cargo.origem, cargo.destino).find((key) =>
    routesByLocationKey.has(key),
  );
  if (!locationKey) return null; // sem rota casada: preço é próprio da carga, não órfão

  const candidates = routesByLocationKey.get(locationKey).filter((route) => route.ativa !== false);
  if (candidates.length === 0) return null;

  const cargoProfile = String(cargo.perfil ?? "").trim().toUpperCase();
  const cargoEixos = toNumberOrNull(cargo.eixos) ?? 0;
  const sameProfile = cargoProfile
    ? candidates.filter((c) => String(c.perfil_padrao ?? "").toUpperCase() === cargoProfile)
    : [];
  const matched =
    sameProfile.find((c) => (toNumberOrNull(c.eixos) ?? 0) === cargoEixos) ||
    sameProfile[0] ||
    candidates[0];

  return matched && toNumberOrNull(matched.valor_padrao) !== null ? matched : null;
}

async function main() {
  const lhFilter = parseLhFilter();

  const report = await withPgTransaction(async (client) => {
    const { rows: routeRows } = await client.query(
      `SELECT origin_key, destination_key, perfil_padrao, eixos, valor_padrao, ativa, origem, destino
         FROM public.route_metrics_cache`,
    );
    const routesByLocationKey = new Map();
    for (const route of routeRows) {
      if (!route.origin_key || !route.destination_key) continue;
      const key = `${route.origin_key}|${route.destination_key}`;
      if (!routesByLocationKey.has(key)) routesByLocationKey.set(key, []);
      routesByLocationKey.get(key).push(route);
    }

    const { rows: cargoRows } = await client.query(
      `SELECT id, lh_manual, sheet_lh, origem, destino, perfil, eixos, valor, bonus, status, data
         FROM public.cargas
        WHERE status IN ('OPEN', 'DRAFT')
          AND valor IS NOT NULL`,
    );

    const orphans = [];
    for (const cargo of cargoRows) {
      const lh = cargo.lh_manual || cargo.sheet_lh || null;
      if (lhFilter && !(lh && lhFilter.has(lh))) continue;
      if (findPricingTariff(cargo, routesByLocationKey)) continue;
      orphans.push({
        id: cargo.id,
        lh,
        origem: cargo.origem,
        destino: cargo.destino,
        perfil: cargo.perfil,
        status: cargo.status,
        data: cargo.data,
        valor: toNumberOrNull(cargo.valor),
        bonus: toNumberOrNull(cargo.bonus),
      });
    }

    let cleared = 0;
    if (APPLY && orphans.length > 0) {
      const ids = orphans.map((o) => o.id);
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
      const result = await client.query(
        // Só o dinheiro: km/duração e status ficam intactos.
        `UPDATE public.cargas SET valor = NULL, bonus = NULL WHERE id IN (${placeholders})`,
        ids,
      );
      cleared = result.rowCount || 0;
    }

    return { scanned: cargoRows.length, orphans, cleared };
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: APPLY ? "apply" : "dry-run",
        lhFilter: lhFilter ? Array.from(lhFilter) : null,
        scannedOpenCargasWithPrice: report.scanned,
        orphanCount: report.orphans.length,
        cleared: report.cleared,
        orphans: report.orphans,
      },
      null,
      2,
    ),
  );

  if (!APPLY && report.orphans.length > 0) {
    console.log(`\n[dry-run] ${report.orphans.length} carga(s) com preço órfão. Rode com --apply para limpar.`);
  }
}

main().catch((error) => {
  console.error("[clear-orphan-cargo-prices] Failed", error);
  process.exitCode = 1;
});
