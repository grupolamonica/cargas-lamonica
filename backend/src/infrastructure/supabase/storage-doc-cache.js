/**
 * Micro-cache em processo dos BYTES dos documentos do Storage privado, com
 * single-flight e teto de memória. Compartilhado pelos 3 (únicos) pontos que
 * baixam anexo de cadastro do bucket:
 *   - operator-admin/use-cases/angellira/anexos-stager.js (bot Angellira)
 *   - operator-admin/use-cases/spx/spx-anexos-stager.js   (bot SPX + dossiê)
 *   - operator-admin/use-cases/reprocess-cadastro-docs.js (re-OCR pelo operador)
 *
 * PROBLEMA (egress): cada doc é uma foto de celular de 1,5-4MB (teto de 8MB em
 * upload-draft-file.js) e NADA era reaproveitado — os mesmos bytes saíam do
 * Supabase de novo a cada passo:
 *   - o MESMO `motorista.cnh_url` é estagiado 2x dentro de um único step do
 *     Angellira (anexos.cnh + anexos.rg);
 *   - `cavalo.crlv_url` sai 2x em UM "aprovar" (pipeline Angellira + pipeline SPX
 *     rodam em sequência no mesmo request);
 *   - o preview dry-run do SPX baixa o conjunto inteiro e o disparo real baixa
 *     tudo outra vez;
 *   - "Reprocessar documentos" re-baixa o plano inteiro (3-7 docs) a cada clique.
 * O cache colapsa todas essas repetições dentro da janela do TTL.
 *
 * POR QUE O PATH BASTA COMO CHAVE (sem updated_at/etag): todo write no bucket usa
 * path IMUTÁVEL e datado — upload-draft-file.js grava `${slot}_${timestamp}.${ext}`
 * com `upsert:false` (e REMOVE o arquivo anterior do slot) e generate-dossie.js
 * grava `risk-docs/${cadastroId}/dossie_${Date.now()}.pdf`, também `upsert:false`.
 * São os 2 únicos `storage.upload(...)` do repo. Logo os bytes de um path nunca
 * mudam: identidade == versão. INVARIANTE A PRESERVAR — se algum dia alguém
 * gravar um path ESTÁVEL com `upsert:true`, este cache precisa passar a versionar
 * a chave (updated_at/etag) ou ser desligado para aquele prefixo.
 *
 * SEGURANÇA — O CACHE É EXCLUSIVO DO CLIENTE service_role (invariante ENFORCADO,
 * não documentado-e-torcer): um hit devolve bytes SEM chamar `storage.download()`,
 * então servir uma entrada populada pelo service_role para um cliente anon/usuário
 * (RLS) seria um bypass de autorização silencioso. Por isso a chave NÃO é apenas
 * (bucket, path):
 *   1. o componente de bucket é o `bucketId` DERIVADO do próprio handle
 *      (`client.storage.from(bucket)`), nunca o rótulo que o caller passou — o
 *      rótulo é só validado contra ele (mismatch => não cacheia + warn), porque
 *      o handle já vem bound no bucket e um rótulo errado seria invisível;
 *   2. o caller passa também o CLIENTE (`client`), e a chave carrega a identidade
 *      dele: fingerprint de `supabaseUrl` + `supabaseKey`. Clientes de privilégios
 *      diferentes vivem em partições diferentes — nunca há hit cruzado. (O handle
 *      do storage NÃO serve para isso: no supabase-js instalado ele só carrega
 *      `x-client-info` em `headers` e um wrapper de `fetch` novo a cada `.from()`,
 *      então não expõe nem credencial nem identidade estável.)
 *   3. ASSERÇÃO de privilégio sobre a credencial: JWT com `role` != service_role e
 *      chave `sb_publishable_*` são REJEITADOS (nada de ler nem popular o cache).
 *      JWT service_role e `sb_secret_*` passam; formato desconhecido passa
 *      isolado no seu próprio fingerprint.
 *   4. se a identidade não for derivável (sem `client`, ou handle sem `bucketId`),
 *      NÃO cacheia — degrada para o comportamento de hoje, nunca para um
 *      resultado errado.
 *
 * OUTRAS REGRAS
 *   - Guarda `Buffer` (memória externa, fora do heap V8 — o container é 768m) e
 *     faz `toString("base64")` por hit; o steady-state fica em 1,0x os bytes em
 *     vez de 1,33x.
 *   - NUNCA cacheia erro nem payload vazio: preserva o best-effort de retry dos
 *     3 call sites (um download que falha continua falhando na próxima tentativa).
 *   - Teto de bytes com evicção LRU (não é cache de entradas: um doc vai a 8MB).
 *   - Per-process, como os rate limiters/idempotency in-memory (Known Issues /
 *     DC-95): com 2+ réplicas o hit rate cai, o resultado nunca fica errado.
 *   - Efeito colateral benigno: um objeto deletado do bucket (cleanup-expired-drafts)
 *     ainda pode ser servido do cache por até o TTL — o stager conclui onde antes
 *     logaria `download_failed`.
 *
 * KNOBS (default de produção entre parênteses)
 *   - DRAFT_DOC_CACHE_ENABLED   (true)      false/0/off => kill-switch, volta ao
 *                                           comportamento anterior sem deploy.
 *   - DRAFT_DOC_CACHE_TTL_MS    (600000)    override explícito em ms (vence tudo;
 *                                           é o que habilita os testes).
 *   - DRAFT_DOC_CACHE_TTL_SECONDS (600)     mesmo knob em segundos (ops).
 *   - DRAFT_DOC_CACHE_MAX_BYTES (50331648)  48MB ~= 2 cadastros; teto rígido 96MB.
 *
 * Precedentes seguidos: application/load-claims/auth.js (getTokenVerifyTtlMs +
 * cache/single-flight de token) e operator-admin/use-cases/dashboard-read-model.js
 * (cache das facets: TTL por env, override explícito vence, OFF em teste, só
 * cacheia sucesso).
 */

