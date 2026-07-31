import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../security-log.js", () => ({ logStructuredEvent: vi.fn() }));

import { logStructuredEvent } from "../security-log.js";
import {
  __resetStorageDocCache,
  downloadDocBase64Cached,
  getStorageDocCacheStats,
  getStorageDocCacheTtlMs,
} from "./storage-doc-cache.js";

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const jwtWithRole = (role) => `hdr.${b64url({ role })}.sig`;
const SERVICE_ROLE_JWT = jwtWithRole("service_role");
const ANON_JWT = jwtWithRole("anon");

/**
 * Fake equivalente ao par (SupabaseClient, StorageFileApi) reais do supabase-js:
 *   - o CLIENTE expõe `supabaseUrl`/`supabaseKey` (privilégio + partição);
 *   - o HANDLE (`client.storage.from(bucket)`) expõe `bucketId` e é uma INSTÂNCIA
 *     NOVA a cada `.from()` — como no supabase-js de verdade.
 */
function makeClient({
  key = SERVICE_ROLE_JWT,
  supabaseUrl = "https://proj.supabase.co",
  bytesByPath = {},
  failPaths = new Set(),
  defaultBytes = "FAKEBYTES",
  raw = false, // devolve Buffer cru em vez de Blob-like
  delayMs = 0,
  omitBucketId = false,
} = {}) {
  const download = vi.fn(async (path) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (failPaths.has(path)) return { data: null, error: { message: "not found" } };
    const buf = Buffer.from(bytesByPath[path] ?? defaultBytes);
    if (raw) return { data: buf, error: null };
    return {
      data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) },
      error: null,
    };
  });
  const from = vi.fn((bucketId) => ({
    url: `${supabaseUrl}/storage/v1`,
    headers: { "x-client-info": "supabase-js/2" }, // o handle real NÃO carrega credencial
    ...(omitBucketId ? {} : { bucketId }),
    download,
  }));
  const client = { supabaseUrl, supabaseKey: key, storage: { from } };
  return { client, from, download, handle: (bucket = "cadastro-drafts") => from(bucket) };
}

/** Açúcar: uma leitura pelo par (cliente, handle). */
function read(ctx, path, bucket = "cadastro-drafts") {
  return downloadDocBase64Cached({ client: ctx.client, storage: ctx.handle(bucket), bucket, path });
}

const TTL = 60_000;

beforeEach(() => {
  vi.clearAllMocks();
  __resetStorageDocCache();
  process.env.DRAFT_DOC_CACHE_TTL_MS = String(TTL);
  delete process.env.DRAFT_DOC_CACHE_ENABLED;
  delete process.env.DRAFT_DOC_CACHE_MAX_BYTES;
});

afterEach(() => {
  __resetStorageDocCache();
  delete process.env.DRAFT_DOC_CACHE_TTL_MS;
  delete process.env.DRAFT_DOC_CACHE_TTL_SECONDS;
  delete process.env.DRAFT_DOC_CACHE_ENABLED;
  delete process.env.DRAFT_DOC_CACHE_MAX_BYTES;
});

describe("getStorageDocCacheTtlMs (knobs)", () => {
  it("override explícito em ms vence", () => {
    process.env.DRAFT_DOC_CACHE_TTL_MS = "1234";
    expect(getStorageDocCacheTtlMs()).toBe(1234);
  });

  it("aceita o knob em segundos", () => {
    delete process.env.DRAFT_DOC_CACHE_TTL_MS;
    process.env.DRAFT_DOC_CACHE_TTL_SECONDS = "600";
    expect(getStorageDocCacheTtlMs()).toBe(600_000);
  });

  it("default OFF em teste (sem override) — não vaza estado entre casos", () => {
    delete process.env.DRAFT_DOC_CACHE_TTL_MS;
    expect(getStorageDocCacheTtlMs()).toBe(0);
  });

  it("DRAFT_DOC_CACHE_ENABLED=false é kill-switch (TTL 0) mesmo com override", () => {
    process.env.DRAFT_DOC_CACHE_TTL_MS = "60000";
    process.env.DRAFT_DOC_CACHE_ENABLED = "false";
    expect(getStorageDocCacheTtlMs()).toBe(0);
  });
});

