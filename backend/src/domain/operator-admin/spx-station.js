// backend/src/domain/operator-admin/spx-station.js
//
// Parser do nome de estação do SPX — fonte única (era duplicado no read model da
// Programação; o índice de viagens também precisa dele para agrupar por rota).
//
// "LM Hub_CE_Juazeiro do Norte" (ou "[10768]LM Hub_CE_..." quando vem pela Torre) →
//   label:  "Cidade/UF · TIPO"  (exibição — mantém o tipo LM Hub/SoC/…)
//   cityUf: "Cidade/UF"         (casa o catálogo de rotas / prefill do modal)
//   codigo: "10768"             (código da estação, quando vem entre colchetes; "" se ausente)

export function parseStation(raw) {
  const s = String(raw || "").trim();
  if (!s) return { label: "", cityUf: "", codigo: "" };
  const cod = s.match(/^\[(\d+)\]/);
  const codigo = cod ? cod[1] : "";
  const body = s.replace(/^\[\d+\]\s*/, "");
  const m = body.match(/^(.*?)_([A-Z]{2})_(.+)$/);
  if (!m) return { label: body, cityUf: body, codigo };
  const tipo = m[1].trim();
  const uf = m[2];
  const cidade = m[3].replace(/_/g, " ").trim();
  const cityUf = `${cidade}/${uf}`;
  return { label: `${cityUf}${tipo ? ` · ${tipo}` : ""}`, cityUf, codigo };
}
