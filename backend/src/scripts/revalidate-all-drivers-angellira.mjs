#!/usr/bin/env node
/**
 * Backfill: revalida a vigência Angellira de TODOS os motoristas do
 * motoristas_historico consultando a API AO VIVO e gravando angellira_limit_date
 * fresco. Destrava de imediato os motoristas que aparecem "vencidos" só por causa
 * do snapshot antigo (import manual). O timer do main.js
 * (ANGELLIRA_DRIVER_REVALIDATE_ENABLED) mantém a base fresca depois disso.
 *
 * Uso:
 *   node backend/src/scripts/revalidate-all-drivers-angellira.mjs
 *   node backend/src/scripts/revalidate-all-drivers-angellira.mjs --concurrency=8
 *   node backend/src/scripts/revalidate-all-drivers-angellira.mjs --limit=500   (teste)
 *
 * Só grava com availability OK (nunca rebaixa por falha). NOT_FOUND zera a vigência.
 */
import "../infrastructure/config/load-env.js";
import { revalidateDriversAngellira } from "../application/operator-admin/use-cases/revalidate-drivers-angellira.js";

process.on("unhandledRejection", (reason) => {
  console.error("[script] Unhandled promise rejection:", reason);
  process.exit(1);
});

function parseArg(name, fallback) {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}`) return true;
  }
  return fallback;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

async function main() {
  const startedAt = Date.now();
  const concurrency = Math.max(1, Number(parseArg("concurrency", 8)));
  const limitArg = parseArg("limit", null);
  const limit = limitArg ? Number.parseInt(limitArg, 10) : null;
  const correlationId = `angellira-drivers-backfill-${startedAt}`;

  console.log(`[revalidate-drivers-angellira] iniciando (concorrencia=${concurrency}${limit ? `, limite=${limit}` : ", base inteira"})`);

  // staleHours=null → ignora frescor (revalida TODOS os selecionados).
  const summary = await revalidateDriversAngellira({
    limit,
    staleHours: null,
    concurrency,
    correlationId,
    onProgress: ({ processed, total, found, notFound, unavailable }) => {
      if (processed % 100 === 0 || processed === total) {
        const pct = total ? Math.round((processed / total) * 100) : 100;
        console.log(
          `[revalidate-drivers-angellira] [${pct}%] ${processed}/${total} — vigente=${found} semCadastro=${notFound} indisp=${unavailable} elapsed=${formatDuration(Date.now() - startedAt)}`,
        );
      }
    },
  });

  console.log("\n==== RESUMO Angellira (motoristas) ====");
  console.log(`Verificados:        ${summary.checked}`);
  console.log(`Vigentes (FOUND):   ${summary.found}`);
  console.log(`Sem cadastro:       ${summary.notFound}`);
  console.log(`Indisponiveis:      ${summary.unavailable}`);
  console.log(`Concorrencia:       ${concurrency}`);
  console.log(`Tempo total:        ${formatDuration(Date.now() - startedAt)}`);
  process.exit(summary.unavailable > 0 && summary.found === 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