describe("downloadDocBase64Cached / hit-miss", () => {
  it("2ª leitura do mesmo path NÃO baixa de novo (1 download, base64 idêntico)", async () => {
    const ctx = makeClient();
    const first = await read(ctx, "a/b.jpg");
    const second = await read(ctx, "a/b.jpg");

    expect(ctx.download).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.base64).toBe(first.base64);
    expect(second.base64).toBe(Buffer.from("FAKEBYTES").toString("base64"));
    expect(getStorageDocCacheStats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
  });

  it("handles DIFERENTES do MESMO cliente compartilham a entrada (é o caso do aprovar)", async () => {
    const ctx = makeClient();
    const h1 = ctx.handle();
    const h2 = ctx.handle();
    expect(h1).not.toBe(h2); // instâncias distintas, como no supabase-js real

    await downloadDocBase64Cached({ client: ctx.client, storage: h1, bucket: "cadastro-drafts", path: "a/b.jpg" });
    const viaOutroHandle = await downloadDocBase64Cached({
      client: ctx.client, storage: h2, bucket: "cadastro-drafts", path: "a/b.jpg",
    });

    expect(viaOutroHandle.cached).toBe(true);
    expect(ctx.download).toHaveBeenCalledTimes(1);
  });

  it("paths diferentes são entradas diferentes", async () => {
    const ctx = makeClient({ bytesByPath: { "a/1.jpg": "UM", "a/2.jpg": "DOIS" } });
    const r1 = await read(ctx, "a/1.jpg");
    const r2 = await read(ctx, "a/2.jpg");
    expect(ctx.download).toHaveBeenCalledTimes(2);
    expect(Buffer.from(r1.base64, "base64").toString()).toBe("UM");
    expect(Buffer.from(r2.base64, "base64").toString()).toBe("DOIS");
  });

  it("aceita Buffer CRU do download (é como reprocess-cadastro-docs.test.js mocka)", async () => {
    const ctx = makeClient({ raw: true, defaultBytes: "fake-bytes" });
    const r1 = await read(ctx, "a/b.jpg");
    const r2 = await read(ctx, "a/b.jpg");
    expect(r1.base64).toBe(Buffer.from("fake-bytes").toString("base64"));
    expect(r2.base64).toBe(r1.base64);
    expect(ctx.download).toHaveBeenCalledTimes(1);
  });

  it("TTL expirado → baixa de novo", async () => {
    process.env.DRAFT_DOC_CACHE_TTL_MS = "50";
    const ctx = makeClient();
    await read(ctx, "a/b.jpg");
    await new Promise((resolve) => setTimeout(resolve, 70));
    const again = await read(ctx, "a/b.jpg");
    expect(ctx.download).toHaveBeenCalledTimes(2);
    expect(again.cached).toBe(false);
  });

  it("TTL 0 (cache off) → todo acesso baixa, nada é guardado", async () => {
    process.env.DRAFT_DOC_CACHE_TTL_MS = "0";
    const ctx = makeClient();
    await read(ctx, "a/b.jpg");
    await read(ctx, "a/b.jpg");
    expect(ctx.download).toHaveBeenCalledTimes(2);
    expect(getStorageDocCacheStats()).toMatchObject({ entries: 0, hits: 0, misses: 0 });
  });
});

describe("downloadDocBase64Cached / fail-safe", () => {
  it("erro NÃO é cacheado (a tentativa seguinte re-baixa) e vem failed:true", async () => {
    const ctx = makeClient({ failPaths: new Set(["a/b.jpg"]) });
    const first = await read(ctx, "a/b.jpg");
    expect(first).toMatchObject({ base64: null, failed: true, cached: false });
    expect(first.error?.message).toBe("not found");

    await read(ctx, "a/b.jpg");
    expect(ctx.download).toHaveBeenCalledTimes(2);
    expect(getStorageDocCacheStats().entries).toBe(0);
  });

  it("payload vazio não é cacheado (failed:false, base64 vazio)", async () => {
    const ctx = makeClient({ defaultBytes: "" });
    const res = await read(ctx, "a/b.jpg");
    expect(res.failed).toBe(false);
    expect(res.base64).toBe("");
    expect(getStorageDocCacheStats().entries).toBe(0);
    await read(ctx, "a/b.jpg");
    expect(ctx.download).toHaveBeenCalledTimes(2);
  });

  it("exceção do download propaga (o call site loga o download_exception dele)", async () => {
    const ctx = makeClient();
    const handle = ctx.handle();
    handle.download = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    await expect(
      downloadDocBase64Cached({ client: ctx.client, storage: handle, bucket: "cadastro-drafts", path: "a/b.jpg" }),
    ).rejects.toThrow("socket hang up");
    expect(getStorageDocCacheStats()).toMatchObject({ entries: 0, inFlight: 0 });
  });

  it("path vazio → failed sem tocar no storage", async () => {
    const ctx = makeClient();
    const res = await read(ctx, "  ");
    expect(res).toEqual({ base64: null, error: null, failed: true, cached: false });
    expect(ctx.download).not.toHaveBeenCalled();
  });
});

