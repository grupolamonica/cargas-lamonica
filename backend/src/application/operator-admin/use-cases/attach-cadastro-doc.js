/**
 * Anexar um documento FALTANTE a um cadastro existente + OCR + pré-preencher.
 *
 * Motivação (Samuel): às vezes o motorista fecha o cadastro SEM anexar um
 * documento (ex.: o cadastro do JOSE EDUARDO veio sem os documentos do
 * proprietário dos veículos). Hoje não dá pra "voltar" no wizard sem excluir e
 * refazer. Este use case deixa o OPERADOR anexar o documento faltante pelo
 * editor, extrair os dados por OCR e PRÉ-PREENCHER os campos vazios — o operador
 * revisa e só grava quando clicar em "Salvar".
 *
 * DECISÃO (não-destrutivo, revisão antes de gravar):
 *   - Este endpoint NÃO persiste em `dados`. Ele sobe o arquivo pro Storage,
 *     OCRa, aplica o merge numa CÓPIA em memória do `dados` e RETORNA essa cópia.
 *     O editor re-preenche os campos a partir dela; o `PATCH /dados` do "Salvar"
 *     é quem persiste (sem risco de lost-update — nada é escrito aqui).
 *   - Reusa o motor de merge do reprocess (buildPartial/sanitizePartial/
 *     applyPartial): só campos preenchidos, type-safe, nunca toca placa/*_url/
 *     frota, só chaves do allowlist `.strict()` do schema.
 *   - Identidade do proprietário (`doc`/`tipo`): preenchida a partir do OCR
 *     APENAS quando o owner ainda não tem `doc` (owner faltante) — nunca
 *     sobrescreve a chave de aprovação de um owner já preenchido.
 *
 * Escopo v1: proprietários (CNH/cartão-CNPJ + comprovante do cavalo e carretas)
 * e CRLV (cavalo e carretas). Documentos do motorista ficam pra depois.
 *
 * Retorno:
 *   { notFound } | { invalid: <code> } | { uploadError: <resp> } |
 *   { dados, report, storagePath }   (dados = cópia mesclada, NÃO persistida)
 */

import {
  VALID_DRAFT_SLOTS,
  uploadDraftFile,
} from "../../candidatura/use-cases/upload-draft-file.js";
import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import {
  extractCnhFromMedia,
  extractComprovanteFromMedia,
  extractCrlvFromMedia,
  extractCartaoCnpjFromMedia,
  consultarCnpjSidecar,
} from "../../repom/ocr-sidecar-client.js";
import {
  buildPartial,
  sanitizePartial,
  applyPartial,
  filledKeys,
} from "./reprocess-cadastro-docs.js";

const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");
const MAX_CARRETAS = 2;

function isMissingTableError(err) {
  return Boolean(err) && (err.code === "42P01" || /relation .* does not exist/i.test(err.message || ""));
}

// docKind → extractor do sidecar (mesmo roteamento do reprocess/wizard).
const OCR_BY_KIND = {
  crlv: extractCrlvFromMedia,
  "owner-cnh": extractCnhFromMedia,
  "cartao-cnpj": extractCartaoCnpjFromMedia,
  comprovante: extractComprovanteFromMedia,
};

function carretaIndex(re, target) {
  const m = re.exec(String(target || ""));
  if (!m) return null;
  const i = Number(m[1]);
  return Number.isInteger(i) && i >= 0 && i < MAX_CARRETAS ? i : null;
}

/**
 * Resolve (docKind, target) → { slot canônico, urlPath (onde gravar o *_url),
 * mergeTarget (caminho lógico do merge OCR) }. O SLOT é derivado no servidor —
 * o cliente não escolhe onde o arquivo é escrito. Retorna null p/ combo inválida
 * (fora do escopo v1 = só proprietários + CRLV).
 */
