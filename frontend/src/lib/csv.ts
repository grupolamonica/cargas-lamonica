/**
 * Utilitários de exportação CSV (padrão Excel pt-BR: separador `;` + BOM UTF-8).
 * Extraído para reuso entre telas (Auditoria — DC-186, fila de leads, etc.).
 */

// BOM (U+FEFF): faz o Excel reconhecer UTF-8 e não corromper acentos.
const UTF8_BOM = String.fromCharCode(0xfeff);

/**
 * Escapa um valor para célula CSV. Envolve em aspas quando contém `;`, aspas
 * ou quebra de linha; duplica aspas internas.
 *
 * Anti CSV/formula injection: células que começam com `= + - @` (ou tab/CR
 * seguidos deles) são avaliadas como fórmula pelo Excel/Sheets. Como o log de
 * auditoria carrega texto controlável por terceiros (nome, observações, etc.),
 * prefixamos essas células com um apóstrofo — o Excel remove o aspeamento CSV
 * na importação, então o quoting sozinho não protege.
 */
export function csvCell(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Monta o CSV (cabeçalho + linhas) e dispara o download no navegador.
 * Usa `;` como separador e prefixa BOM UTF-8.
 */
export function downloadCsv(filename: string, headers: string[], rows: string[][]) {
  const lines = [headers, ...rows].map((cols) => cols.map(csvCell).join(";"));
  const blob = new Blob([`${UTF8_BOM}${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Timestamp compacto YYYYMMDD-HHMM para nomes de arquivo de export. */
export function csvTimestamp(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}