describe("downloadDocBase64Cached / single-flight", () => {
  it("2 chamadas concorrentes do mesmo path = 1 download", async () => {
    const ctx = makeClient({ delayMs: 20 });
    const [a, b] = await Promise.all([read(ctx, "a/b.jpg"), read(ctx, "a/b.jpg")]);
    expect(ctx.download).toHaveBeenCalledTimes(1);
    expect(a.base64).toBe(b.base64);
    // Uma das duas foi servida pelo voo em andamento.
    expect([a.cached, b.cached].filter(Boolean)).toHaveLength(1);
    expect(getStorageDocCacheStats().inFlight).toBe(0);
  });
});

describe("downloadDocBase64Cached / teto de bytes + LRU", () => {
  it("evicta o menos recente ao estourar DRAFT_DOC_CACHE_MAX_BYTES", async () => {
    // Teto de 20 bytes: cabem 2 docs de 10 bytes.
    process.env.DRAFT_DOC_CACHE_MAX_BYTES = "20";
    const ctx = makeClient({
      bytesByPath: { "a/1.jpg": "0123456789", "a/2.jpg": "abcdefghij", "a/3.jpg": "ABCDEFGHIJ" },
    });
    await read(ctx, "a/1.jpg");
    await read(ctx, "a/2.jpg");
    // Toca a/1 → passa a ser a MAIS recente (LRU refresca a recência no hit).
    await read(ctx, "a/1.jpg");
    await read(ctx, "a/3.jpg");

    expect(getStorageDocCacheStats()).toMatchObject({ entries: 2, bytesHeld: 20, evictions: 1 });
    // a/1 (tocada) sobreviveu; a/2 (a menos recente) foi evictada e re-baixa.
    expect((await read(ctx, "a/1.jpg")).cached).toBe(true);
    expect((await read(ctx, "a/2.jpg")).cached).toBe(false);
    expect(ctx.download.mock.calls.map((c) => c[0])).toEqual(["a/1.jpg", "a/2.jpg", "a/3.jpg", "a/2.jpg"]);
  });

  it("doc maior que o teto nunca entra no cache (mas é devolvido normalmente)", async () => {
    process.env.DRAFT_DOC_CACHE_MAX_BYTES = "4";
    const ctx = makeClient({ defaultBytes: "0123456789" });
    const res = await read(ctx, "a/big.jpg");
    expect(res.base64).toBe(Buffer.from("0123456789").toString("base64"));
    expect(getStorageDocCacheStats()).toMatchObject({ entries: 0, bytesHeld: 0 });
    await read(ctx, "a/big.jpg");
    expect(ctx.download).toHaveBeenCalledTimes(2);
  });
});

