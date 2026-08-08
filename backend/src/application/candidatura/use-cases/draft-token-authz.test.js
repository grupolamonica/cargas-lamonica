import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Autorizacao do rascunho ANONIMO por token de posse (DC-283 / CRIT-3 + ALTO-3).
 *
 * Antes: `GET /api/candidatura/draft/me?cpf=` devolvia a ficha inteira (CNH, RG,
 * endereco, credencial de rastreador) pra qualquer CPF informado, e o POST
 * sobrescrevia do mesmo jeito. CPF nao e segredo no Brasil.
 *
 * Estrategia: cliente pg falso em memoria, no mesmo estilo de draft.test.js.
 * O que importa aqui e a decisao de autorizacao, nao o SQL.
 */

const fakeDb = { rows: [], audit: [] };

const fakeClient = {
  async query(sql, params = []) {
    const q = sql.replace(/\s+/g, " ").trim();

    if (/SELECT pg_advisory_xact_lock/i.test(q)) return { rows: [], rowCount: 0 };

    // Busca do rascunho anonimo por CPF (continua sendo a CHAVE de escrita —
    // o que mudou e que achar nao basta mais pra poder escrever).
    if (/SELECT id, id_cadastro, draft_token_hash FROM public\.pending_driver_registrations/i.test(q)) {
      const [cpf] = params;
      const match = fakeDb.rows.filter((r) => r.cpf === cpf).sort((a, b) => b.updated_at - a.updated_at)[0];
      return match
        ? { rows: [{ id: match.id, id_cadastro: match.id_cadastro, draft_token_hash: match.draft_token_hash }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }

    if (/UPDATE public\.pending_driver_registrations SET dados = \$2::jsonb/i.test(q)) {
      const [id, dadosJson, cargaId, tokenHash] = params;
      const row = fakeDb.rows.find((r) => r.id === id);
      row.dados = JSON.parse(dadosJson);
      row.carga_id = cargaId;
      row.draft_token_hash = tokenHash;
      row.updated_at = new Date();
      return { rows: [{ id: row.id, updated_at: row.updated_at }], rowCount: 1 };
    }

    if (/INSERT INTO public\.pending_driver_registrations/i.test(q)) {
      const [idCadastro, cargaId, dadosJson, tokenHash] = params;
      const dados = JSON.parse(dadosJson);
      const row = {
        id: `row-${fakeDb.rows.length + 1}`,
        id_cadastro: idCadastro,
        carga_id: cargaId,
        dados,
        cpf: dados?.motorista?.cpf,
        draft_token_hash: tokenHash,
        updated_at: new Date(),
      };
      fakeDb.rows.push(row);
      return { rows: [{ id: row.id, updated_at: row.updated_at }], rowCount: 1 };
    }

    // Leitura por HASH do token — o CPF nao entra mais nesta consulta.
    if (/SELECT id, carga_id, dados, updated_at FROM public\.pending_driver_registrations WHERE status = 'draft'/i.test(q)) {
      const [tokenHash] = params;
      const match = fakeDb.rows.find((r) => r.draft_token_hash && r.draft_token_hash === tokenHash);
      return match
        ? { rows: [{ id: match.id, carga_id: match.carga_id, dados: match.dados, updated_at: match.updated_at }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }

    if (/INSERT INTO public\.security_audit_logs/i.test(q)) {
      fakeDb.audit.push({ params });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`[fakeClient] query nao mockada: ${q.slice(0, 140)}`);
  },
};

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) => cb(fakeClient),
  withPgTransaction: async (cb) => cb(fakeClient),
}));

const auditEvents = [];
vi.mock("../../../infrastructure/security-audit.js", () => ({
  insertSecurityAuditEvent: async (_client, event) => {
    auditEvents.push(event);
  },
}));

const { saveCandidaturaDraftByCpf } = await import("./save-draft-by-cpf.js");
const { getCandidaturaDraftByToken } = await import("./get-draft.js");
const { hashDraftToken, mintDraftToken, draftTokenMatches } = await import(
  "../../../domain/candidatura/draft-token.js"
);

const CPF_VITIMA = "11122233344";
const CARGA = "carga-1";

function dadosDe(cpf, extras = {}) {
  return { motorista: { cpf, nome: "MOTORISTA TESTE" }, ...extras };
}

