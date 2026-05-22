import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Testes do submit-final (plan 07-04).
 *
 * Estrategia: mock de withPgTransaction passando um cliente fake que simula
 * `pending_driver_registrations` em memoria + sequence cadastro_protocolo_seq.
 * O resolveAnttCascade tambem e mockado para evitar I/O com o sidecar.
 *
 * Cenarios cobertos:
 *   (a) submit happy path → protocolo formato CAD-YYYY-NNNNN + status='pendente'
 *   (b) submit com owner==driver → auto-attribution + ANTT NAO roda para cavalo
 *   (c) idempotency: 2 submits mesma key → 1 row, mesmo protocolo, replay flag
 *   (d) submit com ocr_fallback_manual=true → ANTT roda assim mesmo
 *   (e) submit com carga_id ja aprovada → 409 conflict
 *   (f) sequence falha (nextval throw) → 500 com mensagem clara apontando plan 01
 */

// ── DB fake em memoria ──────────────────────────────────────────────────────
const fakeDb = {
  rows: [],
  audit: [],
  sequence: 0,
  sequenceFails: false,
};

const fakeClient = {
  async query(sql, params = []) {
    const norm = sql.replace(/\s+/g, " ").trim();

    // BEGIN/COMMIT/ROLLBACK do withPgTransaction.
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(norm)) {
      return { rows: [], rowCount: 0 };
    }

    // A3 — advisory lock por carga_id (best-effort no use case).
    if (/pg_advisory_xact_lock\(hashtext\('carga:' \|\| \$1::text\)\)/i.test(norm)) {
      return { rows: [{ pg_advisory_xact_lock: "" }], rowCount: 1 };
    }

    // SELECT idempotency check.
    if (/SELECT id, dados->>'protocolo' AS protocolo, status\s+FROM public\.pending_driver_registrations\s+WHERE id_cadastro = \$1/i.test(norm)) {
      const [idCadastro] = params;
      const matches = fakeDb.rows.filter((r) => r.id_cadastro === idCadastro);
      return {
        rows: matches.map((r) => ({
          id: r.id,
          protocolo: r.dados?.protocolo || null,
          status: r.status,
        })),
        rowCount: matches.length,
      };
    }

    // SELECT conflito carga aprovada.
    if (/SELECT id\s+FROM public\.pending_driver_registrations\s+WHERE carga_id = \$1\s+AND status = 'aprovado'/i.test(norm)) {
      const [cargaId] = params;
      const matches = fakeDb.rows.filter((r) => r.carga_id === cargaId && r.status === "aprovado");
      return { rows: matches.map((r) => ({ id: r.id })), rowCount: matches.length };
    }

    // SELECT sequence (protocolo).
    if (/SELECT to_char\(now\(\),'YYYY'\)\|\|'-'\|\|LPAD\(nextval\('public\.cadastro_protocolo_seq'\)::text,5,'0'\) AS protocolo/i.test(norm)) {
      if (fakeDb.sequenceFails) {
        const err = new Error("relation \"cadastro_protocolo_seq\" does not exist");
        err.code = "42P01";
        throw err;
      }
      fakeDb.sequence += 1;
      const year = new Date().getFullYear();
      const padded = String(fakeDb.sequence).padStart(5, "0");
      return { rows: [{ protocolo: `${year}-${padded}` }], rowCount: 1 };
    }

    // SELECT existing draft (FOR UPDATE) p/ converter em pendente.
    if (/SELECT id\s+FROM public\.pending_driver_registrations\s+WHERE driver_user_id = \$1\s+AND status = 'draft'\s+AND versao_cadastro = 'v2'\s+FOR UPDATE/i.test(norm)) {
      const [driverUserId] = params;
      const matches = fakeDb.rows.filter(
        (r) => r.driver_user_id === driverUserId && r.status === "draft" && r.versao_cadastro === "v2",
      );
      return { rows: matches.map((r) => ({ id: r.id })), rowCount: matches.length };
    }

    // UPDATE draft → pendente.
    if (/UPDATE public\.pending_driver_registrations\s+SET id_cadastro\s+= \$1,\s+status\s+= 'pendente',/i.test(norm)) {
      const [
        idCadastro,
        dadosJson,
        cargaId,
        pancary,
        bancariosJson,
        pis,
        cor,
        estadoCivil,
        rastreadorJson,
        rowId,
      ] = params;
      const row = fakeDb.rows.find((r) => r.id === rowId);
      if (!row) return { rows: [], rowCount: 0 };
      row.id_cadastro = idCadastro;
      row.status = "pendente";
      row.dados = JSON.parse(dadosJson);
      row.carga_id = cargaId;
      row.pancary_autodeclaration = pancary;
      row.pancary_validation_source = "autodeclaration";
      row.dados_bancarios = bancariosJson ? JSON.parse(bancariosJson) : null;
      row.pis = pis;
      row.cor_veiculo = cor;
      row.estado_civil = estadoCivil;
      row.rastreador_detalhes = rastreadorJson ? JSON.parse(rastreadorJson) : null;
      row.updated_at = new Date();
      return { rows: [], rowCount: 1 };
    }

    // INSERT novo (cadastro v2 com status='pendente').
    if (/INSERT INTO public\.pending_driver_registrations \([^)]*id_cadastro,\s*status,\s*versao_cadastro,\s*driver_user_id,\s*carga_id,\s*dados,\s*pancary_autodeclaration,/i.test(norm)) {
      const [
        idCadastro,
        driverUserId,
        cargaId,
        dadosJson,
        pancary,
        bancariosJson,
        pis,
        cor,
        estadoCivil,
        rastreadorJson,
      ] = params;
      const id = `row-${fakeDb.rows.length + 1}`;
      const row = {
        id,
        id_cadastro: idCadastro,
        status: "pendente",
        versao_cadastro: "v2",
        driver_user_id: driverUserId,
        carga_id: cargaId,
        dados: JSON.parse(dadosJson),
        pancary_autodeclaration: pancary,
        pancary_validation_source: "autodeclaration",
        dados_bancarios: bancariosJson ? JSON.parse(bancariosJson) : null,
        pis,
        cor_veiculo: cor,
        estado_civil: estadoCivil,
        rastreador_detalhes: rastreadorJson ? JSON.parse(rastreadorJson) : null,
        created_at: new Date(),
        updated_at: new Date(),
      };
      fakeDb.rows.push(row);
      return { rows: [{ id }], rowCount: 1 };
    }

    // INSERT security_audit.
    if (/INSERT INTO public\.security_audit_logs/i.test(norm)) {
      fakeDb.audit.push({ params });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`[fakeClient] query nao mockada: ${norm.slice(0, 140)}...`);
  },
};

