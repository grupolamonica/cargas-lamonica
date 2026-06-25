/**
 * Resolução de documentos de cadastros MIGRADOS (bot WhatsApp) no share local da
 * produção, para VISUALIZAÇÃO no painel — servidos como base64 (sem subir pro
 * Supabase, respeitando a regra de não sobrecarregar o Storage).
 *
 * Estrutura no share:  {PRODUCAO_DOCS_BASE}/dados_motoristas/{motorista_id}/{sub}/{slug}.*
 * O mapa tipo→{sub,slugs} espelha o buildSpecs de migrate-prod-docs-to-storage.mjs.
 *
 * ⚠ Só funciona em ambiente com acesso ao share (dev/SERVERBD). No VPS/Docker o
 * backend não alcança H: — ali os docs precisariam estar no bucket (*_url).
 *
 * Segurança: o motorista_id NUNCA vem do cliente — vem do `dados._origem` do
 * cadastro. O `tipo` é validado contra DOC_TIPOS (allowlist). sub/slug são fixos.
 * Logo, não há leitura de caminho arbitrário nem path traversal.
 */

import fs from "node:fs";
import path from "node:path";

const PRODUCAO_DOCS_BASE = process.env.PRODUCAO_DOCS_BASE || "H:\\Operacao\\CADASTROWHATS";

const MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
  ".heic": "image/heic", ".heif": "image/heif", ".pdf": "application/pdf",
};

// tipo → rótulo + locais onde procurar (sub do share + slugs candidatos, em ordem).
export const DOC_TIPOS = {
  cnh: { label: "Motorista — CNH", locais: [{ sub: "motorista", slugs: ["cnh-motorista"] }] },
  cnh_verso: { label: "Motorista — CNH (verso)", locais: [{ sub: "motorista", slugs: ["cnh-motorista-verso"] }] },
  selfie: { label: "Motorista — Selfie", locais: [{ sub: "motorista", slugs: ["selfie-cnh", "foto-selfie", "selfie"] }] },
  comprovante: { label: "Motorista — Comprovante de residência", locais: [{ sub: "motorista", slugs: ["comprovante-residencia", "comprovante-endereco", "comprovante"] }] },
  crlv_cavalo: { label: "Cavalo — CRLV", locais: [{ sub: "veiculo", slugs: ["crlv-cavalo"] }] },
  crlv_carreta: { label: "Carreta — CRLV", locais: [{ sub: "veiculo", slugs: ["crlv-carreta"] }] },
  cavalo_owner: { label: "Dono do cavalo — Documento", locais: [{ sub: "proprietario", slugs: ["cavalo-prop-cnh", "cavalo-prop-cartao-pj", "cavalo-prop-cnpj"] }] },
  carreta_owner: { label: "Dono da carreta — Documento", locais: [{ sub: "proprietario", slugs: ["carreta-prop-cnh", "carreta-prop-cartao-pj", "carreta-prop-cnpj"] }] },
};

const _digits = (v) => String(v ?? "").replace(/\D/g, "");
const mimeFromPath = (abs) => MIME_BY_EXT[path.extname(abs).toLowerCase()] || "application/octet-stream";

/** Acha o arquivo no share: {base}/dados_motoristas/{id}/{sub}/{slug}.* (1ª ext que casar). */
function findProdDoc(motoristaId, sub, slugs) {
  try {
    const dir = path.join(PRODUCAO_DOCS_BASE, "dados_motoristas", String(motoristaId), sub);
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir);
    for (const slug of slugs) {
      const alvo = `${slug.toLowerCase()}.`;
      const hit = entries.find((f) => f.toLowerCase().startsWith(alvo));
      if (hit) return path.join(dir, hit);
    }
  } catch {
    return null;
  }
  return null;
}

/** motorista=proprietário do cavalo? (a CNH dele é a do proprietário em proprietario/). */
function motoristaEhOwnerCavalo(dados) {
  const mCpf = _digits(dados?.motorista?.cpf);
  const oDoc = _digits(dados?.cavalo_owner?.doc);
  return !!mCpf && mCpf === oDoc;
}

/**
 * Resolve o caminho ABSOLUTO de um doc no share. Retorna null se não achar.
 * @param {string|number} motoristaId — de dados._origem.motorista_id (NUNCA do cliente)
 * @param {string} tipo — chave de DOC_TIPOS
 * @param {{motoristaEhProp?: boolean}} [opts]
 */
export function resolveLocalProdDoc(motoristaId, tipo, { motoristaEhProp = false } = {}) {
  const spec = DOC_TIPOS[tipo];
  if (!spec || !motoristaId) return null;
  let locais = spec.locais;
  // CNH do motorista quando ele é o dono do cavalo: cai no proprietario/cavalo-prop-cnh.
  if (tipo === "cnh" && motoristaEhProp) {
    locais = [...locais, { sub: "proprietario", slugs: ["cavalo-prop-cnh"] }];
  }
  for (const loc of locais) {
    const abs = findProdDoc(motoristaId, loc.sub, loc.slugs);
    if (abs) return abs;
  }
  return null;
}

/**
 * Lista os docs migrados que EXISTEM no share para um cadastro (manifest p/ a
 * galeria). Não expõe o caminho do share — só tipo/label/filename/content_type.
 * @returns {Array<{tipo,label,filename,content_type}>}
 */
export function listAvailableMigratedDocs(dados) {
  const motoristaId = dados?._origem?.motorista_id;
  if (!motoristaId) return [];
  const ehProp = motoristaEhOwnerCavalo(dados);

  const candidatos = ["cnh", "cnh_verso", "selfie", "comprovante", "crlv_cavalo"];
  if (dados?.cavalo_owner) candidatos.push("cavalo_owner");
  const temCarreta = (Array.isArray(dados?.carretas) && dados.carretas.length > 0) || !!dados?.carreta;
  if (temCarreta) {
    candidatos.push("crlv_carreta");
    const temCarOwner = (Array.isArray(dados?.carreta_owners) && dados.carreta_owners[0]) || dados?.carreta_owner;
    if (temCarOwner) candidatos.push("carreta_owner");
  }

  const out = [];
  for (const tipo of candidatos) {
    const abs = resolveLocalProdDoc(motoristaId, tipo, { motoristaEhProp: ehProp });
    if (abs) out.push({ tipo, label: DOC_TIPOS[tipo].label, filename: path.basename(abs), content_type: mimeFromPath(abs) });
  }
  return out;
}

/**
 * Lê um doc do share e devolve como data-URI base64. Retorna null se não achar.
 * @throws {Error} se o arquivo exceder maxBytes.
 */
export function readLocalProdDocAsDataUri(dados, tipo, { maxBytes = 25 * 1024 * 1024 } = {}) {
  const motoristaId = dados?._origem?.motorista_id;
  if (!motoristaId) return null;
  const abs = resolveLocalProdDoc(motoristaId, tipo, { motoristaEhProp: motoristaEhOwnerCavalo(dados) });
  if (!abs) return null;
  const stat = fs.statSync(abs);
  if (stat.size > maxBytes) {
    const err = new Error(`Documento muito grande (${Math.round(stat.size / 1024 / 1024)}MB).`);
    err.code = "DOC_TOO_LARGE";
    throw err;
  }
  const contentType = mimeFromPath(abs);
  const base64 = fs.readFileSync(abs).toString("base64");
  return {
    data_uri: `data:${contentType};base64,${base64}`,
    content_type: contentType,
    filename: path.basename(abs),
    bytes: stat.size,
  };
}