import { createHash } from "node:crypto";

import { logStructuredEvent } from "../security-log.js";

const DEFAULT_TTL_MS = 600_000; // 10 min: cobre preview -> aprovar -> retry
const DEFAULT_MAX_BYTES = 48 * 1024 * 1024;
// Teto rígido: o container do backend é mem_limit 768m e o base64 transitório de
// um doc de 8MB já custa ~11MB por download concorrente.
const HARD_MAX_BYTES = 96 * 1024 * 1024;

const _entries = new Map(); // cacheKey -> { at, buf }  (ordem = recência, LRU)
const _inFlight = new Map(); // cacheKey -> Promise<internalResult>
const _clientScopes = new WeakMap(); // cliente supabase -> scopeId | null

let _syntheticScopeSeq = 0;

let _bytesHeld = 0;
let _hits = 0;
let _misses = 0;
let _evictions = 0;

function envDisabled() {
  const raw = String(process.env.DRAFT_DOC_CACHE_ENABLED ?? "").trim().toLowerCase();
  return raw === "false" || raw === "0" || raw === "off" || raw === "no";
}

/** TTL efetivo em ms. 0 = cache desligado (passthrough puro). */
export function getStorageDocCacheTtlMs() {
  if (envDisabled()) return 0; // kill-switch de produção
  const rawMs = Number.parseInt(process.env.DRAFT_DOC_CACHE_TTL_MS ?? "", 10);
  if (Number.isFinite(rawMs) && rawMs >= 0) return rawMs; // override explícito vence (habilita teste)
  const rawSeconds = Number.parseInt(process.env.DRAFT_DOC_CACHE_TTL_SECONDS ?? "", 10);
  if (Number.isFinite(rawSeconds) && rawSeconds >= 0) return rawSeconds * 1000;
  if (process.env.VITEST || process.env.NODE_ENV === "test") return 0; // default OFF em teste
  return DEFAULT_TTL_MS;
}

function getMaxBytes() {
  const raw = Number.parseInt(process.env.DRAFT_DOC_CACHE_MAX_BYTES ?? "", 10);
  if (Number.isFinite(raw) && raw >= 0) return Math.min(raw, HARD_MAX_BYTES);
  return DEFAULT_MAX_BYTES;
}

