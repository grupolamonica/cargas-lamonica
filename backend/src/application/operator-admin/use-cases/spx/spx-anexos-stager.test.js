import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../infrastructure/security-log.js", () => ({
  logStructuredEvent: vi.fn(),
}));

import fs from "node:fs";

import { __resetStorageDocCache } from "../../../../infrastructure/supabase/storage-doc-cache.js";
import { stageAnexosForEntity } from "../angellira/anexos-stager.js";
import { resolveSpxBotBaseUrl, stageSpxAnexos } from "./spx-anexos-stager.js";

const CADASTRO_ID = "CAD-SPX-abc123";
// Credencial service_role fake — o micro-cache de bytes só cacheia service_role.
const SERVICE_ROLE_JWT = `hdr.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.sig`;

function okResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}
function errResponse(status, body) {
  return { ok: false, status, text: async () => JSON.stringify(body) };
}

function makeStorageClient({ failPaths = new Set() } = {}) {
  const downloaded = [];
  const downloadImpl = vi.fn(async (path) => {
    downloaded.push(path);
    if (failPaths.has(path)) return { data: null, error: { message: "not found" } };
    const buf = Buffer.from("FAKEBYTES");
    return {
      data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) },
      error: null,
    };
  });
  // Espelha o supabase-js real: supabaseUrl/supabaseKey no CLIENTE (privilégio +
  // partição do micro-cache) e um handle NOVO por .from(), com o bucketId real.
  const from = vi.fn((bucketId) => ({
    url: "https://proj.supabase.co/storage/v1",
    headers: { "x-client-info": "supabase-js/2" },
    bucketId,
    download: downloadImpl,
  }));
  const client = {
    supabaseUrl: "https://proj.supabase.co",
    supabaseKey: SERVICE_ROLE_JWT,
    storage: { from },
  };
  return { storage: client, from, _downloaded: () => downloaded };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Cache de bytes é módulo-level: zera entre casos (os testes reusam os mesmos
  // paths, ora com sucesso ora com falha de download).
  __resetStorageDocCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetStorageDocCache();
  delete process.env.SPX_BOT_URL;
  delete process.env.DRAFT_DOC_CACHE_TTL_MS;
});

describe("resolveSpxBotBaseUrl", () => {
  it("default quando env ausente", () => {
    delete process.env.SPX_BOT_URL;
    expect(resolveSpxBotBaseUrl()).toBe("http://spx-bot:8766");
  });
  it("usa SPX_BOT_URL sem barra final", () => {
    process.env.SPX_BOT_URL = "http://x:9000/";
    expect(resolveSpxBotBaseUrl()).toBe("http://x:9000");
  });
});

describe("stageSpxAnexos / wizard (bucket)", () => {
  it("estaga CNH→cnh_frente, selfie e CRLV do cavalo com os tipos certos", async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/x", bytes: 9 }));
    vi.stubGlobal("fetch", fetchMock);
    const { storage, _downloaded } = makeStorageClient();
    const dados = {
      motorista: {
        cnh_url: "cadastro-drafts/owner/carga/motorista_cnh_1.jpg",
        selfie_cnh_url: "owner/carga/motorista_selfie_cnh_1.jpg",
      },
      cavalo: { crlv_url: "owner/carga/cavalo_crlv_1.png" },
    };
    const anexos = await stageSpxAnexos({ dados, cadastroId: CADASTRO_ID, storageClient: storage });

    expect(anexos).toEqual({
      cnh_frente_path: "/sandbox/x",
      selfie_path: "/sandbox/x",
      crlv_path: "/sandbox/x",
    });
    const tipos = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).tipo);
    expect(tipos).toEqual(["cnh_frente", "selfie_cnh", "crlv_cavalo"]);
    // prefixo cadastro-drafts/ removido antes do download
    expect(_downloaded()[0]).toBe("owner/carga/motorista_cnh_1.jpg");
  });

  it("usa os recortes cnh_frente_url/cnh_verso_url quando presentes (SPX Driver License)", async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/x", bytes: 9 }));
    vi.stubGlobal("fetch", fetchMock);
    const { storage, _downloaded } = makeStorageClient();
    const dados = {
      motorista: {
        cnh_url: "owner/carga/motorista_cnh_inteira.jpg", // original (não usado p/ frente quando há recorte)
        cnh_frente_url: "owner/carga/motorista_cnh_frente_1.jpg",
        cnh_verso_url: "owner/carga/motorista_cnh_verso_1.jpg",
      },
    };
    const anexos = await stageSpxAnexos({ dados, cadastroId: CADASTRO_ID, storageClient: storage });

    expect(anexos).toEqual({ cnh_frente_path: "/sandbox/x", cnh_verso_path: "/sandbox/x" });
    const tipos = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).tipo);
    expect(tipos).toEqual(["cnh_frente", "cnh_verso"]);
    // frente veio do RECORTE (cnh_frente_url), não do cnh_url original.
    expect(_downloaded()).toContain("owner/carga/motorista_cnh_frente_1.jpg");
    expect(_downloaded()).toContain("owner/carga/motorista_cnh_verso_1.jpg");
    expect(_downloaded()).not.toContain("owner/carga/motorista_cnh_inteira.jpg");
  });
});