describe("rascunho anonimo — autorizacao por token de posse", () => {
  beforeEach(() => {
    fakeDb.rows = [];
    fakeDb.audit = [];
    auditEvents.length = 0;
  });

  it("emite token na primeira gravacao e nao guarda o token em claro", async () => {
    const r = await saveCandidaturaDraftByCpf({
      cpf: CPF_VITIMA,
      cargaId: CARGA,
      dados: dadosDe(CPF_VITIMA),
      correlationId: "c1",
    });

    expect(r.statusCode).toBe(200);
    expect(r.payload.draftToken).toEqual(expect.any(String));
    expect(r.payload.draftToken.length).toBeGreaterThan(20);

    // A coluna guarda o SHA-256, nunca o token: vazar a coluna nao abre rascunho.
    const persistido = fakeDb.rows[0].draft_token_hash;
    expect(persistido).not.toBe(r.payload.draftToken);
    expect(persistido).toBe(hashDraftToken(r.payload.draftToken));
  });

  it("ATAQUE — quem so sabe o CPF nao le a ficha do motorista", async () => {
    const dono = await saveCandidaturaDraftByCpf({
      cpf: CPF_VITIMA,
      cargaId: CARGA,
      dados: dadosDe(CPF_VITIMA, { cnh: { registro: "123456789" } }),
      correlationId: "c1",
    });

    // Atacante tem o CPF (listas sao baratas) e tenta ler. Nao tem token.
    const semToken = await getCandidaturaDraftByToken({ draftToken: null, correlationId: "atk" });
    expect(semToken.statusCode).toBe(204);

    const tokenChutado = mintDraftToken().token;
    const comTokenErrado = await getCandidaturaDraftByToken({
      draftToken: tokenChutado,
      correlationId: "atk",
    });
    // 204, igual a "nao existe": de fora nao da pra distinguir os casos, entao
    // nao ha oraculo de existencia.
    expect(comTokenErrado.statusCode).toBe(204);

    // O dono, com o token dele, continua lendo normalmente.
    const legitimo = await getCandidaturaDraftByToken({
      draftToken: dono.payload.draftToken,
      correlationId: "ok",
    });
    expect(legitimo.statusCode).toBe(200);
    expect(legitimo.payload.draft.dados.cnh.registro).toBe("123456789");
  });

  it("ATAQUE — quem so sabe o CPF nao sobrescreve o rascunho alheio", async () => {
    await saveCandidaturaDraftByCpf({
      cpf: CPF_VITIMA,
      cargaId: CARGA,
      dados: dadosDe(CPF_VITIMA, { cnh: { registro: "ORIGINAL" } }),
      correlationId: "c1",
    });

    const ataque = await saveCandidaturaDraftByCpf({
      cpf: CPF_VITIMA,
      cargaId: CARGA,
      dados: dadosDe(CPF_VITIMA, { cnh: { registro: "ENVENENADO" } }),
      draftToken: mintDraftToken().token, // token valido em forma, errado de dono
      correlationId: "atk",
    });

    expect(ataque.statusCode).toBe(403);
    // E o dado do dono nao foi tocado.
    expect(fakeDb.rows[0].dados.cnh.registro).toBe("ORIGINAL");

    const negado = auditEvents.find((e) => e.eventType === "driver.candidatura.draft_token_rejected");
    expect(negado).toBeTruthy();
    expect(negado.outcome).toBe("denied");
    // A trilha registra a tentativa sem gravar o CPF inteiro.
    expect(negado.metadata.cpf_masked).toBe("111***");
    expect(JSON.stringify(negado.metadata)).not.toContain(CPF_VITIMA);
  });

  it("o dono grava de novo com o token dele e o token nao muda", async () => {
    const primeiro = await saveCandidaturaDraftByCpf({
      cpf: CPF_VITIMA, cargaId: CARGA, dados: dadosDe(CPF_VITIMA), correlationId: "c1",
    });
    const hashInicial = fakeDb.rows[0].draft_token_hash;

    const segundo = await saveCandidaturaDraftByCpf({
      cpf: CPF_VITIMA,
      cargaId: CARGA,
      dados: dadosDe(CPF_VITIMA, { cnh: { registro: "ATUALIZADO" } }),
      draftToken: primeiro.payload.draftToken,
      correlationId: "c2",
    });

    expect(segundo.statusCode).toBe(200);
    // Gravacao comum nao reemite token — o cliente ja tem o dele.
    expect(segundo.payload.draftToken).toBeUndefined();
    expect(fakeDb.rows[0].draft_token_hash).toBe(hashInicial);
    expect(fakeDb.rows[0].dados.cnh.registro).toBe("ATUALIZADO");
  });

  it("rascunho LEGADO (sem token) e adotado na proxima gravacao", async () => {
    // Simula linha criada antes da migration: draft_token_hash NULL.
    fakeDb.rows.push({
      id: "legado-1",
      id_cadastro: "CAD-V2-legado",
      carga_id: CARGA,
      dados: dadosDe(CPF_VITIMA),
      cpf: CPF_VITIMA,
      draft_token_hash: null,
      updated_at: new Date(),
    });

    const r = await saveCandidaturaDraftByCpf({
      cpf: CPF_VITIMA, cargaId: CARGA, dados: dadosDe(CPF_VITIMA), correlationId: "c1",
    });

    expect(r.statusCode).toBe(200);
    // Recebe token novo — sem isso o motorista no meio do cadastro ficaria sem
    // conseguir reler o proprio rascunho depois do deploy.
    expect(r.payload.draftToken).toEqual(expect.any(String));
    expect(fakeDb.rows[0].draft_token_hash).toBe(hashDraftToken(r.payload.draftToken));

    // E a partir daqui o rascunho tem dono: outro token nao entra mais.
    const depois = await saveCandidaturaDraftByCpf({
      cpf: CPF_VITIMA, cargaId: CARGA, dados: dadosDe(CPF_VITIMA), draftToken: mintDraftToken().token, correlationId: "atk",
    });
    expect(depois.statusCode).toBe(403);
  });

  it("comparacao de token e por hash de tamanho fixo (constant-time)", () => {
    const { token, hash } = mintDraftToken();
    expect(draftTokenMatches(token, hash)).toBe(true);
    expect(draftTokenMatches(`${token}x`, hash)).toBe(false);
    expect(draftTokenMatches("", hash)).toBe(false);
    expect(draftTokenMatches(null, hash)).toBe(false);
    // Hash malformado nao passa nem por acidente.
    expect(draftTokenMatches(token, "curto")).toBe(false);
    expect(draftTokenMatches(token, null)).toBe(false);
  });
});
