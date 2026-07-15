// Write-back best-effort das alocações do Monitor para a PLANILHA de cada fonte,
// via um Apps Script "web app" (POST). Cada fonte (shopee, nestle) tem sua
// própria planilha e, portanto, sua própria URL/segredo de write-back:
//   - shopee: GOOGLE_SHEET_WRITEBACK_URL        (+ GOOGLE_SHEET_WRITEBACK_SECRET)
//   - nestle: GOOGLE_SHEET_NESTLE_WRITEBACK_URL (+ GOOGLE_SHEET_NESTLE_WRITEBACK_SECRET,
//             cai no segredo da shopee se o próprio não for setado)
//
// Cada `update` carrega a fonte da carga (`source` = cargas.sheet_source). Updates
// SEM source vão para a shopee (padrão histórico). Uma fonte só grava se a sua URL
// estiver configurada; sem URL → no-op silencioso (não é erro).
//
// Princípios:
// - O banco (alloc_*) é a fonte da verdade; a planilha é espelho.
// - NUNCA lança: se a planilha falhar (rede/limite/Apps Script fora), a edição
//   já foi salva no banco; aqui só logamos um aviso.
// - Escreve os valores EFETIVOS (o que o Monitor mostra). "" = limpa a célula.

/** Normaliza a fonte da carga. Só "nestle" é roteado à planilha Nestlé; o resto
 *  (shopee, importadas, nulo) cai na shopee — preservando o comportamento antigo. */
function normSource(source) {
  return String(source ?? "").trim().toLowerCase() === "nestle" ? "nestle" : "shopee";
}

/** URL + segredo do write-back de uma fonte (lidos do ambiente a cada chamada). */
function configForSource(source) {
  const key = normSource(source);
  if (key === "nestle") {
    return {
      source: key,
      url: process.env.GOOGLE_SHEET_NESTLE_WRITEBACK_URL?.trim() || "",
      secret:
        process.env.GOOGLE_SHEET_NESTLE_WRITEBACK_SECRET?.trim() ||
        process.env.GOOGLE_SHEET_WRITEBACK_SECRET?.trim() ||
        "",
    };
  }
  return {
    source: key,
    url: process.env.GOOGLE_SHEET_WRITEBACK_URL?.trim() || "",
    secret: process.env.GOOGLE_SHEET_WRITEBACK_SECRET?.trim() || "",
  };
}

/** Write-back ligado para a fonte? (sem argumento = shopee, padrão histórico.) */
export function isSheetWritebackEnabled(source) {
  return Boolean(configForSource(source).url);
}

/**
 * @param {Array<{lh:string, source?:string, motorista?:string, cavalo?:string, carreta?:string, status?:string, vinculo?:string}>} updates
 * @param {{ fetchImpl?: typeof fetch, log?: (level:string,event:string,data:object)=>void }} [opts]
 */
export async function writeAllocationsToSheet(updates, { fetchImpl = globalThis.fetch, log } = {}) {
  const warn = (event, data) => (log ? log("warn", event, data) : console.warn(`[sheet-writeback] ${event}`, data));

  // Normaliza e AGRUPA por fonte — cada Apps Script só escreve na sua planilha,
  // então um lote com fontes misturadas vira um POST por fonte.
  const groups = new Map(); // source → item[]
  for (const u of updates || []) {
    if (!u || !u.lh) continue;
    const item = {
      lh: String(u.lh).trim(),
      motorista: (u.motorista ?? "").toString(),
      cavalo: (u.cavalo ?? "").toString(),
      carreta: (u.carreta ?? "").toString(),
    };
    if (!item.lh) continue;
    // status (col de status) e vinculo são opcionais: só vão quando o caller manda
    // a chave — assim uma edição sem esses campos não sobrescreve a coluna.
    if ("status" in u) item.status = (u.status ?? "").toString();
    if ("vinculo" in u) item.vinculo = (u.vinculo ?? "").toString();
    const source = normSource(u.source);
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push(item);
  }

  if (groups.size === 0) return { ok: true, updated: 0 };

  let sent = false;
  let anyFail = false;
  let totalUpdated = 0;
  let lastError;

  for (const [source, list] of groups) {
    const { url, secret } = configForSource(source);
    if (!url) {
      // Fonte sem write-back configurado (ex.: Nestlé antes de criar o Apps Script)
      // → não é erro, apenas não espelha. Loga p/ visibilidade.
      warn("skipped-no-url", { source, count: list.length });
      continue;
    }
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, updates: list }),
      });
      const text = await res.text().catch(() => "");
      let body = null;
      try { body = JSON.parse(text); } catch { /* resposta não-JSON (ex.: HTML de erro) */ }

      if (!res.ok || (body && body.ok === false)) {
        anyFail = true;
        warn("failed", { source, status: res.status, body: text.slice(0, 200) });
        continue;
      }
      sent = true;
      totalUpdated += body?.updated ?? list.length;
    } catch (err) {
      anyFail = true;
      lastError = err instanceof Error ? err.message : String(err);
      warn("error", { source, message: lastError });
    }
  }

  // Nenhuma fonte tinha URL → mesmo shape do antigo "desligado".
  if (!sent && !anyFail) return { ok: false, skipped: true };
  if (anyFail) return { ok: false, updated: totalUpdated, ...(lastError ? { error: lastError } : {}) };
  return { ok: true, updated: totalUpdated };
}