/**
 * Classifica a credencial do cliente: true = service_role, false = privilégio de
 * RLS (proibido cachear), null = formato desconhecido (isola pelo fingerprint).
 */
function isServiceRoleCredential(credential) {
  const raw = String(credential || "").trim();
  if (!raw) return null;
  if (raw.startsWith("sb_secret_")) return true; // chave secreta (formato novo)
  if (raw.startsWith("sb_publishable_")) return false; // chave pública (formato novo)
  const parts = raw.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (typeof payload?.role === "string") return payload.role === "service_role";
    } catch {
      return null;
    }
  }
  return null;
}

function computeClientScope(client) {
  const credential = typeof client.supabaseKey === "string" ? client.supabaseKey.trim() : "";
  if (credential) {
    if (isServiceRoleCredential(credential) === false) {
      // Cliente com RLS (anon/publishable): não pode ler nem popular o cache.
      logStructuredEvent("warn", "storage.doc_cache.non_service_role_client", {});
      return null;
    }
    const url = typeof client.supabaseUrl === "string" ? client.supabaseUrl.trim() : "";
    return `fp:${createHash("sha256").update(`${url}\n${credential}`).digest("hex").slice(0, 32)}`;
  }
  // Cliente sem credencial visível (fake de teste, ou versão do supabase-js que
  // passe a esconder supabaseKey): cai na IDENTIDADE do objeto — cada cliente na
  // sua partição, nunca compartilhada. Nunca serve bytes de outro cliente.
  _syntheticScopeSeq += 1;
  return `obj:${_syntheticScopeSeq}`;
}

/** Scope memoizado por cliente (a credencial de um cliente não muda). */
function clientScopeOf(client) {
  if (!client || typeof client !== "object") return null;
  if (_clientScopes.has(client)) return _clientScopes.get(client);
  const scope = computeClientScope(client);
  _clientScopes.set(client, scope);
  return scope;
}

/**
 * Chave do cache, ou null quando NÃO se pode cachear com segurança.
 * Bucket vem do handle (o rótulo do caller é apenas conferido) e o privilégio
 * vem do cliente.
 */
function resolveCacheKey(client, storage, bucketLabel, cleanPath) {
  if (!storage || typeof storage !== "object") return null;

  const bucketId = typeof storage.bucketId === "string" ? storage.bucketId.trim() : "";
  if (!bucketId) return null; // handle sem identidade de bucket → sem cache

  const label = typeof bucketLabel === "string" ? bucketLabel.trim() : "";
  if (label && label !== bucketId) {
    logStructuredEvent("warn", "storage.doc_cache.bucket_mismatch", { bucket: label, bucketId });
    return null; // rótulo divergente do handle → fail-closed
  }

  const scope = clientScopeOf(client);
  if (!scope) return null;

  return `${scope}::${bucketId}::${cleanPath}`;
}

/**
 * União dos 3 decoders que existiam nos call sites: Blob (supabase-js real),
 * Buffer cru (é assim que reprocess-cadastro-docs.test.js mocka o download),
 * ArrayBuffer e array-like (Uint8Array).
 */
async function toBuffer(downloadData) {
  if (downloadData && typeof downloadData.arrayBuffer === "function") {
    return Buffer.from(await downloadData.arrayBuffer());
  }
  if (Buffer.isBuffer(downloadData)) return downloadData;
  if (downloadData instanceof ArrayBuffer) return Buffer.from(downloadData);
  return Buffer.from(downloadData);
}

function dropEntry(key) {
  const entry = _entries.get(key);
  if (!entry) return;
  _entries.delete(key);
  _bytesHeld -= entry.buf.byteLength;
  if (_bytesHeld < 0) _bytesHeld = 0;
}

/** Insere respeitando o teto de bytes (evicção LRU pela frente do Map). */
function storeEntry(key, buf) {
  const size = buf.byteLength;
  const maxBytes = getMaxBytes();
  if (size <= 0 || size > maxBytes) return; // doc maior que o teto nunca entra
  dropEntry(key);
  while (_bytesHeld + size > maxBytes && _entries.size > 0) {
    dropEntry(_entries.keys().next().value);
    _evictions += 1;
  }
  if (_bytesHeld + size > maxBytes) return;
  _entries.set(key, { at: Date.now(), buf });
  _bytesHeld += size;
}

