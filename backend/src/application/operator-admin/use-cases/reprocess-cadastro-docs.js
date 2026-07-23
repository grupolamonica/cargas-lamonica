/**
 * Reprocessar documentos de um cadastro pendente (re-OCR pelo operador).
 *
 * Motivação (Samuel): quando um dado veio errado/vazio da extração automática
 * (ex.: CPF não lido, marca/modelo trocados), o operador clica em "Reprocessar
 * documentos" e o backend re-extrai os documentos JÁ enviados e mescla o
 * resultado de volta no `dados`:
 *   - CNH / CRLV / cartão CNPJ / comprovante → sidecar OCR (Infosimples p/
 *     CNH/CRLV, OpenAI Vision p/ cartão-CNPJ/comprovante), reusando o mesmo
 *     motor e mapeamento do wizard e do Repom.
 *
 * CUIDADO (não quebrar):
 *   - Merge NÃO-DESTRUTIVO: só sobrescreve campos que o OCR devolveu preenchidos.
 *     Campos de IDENTIDADE/roteamento (placa, owner_doc, owner_doc_type, doc,
 *     tipo, *_url, *_storage_path, frota) NUNCA são tocados — o operador corrige
 *     esses no editor de campos, e re-extrair placa/documento errado seria
 *     catastrófico (é a chave do Angellira/aprovação).
 *   - Type-safe: `ano`/`ano_fabricacao`/`eixos` só entram como inteiro no range
 *     do schema; UF só com 2 letras. Evita introduzir tipo inconsistente no JSONB.
 *   - Best-effort por documento: download/OCR que falhe NÃO derruba os outros
 *     nem apaga nada — vira uma linha "falhou" no relatório.
 *   - OCR roda FORA da conexão PG (só SELECT curto + UPDATE curto seguram o pool);
 *     as chamadas ao sidecar (~até 45s cada) rodam em paralelo limitado.
 *
 * Retorno: { notFound } | { dados, report, changed }.
 */

import { DRAFT_FILE_BUCKET } from "../../candidatura/use-cases/upload-draft-file.js";
import { getAdminClient } from "../../load-claims/auth.js";
import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import {
  extractCnhFromMedia,
  extractComprovanteFromMedia,
  extractCrlvFromMedia,
  extractCartaoCnpjFromMedia,
} from "../../repom/ocr-sidecar-client.js";
import {
  buildMotoristaFromCnhFields,
  buildEnderecoFromComprovanteFields,
} from "../../repom/cnh-registration.js";

const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");

function isMissingTableError(err) {
  return Boolean(err) && (err.code === "42P01" || /relation .* does not exist/i.test(err.message || ""));
}

// Máximo de documentos re-processados em paralelo. O sidecar leva ~10-45s por
// doc; a maioria dos cadastros tem 3-5 docs (CNH+comprovante+CRLV+owners), então
// 6 mantém tudo em UMA leva (~1 chamada de wall-clock) sem martelar a Infosimples.
const CONCURRENCY = 6;

// ───────────────────── Mapeadores OCR→schema (CRLV / cartão CNPJ) ─────────────
// Espelham o `cadastroApi.ts` do wizard (chaves canônicas do veiculoCoreSchema/
// ownerSchema) e só devolvem o que veio preenchido e com tipo válido.

function pickFrom(fields) {
  return (...keys) => {
    for (const k of keys) {
      const v = fields?.[k];
      if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
    }
    return "";
  };
}

function splitLocal(texto) {
  const s = String(texto || "").trim();
  if (!s) return { cidade: "", uf: "" };
  const m = s.match(/^(.+?)[\s\-/,]+([A-Za-z]{2})\s*$/);
  if (m) return { cidade: m[1].trim(), uf: m[2].trim().toUpperCase() };
  return { cidade: s, uf: "" };
}

function splitMarcaModelo(texto) {
  const s = String(texto || "").trim();
  const idx = s.indexOf("/");
  if (idx > 0) return { marca: s.slice(0, idx).trim(), modelo: s.slice(idx + 1).trim() };
  return { marca: s, modelo: "" };
}

