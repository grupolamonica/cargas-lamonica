import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../infrastructure/security-log.js", () => ({
  logStructuredEvent: vi.fn(),
}));

import fs from "node:fs";

import { resolveSpxBotBaseUrl, stageSpxAnexos } from "./spx-anexos-stager.js";

const CADASTRO_ID = "CAD-SPX-abc123";

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
  const from = vi.fn(() => ({ download: downloadImpl }));
  return { storage: { storage: { from } }, from, _downloaded: () => downloaded };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SPX_BOT_URL;
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
