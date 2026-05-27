import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Plan 07-14 — Wave 7 / Task 2
 *
 * Integration tests do HTTP layer de /api/candidatura/*.
 *
 * Estrategia (alinhada com backend/src/interface/http/candidatura/handlers.test.js):
 *  - Mocks via `vi.hoisted` para `requireDriverSession`, `getDriverProfileByUserId`
 *    e o use case correspondente (submit / save-draft / get-draft).
 *  - `withPgClient` / `withPgTransaction` sao mockados com um cliente fake em
 *    memoria — habilita verificar (a) row criada com versao_cadastro='v2'
 *    + dados.protocolo e (b) idempotency replay devolvendo a mesma row.
 *  - Mocks de servicos externos (Infosimples sidecar via antt-cascade) garantem
 *    determinismo — nenhum I/O de rede.
 *
 * Tests cobrem:
 *   1. Submit happy path → 201 + row em pending_driver_registrations.
 *   2. Submit idempotency → segundo POST com mesma Idempotency-Key → 200 replay.
 *   3. Draft save + get → POST grava draft, GET subsequente recupera mesmo dados.
 *   4. Pre-check sem auth → 401 (UnauthorizedError → resposta padronizada).
 */

// ── Fake DB compartilhado ──────────────────────────────────────────────────
const fakeDb = {
  rows: [],
  audit: [],
  sequence: 0,
};