export function resolveWriteTarget(docKind, target) {
  const carretaIdx = carretaIndex(/^carretas\.(\d+)$/, target);
  const carretaOwnerIdx = carretaIndex(/^carreta_owners\.(\d+)$/, target);

  if (docKind === "crlv") {
    if (target === "cavalo") {
      return { slot: "cavalo_crlv", urlPath: ["cavalo", "crlv_url"], mergeTarget: "cavalo" };
    }
    if (carretaIdx !== null) {
      return {
        slot: `carreta_crlv_${carretaIdx}`,
        urlPath: ["carretas", carretaIdx, "crlv_url"],
        mergeTarget: `carretas.${carretaIdx}`,
      };
    }
    return null;
  }

  if (docKind === "owner-cnh" || docKind === "cartao-cnpj") {
    // PF (CNH) e PJ (cartão-CNPJ) usam o MESMO slot de owner-doc.
    if (target === "cavalo_owner") {
      return { slot: "cavalo_owner_cnh", urlPath: ["cavalo_owner", "owner_doc_url"], mergeTarget: "cavalo_owner" };
    }
    if (carretaOwnerIdx !== null) {
      return {
        slot: `carreta_owner_cnh_${carretaOwnerIdx}`,
        urlPath: ["carreta_owners", carretaOwnerIdx, "owner_doc_url"],
        mergeTarget: `carreta_owners.${carretaOwnerIdx}`,
      };
    }
    return null;
  }

  if (docKind === "comprovante") {
    if (target === "cavalo_owner") {
      return {
        slot: "cavalo_owner_comprovante",
        urlPath: ["cavalo_owner", "endereco", "comprovante_storage_path"],
        mergeTarget: "cavalo_owner.endereco",
      };
    }
    if (carretaOwnerIdx !== null) {
      return {
        slot: `carreta_owner_comprovante_${carretaOwnerIdx}`,
        urlPath: ["carreta_owners", carretaOwnerIdx, "endereco", "comprovante_storage_path"],
        mergeTarget: `carreta_owners.${carretaOwnerIdx}.endereco`,
      };
    }
    return null;
  }

  return null;
}

/** Deep-set `value` no `obj` seguindo `path` (cria objetos/arrays intermediários). */
function setDeep(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const nextKey = path[i + 1];
    const wantArray = typeof nextKey === "number";
    if (cur[key] === null || typeof cur[key] !== "object") {
      cur[key] = wantArray ? [] : {};
    }
    cur = cur[key];
  }
  cur[path[path.length - 1]] = value;
}

/** Lê o objeto do owner no `dados` a partir do mergeTarget do owner. */
function ownerAt(dados, target) {
  if (target === "cavalo_owner") return dados?.cavalo_owner;
  const m = /^carreta_owners\.(\d+)$/.exec(String(target || ""));
  if (m) return Array.isArray(dados?.carreta_owners) ? dados.carreta_owners[Number(m[1])] : undefined;
  return undefined;
}

function pickDocFromFields(fields, keys) {
  for (const k of keys) {
    const digits = onlyDigits(fields?.[k]);
    if (digits) return digits;
  }
  return "";
}