describe("downloadDocBase64Cached / invariante service_role (isolamento)", () => {
  it("credenciais diferentes NÃO compartilham entrada (partições separadas)", async () => {
    const service = makeClient({ key: SERVICE_ROLE_JWT, defaultBytes: "SEGREDO" });
    const outro = makeClient({ key: `${SERVICE_ROLE_JWT}x`, defaultBytes: "OUTRO" });
    await read(service, "a/b.jpg");
    const res = await read(outro, "a/b.jpg");

    expect(outro.download).toHaveBeenCalledTimes(1); // baixou com a própria credencial
    expect(Buffer.from(res.base64, "base64").toString()).toBe("OUTRO"); // não herdou bytes do outro cliente
    expect(getStorageDocCacheStats().entries).toBe(2);
  });

  it("cliente com JWT role != service_role NUNCA é cacheado (fail-closed)", async () => {
    const service = makeClient({ key: SERVICE_ROLE_JWT, defaultBytes: "SEGREDO" });
    await read(service, "a/b.jpg");

    const anon = makeClient({ key: ANON_JWT, defaultBytes: "ANON" });
    await read(anon, "a/b.jpg");
    await read(anon, "a/b.jpg");

    expect(anon.download).toHaveBeenCalledTimes(2); // nem lê nem popula o cache
    expect(getStorageDocCacheStats().entries).toBe(1); // só a entrada do service_role
    expect(logStructuredEvent).toHaveBeenCalledWith("warn", "storage.doc_cache.non_service_role_client", {});
  });

  it("chave publishable (formato novo) também é rejeitada; sb_secret_ é aceita", async () => {
    const publishable = makeClient({ key: "sb_publishable_abc123" });
    await read(publishable, "a/b.jpg");
    await read(publishable, "a/b.jpg");
    expect(publishable.download).toHaveBeenCalledTimes(2);

    const secret = makeClient({ key: "sb_secret_abc123" });
    await read(secret, "a/b.jpg");
    await read(secret, "a/b.jpg");
    expect(secret.download).toHaveBeenCalledTimes(1);
  });

  it("rótulo de bucket divergente do handle → não cacheia + warn (mislabel não vira hit errado)", async () => {
    const ctx = makeClient();
    const mislabeled = () =>
      downloadDocBase64Cached({
        client: ctx.client, storage: ctx.handle("risk-docs"), bucket: "cadastro-drafts", path: "a/b.jpg",
      });
    await mislabeled();
    await mislabeled();
    expect(ctx.download).toHaveBeenCalledTimes(2);
    expect(getStorageDocCacheStats().entries).toBe(0);
    expect(logStructuredEvent).toHaveBeenCalledWith(
      "warn",
      "storage.doc_cache.bucket_mismatch",
      { bucket: "cadastro-drafts", bucketId: "risk-docs" },
    );
  });

  it("mesmo path em buckets diferentes = entradas diferentes (bucket vem do handle)", async () => {
    const ctx = makeClient({ bytesByPath: {}, defaultBytes: "BYTES" });
    await read(ctx, "x/1.pdf", "cadastro-drafts");
    const risco = await read(ctx, "x/1.pdf", "risk-docs");
    expect(risco.cached).toBe(false); // não reaproveitou a entrada do outro bucket
    expect(ctx.download).toHaveBeenCalledTimes(2);
    expect(getStorageDocCacheStats().entries).toBe(2);
  });

  it("sem `client` → sem cache (não dá para provar o privilégio)", async () => {
    const ctx = makeClient();
    const handle = ctx.handle();
    await downloadDocBase64Cached({ storage: handle, bucket: "cadastro-drafts", path: "a/b.jpg" });
    await downloadDocBase64Cached({ storage: handle, bucket: "cadastro-drafts", path: "a/b.jpg" });
    expect(ctx.download).toHaveBeenCalledTimes(2);
    expect(getStorageDocCacheStats().entries).toBe(0);
  });

  it("handle sem bucketId (shape inesperada) → sem cache", async () => {
    const ctx = makeClient({ omitBucketId: true });
    await read(ctx, "a/b.jpg");
    await read(ctx, "a/b.jpg");
    expect(ctx.download).toHaveBeenCalledTimes(2);
    expect(getStorageDocCacheStats().entries).toBe(0);
  });

  it("cliente sem credencial visível → partição por identidade do objeto (nunca compartilhada)", async () => {
    const a = makeClient({ key: "", defaultBytes: "A" });
    const b = makeClient({ key: "", defaultBytes: "B" });
    await read(a, "a/b.jpg");
    const hitA = await read(a, "a/b.jpg");
    const missB = await read(b, "a/b.jpg");

    expect(hitA.cached).toBe(true); // o MESMO cliente reaproveita
    expect(missB.cached).toBe(false); // outro objeto = outra partição
    expect(Buffer.from(missB.base64, "base64").toString()).toBe("B");
    expect(a.download).toHaveBeenCalledTimes(1);
    expect(b.download).toHaveBeenCalledTimes(1);
  });
});

describe("__resetStorageDocCache", () => {
  it("zera entradas, bytes e contadores", async () => {
    const ctx = makeClient();
    await read(ctx, "a/b.jpg");
    expect(getStorageDocCacheStats().entries).toBe(1);
    __resetStorageDocCache();
    expect(getStorageDocCacheStats()).toEqual({
      hits: 0, misses: 0, evictions: 0, entries: 0, bytesHeld: 0, inFlight: 0,
    });
    await read(ctx, "a/b.jpg");
    expect(ctx.download).toHaveBeenCalledTimes(2);
  });
});