const fakeClient = {
  async query(sql, params = []) {
    const norm = sql.replace(/\s+/g, " ").trim();

    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(norm)) {
      return { rows: [], rowCount: 0 };
    }

    // A3 — advisory lock por carga_id.
    if (/pg_advisory_xact_lock\(hashtext\('carga:' \|\| \$1::text\)\)/i.test(norm)) {
      return { rows: [{ pg_advisory_xact_lock: "" }], rowCount: 1 };
    }

    // Idempotency lookup (submit-final).
    if (
      /SELECT id, dados->>'protocolo' AS protocolo, status\s+FROM public\.pending_driver_registrations\s+WHERE id_cadastro = \$1/i.test(
        norm,
      )
    ) {
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

    // Conflito de carga aprovada.
    if (
      /SELECT id\s+FROM public\.pending_driver_registrations\s+WHERE carga_id = \$1\s+AND status = 'aprovado'/i.test(
        norm,
      )
    ) {
      return { rows: [], rowCount: 0 };
    }

    // Iter #7 — duplicate detection (cpf, horsePlate). Sem matches por padrao.
    if (
      /SELECT id, status, dados->>'protocolo' AS protocolo\s+FROM public\.pending_driver_registrations\s+WHERE dados->'motorista'->>'cpf' = \$1\s+AND dados->'cavalo'->>'placa' = \$2/i.test(
        norm,
      )
    ) {
      return { rows: [], rowCount: 0 };
    }
    // Iter #7 — duplicate detection do pre-check (mesmo prefixo + status).
    if (
      /SELECT id, status, created_at, carga_id\s+FROM public\.pending_driver_registrations\s+WHERE dados->'motorista'->>'cpf' = \$1\s+AND dados->'cavalo'->>'placa' = \$2/i.test(
        norm,
      )
    ) {
      return { rows: [], rowCount: 0 };
    }

    // Protocolo via sequence.
    if (
      /SELECT to_char\(now\(\),'YYYY'\)\|\|'-'\|\|LPAD\(nextval\('public\.cadastro_protocolo_seq'\)::text,5,'0'\) AS protocolo/i.test(
        norm,
      )
    ) {
      fakeDb.sequence += 1;
      const year = new Date().getFullYear();
      const padded = String(fakeDb.sequence).padStart(5, "0");
      return { rows: [{ protocolo: `${year}-${padded}` }], rowCount: 1 };
    }

    // Existing draft (FOR UPDATE) — para converter em pendente.
    if (
      /SELECT id\s+FROM public\.pending_driver_registrations\s+WHERE driver_user_id = \$1\s+AND status = 'draft'\s+AND versao_cadastro = 'v2'\s+FOR UPDATE/i.test(
        norm,
      )
    ) {
      const [driverUserId] = params;
      const matches = fakeDb.rows.filter(
        (r) =>
          r.driver_user_id === driverUserId &&
          r.status === "draft" &&
          r.versao_cadastro === "v2",
      );
      return { rows: matches.map((r) => ({ id: r.id })), rowCount: matches.length };
    }

    // Iter #7 — Save draft escopado por (driver, carga_id).
    if (
      /SELECT id, id_cadastro\s+FROM public\.pending_driver_registrations\s+WHERE driver_user_id = \$1\s+AND carga_id = \$2\s+AND status = 'draft'\s+AND versao_cadastro = 'v2'\s+FOR UPDATE/i.test(
        norm,
      )
    ) {
      const [driverUserId, cargaId] = params;
      const matches = fakeDb.rows.filter(
        (r) =>
          r.driver_user_id === driverUserId &&
          r.carga_id === cargaId &&
          r.status === "draft" &&
          r.versao_cadastro === "v2",
      );
      return {
        rows: matches.map((r) => ({ id: r.id, id_cadastro: r.id_cadastro })),
        rowCount: matches.length,
      };
    }
    // Iter #7 — Save draft fallback legacy (carga_id IS NULL).
    if (
      /SELECT id, id_cadastro\s+FROM public\.pending_driver_registrations\s+WHERE driver_user_id = \$1\s+AND carga_id IS NULL\s+AND status = 'draft'\s+AND versao_cadastro = 'v2'\s+FOR UPDATE/i.test(
        norm,
      )
    ) {
      const [driverUserId] = params;
      const matches = fakeDb.rows.filter(
        (r) =>
          r.driver_user_id === driverUserId &&
          r.carga_id == null &&
          r.status === "draft" &&
          r.versao_cadastro === "v2",
      );
      return {
        rows: matches.map((r) => ({ id: r.id, id_cadastro: r.id_cadastro })),
        rowCount: matches.length,
      };
    }

    // INSERT novo draft.
    if (
      /INSERT INTO public\.pending_driver_registrations \([^)]+\)\s+VALUES \(\$1, 'draft', 'v2', \$2, \$3, \$4::jsonb\)\s+RETURNING id, updated_at/i.test(
        norm,
      )
    ) {
      const [idCadastro, driverUserId, cargaId, dadosJson] = params;
      const id = `draft-row-${fakeDb.rows.length + 1}`;
      const updated_at = new Date();
      fakeDb.rows.push({
        id,
        id_cadastro: idCadastro,
        status: "draft",
        versao_cadastro: "v2",
        driver_user_id: driverUserId,
        carga_id: cargaId,
        dados: JSON.parse(dadosJson),
        updated_at,
        created_at: new Date(),
      });
      return { rows: [{ id, updated_at }], rowCount: 1 };
    }

    // UPDATE draft existente (autosave).
    if (
      /UPDATE public\.pending_driver_registrations\s+SET dados = \$2::jsonb,\s+carga_id = \$3\s+WHERE id = \$1\s+RETURNING id, updated_at/i.test(
        norm,
      )
    ) {
      const [draftId, dadosJson, cargaId] = params;
      const row = fakeDb.rows.find((r) => r.id === draftId);
      if (!row) return { rows: [], rowCount: 0 };
      row.dados = JSON.parse(dadosJson);
      row.carga_id = cargaId;
      row.updated_at = new Date();
      return { rows: [{ id: row.id, updated_at: row.updated_at }], rowCount: 1 };
    }

    // Iter #7 — get-draft escopado por cargaId (carga_id = $2 OR carga_id IS NULL).
    if (
      /SELECT id, carga_id, dados, updated_at\s+FROM public\.pending_driver_registrations\s+WHERE driver_user_id = \$1\s+AND status = 'draft'\s+AND versao_cadastro = 'v2'\s+AND updated_at > now\(\) - interval '72 hours'\s+AND \(carga_id = \$2 OR carga_id IS NULL\)/i.test(
        norm,
      )
    ) {
      const [driverUserId, cargaId] = params;
      const cutoff = Date.now() - 72 * 3600 * 1000;
      const matches = fakeDb.rows
        .filter(
          (r) =>
            r.driver_user_id === driverUserId &&
            r.status === "draft" &&
            r.versao_cadastro === "v2" &&
            r.updated_at.getTime() > cutoff &&
            (r.carga_id === cargaId || r.carga_id == null),
        )
        .sort((a, b) => {
          const aMatch = a.carga_id === cargaId ? 1 : 0;
          const bMatch = b.carga_id === cargaId ? 1 : 0;
          if (aMatch !== bMatch) return bMatch - aMatch;
          return b.updated_at.getTime() - a.updated_at.getTime();
        })
        .slice(0, 1);
      return {
        rows: matches.map((r) => ({
          id: r.id,
          carga_id: r.carga_id,
          dados: r.dados,
          updated_at: r.updated_at,
        })),
        rowCount: matches.length,
      };
    }

    // SELECT do get-draft sem cargaId (legacy — mais recente do driver).
    if (
      /SELECT id, carga_id, dados, updated_at\s+FROM public\.pending_driver_registrations\s+WHERE driver_user_id = \$1\s+AND status = 'draft'\s+AND versao_cadastro = 'v2'\s+AND updated_at > now\(\) - interval '72 hours'\s+ORDER BY updated_at DESC\s+LIMIT 1/i.test(
        norm,
      )
    ) {
      const [driverUserId] = params;
      const cutoff = Date.now() - 72 * 3600 * 1000;
      const matches = fakeDb.rows
        .filter(
          (r) =>
            r.driver_user_id === driverUserId &&
            r.status === "draft" &&
            r.versao_cadastro === "v2" &&
            r.updated_at.getTime() > cutoff,
        )
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime())
        .slice(0, 1);
      return {
        rows: matches.map((r) => ({
          id: r.id,
          carga_id: r.carga_id,
          dados: r.dados,
          updated_at: r.updated_at,
        })),
        rowCount: matches.length,
      };
    }

    // UPDATE draft → pendente (submit converte).
    if (
      /UPDATE public\.pending_driver_registrations\s+SET id_cadastro\s+= \$1,\s+status\s+= 'pendente',/i.test(
        norm,
      )
    ) {
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

    // INSERT submit v2 (status='pendente').
    if (
      /INSERT INTO public\.pending_driver_registrations \([^)]*id_cadastro,\s*status,\s*versao_cadastro,\s*driver_user_id,\s*carga_id,\s*dados,\s*pancary_autodeclaration,/i.test(
        norm,
      )
    ) {
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
      const id = `submit-row-${fakeDb.rows.length + 1}`;
      fakeDb.rows.push({
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
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    // Audit logs.
    if (/INSERT INTO public\.security_audit_logs/i.test(norm)) {
      fakeDb.audit.push({ params });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`[fakeClient] query nao mockada: ${norm.slice(0, 140)}...`);
  },
};

// ── Mocks de modulos (antes dos imports dos handlers) ──────────────────────

const {
  mockRequireDriverSession,
  mockGetDriverProfileByUserId,
  mockResolveAnttCascade,
} = vi.hoisted(() => ({
  mockRequireDriverSession: vi.fn(),
  mockGetDriverProfileByUserId: vi.fn(),
  mockResolveAnttCascade: vi.fn(),
}));

vi.mock("../../../application/load-claims/auth.js", () => ({
  requireDriverSession: mockRequireDriverSession,
}));

vi.mock("../../../application/load-claims/profile-service.js", () => ({
  getDriverProfileByUserId: mockGetDriverProfileByUserId,
}));

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) => cb(fakeClient),
  withPgTransaction: async (cb) => cb(fakeClient),
}));

