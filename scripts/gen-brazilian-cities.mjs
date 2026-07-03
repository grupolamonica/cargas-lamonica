// Gera frontend/src/lib/brazilianCities.ts a partir da lista oficial de
// municípios do IBGE. Execução one-off (build-time): NÃO roda em runtime/CI.
// Uso: node scripts/gen-brazilian-cities.mjs
//
// Mesmo padrão dos catálogos estáticos já versionados (brazilianBanks.ts, ufs.ts):
// baixa uma vez e commita o .ts resultante — zero dependência de rede em produção.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "frontend", "src", "lib", "brazilianCities.ts");
const SOURCE_URL = "https://servicodados.ibge.gov.br/api/v1/localidades/municipios";

// A UF pode estar em microrregiao.mesorregiao.UF (estrutura clássica) ou em
// regiao-imediata.regiao-intermediaria.UF (estrutura nova). Tentamos ambas.
function ufOf(municipio) {
  return (
    municipio?.microrregiao?.mesorregiao?.UF?.sigla ||
    municipio?.["regiao-imediata"]?.["regiao-intermediaria"]?.UF?.sigla ||
    municipio?.UF?.sigla ||
    null
  );
}

const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(`Falha ao buscar municípios do IBGE: HTTP ${response.status}`);
}
const data = await response.json();

const cities = data
  .map((municipio) => ({ nome: String(municipio.nome ?? "").trim(), uf: ufOf(municipio) }))
  .filter((city) => city.nome && city.uf)
  .sort((a, b) => a.uf.localeCompare(b.uf, "pt-BR") || a.nome.localeCompare(b.nome, "pt-BR"));

const escapeString = (value) => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const lines = cities.map((city) => `  { nome: "${escapeString(city.nome)}", uf: "${city.uf}" },`).join("\n");

const content = `// AUTO-GERADO por scripts/gen-brazilian-cities.mjs — NÃO EDITAR À MÃO.
// Fonte: IBGE ${SOURCE_URL}
// Total: ${cities.length} municípios. Regenerar: node scripts/gen-brazilian-cities.mjs
export interface BrazilianCity {
  nome: string;
  uf: string;
}

export const BRAZILIAN_CITIES: BrazilianCity[] = [
${lines}
];
`;

writeFileSync(OUT, content, "utf8");
console.log(`Gerado ${OUT} com ${cities.length} municípios.`);