function fieldStr(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

/**
 * Mapeia a resposta da consulta receita-federal/cnpj (data[]) para as chaves de
 * campo que o buildOwnerFromCartaoCnpjFields lê. Só devolve o que veio preenchido.
 * Chaves confirmadas por fixture (cadastro-motorista/cadastroApi.test.ts).
 */
function mapCnpjConsultaToFields(data) {
  const row = Array.isArray(data) ? data[0] : null;
  if (!row || typeof row !== "object") return {};
  const out = {};
  const set = (k, ...aliases) => {
    const v = fieldStr(row, ...aliases);
    if (v) out[k] = v;
  };
  set("razao_social", "razao_social", "nome_empresarial", "nome");
  set("cep", "endereco_cep", "cep", "numero_cep", "normalizado_endereco_cep");
  set("uf", "endereco_uf", "uf", "estado");
  set("municipio", "endereco_municipio", "municipio", "cidade", "localidade");
  set("bairro", "endereco_bairro", "bairro");
  set("logradouro", "endereco_logradouro", "logradouro", "endereco");
  set("numero", "endereco_numero", "numero", "numero_endereco");
  return out;
}

// Mantém só caracteres seguros de path (UUID, CPF, id migrado numérico) — nunca
// separadores nem '..'. Barra traversal/clobber vindo de valores inesperados.
const safeSeg = (v) => String(v ?? "").replace(/[^A-Za-z0-9_-]/g, "");

/**
 * Deriva a pasta de storage `{ownerKey}/{cargaId}` SOMENTE de colunas confiáveis
 * da própria linha (CPF do motorista + carga_id/id_cadastro), NUNCA de `*_url` do
 * `dados` — esses são controláveis pelo cliente (o submit aceita qualquer string),
 * e derivar a pasta deles permitiria apagar/sobrescrever docs de OUTRO cadastro no
 * bucket (service_role) ou traversal. ownerKey = CPF (11 díg, esquema do wizard p/
 * anônimo) senão a própria carga; cargaId = carga_id || id_cadastro || id.
 */
function deriveFolder({ cpf, cargaFallback }) {
  const cargaId = safeSeg(cargaFallback);
  if (!cargaId) return null;
  const cpfDigits = onlyDigits(cpf);
  const ownerKey = cpfDigits.length === 11 ? cpfDigits : cargaId;
  return { ownerKey, cargaId };
}

/**
 * Anexa um documento faltante e devolve o `dados` PRÉ-preenchido (não persiste).
 *
 * @param {object} p
 * @param {string} p.id           — id da linha pending_driver_registrations
 * @param {string} p.docKind      — 'crlv' | 'owner-cnh' | 'cartao-cnpj' | 'comprovante'
 * @param {string} p.target       — 'cavalo' | 'carretas.N' | 'cavalo_owner' | 'carreta_owners.N'
 * @param {Buffer} p.file
 * @param {number} p.size
 * @param {string} p.contentType
 * @param {string} [p.originalFilename]
 * @param {string} [p.correlationId]
 * @param {string} [p.operatorId]
 * @param {string} [p.requestIp]
 */
export async function attachCadastroDocument({
  id,
  docKind,
  target,
  file,
  size,
  contentType,
  originalFilename = null,
  correlationId = null,
  operatorId = null,
  requestIp = null,
} = {}) {
  if (!id) return { invalid: "MISSING_ID" };
  if (!Buffer.isBuffer(file)) return { invalid: "MISSING_FILE" };

  const write = resolveWriteTarget(docKind, target);
  if (!write) return { invalid: "BAD_TARGET" };
  // Defense-in-depth: o slot derivado tem que estar na allowlist.
  if (!VALID_DRAFT_SLOTS.has(write.slot)) return { invalid: "BAD_SLOT" };

  // 1) Carrega o cadastro (SELECT curto — OCR roda fora da conexão PG).
  const row = await withPgClient((client) =>
    client
      .query(`SELECT id, id_cadastro, carga_id, dados FROM public.pending_driver_registrations WHERE id = $1`, [id])
      .then((r) => r.rows[0] || null)
      .catch((err) => {
        if (isMissingTableError(err)) return null;
        throw err;
      }),
  );
  if (!row) return { notFound: true };

  // Trabalha numa CÓPIA — nada é persistido aqui.
  const dados = row.dados && typeof row.dados === "object" ? JSON.parse(JSON.stringify(row.dados)) : {};
  const idCadastro = row.id_cadastro || String(id);
  const cargaFallback = row.carga_id || idCadastro;

  // Comprovante de residência só faz sentido num proprietário que JÁ existe (tem
  // doc). Criar um owner só com `endereco` deixaria um proprietário sem tipo/doc/
  // nome (obrigatórios no ownerSchema) → 422 latente no re-submit, e o editor não
  // expõe o `tipo` p/ consertar. Exige anexar antes a CNH/cartão (que preenchem
  // tipo/doc/nome). O backend é a fronteira (a UI pode ou não ofertar o tile).
  if (docKind === "comprovante" && onlyDigits(ownerAt(dados, target)?.doc).length < 11) {
    return { invalid: "OWNER_ABSENT" };
  }

  // 2) Pasta de storage — SÓ de colunas confiáveis da linha (CPF + carga).
  const folder = deriveFolder({ cpf: dados?.motorista?.cpf, cargaFallback });
  if (!folder) return { invalid: "NO_STORAGE_FOLDER" };

  // 3) Upload (service_role, via o mesmo use case do wizard).
  const up = await uploadDraftFile({
    ownerKey: folder.ownerKey,
    cargaId: folder.cargaId,
    slot: write.slot,
    file,
    size,
    contentType,
    originalFilename,
    requestIp,
    correlationId,
  });
  if (up.statusCode !== 200) return { uploadError: up };
  const storagePath = up.payload.storage_path;

  // 4) Grava o *_url na cópia — SEMPRE (anexar o doc é a ação primária; o OCR é bônus).
  setDeep(dados, write.urlPath, storagePath);

  // 5) OCR (best-effort — nunca lança; falha vira relatório).
  const extractor = OCR_BY_KIND[docKind];
  let ocr = { ok: false };
  try {
    ocr = await extractor({ imagemBase64: file.toString("base64"), idCadastro, correlationId });
  } catch (err) {
    ocr = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // 5b) Cartão-CNPJ: se o OCR não trouxe o ENDEREÇO (o sidecar pode não estar
  // enriquecendo), busca os dados AUTORITATIVOS na Receita (consulta Node,
  // observável) usando o CNPJ que o Vision leu, e injeta nos fields. Se a consulta
  // falhar, registra o motivo no relatório (para de silenciar). Ver
  // [[cargas-ocr-cartao-cnpj-vision-receita]].
  let rfNote = null;
  if (docKind === "cartao-cnpj" && ocr.ok && ocr.fields) {
    const jaTemEndereco = !!fieldStr(ocr.fields, "logradouro", "endereco");
    if (!jaTemEndereco) {
      const cnpj = pickDocFromFields(ocr.fields, ["cnpj", "numero_cnpj", "cnpj_numero"]);
      if (cnpj.length === 14) {
        const consulta = await consultarCnpjSidecar({ cnpj, correlationId });
        if (consulta.ok) {
          Object.assign(ocr.fields, mapCnpjConsultaToFields(consulta.data));
          // Confirma que o endereço realmente entrou (consulta pode vir ok mas com
          // data vazia) — senão avisa o operador em vez de silenciar.
          rfNote = fieldStr(ocr.fields, "logradouro", "endereco")
            ? "receita_ok"
            : "Receita respondeu sem endereço — preencha manualmente";
        } else {
          rfNote = `Receita indisponível: ${consulta.codeMessage || consulta.error || "erro desconhecido"}`;
        }
      } else {
        rfNote = "CNPJ não legível para consulta à Receita";
      }
    }
  }

  // 6) Merge não-destrutivo do que o OCR extraiu (na cópia).
  let filled = [];
  if (ocr.ok && ocr.fields) {
    let partial = sanitizePartial(
      { kind: docKind, target: write.mergeTarget },
      buildPartial(docKind, ocr.fields, dados),
      dados,
    );
    // Identidade do proprietário: preenche doc+tipo SÓ quando o owner não tem doc.
    if (docKind === "owner-cnh" || docKind === "cartao-cnpj") {
      const existing = ownerAt(dados, write.mergeTarget);
      const hasDoc = onlyDigits(existing?.doc).length >= 11;
      if (!hasDoc) {
        const isPj = docKind === "cartao-cnpj";
        const doc = isPj
          ? pickDocFromFields(ocr.fields, ["cnpj", "numero_cnpj", "cnpj_numero"])
          : pickDocFromFields(ocr.fields, ["cpf", "numero_cpf", "cpf_numero"]);
        const expectedLen = isPj ? 14 : 11;
        if (doc.length === expectedLen) {
          partial = { ...partial, doc, tipo: isPj ? "pj" : "pf" };
        }
      }
    }
    filled = filledKeys(partial);
    if (filled.length) applyPartial(dados, write.mergeTarget, partial);
  }

  // 7) Auditoria (best-effort) — SEM escrever `dados`.
  try {
    await withPgClient((client) =>
      insertSecurityAuditEvent(client, {
        eventType: "operator.cadastro.attach_doc",
        actorUserId: operatorId,
        actorRole: "operator",
        resourceType: "pending_driver_registration",
        resourceId: id,
        action: "update",
        outcome: "success",
        requestIp,
        correlationId,
        metadata: { docKind, target: write.mergeTarget, slot: write.slot, ocrOk: !!ocr.ok, filled },
      }),
    );
  } catch {
    // auditoria é best-effort.
  }

  // rfNote de falha da consulta à Receita vira a `message` do relatório (o editor
  // mostra), mesmo com o OCR ok — assim o operador vê PORQUE o endereço não veio.
  const rfFailMsg = rfNote && rfNote !== "receita_ok" ? rfNote : null;
  const report = {
    label: `${target}.${docKind}`,
    kind: docKind,
    ok: !!ocr.ok,
    provider: ocr.provider ?? null,
    code: ocr.code ?? null,
    message: rfFailMsg ?? ocr.codeMessage ?? ocr.error ?? null,
    filled,
    storage_path: storagePath,
  };

  logStructuredEvent("info", "operator.attach_doc.done", {
    id, correlationId, docKind, target: write.mergeTarget, ocrOk: !!ocr.ok, filled: filled.length, rf: rfNote,
  });

  return { dados, report, storagePath };
}
