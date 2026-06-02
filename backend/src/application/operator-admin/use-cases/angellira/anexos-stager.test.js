import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../infrastructure/security-log.js", () => ({
  logStructuredEvent: vi.fn(),
}));

import { resolveBotBaseUrl, stageAnexosForEntity } from "./anexos-stager.js";

const CADASTRO_ID = "CAD-V2-abc123";

/**
 * Resposta fake do /api/anexo/salvar. Plain object (não `Response`) — o ctor
 * global `Response` não é estável no environment node do vitest.
 */
function okResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}
function errResponse(status, body) {
  return { ok: false, status, text: async () => JSON.stringify(body) };
}

/**
 * Fake do admin storage client: storage.from(bucket).download(path) devolve um
 * objeto Blob-like (arrayBuffer). Registra os paths baixados pra assert.
 */
function makeStorageClient({ failPaths = new Set() } = {}) {
  const downloaded = [];
  const downloadImpl = vi.fn(async (path) => {
    downloaded.push(path);
    if (failPaths.has(path)) {
      return { data: null, error: { message: "not found" } };
    }
    const buf = Buffer.from("FAKEBYTES");
    return {
      data: {
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      },
      error: null,
    };
  });
  const fromObj = { download: downloadImpl };
  const from = vi.fn(() => fromObj);
  // Cliente admin Supabase fake: o stager chama client.storage.from(bucket).
  const client = { storage: { from } };
  return { storage: client, from, _downloaded: () => downloaded };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ANGELLIRA_BOT_URL;
});

describe("resolveBotBaseUrl", () => {
  it("usa o default quando env ausente", () => {
    expect(resolveBotBaseUrl()).toBe("http://angelira-bot:8765");
  });
  it("usa ANGELLIRA_BOT_URL sem barra final", () => {
    process.env.ANGELLIRA_BOT_URL = "http://x:9000/";
    expect(resolveBotBaseUrl()).toBe("http://x:9000");
  });
});