/** Download cru + decode. NÃO captura exceção: o call site já loga a dele. */
async function downloadFresh(storage, cleanPath) {
  const { data, error } = await storage.download(cleanPath);
  if (error || !data) {
    return { buf: null, base64: null, error: error || null, failed: true };
  }
  const buf = await toBuffer(data);
  return { buf, base64: buf.toString("base64"), error: null, failed: false };
}

function publicResult(result, cached) {
  return { base64: result.base64, error: result.error, failed: result.failed, cached };
}

/**
 * Baixa (ou reaproveita do cache) os bytes de um doc do Storage e devolve base64.
 *
 * @param {object} args
 * @param {object} args.client    cliente supabase que originou o handle (service_role);
 *                                é dele que sai a partição do cache. Sem ele: sem cache.
 * @param {object} args.storage   handle já em `.from(bucket)` desse cliente
 * @param {string} args.bucket    rótulo do bucket (só validado contra o handle)
 * @param {string} args.path      path JÁ sem o prefixo `<bucket>/` (o caller strippa)
 * @param {number} [args.ttlMs]   override do TTL (testes); default = env
 * @returns {Promise<{base64:string|null, error:any|null, failed:boolean, cached:boolean}>}
 *   failed=true  → download falhou/veio vazio (o caller loga download_failed)
 *   base64===""  → baixou mas decodificou vazio (o caller loga empty_after_decode)
 */
export async function downloadDocBase64Cached({ client, storage, bucket, path, ttlMs } = {}) {
  const cleanPath = String(path || "").trim();
  if (!cleanPath) return { base64: null, error: null, failed: true, cached: false };

  const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : getStorageDocCacheTtlMs();
  const key = ttl > 0 ? resolveCacheKey(client, storage, bucket, cleanPath) : null;
  if (!key) {
    // Cache off, ou identidade do cliente não verificável → comportamento de hoje.
    return publicResult(await downloadFresh(storage, cleanPath), false);
  }

  const hit = _entries.get(key);
  if (hit && Date.now() - hit.at < ttl) {
    _entries.delete(key);
    _entries.set(key, hit); // LRU: refresca a recência (não o `at` do TTL)
    _hits += 1;
    return { base64: hit.buf.toString("base64"), error: null, failed: false, cached: true };
  }
  if (hit) dropEntry(key); // expirado

  // Single-flight: a leva de 6 docs em paralelo do reprocess (ou o mesmo doc
  // planejado 2x) não pode virar 2 downloads do mesmo path.
  const inFlight = _inFlight.get(key);
  if (inFlight) {
    _hits += 1;
    return publicResult(await inFlight, true);
  }

  const promise = downloadFresh(storage, cleanPath);
  _inFlight.set(key, promise);
  try {
    const result = await promise;
    _misses += 1;
    // Só cacheia bytes REAIS: erro/vazio nunca gruda (best-effort preservado).
    if (!result.failed && result.buf && result.buf.byteLength > 0) {
      storeEntry(key, result.buf);
    }
    return publicResult(result, false);
  } finally {
    _inFlight.delete(key);
  }
}

/**
 * Hook de teste: zera o estado de módulo (evita bleed entre casos).
 * `_syntheticScopeSeq` NÃO é zerado de propósito: o WeakMap de scopes sobrevive
 * ao reset, então reciclar ids faria dois clientes distintos colidirem.
 */
export function __resetStorageDocCache() {
  _entries.clear();
  _inFlight.clear();
  _bytesHeld = 0;
  _hits = 0;
  _misses = 0;
  _evictions = 0;
}

/** Observabilidade (hit rate do cache de bytes). */
export function getStorageDocCacheStats() {
  return {
    hits: _hits,
    misses: _misses,
    evictions: _evictions,
    entries: _entries.size,
    bytesHeld: _bytesHeld,
    inFlight: _inFlight.size,
  };
}
