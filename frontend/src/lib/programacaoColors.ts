// Cor da LINHA da Programação por rota (código de PARTIDA + CHEGADA + tipo de VEÍCULO).
// As regras vêm do backend (tabela compartilhada, editável pela tela). Aqui só o
// casamento viagem→cor e o cálculo de texto contrastante p/ a linha ficar legível.

import type { ProgramacaoRow, RouteColorRule } from "@/services/readModels";

// Normaliza o tipo de veículo p/ casar sem ruído — MESMA regra do backend
// (programacao-route-colors.js normalizeVehicle): MAIÚSCULAS, espaços colapsados e
// hífen canônico (" - "), então "CARRETA-EXPRESSA" casa com o seed "CARRETA - EXPRESSA".
export function normalizeVehicle(v: string | null | undefined): string {
  return String(v ?? "").toUpperCase().replace(/\s+/g, " ").replace(/\s*-\s*/g, " - ").trim();
}

function key(partida: string, chegada: string, veiculo: string): string {
  return `${String(partida).trim()}|${String(chegada).trim()}|${normalizeVehicle(veiculo)}`;
}

/** Mapa (partida|chegada|veículo) → cor hex, a partir das regras. */
export function buildRouteColorMap(rules: RouteColorRule[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rules ?? []) {
    if (!r.partida || !r.chegada || !r.veiculo || !r.cor) continue;
    m.set(key(r.partida, r.chegada, r.veiculo), r.cor);
  }
  return m;
}

/** Cor da linha para uma viagem (ou null se não há regra / sem código de estação). */
export function colorForRow(map: Map<string, string>, row: ProgramacaoRow): string | null {
  const p = String(row.origemCodigo ?? "").trim();
  const c = String(row.destinoCodigo ?? "").trim();
  if (!p || !c) return null;
  return map.get(key(p, c, row.veiculo)) ?? null;
}

// Luminância relativa (sRGB) → texto escuro em fundo claro, branco em fundo escuro.
// Mantém a linha legível seja qual for a cor que o operador escolher.
function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return 1; // desconhecido → assume claro (texto escuro)
  let h = m[1];
  if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
  const toLin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const r = toLin(parseInt(h.slice(0, 2), 16));
  const g = toLin(parseInt(h.slice(2, 4), 16));
  const b = toLin(parseInt(h.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(l1: number, l2: number): number {
  const a = Math.max(l1, l2);
  const b = Math.min(l1, l2);
  return (a + 0.05) / (b + 0.05);
}

// Texto escuro (#0f172a) ou claro (#f8fafc) — o que der MAIOR contraste sobre `hex`.
// Comparar as razões reais (não um limiar fixo de luminância) escolhe certo também
// nas cores de luminância média que um operador pode pegar no seletor.
const DARK_TEXT = "#0f172a";
const LIGHT_TEXT = "#f8fafc";
const DARK_L = relativeLuminance(DARK_TEXT);
const LIGHT_L = relativeLuminance(LIGHT_TEXT);

/** Cor de texto legível sobre `hex` (maior razão de contraste WCAG). */
export function contrastText(hex: string): string {
  const bg = relativeLuminance(hex);
  return contrastRatio(bg, DARK_L) >= contrastRatio(bg, LIGHT_L) ? DARK_TEXT : LIGHT_TEXT;
}

// Presets p/ o seletor (o operador ainda pode escolher qualquer cor no <input type=color>).
export const COLOR_PRESETS: { nome: string; hex: string }[] = [
  { nome: "Amarelo", hex: "#fde047" },
  { nome: "Laranja", hex: "#fdba74" },
  { nome: "Azul", hex: "#93c5fd" },
  { nome: "Verde", hex: "#86efac" },
  { nome: "Vermelho", hex: "#fca5a5" },
  { nome: "Roxo", hex: "#d8b4fe" },
  { nome: "Rosa", hex: "#f9a8d4" },
  { nome: "Cinza", hex: "#cbd5e1" },
];