// Mocks de modulo (antes do import dos use cases).
vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) => cb(fakeClient),
  withPgTransaction: async (cb) => cb(fakeClient),
}));

// Mock do resolveAnttCascade — evita I/O com sidecar.
const anttCascadeMock = vi.fn();
vi.mock("./antt-cascade.js", () => ({
  resolveAnttCascade: anttCascadeMock,
}));

const { submitCandidaturaFinal } = await import("./submit-final.js");

// ── Helpers ────────────────────────────────────────────────────────────────

function basePayload(overrides = {}) {
  // Payload minimo "happy path" — owner do cavalo NAO e o driver.
  return {
    motorista: {
      nome: "Antonio Tester",
      telefones: ["11999998888"],
      telefone_primario: "11999998888",
      endereco: {
        cep: "01310100",
        numero: "123",
        logradouro: "Av. Paulista",
        bairro: "Bela Vista",
        cidade: "Sao Paulo",
        uf: "SP",
      },
      tag_pedagio: "sem_parar",
      pancary_autodeclaration: "sim",
      rastreador: {
        empresa: "Sascar",
        login: "antonio",
        senha: "***",
        id_rastreador: "RT123",
      },
    },
    cavalo: {
      placa: "ABC1D23",
      renavam: "12345678901",
      chassi: "9BWZZZ377VT004251",
      marca: "Volvo",
      ano: 2022,
      cor: "Branca",
      owner_doc: "12345678000199",
      owner_doc_type: "cnpj",
    },
    cavalo_owner: {
      tipo: "pj",
      doc: "12345678000199",
      nome: "Transportadora X LTDA",
      dados_bancarios: {
        banco_compe: "001",
        banco_nome: "Banco do Brasil",
        agencia: "1234",
        conta: "56789-0",
        tipo: "corrente",
      },
    },
    carretas: [],
    carreta_owners: [],
    ...overrides,
  };
}

