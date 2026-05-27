import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Testes do handler HTTP upload-draft-file.
 *
 * Mocka requireDriverSession (auth) e uploadDraftFile (use case). Simula
 * `req.file` populado pelo multer.memoryStorage.
 *
 * Cobre:
 *   - 200 happy path com Bearer driver
 *   - 200 happy path anonimo com cpf no body
 *   - 401 sem auth e sem cpf
 *   - 400 file ausente (multer nao preencheu req.file)
 *   - 422 schema falha (cargaId nao UUID)
 *   - 403 ForbiddenError no requireDriverSession
 */

vi.mock("../../../infrastructure/config/load-env.js", () => ({}));

vi.mock("../../../application/load-claims/auth.js", () => ({
  requireDriverSession: vi.fn(),
}));

vi.mock("../../../application/candidatura/use-cases/upload-draft-file.js", () => ({
  uploadDraftFile: vi.fn(),
}));

import { ForbiddenError, UnauthorizedError } from "../../../domain/load-claims/errors.js";
import { requireDriverSession } from "../../../application/load-claims/auth.js";
import { uploadDraftFile } from "../../../application/candidatura/use-cases/upload-draft-file.js";
import { resolveUploadDraftFileResponse } from "./upload-draft-file.handler.js";

const DRIVER_ID = "11111111-2222-3333-4444-555555555555";
const CARGA_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeRequest({ headers = {}, body = {}, file } = {}) {
  return {
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    body,
    file,
  };
}

function makeFile({ size = 1024, mimetype = "image/png", originalname = "x.png" } = {}) {
  return {
    buffer: Buffer.from("png-data"),
    size,
    mimetype,
    originalname,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveUploadDraftFileResponse", () => {
  it("200 happy path com Bearer driver", async () => {
    requireDriverSession.mockResolvedValue({ user: { id: DRIVER_ID } });
    uploadDraftFile.mockResolvedValue({
      statusCode: 200,
      payload: { storage_path: "ok-path", slot: "motorista_cnh" },
    });

    const result = await resolveUploadDraftFileResponse(
      makeRequest({
        headers: { authorization: "Bearer abc" },
        body: { cargaId: CARGA_ID, slot: "motorista_cnh" },
        file: makeFile(),
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(uploadDraftFile).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerKey: DRIVER_ID,
        cargaId: CARGA_ID,
        slot: "motorista_cnh",
      }),
    );
  });

  it("200 happy path anonimo com cpf no body", async () => {
    requireDriverSession.mockRejectedValue(new UnauthorizedError("no token"));
    uploadDraftFile.mockResolvedValue({
      statusCode: 200,
      payload: { storage_path: "ok-anon" },
    });

    const result = await resolveUploadDraftFileResponse(
      makeRequest({
        body: { cargaId: CARGA_ID, slot: "cavalo_crlv", cpf: "12345678901" },
        file: makeFile({ mimetype: "application/pdf", originalname: "crlv.pdf" }),
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(uploadDraftFile).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerKey: "12345678901",
        slot: "cavalo_crlv",
      }),
    );
  });

  it("401 sem auth e sem cpf no body", async () => {
    requireDriverSession.mockRejectedValue(new UnauthorizedError("no token"));

    const result = await resolveUploadDraftFileResponse(
      makeRequest({
        body: { cargaId: CARGA_ID, slot: "motorista_cnh" },
        file: makeFile(),
      }),
    );

    expect(result.statusCode).toBe(401);
    expect(result.payload.error).toBe("Unauthorized");
    expect(uploadDraftFile).not.toHaveBeenCalled();
  });

  it("400 quando file ausente (multer nao preencheu req.file)", async () => {
    requireDriverSession.mockResolvedValue({ user: { id: DRIVER_ID } });

    const result = await resolveUploadDraftFileResponse(
      makeRequest({
        headers: { authorization: "Bearer abc" },
        body: { cargaId: CARGA_ID, slot: "motorista_cnh" },
      }),
    );

    expect(result.statusCode).toBe(400);
    expect(result.payload.error).toBe("FILE_REQUIRED");
  });

  it("422 quando cargaId nao e UUID", async () => {
    requireDriverSession.mockResolvedValue({ user: { id: DRIVER_ID } });

    const result = await resolveUploadDraftFileResponse(
      makeRequest({
        headers: { authorization: "Bearer abc" },
        body: { cargaId: "not-a-uuid", slot: "motorista_cnh" },
        file: makeFile(),
      }),
    );

    expect(result.statusCode).toBe(422);
    expect(result.payload.error).toBe("ValidationError");
  });

  it("422 quando slot fora da allowlist", async () => {
    requireDriverSession.mockResolvedValue({ user: { id: DRIVER_ID } });

    const result = await resolveUploadDraftFileResponse(
      makeRequest({
        headers: { authorization: "Bearer abc" },
        body: { cargaId: CARGA_ID, slot: "slot_invalido" },
        file: makeFile(),
      }),
    );

    expect(result.statusCode).toBe(422);
  });

  it("403 quando requireDriverSession lanca ForbiddenError", async () => {
    requireDriverSession.mockRejectedValue(new ForbiddenError("not a driver"));

    const result = await resolveUploadDraftFileResponse(
      makeRequest({
        headers: { authorization: "Bearer abc" },
        body: { cargaId: CARGA_ID, slot: "motorista_cnh" },
        file: makeFile(),
      }),
    );

    expect(result.statusCode).toBe(403);
    expect(result.payload.error).toBe("Forbidden");
  });
});
