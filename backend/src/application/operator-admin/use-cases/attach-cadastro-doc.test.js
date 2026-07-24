import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedPendingRegistration,
  withPgClient,
  withPgTransaction,
} from "../test-harness.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));

// OCR sidecar — 4 extractors mockados (nunca lançam).
const { cnhMock, comprovanteMock, crlvMock, cartaoMock } = vi.hoisted(() => ({
  cnhMock: vi.fn(),
  comprovanteMock: vi.fn(),
  crlvMock: vi.fn(),
  cartaoMock: vi.fn(),
}));
vi.mock("../../repom/ocr-sidecar-client.js", () => ({
  extractCnhFromMedia: cnhMock,
  extractComprovanteFromMedia: comprovanteMock,
  extractCrlvFromMedia: crlvMock,
  extractCartaoCnpjFromMedia: cartaoMock,
}));

// upload-draft-file: mantém VALID_DRAFT_SLOTS/DRAFT_FILE_BUCKET reais e mocka só
// o uploadDraftFile (o storage real não roda no teste). O storage_path devolvido
// codifica o slot p/ provar que o backend derivou o slot certo.
const { uploadMock } = vi.hoisted(() => ({ uploadMock: vi.fn() }));
vi.mock("../../candidatura/use-cases/upload-draft-file.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, uploadDraftFile: uploadMock };
});

vi.mock("../../../infrastructure/security-audit.js", () => ({ insertSecurityAuditEvent: vi.fn() }));

const { attachCadastroDocument } = await import("./attach-cadastro-doc.js");

async function getDados(id) {
  const { rows } = await query(`SELECT dados FROM public.pending_driver_registrations WHERE id = $1`, [id]);
  return rows[0]?.dados;
}

const FILE = Buffer.from("fake-doc-bytes");
const baseArgs = { file: FILE, size: FILE.length, contentType: "image/jpeg", originalFilename: "doc.jpg" };

