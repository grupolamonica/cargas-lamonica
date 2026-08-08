import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Expurgo por retenção da trilha (DC-283 / MED-9).
 *
 * O teste que mais importa aqui é o do `SET LOCAL app.audit_purge`: a trilha é
 * append-only por trigger (ALTO-15), então sem essa declaração o DELETE levanta
 * exceção. Se alguém remover a linha achando que é supérflua, o expurgo passa a
 * falhar em produção — e a retenção volta a não existir sem ninguém notar.
 */

const queries = [];
const fakeDb = { rows: [], audit: [] };

const fakeClient = {
  async query(sql, params = []) {
    const q = sql.replace(/\s+/g, " ").trim();
    queries.push(q);

    if (/^SET LOCAL app\.audit_purge/i.test(q)) return { rows: [], rowCount: 0 };

    if (/SELECT COUNT\(\*\)::int AS elegiveis FROM public\.security_audit_logs/i.test(q)) {
      const cutoff = new Date(params[0]).getTime();
      return { rows: [{ elegiveis: fakeDb.rows.filter((r) => r.created_at < cutoff).length }], rowCount: 1 };
    }

    if (/DELETE FROM public\.security_audit_logs/i.test(q)) {
      const cutoff = new Date(params[0]).getTime();
      const limite = Number(params[1]);
      const alvo = fakeDb.rows
        .filter((r) => r.created_at < cutoff)
        .sort((a, b) => a.created_at - b.created_at)
        .slice(0, limite);
      fakeDb.rows = fakeDb.rows.filter((r) => !alvo.includes(r));
      return { rows: [], rowCount: alvo.length };
    }

    if (/INSERT INTO public\.security_audit_logs/i.test(q)) {
      fakeDb.audit.push(params);
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`[fakeClient] query nao mockada: ${q.slice(0, 120)}`);
  },
};

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) => cb(fakeClient),
  withPgTransaction: async (cb) => cb(fakeClient),
}));

const eventos = [];
vi.mock("../../../infrastructure/security-audit.js", () => ({
  insertSecurityAuditEvent: async (_c, e) => {
    eventos.push(e);
  },
}));

const { purgeExpiredAuditLogs, resolveAuditPurgeMode } = await import("./purge-expired-audit-logs.js");

const DIA = 24 * 60 * 60 * 1000;

function semear(idadeEmDias) {
  fakeDb.rows.push({ id: `ev-${fakeDb.rows.length + 1}`, created_at: Date.now() - idadeEmDias * DIA });
}

describe("expurgo por retencao da trilha de auditoria", () => {
  beforeEach(() => {
    queries.length = 0;
    fakeDb.rows = [];
    fakeDb.audit = [];
    eventos.length = 0;
  });

  it("declara app.audit_purge ANTES do DELETE — sem isso o trigger bloqueia", async () => {
    semear(200);
    await purgeExpiredAuditLogs({ retentionDays: 90 });

    const iSet = queries.findIndex((q) => /^SET LOCAL app\.audit_purge = 'on'/i.test(q));
    const iDel = queries.findIndex((q) => /DELETE FROM public\.security_audit_logs/i.test(q));

    expect(iSet).toBeGreaterThanOrEqual(0);
    expect(iDel).toBeGreaterThanOrEqual(0);
    expect(iSet).toBeLessThan(iDel);
  });

  it("modo report conta e NAO apaga", async () => {
    semear(200);
    semear(10);

    const r = await purgeExpiredAuditLogs({ retentionDays: 90, dryRun: true });

    expect(r.dryRun).toBe(true);
    expect(r.eligibleCount).toBe(1);
    expect(r.deletedCount).toBe(0);
    expect(fakeDb.rows).toHaveLength(2);
    // Em report nem chega a declarar a valvula — nao ha DELETE pra autorizar.
    expect(queries.some((q) => /app\.audit_purge/i.test(q))).toBe(false);
  });

  it("preserva o que ainda esta dentro da retencao", async () => {
    semear(200);
    semear(100);
    semear(89); // dentro dos 90 dias

    const r = await purgeExpiredAuditLogs({ retentionDays: 90 });

    expect(r.deletedCount).toBe(2);
    expect(fakeDb.rows).toHaveLength(1);
  });

  it("respeita o teto por ciclo — o primeiro ciclo nao trava a tabela inteira", async () => {
    for (let i = 0; i < 10; i += 1) semear(200 + i);

    const primeiro = await purgeExpiredAuditLogs({ retentionDays: 90, limit: 4 });
    expect(primeiro.deletedCount).toBe(4);
    expect(fakeDb.rows).toHaveLength(6);
  });

  it("registra na propria trilha QUE houve expurgo", async () => {
    semear(200);
    await purgeExpiredAuditLogs({ retentionDays: 90 });

    const ev = eventos.find((e) => e.eventType === "security-audit.retention.purged");
    expect(ev).toBeTruthy();
    expect(ev.metadata.deletedCount).toBe(1);
    expect(ev.metadata.retentionDays).toBe(90);
  });

  it("ciclo sem nada elegivel nao polui a trilha com evento vazio", async () => {
    semear(10);
    const r = await purgeExpiredAuditLogs({ retentionDays: 90 });

    expect(r.deletedCount).toBe(0);
    expect(eventos).toHaveLength(0);
  });

  it("modo default e 'report'; valor invalido nao vira 'on'", () => {
    expect(resolveAuditPurgeMode(undefined)).toBe("report");
    expect(resolveAuditPurgeMode("banana")).toBe("report");
    expect(resolveAuditPurgeMode("true")).toBe("report");
    expect(resolveAuditPurgeMode("off")).toBe("off");
    expect(resolveAuditPurgeMode("ON")).toBe("on");
  });
});
