/**
 * "Carga da planilha online" = sincronizada da planilha Shopee (Google Sheets).
 *
 * Marcador definitivo: `sheet_synced_at` — só o sync da planilha preenche esse
 * campo. Cargas importadas via CSV (programação) têm `sheet_lh` (COD. CARGA) mas
 * `sheet_synced_at` NULL: NÃO são cargas Shopee e não devem ter o cliente
 * forçado/travado como Shopee nem exibido como Shopee.
 *
 * Alinhado com o backend, que usa a mesma regra para separar os dois casos:
 * `backend/src/application/google-sheets/google-sheet-loads.js`
 * (`.not("sheet_synced_at", "is", null)`).
 *
 * Antes essa checagem olhava só `sheet_lh`, o que classificava erroneamente as
 * cargas importadas como Shopee (cliente virava Shopee e ficava bloqueado).
 */
export function isOnlineSheetCargo(
  cargo?: { sheet_lh?: string | null; sheet_synced_at?: string | null } | null,
): boolean {
  return (
    typeof cargo?.sheet_lh === "string" &&
    cargo.sheet_lh.trim() !== "" &&
    typeof cargo?.sheet_synced_at === "string" &&
    cargo.sheet_synced_at.trim() !== ""
  );
}