describe("attachCadastroDocument (integração pg-mem)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
    // Upload sempre OK; o path codifica o slot escolhido pelo backend.
    uploadMock.mockImplementation(async ({ ownerKey, cargaId, slot }) => ({
      statusCode: 200,
      payload: { storage_path: `${ownerKey}/${cargaId}/${slot}_999.jpg`, slot },
    }));
    cnhMock.mockResolvedValue({ ok: false, requiresUpload: true });
    comprovanteMock.mockResolvedValue({ ok: false, requiresUpload: true });
    crlvMock.mockResolvedValue({ ok: false, requiresUpload: true });
    cartaoMock.mockResolvedValue({ ok: false, requiresUpload: true });
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("cadastro inexistente → { notFound }", async () => {
    const r = await attachCadastroDocument({ id: crypto.randomUUID(), docKind: "crlv", target: "cavalo", ...baseArgs });
    expect(r).toEqual({ notFound: true });
  });

  it("combinação inválida (motorista fora do escopo v1) → { invalid: BAD_TARGET }", async () => {
    const { id } = await seedPendingRegistration({ dados: { motorista: { cpf: "11111111111", cnh_url: "o/c/motorista_cnh_1.jpg" } } });
    const r = await attachCadastroDocument({ id, docKind: "cnh", target: "motorista", ...baseArgs });
    expect(r).toEqual({ invalid: "BAD_TARGET" });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("CRLV do cavalo: grava crlv_url (slot cavalo_crlv) + mescla campos; placa preservada; NÃO persiste", async () => {
    const { id } = await seedPendingRegistration({
      dados: {
        motorista: { cpf: "11111111111", cnh_url: "own/car/motorista_cnh_1.jpg" },
        cavalo: { placa: "ABC1D23", marca: "MARCA ANTIGA" },
      },
    });
    crlvMock.mockResolvedValue({ ok: true, provider: "infosimples", fields: { marca_modelo: "VOLVO/FH 540", ano_modelo: "2020", placa: "ZZZ9Z99" } });

    const r = await attachCadastroDocument({ id, docKind: "crlv", target: "cavalo", ...baseArgs });

    // Deriva a pasta de colunas confiáveis (CPF + carga=id), NÃO de *_url; slot canônico cavalo_crlv.
    expect(uploadMock).toHaveBeenCalledWith(expect.objectContaining({ ownerKey: "11111111111", cargaId: id, slot: "cavalo_crlv" }));
    expect(r.dados.cavalo.crlv_url).toBe(`11111111111/${id}/cavalo_crlv_999.jpg`);
    expect(r.dados.cavalo.marca).toBe("VOLVO"); // OCR mesclado
    expect(r.dados.cavalo.ano).toBe(2020);
    expect(r.dados.cavalo.placa).toBe("ABC1D23"); // identidade NÃO tocada
    expect(r.report.ok).toBe(true);

    // NÃO persiste: a linha no banco continua sem crlv_url.
    const persisted = await getDados(id);
    expect(persisted.cavalo.crlv_url).toBeUndefined();
    expect(persisted.cavalo.marca).toBe("MARCA ANTIGA");
  });

  it("Owner CNH (PF) em owner VAZIO: preenche owner_doc_url + doc/tipo (cpf/pf) + nome", async () => {
    const { id } = await seedPendingRegistration({
      dados: {
        motorista: { cpf: "11111111111", cnh_url: "own/car/motorista_cnh_1.jpg" },
        cavalo: { placa: "ABC1D23" },
        cavalo_owner: {}, // owner faltante
      },
    });
    cnhMock.mockResolvedValue({ ok: true, fields: { nome: "JOSE PROPRIETARIO", cpf: "22233344455", registro: "99988877766", categoria: "E" } });

    const r = await attachCadastroDocument({ id, docKind: "owner-cnh", target: "cavalo_owner", ...baseArgs });

    expect(uploadMock).toHaveBeenCalledWith(expect.objectContaining({ slot: "cavalo_owner_cnh" }));
    expect(r.dados.cavalo_owner.owner_doc_url).toBe(`11111111111/${id}/cavalo_owner_cnh_999.jpg`);
    expect(r.dados.cavalo_owner.doc).toBe("22233344455"); // doc preenchido (owner era vazio)
    expect(r.dados.cavalo_owner.tipo).toBe("pf");
    expect(r.dados.cavalo_owner.nome).toBe("JOSE PROPRIETARIO");
    expect(r.dados.cavalo_owner).not.toHaveProperty("data_nascimento"); // ownerSchema não tem
  });

  it("Owner cartão-CNPJ (PJ) em owner vazio: doc/tipo = cnpj/pj + razão social", async () => {
    const { id } = await seedPendingRegistration({
      dados: { motorista: { cpf: "11111111111", cnh_url: "own/car/motorista_cnh_1.jpg" }, carreta_owners: [{}] },
    });
    cartaoMock.mockResolvedValue({ ok: true, fields: { razao_social: "TRANSPORTES X LTDA", cnpj: "12345678000199" } });

    const r = await attachCadastroDocument({ id, docKind: "cartao-cnpj", target: "carreta_owners.0", ...baseArgs });

    expect(uploadMock).toHaveBeenCalledWith(expect.objectContaining({ slot: "carreta_owner_cnh_0" }));
    expect(r.dados.carreta_owners[0].owner_doc_url).toBe(`11111111111/${id}/carreta_owner_cnh_0_999.jpg`);
    expect(r.dados.carreta_owners[0].doc).toBe("12345678000199");
    expect(r.dados.carreta_owners[0].tipo).toBe("pj");
    expect(r.dados.carreta_owners[0].nome).toBe("TRANSPORTES X LTDA");
  });

  it("Owner com doc EXISTENTE: identidade NÃO é sobrescrita (só nome/campos do OCR)", async () => {
    const { id } = await seedPendingRegistration({
      dados: {
        motorista: { cpf: "11111111111", cnh_url: "own/car/motorista_cnh_1.jpg" },
        cavalo_owner: { tipo: "pf", doc: "55566677788", nome: "NOME ANTIGO" },
      },
    });
    cnhMock.mockResolvedValue({ ok: true, fields: { nome: "NOME NOVO", cpf: "99999999999" } });

    const r = await attachCadastroDocument({ id, docKind: "owner-cnh", target: "cavalo_owner", ...baseArgs });
    expect(r.dados.cavalo_owner.doc).toBe("55566677788"); // doc existente PRESERVADO
    expect(r.dados.cavalo_owner.tipo).toBe("pf");
    expect(r.dados.cavalo_owner.nome).toBe("NOME NOVO"); // nome atualizado pelo OCR
  });

  it("Comprovante do owner: grava endereco.comprovante_storage_path mesmo com OCR incompleto", async () => {
    const { id } = await seedPendingRegistration({
      dados: {
        motorista: { cpf: "11111111111", cnh_url: "own/car/motorista_cnh_1.jpg" },
        cavalo_owner: { tipo: "pf", doc: "55566677788", nome: "DONO" },
      },
    });
    // OCR do comprovante incompleto (só bairro) → não cria endereco novo, mas o *_url entra.
    comprovanteMock.mockResolvedValue({ ok: true, fields: { bairro: "Centro" } });

    const r = await attachCadastroDocument({ id, docKind: "comprovante", target: "cavalo_owner", ...baseArgs });
    expect(uploadMock).toHaveBeenCalledWith(expect.objectContaining({ slot: "cavalo_owner_comprovante" }));
    expect(r.dados.cavalo_owner.endereco.comprovante_storage_path).toBe(`11111111111/${id}/cavalo_owner_comprovante_999.jpg`);
  });

  it("Comprovante em owner AUSENTE (sem doc) → { invalid: OWNER_ABSENT }, sem upload (não cria owner sem tipo/doc/nome)", async () => {
    const { id } = await seedPendingRegistration({
      dados: { motorista: { cpf: "11111111111" }, cavalo: { placa: "ABC1D23" }, cavalo_owner: {} },
    });
    const r = await attachCadastroDocument({ id, docKind: "comprovante", target: "cavalo_owner", ...baseArgs });
    expect(r).toEqual({ invalid: "OWNER_ABSENT" });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("owner-cnh: uf_emissor por extenso (estado_emissor) é DESCARTADO (ownerSchema.cnh.uf_emissor = length 2)", async () => {
    const { id } = await seedPendingRegistration({
      dados: { motorista: { cpf: "11111111111" }, cavalo_owner: {} },
    });
    cnhMock.mockResolvedValue({ ok: true, fields: { nome: "X", cpf: "22233344455", registro: "123", estado_emissor: "SAO PAULO" } });
    const r = await attachCadastroDocument({ id, docKind: "owner-cnh", target: "cavalo_owner", ...baseArgs });
    expect(r.dados.cavalo_owner.cnh.registro).toBe("123"); // bloco cnh existe
    expect(r.dados.cavalo_owner.cnh.uf_emissor).toBeUndefined(); // UF por extenso NÃO gravada
  });

  it("OCR falha: o *_url ainda é gravado (anexar é a ação primária), report ok:false", async () => {
    const { id } = await seedPendingRegistration({
      dados: { motorista: { cpf: "11111111111", cnh_url: "own/car/motorista_cnh_1.jpg" }, cavalo: { placa: "ABC1D23" } },
    });
    crlvMock.mockResolvedValue({ ok: false, code: 612, codeMessage: "não localizado", requiresUpload: true });

    const r = await attachCadastroDocument({ id, docKind: "crlv", target: "cavalo", ...baseArgs });
    expect(r.dados.cavalo.crlv_url).toBe(`11111111111/${id}/cavalo_crlv_999.jpg`); // url gravada
    expect(r.report.ok).toBe(false);
    expect(r.report.filled).toEqual([]);
  });

  it("sem doc anterior: pasta cai no CPF + carga_id/id (fallback)", async () => {
    const { id } = await seedPendingRegistration({ dados: { motorista: { cpf: "11111111111" }, cavalo: { placa: "ABC1D23" } } });
    await attachCadastroDocument({ id, docKind: "crlv", target: "cavalo", ...baseArgs });
    // ownerKey = CPF; cargaId = id_cadastro||id (aqui = id, pois seed não seta id_cadastro).
    expect(uploadMock).toHaveBeenCalledWith(expect.objectContaining({ ownerKey: "11111111111", cargaId: id }));
  });

  it("cadastro migrado (docs em migrados/): ignora essa pasta e deriva pelo CPF", async () => {
    const { id } = await seedPendingRegistration({
      dados: {
        motorista: { cpf: "03712810679" },
        // Migrado: todos os docs em migrados/<id>/ (share local, não cadastro-drafts).
        cavalo: { placa: "KBR1B79", crlv_url: "migrados/1016/cavalo_crlv.pdf" },
        carretas: [{ placa: "XYZ0A11" }],
        carreta_owners: [{}],
      },
    });
    crlvMock.mockResolvedValue({ ok: true, fields: { marca_modelo: "RANDON/SR" } });
    await attachCadastroDocument({ id, docKind: "owner-cnh", target: "carreta_owners.0", ...baseArgs });
    // NÃO usa a pasta migrados/1016; cai no CPF + carga (id_cadastro||id = id aqui).
    expect(uploadMock).toHaveBeenCalledWith(
      expect.objectContaining({ ownerKey: "03712810679", cargaId: id, slot: "carreta_owner_cnh_0" }),
    );
  });

  it("índice de carreta fora do range (>=2) → BAD_TARGET", async () => {
    const { id } = await seedPendingRegistration({ dados: { motorista: { cpf: "11111111111", cnh_url: "o/c/motorista_cnh_1.jpg" } } });
    const r = await attachCadastroDocument({ id, docKind: "crlv", target: "carretas.2", ...baseArgs });
    expect(r).toEqual({ invalid: "BAD_TARGET" });
  });
});