/** Inteiro no range [min,max] (dígitos apenas) ou null (não seta). */
function toIntInRange(raw, min, max) {
  const n = Number.parseInt(onlyDigits(raw), 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/**
 * CRLV (flatten) → campos do veículo (cavalo/carreta). Espelha o `ocrCrlv` do
 * wizard, mapeando para as chaves do veiculoCoreSchema. NUNCA inclui placa,
 * owner_doc(_type), crlv_url, frota (identidade/roteamento).
 */
export function buildVeiculoFromCrlvFields(fields) {
  const v = pickFrom(fields);
  const out = {};
  const set = (k, val) => {
    if (val !== null && val !== undefined && val !== "") out[k] = val;
  };

  const mm = splitMarcaModelo(v("marca_modelo_versao", "marca_modelo"));
  set("marca", mm.marca || v("marca", "veiculo_marca"));
  set("modelo", mm.modelo || v("modelo"));
  set("tipo", v("especie_tipo", "especie", "tipo", "tipo_veiculo"));
  set("carroceria", v("carroceria", "tipo_carroceria"));
  set("cor", v("cor_predominante", "cor", "cor_veiculo"));
  set("renavam", v("renavam"));
  set("chassi", v("chassi"));
  set("antt", v("antt", "rntrc", "numero_antt", "numero_rntrc", "registro_rntrc", "rntrc_numero", "antt_rntrc", "registro_antt"));
  set(
    "ultimo_licenciamento",
    v("preencher_campo_data", "data_assinatura", "data_licenciamento", "data_ultimo_licenciamento", "assinatura_data", "data_licenciamento_crlv", "data", "data_emissao", "ultimo_licenciamento"),
  );

  const anoModelo = toIntInRange(v("ano_modelo", "ano_modelo_veiculo"), 1950, 2100);
  if (anoModelo !== null) out.ano = anoModelo; // schema `ano` = ano-modelo
  const anoFab = toIntInRange(v("ano_fabricacao", "ano_fabricacao_veiculo"), 1950, 2100);
  if (anoFab !== null) out.ano_fabricacao = anoFab;
  const eixos = toIntInRange(v("eixos", "quantidade_eixos", "numero_eixos"), 2, 9);
  if (eixos !== null) out.eixos = eixos;

  const local = splitLocal(v("local", "municipio_uf", "local_emplacamento", "cidade_uf", "municipio_emplacamento"));
  const uf = local.uf || v("uf_emplacamento", "uf");
  if (/^[A-Za-z]{2}$/.test(uf)) out.uf_emplacamento = uf.toUpperCase();
  set("cidade_emplacamento", local.cidade || v("municipio", "cidade_emplacamento", "cidade"));

  return out;
}

/**
 * Cartão CNPJ (flatten) → campos do proprietário PJ. Espelha o `ocrCartaoCnpj`
 * do wizard. Só devolve `nome` (razão social) + `endereco` (parcial ok). NUNCA
 * toca doc/tipo/owner_doc_url.
 */
export function buildOwnerFromCartaoCnpjFields(fields) {
  const v = pickFrom(fields);
  const out = {};
  const razao = v("razao_social", "nome_empresarial", "nome");
  if (razao) out.nome = razao;

  const endereco = {};
  const setE = (k, val) => {
    if (val) endereco[k] = val;
  };
  setE("cep", v("cep", "numero_cep"));
  const uf = v("uf");
  if (/^[A-Za-z]{2}$/.test(uf)) endereco.uf = uf.toUpperCase();
  setE("cidade", v("municipio", "cidade"));
  setE("bairro", v("bairro"));
  setE("logradouro", v("logradouro", "endereco"));
  setE("numero", v("numero", "numero_endereco"));
  if (Object.keys(endereco).length) out.endereco = endereco;

  return out;
}

/**
 * CNH (flatten) → campos PESSOAIS do proprietário PF. Reusa o mapeador do Repom
 * e remove `cpf`/`data_nascimento` (o ownerSchema usa `doc` e não tem
 * data_nascimento). Mantém nome/filiacao/naturalidade/rg + bloco `cnh`.
 */
export function buildOwnerFromCnhFields(fields) {
  const person = buildMotoristaFromCnhFields(fields, { cpf: "" });
  delete person.cpf; // owner tem `doc`, não `cpf`
  delete person.data_nascimento; // ownerSchema (strict) não possui esse campo
  return person;
}

// ───────────────────── Plano de documentos ───────────────────────────────────

/**
 * Enumera os documentos presentes no `dados` e para cada um resolve
 * { label, kind, target, storagePath }.
 *   kind: 'cnh' | 'comprovante' | 'crlv' | 'cartao-cnpj' | 'owner-cnh'
 *   target: caminho lógico da entidade ('motorista', 'motorista.endereco',
 *           'cavalo', 'carretas.0', 'cavalo_owner', 'carreta_owners.1')
 */
export function buildDocPlan(dados) {
  const plan = [];
  const push = (label, kind, target, storagePath) => {
    if (storagePath && typeof storagePath === "string" && storagePath.trim()) {
      plan.push({ label, kind, target, storagePath: storagePath.trim() });
    }
  };

  const m = dados?.motorista || {};
  push("motorista.cnh", "cnh", "motorista", m.cnh_url);
  push("motorista.comprovante", "comprovante", "motorista.endereco", m.comprovante_url);

  const cavalo = dados?.cavalo || {};
  push("cavalo.crlv", "crlv", "cavalo", cavalo.crlv_url);

  const carretas = Array.isArray(dados?.carretas) ? dados.carretas : [];
  carretas.forEach((c, i) => push(`carretas[${i}].crlv`, "crlv", `carretas.${i}`, c?.crlv_url));

  const ownerDoc = (owner, target, labelBase) => {
    if (!owner || !owner.owner_doc_url) return;
    const isPJ = owner.tipo === "pj" || onlyDigits(owner.doc).length === 14;
    if (isPJ) push(`${labelBase}.cartao_cnpj`, "cartao-cnpj", target, owner.owner_doc_url);
    else push(`${labelBase}.cnh`, "owner-cnh", target, owner.owner_doc_url);
  };
  ownerDoc(dados?.cavalo_owner, "cavalo_owner", "cavalo_owner");
  const carretaOwners = Array.isArray(dados?.carreta_owners) ? dados.carreta_owners : [];
  carretaOwners.forEach((o, i) => ownerDoc(o, `carreta_owners.${i}`, `carreta_owners[${i}]`));

  return plan;
}

// ───────────────────── Extração + merge ──────────────────────────────────────

async function runExtractor(kind, { imagemBase64, idCadastro, correlationId }) {
  switch (kind) {
    case "cnh":
    case "owner-cnh":
      return extractCnhFromMedia({ imagemBase64, idCadastro, correlationId });
    case "comprovante":
      return extractComprovanteFromMedia({ imagemBase64, idCadastro, correlationId });
    case "crlv":
      return extractCrlvFromMedia({ imagemBase64, idCadastro, correlationId });
    case "cartao-cnpj":
      return extractCartaoCnpjFromMedia({ imagemBase64, idCadastro, correlationId });
    default:
      return { ok: false, error: "UNKNOWN_KIND" };
  }
}

/** Monta o `partial` (só campos preenchidos, type-safe, sem chaves protegidas). */
function buildPartial(kind, fields, dados) {
  switch (kind) {
    case "cnh": {
      // Preserva o CPF da sessão; só extrai da CNH se o cadastro estiver sem CPF.
      const existingCpf = onlyDigits(dados?.motorista?.cpf);
      const partial = buildMotoristaFromCnhFields(fields, { cpf: existingCpf });
      if (!existingCpf) {
        const ocrCpf = onlyDigits(pickFrom(fields)("cpf", "numero_cpf"));
        if (ocrCpf.length === 11) partial.cpf = ocrCpf;
        else delete partial.cpf; // não grava CPF vazio
      }
      return partial;
    }
    case "owner-cnh":
      return buildOwnerFromCnhFields(fields);
    case "comprovante":
      return buildEnderecoFromComprovanteFields(fields);
    case "crlv":
      return buildVeiculoFromCrlvFields(fields);
    case "cartao-cnpj":
      return buildOwnerFromCartaoCnpjFields(fields);
    default:
      return {};
  }
}

/** Merge raso com 1 nível de profundidade p/ objetos (cnh, endereco). */
function deepMergePartial(existing, partial) {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const result = { ...base };
  for (const [k, val] of Object.entries(partial)) {
    if (
      val && typeof val === "object" && !Array.isArray(val) &&
      result[k] && typeof result[k] === "object" && !Array.isArray(result[k])
    ) {
      result[k] = { ...result[k], ...val };
    } else {
      result[k] = val;
    }
  }
  return result;
}

/** Aplica o `partial` no `dados` no caminho `target` (muta `dados`). */
function applyPartial(dados, target, partial) {
  if (target === "motorista") {
    dados.motorista = deepMergePartial(dados.motorista, partial);
    return;
  }
  if (target === "motorista.endereco") {
    dados.motorista = dados.motorista && typeof dados.motorista === "object" ? dados.motorista : {};
    dados.motorista.endereco = deepMergePartial(dados.motorista.endereco, partial);
    return;
  }
  if (target === "cavalo") {
    dados.cavalo = deepMergePartial(dados.cavalo, partial);
    return;
  }
  if (target === "cavalo_owner") {
    dados.cavalo_owner = deepMergePartial(dados.cavalo_owner, partial);
    return;
  }
  const carretaMatch = target.match(/^carretas\.(\d+)$/);
  if (carretaMatch) {
    const i = Number(carretaMatch[1]);
    if (!Array.isArray(dados.carretas)) dados.carretas = [];
    dados.carretas[i] = deepMergePartial(dados.carretas[i], partial);
    return;
  }
  const ownerMatch = target.match(/^carreta_owners\.(\d+)$/);
  if (ownerMatch) {
    const i = Number(ownerMatch[1]);
    if (!Array.isArray(dados.carreta_owners)) dados.carreta_owners = [];
    dados.carreta_owners[i] = deepMergePartial(dados.carreta_owners[i], partial);
  }
}

// ── Sanitização type-safe (invariante 2) ─────────────────────────────────────
// O reprocess persiste no JSONB SEM re-validar pelo candidaturaSubmitSchema
// (.strict()), então o merge NÃO pode gravar valor fora do range do schema —
// senão corrompe um campo antes válido e trava o re-submit (422). Os builders
// já guardam alguns campos; aqui garantimos cep/uf/rg_uf em TODOS os caminhos.

const ufOk = (v) => /^[A-Za-z]{2}$/.test(String(v ?? "").trim());
// enderecoSchema.cep = min(8) max(9): aceita "12345678" e "12345-678".
const cepOk = (v) => /^\d{5}-?\d{3}$/.test(String(v ?? "").trim());

/**
 * Limpa um objeto endereco extraído: descarta cep/uf com formato inválido.
 * Se o endereco de destino NÃO existia (owner PJ sem endereco é válido —
 * optional no ownerSchema), só devolve algo quando o endereco novo está
 * COMPLETO (cep+logradouro+numero, obrigatórios no enderecoSchema); caso
 * contrário devolve null (não cria um endereco parcial inválido). Endereco já
 * existente recebe só os subcampos válidos (merge não-destrutivo).
 */
function sanitizeEndereco(endereco, existingEndereco) {
  const e = { ...endereco };
  if (e.cep !== undefined && !cepOk(e.cep)) delete e.cep;
  if (e.uf !== undefined && !ufOk(e.uf)) delete e.uf;
  const hasExisting =
    existingEndereco && typeof existingEndereco === "object" && Object.keys(existingEndereco).length > 0;
  if (!hasExisting && !(e.cep && e.logradouro && e.numero)) return null;
  return e;
}

/** Objeto existente no `dados` no caminho `target` (p/ decidir merge vs criação). */
function getEntityAt(dados, target) {
  if (target === "motorista") return dados?.motorista;
  if (target === "motorista.endereco") return dados?.motorista?.endereco;
  if (target === "cavalo") return dados?.cavalo;
  if (target === "cavalo_owner") return dados?.cavalo_owner;
  const cm = target.match(/^carretas\.(\d+)$/);
  if (cm) return Array.isArray(dados?.carretas) ? dados.carretas[Number(cm[1])] : undefined;
  const om = target.match(/^carreta_owners\.(\d+)$/);
  if (om) return Array.isArray(dados?.carreta_owners) ? dados.carreta_owners[Number(om[1])] : undefined;
  return undefined;
}

/**
 * Sanitiza o `partial` contra as restrições do schema, avaliando o estado
 * ATUAL de `dados` (para a regra de criação de endereco). Devolve um novo objeto.
 */
function sanitizePartial(doc, partial, dados) {
  const p = { ...partial };
  // rg_uf (motoristaSchema/ownerSchema .length(2)).
  if (p.rg_uf !== undefined && !ufOk(p.rg_uf)) delete p.rg_uf;

  if (doc.kind === "comprovante") {
    // O partial É o endereco (target motorista.endereco).
    const clean = sanitizeEndereco(p, getEntityAt(dados, doc.target));
    return clean || {};
  }
  if (p.endereco && typeof p.endereco === "object") {
    // Owner (cartão CNPJ) — endereco aninhado.
    const owner = getEntityAt(dados, doc.target);
    const cleanEnd = sanitizeEndereco(p.endereco, owner?.endereco);
    if (cleanEnd) p.endereco = cleanEnd;
    else delete p.endereco;
  }
  return p;
}

/** Lista de chaves preenchidas (para o relatório), achatando 1 nível. */
function filledKeys(partial) {
  const keys = [];
  for (const [k, val] of Object.entries(partial)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      for (const nk of Object.keys(val)) keys.push(`${k}.${nk}`);
    } else {
      keys.push(k);
    }
  }
  return keys;
}

/** Baixa os bytes do bucket cadastro-drafts e devolve base64 (ou null). */
async function downloadDocBase64(storage, storagePath, { label, correlationId }) {
  const prefix = `${DRAFT_FILE_BUCKET}/`;
  const p = String(storagePath || "").trim().replace(/^\/+/, "");
  const cleanPath = p.startsWith(prefix) ? p.slice(prefix.length) : p;
  if (!cleanPath) return null;
  try {
    const { data, error } = await storage.download(cleanPath);
    if (error || !data) {
      logStructuredEvent("warn", "operator.reprocess.download_failed", {
        label, correlationId: correlationId ?? null, path: cleanPath, message: error?.message || "vazio",
      });
      return null;
    }
    if (typeof data.arrayBuffer === "function") {
      return Buffer.from(await data.arrayBuffer()).toString("base64");
    }
    return Buffer.from(data).toString("base64");
  } catch (err) {
    logStructuredEvent("warn", "operator.reprocess.download_exception", {
      label, correlationId: correlationId ?? null, message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Executa `fn` sobre `items` com no máximo `limit` em paralelo (ordem preservada). */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Reprocessa os documentos de um cadastro pendente.
 * @param {object} p
 * @param {string} p.id            — id da linha pending_driver_registrations
 * @param {string} [p.correlationId]
 * @param {string} [p.operatorId]  — para a auditoria
 * @param {string} [p.requestIp]   — para a auditoria
 * @returns {Promise<{notFound:true} | {dados:object, report:Array, changed:boolean}>}
 */
export async function reprocessCadastroDocuments({ id, correlationId = null, operatorId = null, requestIp = null } = {}) {
  // 1) Carrega o cadastro (SELECT curto — sem segurar conexão durante o OCR).
  const row = await withPgClient((client) =>
    client
      .query(`SELECT id, id_cadastro, dados, status FROM public.pending_driver_registrations WHERE id = $1`, [id])
      .then((r) => r.rows[0] || null)
      .catch((err) => {
        if (isMissingTableError(err)) return null;
        throw err;
      }),
  );
  if (!row) return { notFound: true };

  // Snapshot só para PLANEJAR quais docs reprocessar. O merge NÃO é feito aqui:
  // acontece sobre o estado FRESCO, relido no momento da escrita (passo 4/5).
  const snapshot = row.dados && typeof row.dados === "object" ? row.dados : {};
  const idCadastro = row.id_cadastro || String(id);

  const plan = buildDocPlan(snapshot);
  if (!plan.length) return { dados: snapshot, report: [], changed: false };

  // 2) Storage client (service_role). Sem ele (env ausente) → tudo falha suave.
  let storage = null;
  try {
    storage = getAdminClient().storage.from(DRAFT_FILE_BUCKET);
  } catch (err) {
    logStructuredEvent("warn", "operator.reprocess.storage_unavailable", {
      correlationId, message: err instanceof Error ? err.message : String(err),
    });
  }

  // 3) Download + OCR em paralelo limitado (FORA da conexão PG). Só coleta a
  //    extração crua — o merge acontece no passo 4/5 sobre o dados fresco.
  const extractions = await mapWithConcurrency(plan, CONCURRENCY, async (doc) => {
    if (!storage) return { doc, ok: false, error: "STORAGE_UNAVAILABLE" };
    const imagemBase64 = await downloadDocBase64(storage, doc.storagePath, { label: doc.label, correlationId });
    if (!imagemBase64) return { doc, ok: false, error: "DOWNLOAD_FAILED" };
    const res = await runExtractor(doc.kind, { imagemBase64, idCadastro, correlationId });
    return { doc, ...res };
  });

  // 4+5) RELÊ o `dados` ATUAL, mescla e persiste — tudo numa conexão só (sem OCR
  //   no meio → janela sub-ms, como o resto do read-modify-write do operador).
  //   Reler fresco evita LOST UPDATE: uma edição concorrente feita durante os
  //   ~45s de OCR (ex.: operador corrige a placa noutra aba, ou o marcador de
  //   não conformidade) é PRESERVADA, porque o merge é não-destrutivo sobre o
  //   estado atual — em vez de reescrever o snapshot inteiro lido antes do OCR.
  const outcome = await withPgClient(async (client) => {
    const fresh = await client
      .query(`SELECT dados FROM public.pending_driver_registrations WHERE id = $1`, [id])
      .then((r) => r.rows[0] || null);
    if (!fresh) return { notFound: true };
    const dados = fresh.dados && typeof fresh.dados === "object" ? fresh.dados : {};

    const report = [];
    let changed = false;
    for (const res of extractions) {
      const { doc } = res;
      if (!res.ok || !res.fields) {
        report.push({
          label: doc.label, kind: doc.kind, ok: false,
          code: res.code ?? null, message: res.codeMessage ?? res.error ?? null, filled: [],
        });
        continue;
      }
      const partial = sanitizePartial(doc, buildPartial(doc.kind, res.fields, dados), dados);
      const filled = filledKeys(partial);
      if (filled.length) {
        applyPartial(dados, doc.target, partial);
        changed = true;
      }
      report.push({ label: doc.label, kind: doc.kind, ok: true, provider: res.provider ?? null, filled });
    }

    if (changed) {
      await client.query(
        `UPDATE public.pending_driver_registrations SET dados = $1::jsonb, updated_at = now() WHERE id = $2`,
        [JSON.stringify(dados), id],
      );
    }
    try {
      await insertSecurityAuditEvent(client, {
        eventType: "operator.cadastro.reprocess_docs",
        actorUserId: operatorId,
        actorRole: "operator",
        resourceType: "pending_driver_registration",
        resourceId: id,
        action: "update",
        outcome: "success",
        requestIp,
        correlationId,
        metadata: { changed, docs: report.map((r) => ({ label: r.label, ok: r.ok, filled: r.filled })) },
      });
    } catch {
      // auditoria é best-effort — não derruba o reprocessamento.
    }
    return { dados, report, changed };
  });

  if (outcome.notFound) return { notFound: true };

  logStructuredEvent("info", "operator.reprocess.done", {
    id, correlationId, changed: outcome.changed, docs: outcome.report.length,
    ok: outcome.report.filter((r) => r.ok).length,
  });

  return outcome;
}
