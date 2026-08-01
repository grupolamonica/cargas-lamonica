#!/usr/bin/env node
/**
 * Saneamento: solta os `cargas.alloc_status` que ficaram CONGELADOS — override
 * gravado pelo modal do Monitor sem o operador ter escolhido nada (race do
 * prefill com o overlay ao vivo do SPX), que depois mascarava o avanço da viagem
 * e ainda era espelhado na coluna L da planilha a cada save de alocação.
 *
 * Aplica a MESMA regra do sync ASPX (`shouldReleaseAllocStatusOverride`), então
 * overrides deliberados são preservados: CTE EM EMISSÃO, CTE ENVIADO, NO SHOW e
 * CANCELADO. Cobre o resíduo que o sync não alcança (LH fora da janela da Torre).
 *
 * Uso (rodar onde há acesso ao banco):
 *   node backend/src/scripts/release-frozen-alloc-status.mjs            # DRY-RUN (não grava)
 *   node backend/src/scripts/release-frozen-alloc-status.mjs --apply    # aplica
 *   node backend/src/scripts/release-frozen-alloc-status.mjs --limit=200
 *
 * Rode SEMPRE o dry-run primeiro e confira a lista antes de usar --apply.
 */
import "../infrastructure/config/load-env.js";
import { releaseFrozenAllocStatus } from "../application/operator-admin/use-cases/release-frozen-alloc-status.js";

process.on("unhandledRejection", (reason) => {
  console.error("[release-frozen-alloc-status] Unhandled rejection:", reason);
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

const apply = Boolean(parseArg("apply", false));
const limit = Number(parseArg("limit", 1000)) || 1000;

console.log(`[release-frozen-alloc-status] modo=${apply ? "APLICAR (grava)" : "DRY-RUN (não grava)"} · limit=${limit}`);

const summary = await releaseFrozenAllocStatus({
  apply,
  limit,
  correlationId: "script-release-frozen-alloc-status",
});

for (const it of summary.items) {
  console.log(`  ${String(it.lh ?? "(sem LH)").padEnd(16)} override[${it.de}] → planilha[${it.para}]`);
}
console.log(
  `[release-frozen-alloc-status] varridas=${summary.scanned} · a soltar=${summary.released} · aplicado=${summary.applied}`,
);
if (!apply && summary.released > 0) {
  console.log("[release-frozen-alloc-status] DRY-RUN — rode com --apply para efetivar.");
}
process.exit(0);