beforeEach(() => {
  fakeDb.rows = [];
  fakeDb.audit = [];
  fakeDb.sequence = 0;
  fakeDb.sequenceFails = false;
  anttCascadeMock.mockReset();
  anttCascadeMock.mockResolvedValue({
    rntrc: "55555555",
    tipo: "ETC",
    situacao: "ATIVO",
    validade: "2030-01-01",
    source: "antt-cascade-antt/transportador",
    attempts: [{ produto: "antt/transportador", code: 200 }],
  });
});

// ── Testes ─────────────────────────────────────────────────────────────────

describe("submitCandidaturaFinal — plan 07-04", () => {
  it("(a) submit happy path → 201 com protocolo CAD-YYYY-NNNNN persistido + status='pendente'", async () => {
    const result = await submitCandidaturaFinal({
      driverUserId: "11111111-1111-1111-1111-111111111111",
      driverCpf: "999.888.777-66",
      cargaId: "L-100",
      idempotencyKey: "key-a-001",
      dados: basePayload(),
      requestIp: "127.0.0.1",
      correlationId: "corr-a",
    });

    expect(result.statusCode).toBe(201);
    expect(result.payload.id).toBeTruthy();
    expect(result.payload.protocolo).toMatch(/^\d{4}-\d{5}$/);

    expect(fakeDb.rows).toHaveLength(1);
    const row = fakeDb.rows[0];
    expect(row.id_cadastro).toBe("CAD-V2-key-a-001");
    expect(row.status).toBe("pendente");
    expect(row.versao_cadastro).toBe("v2");
    expect(row.driver_user_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(row.carga_id).toBe("L-100");
    expect(row.pancary_autodeclaration).toBe("sim");
    expect(row.pancary_validation_source).toBe("autodeclaration");
    expect(row.cor_veiculo).toBe("Branca");
    expect(row.rastreador_detalhes).toEqual({
      empresa: "Sascar",
      login: "antonio",
      senha: "***",
      id_rastreador: "RT123",
    });
    expect(Array.isArray(row.dados_bancarios)).toBe(true);
    expect(row.dados_bancarios[0].banco_compe).toBe("001");
    expect(row.dados_bancarios[0].owner_role).toBe("cavalo");
    // dados.protocolo persistido dentro do JSONB.
    expect(row.dados.protocolo).toBe(result.payload.protocolo);
    // Owner reuse anexado ao dados.
    expect(row.dados.owner_reuse.cavalo_owner_is_driver).toBe(false);

    // ANTT cascade rodou para o cavalo (owner != driver).
    expect(anttCascadeMock).toHaveBeenCalledTimes(1);
    expect(anttCascadeMock.mock.calls[0][0].placa).toBe("ABC1D23");

    // Audit registrado SEM o payload `dados`.
    expect(fakeDb.audit).toHaveLength(1);
    expect(fakeDb.audit[0].params[0]).toBe("driver.candidatura.submitted");
    expect(fakeDb.audit[0].params[3]).toBe("driver");
    const auditMetadata = JSON.parse(fakeDb.audit[0].params[10]);
    expect(auditMetadata).not.toHaveProperty("dados");
    expect(auditMetadata.protocolo).toBe(result.payload.protocolo);
    expect(auditMetadata.carga_id).toBe("L-100");
    expect(auditMetadata.antt_hits).toHaveLength(1);
  });

  it("(b) owner do cavalo == driverCpf → auto-attribution, ANTT NAO roda para o cavalo", async () => {
    const payload = basePayload({
      cavalo: {
        placa: "ABC1D23",
        owner_doc: "99988877766",
        owner_doc_type: "cpf",
      },
      cavalo_owner: undefined, // motorista vira owner.
    });

    const result = await submitCandidaturaFinal({
      driverUserId: "22222222-2222-2222-2222-222222222222",
      driverCpf: "999.888.777-66",
      cargaId: "L-200",
      idempotencyKey: "key-b-002",
      dados: payload,
      correlationId: "corr-b",
    });

    expect(result.statusCode).toBe(201);
    expect(fakeDb.rows[0].dados.owner_reuse.cavalo_owner_is_driver).toBe(true);
    expect(anttCascadeMock).not.toHaveBeenCalled();
  });

  it("(c) idempotency: 2 submits mesma key → 1 row, mesmo protocolo, replay flag", async () => {
    const args = {
      driverUserId: "33333333-3333-3333-3333-333333333333",
      driverCpf: "11122233344",
      cargaId: "L-300",
      idempotencyKey: "key-c-003",
      dados: basePayload(),
      correlationId: "corr-c",
    };

    const first = await submitCandidaturaFinal(args);
    expect(first.statusCode).toBe(201);
    const firstProtocolo = first.payload.protocolo;

    const second = await submitCandidaturaFinal({ ...args, dados: basePayload() });
    expect(second.statusCode).toBe(200);
    expect(second.payload.id).toBe(first.payload.id);
    expect(second.payload.protocolo).toBe(firstProtocolo);
    expect(second.payload.meta.idempotentReplay).toBe(true);

    expect(fakeDb.rows).toHaveLength(1);
    expect(fakeDb.audit).toHaveLength(1); // audit so no 1o submit
    // Sequence consumida apenas uma vez.
    expect(fakeDb.sequence).toBe(1);
  });

  it("(d) ocr_fallback_manual=true + cpf_owner_manual → ANTT roda mesmo assim", async () => {
    const payload = basePayload({
      cavalo: {
        placa: "XYZ4321",
        owner_doc: "12345678000199",
        owner_doc_type: "cnpj",
        ocr_fallback_manual: true,
      },
      cavalo_owner: {
        tipo: "pj",
        doc: "12345678000199",
        nome: "Frota Manual LTDA",
        dados_bancarios: {
          banco_compe: "237",
          banco_nome: "Bradesco",
          agencia: "5555",
          conta: "11111-2",
          tipo: "corrente",
        },
        cpf_owner_manual: true,
      },
    });

    const result = await submitCandidaturaFinal({
      driverUserId: "44444444-4444-4444-4444-444444444444",
      driverCpf: "99988877766",
      cargaId: "L-400",
      idempotencyKey: "key-d-004",
      dados: payload,
      correlationId: "corr-d",
    });

    expect(result.statusCode).toBe(201);
    expect(anttCascadeMock).toHaveBeenCalledTimes(1);
    expect(anttCascadeMock.mock.calls[0][0].placa).toBe("XYZ4321");
  });

  it("(e) carga_id ja com candidatura aprovada → 409 Conflict (sem INSERT)", async () => {
    // Seed: row aprovada para a mesma carga.
    fakeDb.rows.push({
      id: "row-pre",
      id_cadastro: "CAD-V2-pre-existing",
      status: "aprovado",
      versao_cadastro: "v2",
      carga_id: "L-500",
      dados: {},
    });

    const result = await submitCandidaturaFinal({
      driverUserId: "55555555-5555-5555-5555-555555555555",
      driverCpf: "11122233344",
      cargaId: "L-500",
      idempotencyKey: "key-e-005",
      dados: basePayload(),
      correlationId: "corr-e",
    });

    expect(result.statusCode).toBe(409);
    expect(result.payload.error).toBe("CargaAlreadyApproved");
    // Nada novo inserido.
    expect(fakeDb.rows).toHaveLength(1);
    expect(anttCascadeMock).not.toHaveBeenCalled();
  });

  it("(f) sequence cadastro_protocolo_seq ausente → throw com mensagem apontando plan 01", async () => {
    fakeDb.sequenceFails = true;

    await expect(
      submitCandidaturaFinal({
        driverUserId: "66666666-6666-6666-6666-666666666666",
        driverCpf: "11122233344",
        cargaId: "L-600",
        idempotencyKey: "key-f-006",
        dados: basePayload(),
        correlationId: "corr-f",
      }),
    ).rejects.toThrow(/plan 01/);

    // Nenhuma row criada apos o throw (transacao reverte semanticamente — no fake nao executamos rollback, mas validamos que insert nao foi disparado).
    expect(fakeDb.rows).toHaveLength(0);
  });

  it("(h) storage_path dos documentos persiste no JSONB dados (cnh_url / crlv_url / comprovante_url / selfie_cnh_url / owner_doc_url)", async () => {
    // Cobertura 19/05: garante que os caminhos dos arquivos no bucket
    // `cadastro-drafts` sao salvos no row final. Antes o frontend mandava
    // mas o submit reaproveitava sem persistir esses campos.
    anttCascadeMock.mockResolvedValue({
      rntrc: "11223344",
      tipo: "ETC",
      situacao: "ATIVO",
      validade: "2030-01-01",
      source: "antt-cascade-antt/transportador",
      attempts: [{ produto: "antt/transportador", code: 200 }],
    });

    const dados = basePayload({
      motorista: {
        nome: "Antonio Tester",
        telefones: ["11999998888"],
        telefone_primario: "11999998888",
        endereco: {
          cep: "01310100",
          numero: "123",
          logradouro: "Av. Paulista",
          bairro: "Bela Vista",
          cidade: "Sao Paulo",
          uf: "SP",
        },
        tag_pedagio: "sem_parar",
        pancary_autodeclaration: "sim",
        // storage_paths dos documentos do motorista (bucket cadastro-drafts).
        cnh_url: "cadastro-drafts/driver-1/L-700/motorista_cnh_1700000000.pdf",
        comprovante_url: "cadastro-drafts/driver-1/L-700/motorista_comprovante_1700000001.pdf",
        selfie_cnh_url: "cadastro-drafts/driver-1/L-700/motorista_selfie_cnh_1700000002.jpg",
      },
      cavalo: {
        placa: "ABC1D23",
        renavam: "12345678901",
        chassi: "9BWZZZ377VT004251",
        marca: "Volvo",
        ano: 2022,
        cor: "Branca",
        owner_doc: "12345678000199",
        owner_doc_type: "cnpj",
        crlv_url: "cadastro-drafts/driver-1/L-700/cavalo_crlv_1700000003.pdf",
      },
      cavalo_owner: {
        tipo: "pj",
        doc: "12345678000199",
        nome: "Transportadora X LTDA",
        owner_doc_url: "cadastro-drafts/driver-1/L-700/cavalo_owner_cnh_1700000004.pdf",
      },
      carretas: [
        {
          placa: "XYZ9F87",
          renavam: "98765432100",
          chassi: "9CCYYY124VT004251",
          marca: "Randon",
          ano: 2021,
          cor: "Vermelha",
          owner_doc: "55544433000122",
          owner_doc_type: "cnpj",
          crlv_url: "cadastro-drafts/driver-1/L-700/carreta_crlv_0_1700000005.pdf",
        },
      ],
      carreta_owners: [
        {
          tipo: "pj",
          doc: "55544433000122",
          nome: "Transportadora CARRETA LTDA",
          owner_doc_url: "cadastro-drafts/driver-1/L-700/carreta_owner_0_1700000006.pdf",
        },
      ],
    });

    const result = await submitCandidaturaFinal({
      driverUserId: "77777777-7777-7777-7777-777777777777",
      driverCpf: "999.888.777-66",
      cargaId: "L-700",
      idempotencyKey: "key-h-storage-008",
      dados,
      correlationId: "corr-h-storage",
    });

    expect(result.statusCode).toBe(201);
    expect(fakeDb.rows).toHaveLength(1);
    const row = fakeDb.rows[0];

    // Documentos do motorista persistidos no JSONB dados.
    expect(row.dados.motorista.cnh_url).toBe(
      "cadastro-drafts/driver-1/L-700/motorista_cnh_1700000000.pdf",
    );
    expect(row.dados.motorista.comprovante_url).toBe(
      "cadastro-drafts/driver-1/L-700/motorista_comprovante_1700000001.pdf",
    );
    expect(row.dados.motorista.selfie_cnh_url).toBe(
      "cadastro-drafts/driver-1/L-700/motorista_selfie_cnh_1700000002.jpg",
    );

    // CRLV do cavalo persistido.
    expect(row.dados.cavalo.crlv_url).toBe(
      "cadastro-drafts/driver-1/L-700/cavalo_crlv_1700000003.pdf",
    );

    // Documento do owner do cavalo persistido.
    expect(row.dados.cavalo_owner.owner_doc_url).toBe(
      "cadastro-drafts/driver-1/L-700/cavalo_owner_cnh_1700000004.pdf",
    );

    // CRLV da carreta + documento do owner da carreta persistidos.
    expect(row.dados.carretas[0].crlv_url).toBe(
      "cadastro-drafts/driver-1/L-700/carreta_crlv_0_1700000005.pdf",
    );
    expect(row.dados.carreta_owners[0].owner_doc_url).toBe(
      "cadastro-drafts/driver-1/L-700/carreta_owner_0_1700000006.pdf",
    );
  });
});
