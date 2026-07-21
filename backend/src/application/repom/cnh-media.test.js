import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  withPgClient,
  withPgTransaction,
} from "../operator-admin/test-harness.js";

vi.mock("../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));

// uploadDraftFile toca Supabase Storage — mock: capturamos os argumentos.
const { uploadMock } = vi.hoisted(() => ({ uploadMock: vi.fn() }));
vi.mock("../candidatura/use-cases/upload-draft-file.js", () => ({
  uploadDraftFile: uploadMock,
  DRAFT_FILE_BUCKET: "cadastro-drafts",
}));

const { claimMessageOnce, sha256Base64, stageCnhMedia } = await import("./cnh-media.js");

// base64 de "cnh-bytes" (conteúdo qualquer, > 0 bytes)
const B64 = Buffer.from("cnh-bytes").toString("base64");

describe("repom cnh-media (Fase 3b — blocos)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
    uploadMock.mockResolvedValue({ statusCode: 200, payload: { storage_path: "12345678901/repom/motorista_cnh_1.jpg" } });
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  describe("claimMessageOnce", () => {
    it("primeira vez = true; reentrega do mesmo id = false (idempotente)", async () => {
      const first = await withPgClient((c) => claimMessageOnce(c, { externalId: "MSG-1", phone: "5571988887777" }));
      const again = await withPgClient((c) => claimMessageOnce(c, { externalId: "MSG-1", phone: "5571988887777" }));
      expect(first).toBe(true);
      expect(again).toBe(false);
      const { rows } = await query(`SELECT count(*)::int AS n FROM public.repom_processed_messages`);
      expect(rows[0].n).toBe(1);
    });

    it("sem external_id → processa (true), sem gravar", async () => {
      const r = await withPgClient((c) => claimMessageOnce(c, { externalId: null, phone: "5571988887777" }));
      expect(r).toBe(true);
      const { rows } = await query(`SELECT count(*)::int AS n FROM public.repom_processed_messages`);
      expect(rows[0].n).toBe(0);
    });
  });

  describe("sha256Base64", () => {
    it("é determinístico e muda com o conteúdo", () => {
      expect(sha256Base64(B64)).toBe(sha256Base64(B64));
      expect(sha256Base64(B64)).not.toBe(sha256Base64(Buffer.from("outro").toString("base64")));
    });
  });

  describe("stageCnhMedia", () => {
    it("sucesso: chama uploadDraftFile com slot/owner/carga certos e devolve storagePath + sha256", async () => {
      const r = await stageCnhMedia({ cpf: "123.456.789-01", base64: B64, mimetype: "image/jpeg", correlationId: "c1" });
      expect(r).toMatchObject({ ok: true, storagePath: expect.stringContaining("motorista_cnh") });
      expect(r.sha256).toBe(sha256Base64(B64));
      const arg = uploadMock.mock.calls[0][0];
      expect(arg).toMatchObject({ ownerKey: "12345678901", cargaId: "repom", slot: "motorista_cnh", contentType: "image/jpeg" });
      expect(Buffer.isBuffer(arg.file)).toBe(true);
      expect(arg.size).toBe(Buffer.from(B64, "base64").length);
    });

    it("CPF inválido → não chama upload", async () => {
      const r = await stageCnhMedia({ cpf: "123", base64: B64, mimetype: "image/jpeg" });
      expect(r).toMatchObject({ ok: false, reason: "invalid_cpf" });
      expect(uploadMock).not.toHaveBeenCalled();
    });

    it("mídia vazia → empty_media, sem upload", async () => {
      const r = await stageCnhMedia({ cpf: "12345678901", base64: "", mimetype: "image/jpeg" });
      expect(r).toMatchObject({ ok: false, reason: "empty_media" });
      expect(uploadMock).not.toHaveBeenCalled();
    });

    it("tipo não suportado (uploadDraftFile 415) → unsupported_type", async () => {
      uploadMock.mockResolvedValue({ statusCode: 415, payload: { error: "UNSUPPORTED_TYPE" } });
      const r = await stageCnhMedia({ cpf: "12345678901", base64: B64, mimetype: "image/webp" });
      expect(r).toMatchObject({ ok: false, reason: "unsupported_type", statusCode: 415 });
    });

    it("storage fora do ar (502) → storage_unavailable", async () => {
      uploadMock.mockResolvedValue({ statusCode: 502, payload: { error: "STORAGE_UNAVAILABLE" } });
      const r = await stageCnhMedia({ cpf: "12345678901", base64: B64, mimetype: "application/pdf" });
      expect(r).toMatchObject({ ok: false, reason: "storage_unavailable", statusCode: 502 });
    });
  });
});
