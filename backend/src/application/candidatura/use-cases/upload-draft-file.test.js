import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Testes unitarios do use case upload-draft-file.
 *
 * Estrategia: mocka o Supabase Storage client (upload/list/remove/createSignedUrl)
 * e o pg transaction (insertSecurityAuditEvent ja foi testado isoladamente).
 *
 * Cenarios:
 *   (a) happy path com driver_user_id (UUID)
 *   (b) happy path com cpf anonimo (11 digitos)
 *   (c) slot invalido → 400 INVALID_SLOT
 *   (d) storage.upload falha → 502 STORAGE_UNAVAILABLE
 *   (e) old files do mesmo slot removidos antes do upload
 *   (f) contentType nao suportado → 415 UNSUPPORTED_TYPE
 *   (g) file maior que 8MB → 413 FILE_TOO_LARGE
 */

// ─── pg/security-audit/auth mocks ──────────────────────────────────────────
vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgTransaction: vi.fn(async (cb) => {
    return cb({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    });
  }),
}));

vi.mock("../../../infrastructure/security-audit.js", () => ({
  insertSecurityAuditEvent: vi.fn(async () => undefined),
}));

vi.mock("../../load-claims/auth.js", () => ({
  getAdminClient: vi.fn(),
}));

import { uploadDraftFile, VALID_DRAFT_SLOTS } from "./upload-draft-file.js";

