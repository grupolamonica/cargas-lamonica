import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  humanizeOcrMessage,
  uploadDraftFile,
  type UploadDraftFileResponse,
} from "./cadastroApi";

describe("humanizeOcrMessage", () => {
  it("retorna fallback amigavel quando msg ausente", () => {
    expect(humanizeOcrMessage(undefined)).toMatch(/Não deu pra ler/i);
    expect(humanizeOcrMessage("")).toMatch(/Não deu pra ler/i);
    expect(humanizeOcrMessage("   ")).toMatch(/Não deu pra ler/i);
  });

  it("retorna fallback do nosso lado em 5xx sem msg", () => {
    expect(humanizeOcrMessage(undefined, 500)).toMatch(/Deu problema do nosso lado/i);
    expect(humanizeOcrMessage(undefined, 503)).toMatch(/Deu problema do nosso lado/i);
  });

  it("filtra jargao tecnico (HTTP / timeout / Erro NNN / FastAPI / token / detran / Bucket)", () => {
    const technicalSamples = [
      "HTTP 500 internal server error",
      "fetch failed: ECONNRESET",
      "network error",
      "Erro 612 ao processar documento.",
      "FastAPI validation: nome required",
      "Token de autenticacao invalido ou ausente.",
      "Concessionária inválida. Opções: detran-pr, detran-mg",
      "Bucket not found",
      "STORAGE_UNAVAILABLE",
      "INFOSIMPLES_SOURCE_TIMEOUT",
    ];
    for (const sample of technicalSamples) {
      const out = humanizeOcrMessage(sample);
      expect(out).not.toContain(sample);
      expect(out).toMatch(/Não deu pra ler|Deu problema/i);
    }
  });

  it("detecta dica de 'documento errado' e retorna mensagem especifica", () => {
    const wrongDocSamples = [
      "Não foi possivel extrair texto da imagem",
      "Nao conseguimos extrair os campos",
      "Sem texto detectado",
      "extraíu 0 campos",
      "Documento não reconhecido",
      "Documento invalido",
    ];
    for (const sample of wrongDocSamples) {
      expect(humanizeOcrMessage(sample)).toMatch(/documento certo/i);
    }
  });

  it("passa mensagens amigaveis curtas em PT-BR intactas", () => {
    expect(humanizeOcrMessage("CPF inválido (11 dígitos).")).toBe(
      "CPF inválido (11 dígitos).",
    );
    expect(humanizeOcrMessage("Placa inválida (7 caracteres).")).toBe(
      "Placa inválida (7 caracteres).",
    );
  });

  it("descarta mensagens muito longas (provavel stacktrace)", () => {
    const longMsg = "x".repeat(250);
    expect(humanizeOcrMessage(longMsg)).toMatch(/Não deu pra ler/i);
  });
});

function buildFile(name = "cnh.jpg", type = "image/jpeg", size = 4096): File {
  return new File([new Uint8Array(size)], name, { type });
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("uploadDraftFile", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("POSTs multipart with file/slot/cargaId and Bearer token when provided", async () => {
    const payload: UploadDraftFileResponse = {
      storage_path: "abc/123/motorista_cnh_1700000000.jpg",
      signed_url: "https://supabase.test/signed/xyz",
      slot: "motorista_cnh",
      filename: "cnh.jpg",
      size: 4096,
      content_type: "image/jpeg",
      expires_at: "2026-05-17T00:00:00Z",
    };
    fetchMock.mockResolvedValue(jsonResponse(payload));

    const file = buildFile();
    const result = await uploadDraftFile(file, "motorista_cnh", "carga-123", {
      accessToken: "tok-456",
    });

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/cadastro/upload-draft-file");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok-456",
    );

    const fd = init.body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect(fd.get("slot")).toBe("motorista_cnh");
    expect(fd.get("cargaId")).toBe("carga-123");
    expect(fd.get("file")).toBeInstanceOf(File);
    expect((fd.get("file") as File).name).toBe("cnh.jpg");
    expect(fd.get("cpf")).toBeNull(); // CPF não foi passado, não deve ir no body
  });

  it("attaches cpf to FormData when accessToken is absent", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        storage_path: "p",
        signed_url: "u",
        slot: "motorista_cnh",
        filename: "x.jpg",
        size: 1024,
        content_type: "image/jpeg",
        expires_at: "2026-05-17T00:00:00Z",
      }),
    );
    await uploadDraftFile(buildFile(), "motorista_cnh", "carga-1", {
      cpf: "12345678900",
    });
    const init = fetchMock.mock.calls[0][1];
    const fd = init.body as FormData;
    expect(fd.get("cpf")).toBe("12345678900");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("throws a motorista-friendly message on 5xx", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "boom" }, { status: 500 }));
    await expect(
      uploadDraftFile(buildFile(), "motorista_cnh", "carga-1"),
    ).rejects.toThrow(/problema do nosso lado/i);
  });

  it("uses backend message on 4xx when string and PT-BR friendly", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: "Arquivo não suportado." }, { status: 400 }),
    );
    await expect(
      uploadDraftFile(buildFile(), "motorista_cnh", "carga-1"),
    ).rejects.toThrow("Arquivo não suportado.");
  });

  it("throws network-friendly message when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      uploadDraftFile(buildFile(), "motorista_cnh", "carga-1"),
    ).rejects.toThrow(/problema do nosso lado/i);
  });
});
