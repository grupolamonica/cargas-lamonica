import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Testes unitarios dos use cases de draft (save / get / cleanup).
 *
 * Estrategia: mocka `withPgClient`/`withPgTransaction` para passar um cliente fake
 * que simula a tabela `pending_driver_registrations` em memoria com a semantica
 * do trigger BEFORE UPDATE (plan 01 — `updated_at = now()` em todo UPDATE) e
 * o filtro de TTL SLIDING via `now() - interval '72 hours'`.
 *
 * Cobre os 7 cenarios obrigatorios do plan 07-03:
 *   (a) save novo → INSERT + expiresAt ~= now + 72h
 *   (b) save com draft existente → UPDATE merged + updated_at avanca
 *   (c) get sem draft → 204
 *   (d) get com draft updated_at = 71h atras → 200
 *   (e) get com draft updated_at = 73h atras → 204
 *   (f) cleanup apaga apenas drafts > 72h
 *   (g) UPDATE de draft 70h atras reseta updated_at — get subsequente retorna 200 (sliding)
 */

// ─── Estado em memoria compartilhado pelo client fake ─────────────────────────
const fakeDb = {
  rows: [], // array de { id, id_cadastro, status, versao_cadastro, driver_user_id, carga_id, dados, updated_at, created_at }
  audit: [], // log de insertSecurityAuditEvent
};

function makeRow({ id, id_cadastro, status, versao_cadastro, driver_user_id, carga_id, dados, updated_at }) {
  return {
    id,
    id_cadastro,
    status,
    versao_cadastro,
    driver_user_id,
    carga_id,
    dados: typeof dados === "string" ? JSON.parse(dados) : dados,
    updated_at: updated_at || new Date(),
    created_at: new Date(),
  };
}

// Simula o pg client: aceita as queries usadas pelos use cases.
const fakeClient = {
  async query(sql, params = []) {
    const normalizedSql = sql.replace(/\s+/g, " ").trim();

    // SELECT ... FOR UPDATE (save-draft lock pessimista).
    if (/SELECT id, id_cadastro\s+FROM public\.pending_driver_registrations\s+WHERE driver_user_id = \$1\s+AND status = 'draft'\s+AND versao_cadastro = 'v2'\s+FOR UPDATE/i.test(normalizedSql)) {
      const [driverUserId] = params;
      const matches = fakeDb.rows.filter(
        (r) => r.driver_user_id === driverUserId && r.status === "draft" && r.versao_cadastro === "v2",
      );
      return { rows: matches.map((r) => ({ id: r.id, id_cadastro: r.id_cadastro })), rowCount: matches.length };
    }

    // UPDATE existing draft (trigger atualiza updated_at = now()).
    if (/UPDATE public\.pending_driver_registrations\s+SET dados = \$2::jsonb,\s+carga_id = \$3\s+WHERE id = \$1\s+RETURNING id, updated_at/i.test(normalizedSql)) {
      const [draftId, dadosJson, cargaId] = params;
      const row = fakeDb.rows.find((r) => r.id === draftId);
      if (!row) return { rows: [], rowCount: 0 };
      row.dados = JSON.parse(dadosJson);
      row.carga_id = cargaId;
      // Trigger BEFORE UPDATE — sempre seta now().
      row.updated_at = new Date();
      return { rows: [{ id: row.id, updated_at: row.updated_at }], rowCount: 1 };
    }

    // INSERT novo draft.
    if (/INSERT INTO public\.pending_driver_registrations \([^)]+\)\s+VALUES \(\$1, 'draft', 'v2', \$2, \$3, \$4::jsonb\)\s+RETURNING id, updated_at/i.test(normalizedSql)) {
      const [idCadastro, driverUserId, cargaId, dadosJson] = params;
      const id = `row-${fakeDb.rows.length + 1}`;
      const updated_at = new Date();
      const row = makeRow({
        id,
        id_cadastro: idCadastro,
        status: "draft",
        versao_cadastro: "v2",
        driver_user_id: driverUserId,
        carga_id: cargaId,
        dados: dadosJson,
        updated_at,
      });
      fakeDb.rows.push(row);
      return { rows: [{ id, updated_at }], rowCount: 1 };
    }

    // SELECT do get-draft (com filtro de TTL via now() - 72h).
    if (/SELECT id, carga_id, dados, updated_at\s+FROM public\.pending_driver_registrations\s+WHERE driver_user_id = \$1\s+AND status = 'draft'\s+AND versao_cadastro = 'v2'\s+AND updated_at > now\(\) - interval '72 hours'/i.test(normalizedSql)) {
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

    // DELETE do cleanup (> 72h, drafts v2).
    if (/DELETE FROM public\.pending_driver_registrations\s+WHERE status = 'draft'\s+AND versao_cadastro = 'v2'\s+AND updated_at < now\(\) - interval '72 hours'\s+RETURNING id/i.test(normalizedSql)) {
      const cutoff = Date.now() - 72 * 3600 * 1000;
      const toDelete = fakeDb.rows.filter(
        (r) =>
          r.status === "draft" && r.versao_cadastro === "v2" && r.updated_at.getTime() < cutoff,
      );
      fakeDb.rows = fakeDb.rows.filter((r) => !toDelete.includes(r));
      return { rows: toDelete.map((r) => ({ id: r.id })), rowCount: toDelete.length };
    }

    // INSERT no security_audit_logs (registrado para asserts).
    if (/INSERT INTO public\.security_audit_logs/i.test(normalizedSql)) {
      fakeDb.audit.push({ params });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`[fakeClient] query nao mockada: ${normalizedSql.slice(0, 120)}...`);
  },
};