describe("stageSpxAnexos / risk_doc", () => {
  it("estaga o dossiê do bucket de risco como risk_doc_path (tipo risk_doc)", async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/risk.pdf" }));
    vi.stubGlobal("fetch", fetchMock);
    const { storage, _downloaded } = makeStorageClient();
    const anexos = await stageSpxAnexos({
      dados: { motorista: {} },
      cadastroId: CADASTRO_ID,
      riskDocBucketPath: "risk-docs/CAD/dossie_123.pdf",
      storageClient: storage,
    });
    expect(anexos).toEqual({ risk_doc_path: "/sandbox/risk.pdf" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tipo).toBe("risk_doc");
    expect(_downloaded()[0]).toBe("risk-docs/CAD/dossie_123.pdf");
  });
});

describe("stageSpxAnexos / micro-cache de bytes (egress)", () => {
  const dadosWizard = () => ({
    motorista: {
      cnh_url: "cadastro-drafts/owner/carga/motorista_cnh_1.jpg",
      selfie_cnh_url: "owner/carga/motorista_selfie_cnh_1.jpg",
    },
    cavalo: { crlv_url: "owner/carga/cavalo_crlv_1.png" },
  });

  it("SEM cache (default em teste): preview dry-run + disparo real baixam tudo 2x", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/x" })));
    const { storage, _downloaded } = makeStorageClient();
    await stageSpxAnexos({ dados: dadosWizard(), cadastroId: CADASTRO_ID, storageClient: storage });
    await stageSpxAnexos({ dados: dadosWizard(), cadastroId: CADASTRO_ID, storageClient: storage });
    expect(_downloaded()).toHaveLength(6); // 3 docs x 2 passadas
  });

  it("COM cache: a 2ª passada não baixa nada e o mapa/POSTs continuam idênticos", async () => {
    process.env.DRAFT_DOC_CACHE_TTL_MS = "60000";
    const fetchMock = vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/x" }));
    vi.stubGlobal("fetch", fetchMock);
    const { storage, _downloaded } = makeStorageClient();

    const preview = await stageSpxAnexos({ dados: dadosWizard(), cadastroId: CADASTRO_ID, storageClient: storage });
    const real = await stageSpxAnexos({ dados: dadosWizard(), cadastroId: CADASTRO_ID, storageClient: storage });

    expect(_downloaded()).toHaveLength(3); // 6 -> 3 (a 2ª passada é 100% cache)
    expect(real).toEqual(preview);
    expect(real).toEqual({
      cnh_frente_path: "/sandbox/x",
      selfie_path: "/sandbox/x",
      crlv_path: "/sandbox/x",
    });
    // 6 POSTs (3 por passada) com os mesmos bytes — só o egress do bucket caiu.
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const imagens = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).imagem);
    expect(new Set(imagens).size).toBe(1);
    expect(imagens[0]).toBe(Buffer.from("FAKEBYTES").toString("base64"));
  });

  it("COM cache: bucket do risk_doc é chave própria (rótulo do caller é só conferido)", async () => {
    process.env.DRAFT_DOC_CACHE_TTL_MS = "60000";
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/risk.pdf" })));
    const { storage, _downloaded } = makeStorageClient();
    const args = {
      dados: { motorista: {} },
      cadastroId: CADASTRO_ID,
      riskDocBucketPath: "risk-docs/CAD/dossie_123.pdf",
      storageClient: storage,
    };
    const first = await stageSpxAnexos(args);
    const second = await stageSpxAnexos(args);
    expect(first).toEqual({ risk_doc_path: "/sandbox/risk.pdf" });
    expect(second).toEqual(first);
    expect(_downloaded()).toEqual(["risk-docs/CAD/dossie_123.pdf"]); // dossiê baixado 1x
  });
});

