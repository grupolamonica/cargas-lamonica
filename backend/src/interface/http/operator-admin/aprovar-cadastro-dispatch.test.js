// Fluxo de aprovação × disparo do cadastro externo (Angellira/SPX).
//
// Regra (decisão do Samuel): "Aprovar e cadastrar" só marca 'aprovado' quando o
// cadastro externo SOLICITADO dá certo. Se falhar, NÃO aprova — o cadastro segue
// na fila (status inalterado) com o marcador `dados.cadastro_externo_falhou`.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedPendingRegistration,
  seedUser,
  withPgClient,
  withPgTransaction,
} from "../../../application/operator-admin/test-harness.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));

const DRIVER_ID = "11111111-1111-1111-1111-111111111111";

// Supabase Auth admin (criação de conta) — mock: devolve o DRIVER_ID já semeado.
const { createUserMock } = vi.hoisted(() => ({ createUserMock: vi.fn() }));
vi.mock("../../../application/load-claims/auth.js", () => ({
  requireOperatorSession: vi.fn(async () => ({
    user: { id: "22222222-2222-2222-2222-222222222222", app_metadata: { role: "operator", access_level: "advanced" } },
    accessLevel: "advanced",
  })),
  getAdminClient: () => ({ auth: { admin: { createUser: createUserMock } } }),
}));

// Auditoria — no-op nos testes.
vi.mock("../../../infrastructure/security-audit.js", () => ({
  insertSecurityAuditEvent: vi.fn(),
  recordSecurityAuditEvent: vi.fn(),
}));

// Notificação WhatsApp (flag-gated) — no-op.
vi.mock("../../../application/operator-admin/use-cases/registration-approved-outreach.js", () => ({
  notifyRegistrationApproved: () => ({ reason: "disabled" }),
}));

// Pipelines externos (dynamic-imported no handler) — controláveis.
const { angelliraPipelineMock, spxPipelineMock } = vi.hoisted(() => ({
  angelliraPipelineMock: vi.fn(),
  spxPipelineMock: vi.fn(),
}));
vi.mock("../../../application/operator-admin/use-cases/angellira/dispatch-pipeline.js", () => ({
  runAngelliraPipeline: angelliraPipelineMock,
}));
vi.mock("../../../application/operator-admin/use-cases/spx/dispatch-pipeline.js", () => ({
  runSpxPipeline: spxPipelineMock,
}));

const { resolveOperatorAprovarCadastroResponse } = await import("./handlers.js");

function req(id, jobs) {
  return {
    body: JSON.stringify({ jobs }),
    headers: { authorization: "Bearer valid-token" },
    method: "POST",
    query: { id },
    url: `/api/operator/cadastros/${id}/aprovar`,
  };
}

async function seedCadastro() {
  const { id } = await seedPendingRegistration({
    status: "pendente",
    dados: {
      motorista: { cpf: "03650454629", nome: "NILSON DE SOUZA SOARES", telefones: ["71988887777"] },
      cavalo: { placa: "ABC1D23", crlv_url: "p/crlv.pdf", owner_doc: "12345678901", owner_doc_type: "cpf" },
    },
  });
  return id;
}

async function statusOf(id) {
  const { rows } = await query(`SELECT status, dados FROM public.pending_driver_registrations WHERE id = $1`, [id]);
  return rows[0];
}

// Portão operacional REAL de reservar cargas: driver_profiles.active. Só pode
// ficar true quando o cadastro externo (quando solicitado) deu certo.
async function profileActive() {
  const { rows } = await query(`SELECT active FROM public.driver_profiles WHERE user_id = $1`, [DRIVER_ID]);
  return rows[0]?.active;
}

describe("aprovar × disparo do cadastro externo (integração pg-mem)", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
    await seedUser({ id: DRIVER_ID, email: "nilson@motorista.lmc.internal" });
    createUserMock.mockResolvedValue({ data: { user: { id: DRIVER_ID } }, error: null });
    angelliraPipelineMock.mockResolvedValue({ ok: true, results: [] });
    spxPipelineMock.mockResolvedValue({ ok: true, results: [] });
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("sem disparo externo (jobs:[]) → aprova (comportamento original)", async () => {
    const id = await seedCadastro();
    const res = await resolveOperatorAprovarCadastroResponse(req(id, []));
    expect(res.statusCode).toBe(200);
    expect(res.payload.approved).toBe(true);
    expect((await statusOf(id)).status).toBe("aprovado");
    expect(await profileActive()).toBe(true); // aprovado → operacional
    expect(angelliraPipelineMock).not.toHaveBeenCalled();
  });

  it("disparo Angellira OK → aprova e ATIVA o profile", async () => {
    const id = await seedCadastro();
    angelliraPipelineMock.mockResolvedValue({ ok: true, results: [{ step: "motorista", status: "OK", external_id: "x", error: null }] });
    const res = await resolveOperatorAprovarCadastroResponse(req(id, ["angellira"]));
    expect(res.payload.approved).toBe(true);
    expect(res.payload.angellira.ok).toBe(true);
    expect((await statusOf(id)).status).toBe("aprovado");
    expect(await profileActive()).toBe(true);
  });

  it("disparo Angellira FALHA → NÃO aprova; pendente + marcador + profile INATIVO", async () => {
    const id = await seedCadastro();
    angelliraPipelineMock.mockResolvedValue({
      ok: false,
      results: [{ step: "cavalo", status: "ERROR", external_id: null, error: { message: "bot fora do ar" } }],
    });
    const res = await resolveOperatorAprovarCadastroResponse(req(id, ["angellira"]));

    expect(res.statusCode).toBe(200);
    expect(res.payload.approved).toBe(false); // <- não aprovou
    const row = await statusOf(id);
    expect(row.status).toBe("pendente"); // <- SEGUE na fila
    expect(row.dados.cadastro_externo_falhou).toBeTruthy();
    expect(row.dados.cadastro_externo_falhou.angellira.ok).toBe(false);
    // Portão REAL: o motorista NÃO pode reservar cargas (cadastro de risco falhou).
    expect(await profileActive()).toBe(false);
  });

  it("Angellira OK + SPX FALHA → NÃO aprova (só com os dois); profile INATIVO; marcador aponta o SPX", async () => {
    const id = await seedCadastro();
    angelliraPipelineMock.mockResolvedValue({ ok: true, results: [] });
    spxPipelineMock.mockResolvedValue({ ok: false, results: [{ step: "motorista", status: "ERROR", external_id: null, error: { message: "spx caiu" } }] });
    const res = await resolveOperatorAprovarCadastroResponse(req(id, ["angellira", "spx"]));

    expect(res.payload.approved).toBe(false);
    const row = await statusOf(id);
    expect(row.status).toBe("pendente");
    expect(row.dados.cadastro_externo_falhou.angellira.ok).toBe(true); // Angellira deu certo
    expect(row.dados.cadastro_externo_falhou.spx.ok).toBe(false); // SPX falhou
    expect(await profileActive()).toBe(false); // ainda assim NÃO operacional (só com os 2)
  });

  it("Angellira lança exceção → dispatch retorna ok:false → NÃO aprova; profile INATIVO", async () => {
    const id = await seedCadastro();
    angelliraPipelineMock.mockRejectedValue(new Error("pipeline explodiu"));
    const res = await resolveOperatorAprovarCadastroResponse(req(id, ["angellira"]));
    expect(res.payload.approved).toBe(false);
    expect((await statusOf(id)).status).toBe("pendente");
    expect(await profileActive()).toBe(false);
  });
});