vi.mock("../../../application/candidatura/use-cases/antt-cascade.js", () => ({
  resolveAnttCascade: mockResolveAnttCascade,
}));

import { UnauthorizedError } from "../../../domain/load-claims/errors.js";
import {
  resolveCandidaturaPreCheckResponse,
  resolveCandidaturaDraftSaveResponse,
  resolveCandidaturaDraftGetResponse,
  resolveCandidaturaSubmitResponse,
} from "./handlers.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function buildRequest({ body, headers = {}, ip } = {}) {
  return {
    body: typeof body === "string" ? body : body ? JSON.stringify(body) : undefined,
    headers: {
      // IP unico por teste para nao colidir com o rate-limiter (10/min por IP).
      "x-forwarded-for": ip || `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
      ...headers,
    },
    query: {},
  };
}

function basePayload(overrides = {}) {
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe("integration — /api/candidatura/* (Plan 07-14)", () => {
  beforeEach(() => {
    fakeDb.rows = [];
    fakeDb.audit = [];
    fakeDb.sequence = 0;
    vi.clearAllMocks();

    mockResolveAnttCascade.mockResolvedValue({
      rntrc: "55555555",
      tipo: "ETC",
      situacao: "ATIVO",
      validade: "2030-01-01",
      source: "antt-cascade-antt/transportador",
      requiresUpload: false,
      attempts: [],
    });
  });

  it("POST /api/candidatura/submit — happy path retorna 201 com id + protocolo CAD-YYYY-NNNNN e persiste row v2", async () => {
    const driverUserId = "11111111-1111-1111-1111-111111111111";
    mockRequireDriverSession.mockResolvedValue({
      accessToken: "tok",
      user: { id: driverUserId },
    });
    mockGetDriverProfileByUserId.mockResolvedValue({
      statusCode: 200,
      payload: {
        profile: { document_number: "99988877766", phone: "71999999999" },
      },
    });

    const response = await resolveCandidaturaSubmitResponse(
      buildRequest({
        body: { cargaId: "L-100", dados: basePayload() },
        headers: { "idempotency-key": "key-happy-001", "x-correlation-id": "corr-happy" },
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.payload.id).toBeTruthy();
    expect(response.payload.protocolo).toMatch(/^\d{4}-\d{5}$/);

    expect(fakeDb.rows).toHaveLength(1);
    const row = fakeDb.rows[0];
    expect(row.status).toBe("pendente");
    expect(row.versao_cadastro).toBe("v2");
    expect(row.driver_user_id).toBe(driverUserId);
    expect(row.carga_id).toBe("L-100");
    expect(row.dados.protocolo).toBe(response.payload.protocolo);
    expect(row.id_cadastro).toBe("CAD-V2-key-happy-001");

    // Audit registrado (sem PII em metadata).
    expect(fakeDb.audit).toHaveLength(1);
    expect(fakeDb.audit[0].params[0]).toBe("driver.candidatura.submitted");
  });

  it("POST /api/candidatura/submit — idempotency: mesma Idempotency-Key retorna 200 replay com mesmo id+protocolo", async () => {
    const driverUserId = "22222222-2222-2222-2222-222222222222";
    mockRequireDriverSession.mockResolvedValue({
      accessToken: "tok",
      user: { id: driverUserId },
    });
    mockGetDriverProfileByUserId.mockResolvedValue({
      statusCode: 200,
      payload: {
        profile: { document_number: "11122233344", phone: "11988887777" },
      },
    });

    const request = () =>
      buildRequest({
        body: { cargaId: "L-200", dados: basePayload() },
        headers: { "idempotency-key": "key-idem-002", "x-correlation-id": "corr-idem" },
      });

    const first = await resolveCandidaturaSubmitResponse(request());
    expect(first.statusCode).toBe(201);

    const second = await resolveCandidaturaSubmitResponse(request());
    expect(second.statusCode).toBe(200);
    expect(second.payload.id).toBe(first.payload.id);
    expect(second.payload.protocolo).toBe(first.payload.protocolo);
    expect(second.payload.meta.idempotentReplay).toBe(true);

    // Apenas 1 row criada, sequence consumida apenas 1 vez.
    expect(fakeDb.rows).toHaveLength(1);
    expect(fakeDb.sequence).toBe(1);
    expect(fakeDb.audit).toHaveLength(1);
  });

  it("POST /api/candidatura/submit — sem Idempotency-Key retorna 400", async () => {
    mockRequireDriverSession.mockResolvedValue({
      accessToken: "tok",
      user: { id: "user-missing-key" },
    });
    mockGetDriverProfileByUserId.mockResolvedValue({
      statusCode: 200,
      payload: {
        profile: { document_number: "12345678901", phone: "71999999999" },
      },
    });

    const response = await resolveCandidaturaSubmitResponse(
      buildRequest({ body: { cargaId: "L-1", dados: basePayload() } }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.payload.error).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(fakeDb.rows).toHaveLength(0);
  });

  it("POST /api/candidatura/draft + GET /api/candidatura/draft/me — draft persiste e GET retorna os mesmos dados", async () => {
    const driverUserId = "33333333-3333-3333-3333-333333333333";
    mockRequireDriverSession.mockResolvedValue({
      accessToken: "tok",
      user: { id: driverUserId },
    });

    const saveResponse = await resolveCandidaturaDraftSaveResponse(
      buildRequest({
        body: {
          cargaId: "L-300",
          dados: { motorista: { nome: "Joao da Silva" }, step: 1 },
        },
        headers: { "x-correlation-id": "corr-draft-save" },
      }),
    );

    expect(saveResponse.statusCode).toBe(200);
    expect(saveResponse.payload.id).toBeTruthy();
    expect(saveResponse.payload.expiresAt).toBeTruthy();

    const getResponse = await resolveCandidaturaDraftGetResponse(
      buildRequest({ headers: { "x-correlation-id": "corr-draft-get" } }),
    );

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.payload.draft.id).toBe(saveResponse.payload.id);
    expect(getResponse.payload.draft.cargaId).toBe("L-300");
    expect(getResponse.payload.draft.dados).toMatchObject({
      motorista: { nome: "Joao da Silva" },
      step: 1,
    });
    expect(getResponse.payload.expiresAt).toBeTruthy();

    // O TTL é SLIDING: o expiresAt do GET é >= o expiresAt retornado pelo save
    // (porque a query do GET ancora em updated_at, que é o mesmo). Validamos
    // que pelo menos eles são iguais ou maiores.
    const saveExpiresMs = new Date(saveResponse.payload.expiresAt).getTime();
    const getExpiresMs = new Date(getResponse.payload.expiresAt).getTime();
    expect(getExpiresMs).toBeGreaterThanOrEqual(saveExpiresMs);
  });

  // NOTA (08-23): pre-check virou PUBLICO em Phase 7 (commit c5fa0bc) — nao
  // requer Authorization header. Test reescrito para validar o caminho publico
  // com body valido (cpf no form do DriverClaimPanel).
  it("POST /api/candidatura/pre-check publico → 422 quando placa invalida", async () => {
    const response = await resolveCandidaturaPreCheckResponse(
      buildRequest({
        body: { cpf: "12345678901", horsePlate: "INVALIDA", trailerPlates: [] },
      }),
    );

    expect(response.statusCode).toBe(422);
    expect(response.payload).toMatchObject({ error: "ValidationError" });
  });
});