// ─── Factory de fake Supabase storage ──────────────────────────────────────
function makeFakeStorage({ listResult, uploadError, removeError, signedUrlResult } = {}) {
  const calls = {
    listArgs: [],
    uploadArgs: [],
    removeArgs: [],
    signedArgs: [],
  };

  const storage = {
    list: vi.fn(async (prefix, opts) => {
      calls.listArgs.push({ prefix, opts });
      return listResult || { data: [], error: null };
    }),
    upload: vi.fn(async (path, buffer, options) => {
      calls.uploadArgs.push({ path, buffer, options });
      if (uploadError) {
        return { data: null, error: { message: uploadError } };
      }
      return { data: { path }, error: null };
    }),
    remove: vi.fn(async (paths) => {
      calls.removeArgs.push(paths);
      if (removeError) {
        return { data: null, error: { message: removeError } };
      }
      return { data: paths, error: null };
    }),
    createSignedUrl: vi.fn(async (path, ttl) => {
      calls.signedArgs.push({ path, ttl });
      return (
        signedUrlResult || {
          data: { signedUrl: `https://signed.test/${path}?ttl=${ttl}` },
          error: null,
        }
      );
    }),
  };

  return {
    client: { storage: { from: vi.fn(() => storage) } },
    calls,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("uploadDraftFile", () => {
  const driverUserId = "11111111-2222-3333-4444-555555555555";
  const cargaId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const file = Buffer.from("PNG bytes here");

  it("(a) happy path com driver_user_id", async () => {
    const { client, calls } = makeFakeStorage();

    const result = await uploadDraftFile({
      ownerKey: driverUserId,
      cargaId,
      slot: "motorista_cnh",
      file,
      size: file.length,
      contentType: "image/png",
      originalFilename: "cnh.png",
      correlationId: "corr-A",
      supabaseClient: client,
    });

    expect(result.statusCode).toBe(200);
    expect(result.payload.slot).toBe("motorista_cnh");
    expect(result.payload.storage_path).toMatch(
      new RegExp(`^${driverUserId}/${cargaId}/motorista_cnh_\\d+\\.png$`),
    );
    expect(result.payload.signed_url).toContain("https://signed.test/");
    expect(result.payload.content_type).toBe("image/png");
    expect(result.payload.size).toBe(file.length);
    expect(result.payload.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(calls.uploadArgs).toHaveLength(1);
    expect(calls.uploadArgs[0].options).toEqual({
      contentType: "image/png",
      upsert: false,
    });
  });

  it("(b) happy path com cpf anonimo", async () => {
    const { client, calls } = makeFakeStorage();
    const cpf = "12345678901";

    const result = await uploadDraftFile({
      ownerKey: cpf,
      cargaId,
      slot: "cavalo_crlv",
      file,
      size: file.length,
      contentType: "application/pdf",
      correlationId: "corr-B",
      supabaseClient: client,
    });

    expect(result.statusCode).toBe(200);
    expect(result.payload.storage_path).toMatch(
      new RegExp(`^${cpf}/${cargaId}/cavalo_crlv_\\d+\\.pdf$`),
    );
    expect(calls.uploadArgs[0].path).toBe(result.payload.storage_path);
  });

  it("(c) slot invalido retorna 400 INVALID_SLOT", async () => {
    const { client } = makeFakeStorage();

    const result = await uploadDraftFile({
      ownerKey: driverUserId,
      cargaId,
      slot: "slot_inventado",
      file,
      size: file.length,
      contentType: "image/png",
      supabaseClient: client,
    });

    expect(result.statusCode).toBe(400);
    expect(result.payload.error).toBe("INVALID_SLOT");
  });

  it("(d) storage.upload falha retorna 502 STORAGE_UNAVAILABLE", async () => {
    const { client } = makeFakeStorage({ uploadError: "boom" });

    const result = await uploadDraftFile({
      ownerKey: driverUserId,
      cargaId,
      slot: "motorista_cnh",
      file,
      size: file.length,
      contentType: "image/png",
      supabaseClient: client,
    });

    expect(result.statusCode).toBe(502);
    expect(result.payload.error).toBe("STORAGE_UNAVAILABLE");
  });

  it("(e) remove arquivos antigos do mesmo slot antes do upload novo", async () => {
    const oldFiles = [
      { name: "motorista_cnh_111.png" },
      { name: "motorista_cnh_222.png" },
      { name: "cavalo_crlv_333.pdf" }, // outro slot — nao deve ser removido
    ];
    const { client, calls } = makeFakeStorage({
      listResult: { data: oldFiles, error: null },
    });

    await uploadDraftFile({
      ownerKey: driverUserId,
      cargaId,
      slot: "motorista_cnh",
      file,
      size: file.length,
      contentType: "image/png",
      supabaseClient: client,
    });

    expect(calls.listArgs).toHaveLength(1);
    expect(calls.listArgs[0].prefix).toBe(`${driverUserId}/${cargaId}`);
    expect(calls.removeArgs).toHaveLength(1);
    expect(calls.removeArgs[0]).toEqual([
      `${driverUserId}/${cargaId}/motorista_cnh_111.png`,
      `${driverUserId}/${cargaId}/motorista_cnh_222.png`,
    ]);
  });

  it("(f) contentType nao suportado retorna 415", async () => {
    const { client } = makeFakeStorage();

    const result = await uploadDraftFile({
      ownerKey: driverUserId,
      cargaId,
      slot: "motorista_cnh",
      file,
      size: file.length,
      contentType: "application/zip",
      supabaseClient: client,
    });

    expect(result.statusCode).toBe(415);
    expect(result.payload.error).toBe("UNSUPPORTED_TYPE");
  });

  it("(g) arquivo > 8MB retorna 413 FILE_TOO_LARGE", async () => {
    const { client } = makeFakeStorage();

    const result = await uploadDraftFile({
      ownerKey: driverUserId,
      cargaId,
      slot: "motorista_cnh",
      file,
      size: 9 * 1024 * 1024,
      contentType: "image/png",
      supabaseClient: client,
    });

    expect(result.statusCode).toBe(413);
    expect(result.payload.error).toBe("FILE_TOO_LARGE");
  });

  it("allowlist VALID_DRAFT_SLOTS contem todos os 15 slots esperados", () => {
    // 15 = 14 originais + motorista_selfie_cnh (adicionado em 2026-05-16
    // junto com o feature A1bSelfie do wizard).
    expect(VALID_DRAFT_SLOTS.size).toBe(15);
    expect(VALID_DRAFT_SLOTS.has("motorista_cnh")).toBe(true);
    expect(VALID_DRAFT_SLOTS.has("motorista_selfie_cnh")).toBe(true);
    expect(VALID_DRAFT_SLOTS.has("carreta_owner_comprovante_1")).toBe(true);
  });
});
