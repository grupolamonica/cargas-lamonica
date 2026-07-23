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

// OCR sidecar — mock dos 4 extractors (nunca lançam; { ok, fields } | { ok:false }).
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

// Storage admin client — mock do download (retorna Buffer).
const { downloadMock } = vi.hoisted(() => ({ downloadMock: vi.fn() }));
vi.mock("../../load-claims/auth.js", () => ({
  getAdminClient: () => ({ storage: { from: () => ({ download: downloadMock }) } }),
}));

// Auditoria — no-op nos testes.
vi.mock("../../../infrastructure/security-audit.js", () => ({ insertSecurityAuditEvent: vi.fn() }));

const { reprocessCadastroDocuments, buildVeiculoFromCrlvFields, buildOwnerFromCartaoCnpjFields } =
  await import("./reprocess-cadastro-docs.js");

async function getDados(id) {
  const { rows } = await query(`SELECT dados FROM public.pending_driver_registrations WHERE id = $1`, [id]);
  return rows[0]?.dados;
}

describe("reprocessCadastroDocuments (integração pg-mem)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
    // Download sempre entrega bytes (o base64 exato não importa — o OCR é mock).
    downloadMock.mockResolvedValue({ data: Buffer.from("fake-bytes"), error: null });
    cnhMock.mockResolvedValue({ ok: false, requiresUpload: true });
    comprovanteMock.mockResolvedValue({ ok: false, requiresUpload: true });
    crlvMock.mockResolvedValue({ ok: false, requiresUpload: true });
    cartaoMock.mockResolvedValue({ ok: false, requiresUpload: true });
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("cadastro inexistente → { notFound }", async () => {
    const r = await reprocessCadastroDocuments({ id: crypto.randomUUID() });
    expect(r).toEqual({ notFound: true });
  });

  it("sem documentos anexados → changed:false, report vazio", async () => {
    const { id } = await seedPendingRegistration({
      status: "pendente",
      dados: { motorista: { cpf: "11111111111", nome: "SEM DOCS" } },
    });
    const r = await reprocessCadastroDocuments({ id });
    expect(r.changed).toBe(false);
    expect(r.report).toEqual([]);
  });

  it("re-OCR mescla CNH+comprovante+CRLV+cartão CNPJ preservando identidade/urls", async () => {
    const { id } = await seedPendingRegistration({
      status: "pendente",
      dados: {
        motorista: {
          cpf: "11111111111",
          nome: "NOME ANTIGO",
          cnh_url: "owner/carga/cnh_1.jpg",
          comprovante_url: "owner/carga/comprovante_1.jpg",
          endereco: { cep: "40000000", comprovante_storage_path: "owner/carga/comprovante_1.jpg" },
          telefones: ["71988887777"],
        },
        cavalo: {
          placa: "ABC1D23",
          crlv_url: "owner/carga/crlv_cavalo_1.jpg",
          owner_doc: "12345678000199",
          owner_doc_type: "cnpj",
          marca: "MARCA ANTIGA",
        },
        cavalo_owner: {
          tipo: "pj",
          doc: "12345678000199",
          nome: "RAZAO ANTIGA",
          owner_doc_url: "owner/carga/cartao_cnpj_1.jpg",
        },
      },
    });

    cnhMock.mockResolvedValue({
      ok: true,
      provider: "infosimples",
      fields: { nome: "JOAO DA SILVA", registro: "12345678901", categoria: "E", validade: "12/2028" },
    });
    comprovanteMock.mockResolvedValue({
      ok: true,
      fields: { cep: "41500000", logradouro: "Rua Nova", numero: "10", bairro: "Centro", municipio_uf: "Salvador - BA" },
    });
    crlvMock.mockResolvedValue({
      ok: true,
      fields: { marca_modelo: "VOLVO/FH 540", ano_modelo: "2020", ano_fabricacao: "2019", cor: "BRANCA", placa: "ZZZ9Z99" },
    });
    cartaoMock.mockResolvedValue({
      ok: true,
      // endereco COMPLETO (cep+logradouro+numero) — senão o sanitizador não cria
      // endereco novo incompleto no owner (que não tinha endereco).
      fields: { razao_social: "TRANSPORTES NOVA LTDA", cep: "01000000", uf: "SP", municipio: "Sao Paulo", logradouro: "Av. Paulista", numero: "1000" },
    });

    const r = await reprocessCadastroDocuments({ id, operatorId: "op-1" });
    expect(r.changed).toBe(true);

    const dados = await getDados(id);

    // Motorista: nome sobrescrito, CPF da sessão PRESERVADO, bloco cnh mesclado, url intacta.
    expect(dados.motorista.nome).toBe("JOAO DA SILVA");
    expect(dados.motorista.cpf).toBe("11111111111");
    expect(dados.motorista.cnh.registro).toBe("12345678901");
    expect(dados.motorista.cnh.categoria).toBe("E");
    expect(dados.motorista.cnh_url).toBe("owner/carga/cnh_1.jpg");
    expect(dados.motorista.telefones).toEqual(["71988887777"]);

    // Endereço (comprovante): merge preservando comprovante_storage_path.
    expect(dados.motorista.endereco.cep).toBe("41500000");
    expect(dados.motorista.endereco.logradouro).toBe("Rua Nova");
    expect(dados.motorista.endereco.cidade).toBe("Salvador");
    expect(dados.motorista.endereco.uf).toBe("BA");
    expect(dados.motorista.endereco.comprovante_storage_path).toBe("owner/carga/comprovante_1.jpg");

    // Cavalo (CRLV): marca sobrescrita, ano int, PLACA e crlv_url e owner_doc PRESERVADOS.
    expect(dados.cavalo.marca).toBe("VOLVO");
    expect(dados.cavalo.modelo).toBe("FH 540");
    expect(dados.cavalo.ano).toBe(2020);
    expect(dados.cavalo.ano_fabricacao).toBe(2019);
    expect(dados.cavalo.placa).toBe("ABC1D23"); // NÃO tocou (não é a placa "ZZZ9Z99" do OCR)
    expect(dados.cavalo.crlv_url).toBe("owner/carga/crlv_cavalo_1.jpg");
    expect(dados.cavalo.owner_doc).toBe("12345678000199");
    expect(dados.cavalo.owner_doc_type).toBe("cnpj");

    // Owner PJ (cartão CNPJ): razão social sobrescrita, doc/tipo/url PRESERVADOS.
    expect(dados.cavalo_owner.nome).toBe("TRANSPORTES NOVA LTDA");
    expect(dados.cavalo_owner.doc).toBe("12345678000199");
    expect(dados.cavalo_owner.tipo).toBe("pj");
    expect(dados.cavalo_owner.owner_doc_url).toBe("owner/carga/cartao_cnpj_1.jpg");
    expect(dados.cavalo_owner.endereco.uf).toBe("SP");

    // Relatório: 4 docs OK.
    expect(r.report.filter((d) => d.ok)).toHaveLength(4);
  });

  it("preenche CPF do motorista quando estava vazio (extraído da CNH)", async () => {
    const { id } = await seedPendingRegistration({
      status: "pendente",
      dados: { motorista: { nome: "SEM CPF", cnh_url: "owner/carga/cnh_1.jpg" } },
    });
    cnhMock.mockResolvedValue({ ok: true, fields: { nome: "COM CPF AGORA", cpf: "22233344455" } });

    const r = await reprocessCadastroDocuments({ id });
    expect(r.changed).toBe(true);
    const dados = await getDados(id);
    expect(dados.motorista.cpf).toBe("22233344455");
  });

  it("documento que o OCR não conseguiu ler → report ok:false e dados intactos", async () => {
    const { id } = await seedPendingRegistration({
      status: "pendente",
      dados: { motorista: { cpf: "11111111111", nome: "ORIGINAL", cnh_url: "owner/carga/cnh_1.jpg" } },
    });
    cnhMock.mockResolvedValue({ ok: false, code: 612, codeMessage: "não localizado", requiresUpload: true });

    const r = await reprocessCadastroDocuments({ id });
    expect(r.changed).toBe(false);
    expect(r.report[0]).toMatchObject({ label: "motorista.cnh", ok: false, code: 612 });
    const dados = await getDados(id);
    expect(dados.motorista.nome).toBe("ORIGINAL"); // não apagou nada
  });

  it("download que falha não derruba os outros documentos", async () => {
    const { id } = await seedPendingRegistration({
      status: "pendente",
      dados: {
        motorista: { cpf: "11111111111", nome: "X", cnh_url: "owner/carga/cnh_1.jpg" },
        cavalo: { placa: "ABC1D23", crlv_url: "owner/carga/crlv_1.jpg" },
      },
    });
    // CNH baixa OK; CRLV falha no download.
    downloadMock.mockImplementation(async (path) =>
      path.includes("crlv") ? { data: null, error: { message: "not found" } } : { data: Buffer.from("x"), error: null },
    );
    cnhMock.mockResolvedValue({ ok: true, fields: { nome: "NOVO NOME" } });
    crlvMock.mockResolvedValue({ ok: true, fields: { marca_modelo: "SCANIA/R450" } });

    const r = await reprocessCadastroDocuments({ id });
    const dados = await getDados(id);
    expect(dados.motorista.nome).toBe("NOVO NOME");
    // CRLV não foi lido → marca continua ausente e report marca falha.
    expect(dados.cavalo.marca).toBeUndefined();
    expect(r.report.find((d) => d.label === "cavalo.crlv")).toMatchObject({ ok: false });
    expect(crlvMock).not.toHaveBeenCalled(); // download falhou antes do OCR
  });

  it("sanitiza CEP/UF inválidos do comprovante (não corrompe endereco válido — invariante 2)", async () => {
    const { id } = await seedPendingRegistration({
      status: "pendente",
      dados: {
        motorista: {
          cpf: "11111111111",
          nome: "X",
          comprovante_url: "owner/carga/comprovante_1.jpg",
          endereco: { cep: "40000000", logradouro: "Rua Velha", numero: "5", uf: "BA" },
        },
      },
    });
    // OCR devolve CEP parcial e UF por extenso → devem ser DESCARTADOS.
    comprovanteMock.mockResolvedValue({ ok: true, fields: { cep: "4150", uf: "São Paulo", bairro: "Centro" } });

    await reprocessCadastroDocuments({ id });
    const dados = await getDados(id);
    expect(dados.motorista.endereco.cep).toBe("40000000"); // CEP válido preservado
    expect(dados.motorista.endereco.uf).toBe("BA"); // UF válida preservada
    expect(dados.motorista.endereco.bairro).toBe("Centro"); // campo válido novo entra
  });

  it("descarta rg_uf inválido da CNH (motoristaSchema.rg_uf length(2))", async () => {
    const { id } = await seedPendingRegistration({
      status: "pendente",
      dados: { motorista: { cpf: "11111111111", nome: "X", rg_uf: "MG", cnh_url: "owner/carga/cnh_1.jpg" } },
    });
    cnhMock.mockResolvedValue({ ok: true, fields: { nome: "NOVO", rg_uf: "MG9014856" } });

    await reprocessCadastroDocuments({ id });
    const dados = await getDados(id);
    expect(dados.motorista.nome).toBe("NOVO");
    expect(dados.motorista.rg_uf).toBe("MG"); // rg_uf inválido não sobrescreve o válido
  });

  it("não cria endereco NOVO incompleto no owner PJ (enderecoSchema exige cep+logradouro+numero)", async () => {
    const { id } = await seedPendingRegistration({
      status: "pendente",
      dados: {
        cavalo_owner: { tipo: "pj", doc: "12345678000199", nome: "X", owner_doc_url: "owner/carga/cartao_1.jpg" },
      },
    });
    // Cartão devolve só cep+uf+cidade (sem logradouro/numero) → endereco NÃO é criado.
    cartaoMock.mockResolvedValue({ ok: true, fields: { razao_social: "NOVA RAZAO LTDA", cep: "01000000", uf: "SP", municipio: "Sao Paulo" } });

    await reprocessCadastroDocuments({ id });
    const dados = await getDados(id);
    expect(dados.cavalo_owner.nome).toBe("NOVA RAZAO LTDA"); // nome entra
    expect(dados.cavalo_owner.endereco).toBeUndefined(); // endereco incompleto NÃO criado
  });

  it("merge sobre dados FRESCO: edição concorrente durante o OCR é preservada (anti lost-update)", async () => {
    const { id } = await seedPendingRegistration({
      status: "pendente",
      dados: {
        motorista: { cpf: "11111111111", nome: "ORIGINAL", cnh_url: "owner/carga/cnh_1.jpg" },
        cavalo: { placa: "ABC1D23", crlv_url: "owner/carga/crlv_1.jpg" },
      },
    });
    // Simula uma edição concorrente DURANTE o OCR: o mock da CNH corrige a placa
    // do cavalo (outra aba/operador) antes de o reprocess reler o dados.
    cnhMock.mockImplementation(async () => {
      const { rows } = await query(`SELECT dados FROM public.pending_driver_registrations WHERE id = $1`, [id]);
      const d = rows[0].dados;
      d.cavalo.placa = "XYZ4E56"; // correção manual da placa
      await query(`UPDATE public.pending_driver_registrations SET dados = $1::jsonb WHERE id = $2`, [JSON.stringify(d), id]);
      return { ok: true, fields: { nome: "NOME DA CNH" } };
    });
    crlvMock.mockResolvedValue({ ok: true, fields: { marca_modelo: "SCANIA/R450" } });

    await reprocessCadastroDocuments({ id });
    const dados = await getDados(id);
    expect(dados.cavalo.placa).toBe("XYZ4E56"); // correção concorrente PRESERVADA (não revertida)
    expect(dados.cavalo.marca).toBe("SCANIA"); // OCR do CRLV aplicado
    expect(dados.motorista.nome).toBe("NOME DA CNH"); // OCR da CNH aplicado
  });

  describe("mapeadores puros", () => {
    it("buildVeiculoFromCrlvFields: type-safe (ano int, uf 2 letras, ignora inválidos)", () => {
      const out = buildVeiculoFromCrlvFields({
        marca_modelo: "VOLVO/FH",
        ano_modelo: "2021",
        ano_fabricacao: "abc", // inválido → ignorado
        eixos: "6",
        uf_emplacamento: "BAHIA", // não são 2 letras → ignorado
        cor: "PRATA",
      });
      expect(out.marca).toBe("VOLVO");
      expect(out.modelo).toBe("FH");
      expect(out.ano).toBe(2021);
      expect(out).not.toHaveProperty("ano_fabricacao");
      expect(out.eixos).toBe(6);
      expect(out).not.toHaveProperty("uf_emplacamento");
      expect(out.cor).toBe("PRATA");
      // NUNCA inclui identidade/roteamento.
      expect(out).not.toHaveProperty("placa");
      expect(out).not.toHaveProperty("owner_doc");
      expect(out).not.toHaveProperty("crlv_url");
    });

    it("buildOwnerFromCartaoCnpjFields: nome + endereco, sem doc/tipo/url", () => {
      const out = buildOwnerFromCartaoCnpjFields({
        razao_social: "EMPRESA X LTDA",
        cep: "01000000",
        uf: "SP",
        municipio: "Sao Paulo",
      });
      expect(out.nome).toBe("EMPRESA X LTDA");
      expect(out.endereco).toMatchObject({ cep: "01000000", uf: "SP", cidade: "Sao Paulo" });
      expect(out).not.toHaveProperty("doc");
      expect(out).not.toHaveProperty("tipo");
      expect(out).not.toHaveProperty("owner_doc_url");
    });
  });
});