describe("stageAnexosForEntity / motorista", () => {
  it("estaga cnh_url como cnh E rg → { cnh, rg } com tipos cnh_motorista/rg_motorista", async () => {
    const fetchMock = vi.fn(async () =>
      okResponse({ ok: true, anexo_path: "/sandbox/x.jpg", bytes: 10 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { storage, _downloaded } = makeStorageClient();
    const dados = {
      motorista: {
        // cnh_url é usado para AMBOS cnh e rg (selfie_cnh_url não é enviada ao Angellira)
        cnh_url: "cadastro-drafts/owner/carga/motorista_cnh_1.jpg",
        selfie_cnh_url: "owner/carga/motorista_selfie_cnh_1.jpg",
      },
    };

    const anexos = await stageAnexosForEntity({
      dados,
      entity: "motorista",
      cadastroId: CADASTRO_ID,
      storageClient: storage,
    });

    expect(anexos).toEqual({ cnh: "/sandbox/x.jpg", rg: "/sandbox/x.jpg" });
    // 2 POSTs com tipos corretos (ambos usam cnh_url)
    const tipos = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).tipo);
    expect(tipos).toEqual(["cnh_motorista", "rg_motorista"]);
    // prefixo cadastro-drafts/ removido antes do download
    expect(_downloaded()[0]).toBe("owner/carga/motorista_cnh_1.jpg");
  });
});

describe("stageAnexosForEntity / veículo", () => {
  it("cavalo → { crlv } tipo crlv_cavalo", async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/crlv.png" }));
    vi.stubGlobal("fetch", fetchMock);
    const { storage } = makeStorageClient();
    const dados = { cavalo: { crlv_url: "owner/carga/cavalo_crlv_1.png" } };

    const anexos = await stageAnexosForEntity({
      dados, entity: "cavalo", cadastroId: CADASTRO_ID, storageClient: storage,
    });
    expect(anexos).toEqual({ crlv: "/sandbox/crlv.png" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tipo).toBe("crlv_cavalo");
  });

  it("carreta idx 1 → { crlv } tipo crlv_carreta", async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/c.png" }));
    vi.stubGlobal("fetch", fetchMock);
    const { storage } = makeStorageClient();
    const dados = { carretas: [{}, { crlv_url: "owner/carga/carreta_crlv_1.png" }] };

    const anexos = await stageAnexosForEntity({
      dados, entity: "carreta", idx: 1, cadastroId: CADASTRO_ID, storageClient: storage,
    });
    expect(anexos).toEqual({ crlv: "/sandbox/c.png" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tipo).toBe("crlv_carreta");
  });
});

describe("stageAnexosForEntity / proprietário PF vs PJ", () => {
  it("PF → { cnh } tipo cnh_proprietario", async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/cnh.jpg" }));
    vi.stubGlobal("fetch", fetchMock);
    const { storage } = makeStorageClient();
    const dados = {
      cavalo_owner: { tipo: "pf", doc: "12345678909", owner_doc_url: "owner/carga/cavalo_owner_cnh_1.jpg" },
    };
    const anexos = await stageAnexosForEntity({
      dados, entity: "cavalo_owner", cadastroId: CADASTRO_ID, storageClient: storage,
    });
    expect(anexos).toEqual({ cnh: "/sandbox/cnh.jpg" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tipo).toBe("cnh_proprietario");
  });

  it("PJ (cnpj 14 dígitos) → { cartao_cnpj } tipo cartao_cnpj", async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/cnpj.pdf" }));
    vi.stubGlobal("fetch", fetchMock);
    const { storage } = makeStorageClient();
    const dados = {
      cavalo_owner: { tipo: "pj", doc: "12345678000199", owner_doc_url: "owner/carga/cavalo_owner_cnh_1.pdf" },
    };
    const anexos = await stageAnexosForEntity({
      dados, entity: "cavalo_owner", cadastroId: CADASTRO_ID, storageClient: storage,
    });
    expect(anexos).toEqual({ cartao_cnpj: "/sandbox/cnpj.pdf" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tipo).toBe("cartao_cnpj");
  });

  it("carreta_owner PJ → tipo cartao_cnpj_carreta", async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/cc.pdf" }));
    vi.stubGlobal("fetch", fetchMock);
    const { storage } = makeStorageClient();
    const dados = {
      carreta_owners: [{ tipo: "pj", doc: "12345678000199", owner_doc_url: "owner/carga/carreta_owner_cnh_0.pdf" }],
    };
    const anexos = await stageAnexosForEntity({
      dados, entity: "carreta_owner", idx: 0, cadastroId: CADASTRO_ID, storageClient: storage,
    });
    expect(anexos).toEqual({ cartao_cnpj: "/sandbox/cc.pdf" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tipo).toBe("cartao_cnpj_carreta");
  });
});

describe("stageAnexosForEntity / best-effort resilience", () => {
  it("sem docs no dados → {} sem tocar storage nem fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { storage } = makeStorageClient();
    const anexos = await stageAnexosForEntity({
      dados: { motorista: {} }, entity: "motorista", cadastroId: CADASTRO_ID, storageClient: storage,
    });
    expect(anexos).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.storage.from).not.toHaveBeenCalled();
  });

  it("download falha → doc pulado, NÃO lança, mapa vazio (cnh e rg usam o mesmo cnh_url)", async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: true, anexo_path: "/sandbox/ok.jpg" }));
    vi.stubGlobal("fetch", fetchMock);
    const failPath = "owner/carga/motorista_cnh_1.jpg";
    const { storage } = makeStorageClient({ failPaths: new Set([failPath]) });
    const dados = {
      motorista: {
        cnh_url: failPath, // vai falhar no download → cnh E rg ficam sem path
        selfie_cnh_url: "owner/carga/motorista_selfie_cnh_1.jpg", // ignorado
      },
    };
    const anexos = await stageAnexosForEntity({
      dados, entity: "motorista", cadastroId: CADASTRO_ID, storageClient: storage,
    });
    // cnh_url falhou → tanto cnh quanto rg ficam fora do mapa
    expect(anexos).toEqual({});
  });

  it("bot rejeita /api/anexo/salvar (400) → doc pulado, NÃO lança", async () => {
    const fetchMock = vi.fn(async () => errResponse(400, { detail: "tipo invalido" }));
    vi.stubGlobal("fetch", fetchMock);
    const { storage } = makeStorageClient();
    const dados = { cavalo: { crlv_url: "owner/carga/cavalo_crlv_1.png" } };
    const anexos = await stageAnexosForEntity({
      dados, entity: "cavalo", cadastroId: CADASTRO_ID, storageClient: storage,
    });
    expect(anexos).toEqual({});
  });

  it("sem cadastroId → {} (bot rejeitaria id_cadastro vazio)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { storage } = makeStorageClient();
    const dados = { cavalo: { crlv_url: "owner/carga/cavalo_crlv_1.png" } };
    const anexos = await stageAnexosForEntity({
      dados, entity: "cavalo", cadastroId: "", storageClient: storage,
    });
    expect(anexos).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
