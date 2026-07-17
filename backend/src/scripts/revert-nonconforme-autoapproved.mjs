#!/usr/bin/env node
/**
 * Remediação: reverte para 'pendente' os cadastros AUTO-aprovados (marcador
 * `auto:angellira-vigencia`) cujo CONJUNTO (motorista + cavalo + carretas) NÃO
 * está conforme no Angellira. Corrige as aprovações da regra antiga, que só
 * olhava o motorista por CPF (ver auto-approve-vigentes.js / PR do fix).
 *
 * Os que continuam com o conjunto conforme permanecem aprovados. Indisponibilidade
 * transitória do Angellira NÃO reverte (incerteza — reavalia depois).
 *
 * Uso (rodar na VPS, onde há credenciais Angellira + acesso ao banco):
 *   node backend/src/scripts/revert-nonconforme-autoapproved.mjs            # DRY-RUN (não grava)
 *   node backend/src/scripts/revert-nonconforme-autoapproved.mjs --apply    # aplica a reversão
 *   node backend/src/scripts/revert-nonconforme-autoapproved.mjs --limit=200
 *
 * Rode SEMPRE o dry-run primeiro e confira o resumo antes de usar --apply.
 */
import "../infrastructure/config/load-env.js";
import { runRevertNonConformeAutoApproved } from "../application/operator-admin/use-cases/angellira/auto-approve-vigentes.js";

process.on("unhandledRejection", (reason) => {
  console.error("[revert-nonconforme] Unhandled rejection:", reason);
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

console.log(`[revert-nonconforme] modo=${apply ? "APLICAR (grava)" : "DRY-RUN (não grava)"} · limit=${limit}`);

const summary = await runRevertNonConformeAutoApproved({
  apply,
  limit,
  correlationId: "script-revert-nonconforme",
});

console.log("[revert-nonconforme] resumo:", JSON.stringify(summary, null, 2));
if (summary.skipped) {
  console.log("[revert-nonconforme] pulado — o job de aprovação está rodando. Tente de novo em instantes.");
} else if (!apply) {
  console.log(
    `[revert-nonconforme] DRY-RUN: reverteria ${summary.aRevertar} de ${summary.scanned} ` +
      `(conformes mantidos: ${summary.conformes}; indisponíveis ignorados: ${summary.indisponiveis}). ` +
      `Rode com --apply para efetivar.`,
  );
} else {
  console.log(`[revert-nonconforme] Revertidos ${summary.reverted} de ${summary.scanned} cadastros para pendente.`);
}
process.exit(0);
