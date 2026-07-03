// Write-back best-effort das alocações do Monitor para a planilha, via um
// Apps Script "web app" (POST). Liga SOMENTE se GOOGLE_SHEET_WRITEBACK_URL
// estiver setado (ex.: staging/teste apontando pra planilha cópia).
//
// Princípios:
// - O banco (alloc_*) é a fonte da verdade; a planilha é espelho.
// - NUNCA lança: se a planilha falhar (rede/limite/Apps Script fora), a edição
//   já foi salva no banco; aqui só logamos um aviso.
// - Escreve os valores EFETIVOS (o que o Monitor mostra). "" = limpa a célula.

export function isSheetWritebackEnabled() {
  return Boolean(process.env.GOOGLE_SHEET_WRITEBACK_URL?.trim());
}

/**
 * @param {Array<{lh:string, motorista?:string, cavalo?:string, carreta?:string}>} updates
 * @param {{ fetchImpl?: typeof fetch, log?: (level:string,event:string,data:object)=>void }} [opts]
 */
export async function writeAllocationsToSheet(updates, { fetchImpl = globalThis.fetch, log } = {}) {
  const url = process.env.GOOGLE_SHEET_WRITEBACK_URL?.trim();
  if (!url) return { ok: false, skipped: true };

  const list = (updates || [])
    .filter((u) => u && u.lh)
    .map((u) => ({
      lh: String(u.lh).trim(),
      motorista: (u.motorista ?? "").toString(),
      cavalo: (u.cavalo ?? "").toString(),
      carreta: (u.carreta ?? "").toString(),
    }))
    .filter((u) => u.lh);

  if (list.length === 0) return { ok: true, updated: 0 };

  const secret = process.env.GOOGLE_SHEET_WRITEBACK_SECRET?.trim() || "";
  const warn = (event, data) => (log ? log("warn", event, data) : console.warn(`[sheet-writeback] ${event}`, data));

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
      warn("failed", { status: res.status, body: text.slice(0, 200) });
      return { ok: false, status: res.status, body };
    }
    return { ok: true, updated: body?.updated ?? list.length };
  } catch (err) {
    warn("error", { message: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: String(err) };
  }
}