// UM "aprovar" roda os dois pipelines em sequência no MESMO request
// (handlers.js: dispatchAngelliraFromApprove -> dispatchSpxFromApprove) e o
// cavalo.crlv_url é o doc que os dois estagiam — a duplicata determinística
// entre pipelines. Cada pipeline chama client.storage.from(bucket) por conta
// própria, ou seja: handles DIFERENTES do MESMO cliente service_role. O cache
// tem de enxergar isso como a mesma entrada (chave por credencial+bucket, não
// por instância do handle).
describe("aprovar = Angellira + SPX no mesmo request (dedupe entre pipelines)", () => {
  const CRLV = "owner/carga/cavalo_crlv_1.png";

  it("SEM cache: o crlv do cavalo sai do bucket 2x", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/x" })));
    const { storage, _downloaded } = makeStorageClient();
    const dados = { motorista: {}, cavalo: { crlv_url: CRLV } };

    await stageAnexosForEntity({ dados, entity: "cavalo", cadastroId: CADASTRO_ID, storageClient: storage });
    await stageSpxAnexos({ dados, cadastroId: CADASTRO_ID, storageClient: storage });

    expect(_downloaded()).toEqual([CRLV, CRLV]);
  });

  it("COM cache: sai 1x e os dois bots recebem os mesmos bytes", async () => {
    process.env.DRAFT_DOC_CACHE_TTL_MS = "60000";
    const fetchMock = vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/x" }));
    vi.stubGlobal("fetch", fetchMock);
    const { storage, from, _downloaded } = makeStorageClient();
    const dados = { motorista: {}, cavalo: { crlv_url: CRLV } };

    const angellira = await stageAnexosForEntity({
      dados, entity: "cavalo", cadastroId: CADASTRO_ID, storageClient: storage,
    });
    const spx = await stageSpxAnexos({ dados, cadastroId: CADASTRO_ID, storageClient: storage });

    expect(_downloaded()).toEqual([CRLV]); // 2 -> 1
    expect(from.mock.results.length).toBeGreaterThan(1); // handles distintos do mesmo cliente
    expect(from.mock.results[0].value).not.toBe(from.mock.results[1].value);
    // Comportamento preservado: os 2 bots seguem recebendo o POST com os bytes.
    expect(angellira).toEqual({ crlv: "/sandbox/x" });
    expect(spx).toEqual({ crlv_path: "/sandbox/x" });
    const enviados = fetchMock.mock.calls.map((c) => ({
      url: c[0], tipo: JSON.parse(c[1].body).tipo, imagem: JSON.parse(c[1].body).imagem,
    }));
    expect(enviados.map((e) => e.url)).toEqual([
      "http://angelira-bot:8765/api/anexo/salvar",
      "http://spx-bot:8766/spx/anexo/salvar",
    ]);
    expect(enviados.map((e) => e.tipo)).toEqual(["crlv_cavalo", "crlv_cavalo"]);
    expect(enviados[1].imagem).toBe(enviados[0].imagem);
  });
});

describe("stageSpxAnexos / migrado (share local)", () => {
  it("resolve docs do share via _origem.motorista_id — sem tocar no Supabase", async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/local" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readdirSync").mockReturnValue(["cnh-motorista.jpg", "crlv-cavalo.pdf"]);
    vi.spyOn(fs.promises, "readFile").mockResolvedValue("QkFTRTY0");

    const { storage, _downloaded } = makeStorageClient();
    const dados = { _origem: { fonte: "bot_whatsapp", motorista_id: 891 } };
    const anexos = await stageSpxAnexos({ dados, cadastroId: CADASTRO_ID, storageClient: storage });

    // Achou cnh-motorista (fallback de cnh_frente) e crlv-cavalo; verso/selfie ausentes.
    expect(anexos).toEqual({ cnh_frente_path: "/sandbox/local", crlv_path: "/sandbox/local" });
    expect(_downloaded()).toHaveLength(0); // nada do Supabase
    const tipos = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).tipo).sort();
    expect(tipos).toEqual(["cnh_frente", "crlv_cavalo"]);
  });
});

describe("stageSpxAnexos / best-effort", () => {
  it("sem docs nem risk_doc → {} sem fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { storage } = makeStorageClient();
    const anexos = await stageSpxAnexos({ dados: { motorista: {} }, cadastroId: CADASTRO_ID, storageClient: storage });
    expect(anexos).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("download falha → doc pulado, não lança", async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/x" }));
    vi.stubGlobal("fetch", fetchMock);
    const failPath = "owner/carga/cavalo_crlv_1.png";
    const { storage } = makeStorageClient({ failPaths: new Set([failPath]) });
    const anexos = await stageSpxAnexos({
      dados: { cavalo: { crlv_url: failPath } }, cadastroId: CADASTRO_ID, storageClient: storage,
    });
    expect(anexos).toEqual({});
  });

  it("bot rejeita salvar (400) → doc pulado, não lança", async () => {
    const fetchMock = vi.fn(async () => errResponse(400, { detail: "tipo invalido" }));
    vi.stubGlobal("fetch", fetchMock);
    const { storage } = makeStorageClient();
    const anexos = await stageSpxAnexos({
      dados: { cavalo: { crlv_url: "owner/carga/cavalo_crlv_1.png" } }, cadastroId: CADASTRO_ID, storageClient: storage,
    });
    expect(anexos).toEqual({});
  });

  it("sem cadastroId → {} sem fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { storage } = makeStorageClient();
    const anexos = await stageSpxAnexos({
      dados: { cavalo: { crlv_url: "owner/carga/cavalo_crlv_1.png" } }, cadastroId: "", storageClient: storage,
    });
    expect(anexos).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