// Mock do modulo de postgres ANTES do import dos use cases (vi.hoisted).
vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) => cb(fakeClient),
  withPgTransaction: async (cb) => cb(fakeClient),
}));

// Re-importa apos os mocks.
const { saveCandidaturaDraft } = await import("./save-draft.js");
const { getCandidaturaDraft } = await import("./get-draft.js");
const { cleanupExpiredDrafts } = await import("./cleanup-expired-drafts.js");

// Helper: setta updated_at de uma row para `N` ms atras (simula draft envelhecido).
function ageRow(rowId, msAgo) {
  const row = fakeDb.rows.find((r) => r.id === rowId);
  if (!row) throw new Error(`row ${rowId} nao existe`);
  row.updated_at = new Date(Date.now() - msAgo);
}

describe("candidatura draft use cases", () => {
  beforeEach(() => {
    fakeDb.rows = [];
    fakeDb.audit = [];
  });

  it("(a) saveCandidaturaDraft INSERTa novo draft e retorna expiresAt ~= now + 72h", async () => {
    const t0 = Date.now();
    const result = await saveCandidaturaDraft({
      driverUserId: "11111111-1111-1111-1111-111111111111",
      cargaId: "L-001",
      dados: { motorista: { nome: "Antonio" } },
      requestIp: "127.0.0.1",
      correlationId: "corr-a",
    });

    expect(result.statusCode).toBe(200);
    expect(result.payload.id).toBeTruthy();
    expect(result.payload.expiresAt).toBeTruthy();

    const expiresAtMs = new Date(result.payload.expiresAt).getTime();
    const expected = t0 + 72 * 3600 * 1000;
    // Tolera +/- 5s para latencia do teste.
    expect(Math.abs(expiresAtMs - expected)).toBeLessThan(5000);

    expect(fakeDb.rows).toHaveLength(1);
    expect(fakeDb.rows[0].id_cadastro).toMatch(/^CAD-V2-/);
    expect(fakeDb.rows[0].status).toBe("draft");
    expect(fakeDb.rows[0].versao_cadastro).toBe("v2");

    // Audit deve ter sido escrito SEM o payload dados (PII).
    // Nota: sanitizeLogPayload redacta strings >= 32 chars (incl. id_cadastro com uuid),
    // entao validamos apenas a estrutura: id_cadastro presente, carga_id correto, sem `dados`.
    expect(fakeDb.audit).toHaveLength(1);
    const auditMetadata = JSON.parse(fakeDb.audit[0].params[10]);
    expect(auditMetadata).not.toHaveProperty("dados");
    expect(auditMetadata).toHaveProperty("id_cadastro");
    expect(auditMetadata.carga_id).toBe("L-001");

    // E o event_type deve ser correto (param 0 do INSERT no security_audit_logs).
    expect(fakeDb.audit[0].params[0]).toBe("driver.candidatura.draft_saved");
    // actorRole 'driver' (param 3) e actorUserId presente (param 2).
    expect(fakeDb.audit[0].params[3]).toBe("driver");
    expect(fakeDb.audit[0].params[2]).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("(b) saveCandidaturaDraft com draft existente faz UPDATE (mesmo id) e updated_at avanca", async () => {
    const driverUserId = "22222222-2222-2222-2222-222222222222";

    const first = await saveCandidaturaDraft({
      driverUserId,
      cargaId: "L-001",
      dados: { step: 1 },
      correlationId: "corr-b1",
    });

    // Envelhece a row 5s para garantir avanco perceptivel apos o UPDATE.
    ageRow(first.payload.id, 5_000);
    const updatedAtBefore = fakeDb.rows[0].updated_at.getTime();

    const second = await saveCandidaturaDraft({
      driverUserId,
      cargaId: "L-001",
      dados: { step: 2 },
      correlationId: "corr-b2",
    });

    expect(second.statusCode).toBe(200);
    expect(second.payload.id).toBe(first.payload.id); // mesmo draft (upsert idempotente)
    expect(fakeDb.rows).toHaveLength(1); // sem duplicar
    expect(fakeDb.rows[0].dados).toEqual({ step: 2 }); // payload sobrescrito

    // Trigger BEFORE UPDATE simulado reseta updated_at para now() — avanca >= 5s.
    const updatedAtAfter = fakeDb.rows[0].updated_at.getTime();
    expect(updatedAtAfter).toBeGreaterThan(updatedAtBefore);
  });

  it("(c) getCandidaturaDraft retorna 204 quando driver nao tem draft", async () => {
    const result = await getCandidaturaDraft({
      driverUserId: "33333333-3333-3333-3333-333333333333",
      correlationId: "corr-c",
    });
    expect(result.statusCode).toBe(204);
    expect(result.payload).toBeUndefined();
  });

  it("(d) getCandidaturaDraft retorna 200 quando draft tem updated_at = 71h atras", async () => {
    const driverUserId = "44444444-4444-4444-4444-444444444444";
    const saved = await saveCandidaturaDraft({
      driverUserId,
      cargaId: "L-002",
      dados: { nome: "Joao" },
      correlationId: "corr-d-save",
    });

    // Envelhece para 71h atras (ainda dentro da janela de 72h).
    ageRow(saved.payload.id, 71 * 3600 * 1000);

    const result = await getCandidaturaDraft({ driverUserId, correlationId: "corr-d-get" });

    expect(result.statusCode).toBe(200);
    expect(result.payload.draft.id).toBe(saved.payload.id);
    expect(result.payload.draft.cargaId).toBe("L-002");
    expect(result.payload.draft.dados).toEqual({ nome: "Joao" });
    expect(result.payload.expiresAt).toBeTruthy();
  });

  it("(e) getCandidaturaDraft retorna 204 quando draft tem updated_at = 73h atras (expirado)", async () => {
    const driverUserId = "55555555-5555-5555-5555-555555555555";
    const saved = await saveCandidaturaDraft({
      driverUserId,
      cargaId: "L-003",
      dados: { nome: "Maria" },
      correlationId: "corr-e-save",
    });

    // Envelhece para 73h atras (fora da janela de 72h).
    ageRow(saved.payload.id, 73 * 3600 * 1000);

    const result = await getCandidaturaDraft({ driverUserId, correlationId: "corr-e-get" });
    expect(result.statusCode).toBe(204);
  });

  it("(f) cleanupExpiredDrafts apaga apenas drafts com updated_at > 72h", async () => {
    // 3 drafts: 1 fresco (10min), 1 com 73h, 1 com 100h.
    const driverA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const driverB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const driverC = "cccccccc-cccc-cccc-cccc-cccccccccccc";

    const fresh = await saveCandidaturaDraft({ driverUserId: driverA, cargaId: "L-A", dados: {}, correlationId: "f-a" });
    const aged73 = await saveCandidaturaDraft({ driverUserId: driverB, cargaId: "L-B", dados: {}, correlationId: "f-b" });
    const aged100 = await saveCandidaturaDraft({ driverUserId: driverC, cargaId: "L-C", dados: {}, correlationId: "f-c" });

    ageRow(fresh.payload.id, 10 * 60 * 1000); // 10 min
    ageRow(aged73.payload.id, 73 * 3600 * 1000); // 73h
    ageRow(aged100.payload.id, 100 * 3600 * 1000); // 100h

    const result = await cleanupExpiredDrafts();
    expect(result.deletedCount).toBe(2);

    // Restou apenas o fresco.
    expect(fakeDb.rows).toHaveLength(1);
    expect(fakeDb.rows[0].id).toBe(fresh.payload.id);
  });

  it("(g) UPDATE de draft 70h atras reseta updated_at — get subsequente retorna 200 (sliding window)", async () => {
    const driverUserId = "ddddddddd-dddd-dddd-dddd-dddddddddddd".slice(0, 36); // sanity
    const driverUserIdValid = "dddddddd-dddd-dddd-dddd-dddddddddddd";

    const saved = await saveCandidaturaDraft({
      driverUserId: driverUserIdValid,
      cargaId: "L-G",
      dados: { step: 1 },
      correlationId: "g-1",
    });

    // Envelhece para 70h atras.
    ageRow(saved.payload.id, 70 * 3600 * 1000);

    // Save novamente (autosave) — UPDATE dispara trigger e reseta updated_at = now().
    const second = await saveCandidaturaDraft({
      driverUserId: driverUserIdValid,
      cargaId: "L-G",
      dados: { step: 2 },
      correlationId: "g-2",
    });

    // Mesmo id (upsert idempotente).
    expect(second.payload.id).toBe(saved.payload.id);

    // updated_at foi resetado — get retorna 200.
    const result = await getCandidaturaDraft({ driverUserId: driverUserIdValid, correlationId: "g-3" });
    expect(result.statusCode).toBe(200);
    expect(result.payload.draft.dados).toEqual({ step: 2 });

    // E o cleanup nao apaga (esta abaixo de 72h apos o reset).
    const cleanupResult = await cleanupExpiredDrafts();
    expect(cleanupResult.deletedCount).toBe(0);
    expect(fakeDb.rows).toHaveLength(1);
  });
});
