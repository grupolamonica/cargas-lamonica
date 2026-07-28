import { describe, it, expect } from "vitest";

import { notifyNewQueueDrivers } from "./notify-new-queue-drivers.js";

// Linha crua da query leve (leads QUEUED recém-entrados). O filtro por queued_at/status é
// no SQL — aqui o fake devolve o que a query "retornaria".
function row(id, over = {}) {
  return {
    id,
    load_id: `C-${id}`,
    phone: "71999998888",
    load_origem: "Simoes Filho/BA",
    load_destino: "Jaboatão/PE",
    validation_summary_json: null,
    aspx_display_name: `Motorista ${id}`,
    pdr_display_name: null,
    ...over,
  };
}

// Fake pg client: responde à query de candidatos + à de dedup, e grava os INSERTs.
function makeDeps({ candidates, alreadyIds = [], throwCode } = {}) {
  const inserts = [];
  const client = {
    query: (sql, params) => {
      if (throwCode && /FROM public\.load_public_leads/.test(sql)) {
        const e = new Error("boom");
        e.code = throwCode;
        return Promise.reject(e);
      }
      if (/FROM public\.load_public_leads/.test(sql)) return Promise.resolve({ rows: candidates });
      if (/SELECT DISTINCT metadata/.test(sql)) return Promise.resolve({ rows: alreadyIds.map((id) => ({ id })) });
      if (/INSERT INTO public\.operator_notifications/.test(sql)) {
        inserts.push({ title: params[0], body: params[1], metadata: JSON.parse(params[2]) });
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    },
  };
  return { deps: { withPgClient: (fn) => fn(client) }, inserts };
}

describe("notifyNewQueueDrivers (DC-299)", () => {
  it("notifica motorista recém-entrado na fila (insere new_queue_driver com lead/carga/nome)", async () => {
    const { deps, inserts } = makeDeps({ candidates: [row("L1")] });
    const res = await notifyNewQueueDrivers({ deps });
    expect(res.notified).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].metadata.lead_id).toBe("L1");
    expect(inserts[0].metadata.carga_id).toBe("C-L1");
    expect(inserts[0].title).toContain("Motorista L1");
    expect(inserts[0].body).toContain("Simoes Filho/BA → Jaboatão/PE");
  });

  it("sem candidatos → não faz nada", async () => {
    const { deps, inserts } = makeDeps({ candidates: [] });
    const res = await notifyNewQueueDrivers({ deps });
    expect(res.notified).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it("dedup: não renotifica lead já notificado nas últimas 24h", async () => {
    const { deps, inserts } = makeDeps({ candidates: [row("L1")], alreadyIds: ["L1"] });
    const res = await notifyNewQueueDrivers({ deps });
    expect(res.notified).toBe(0);
    expect(res.skipped).toBe(1);
    expect(inserts).toHaveLength(0);
  });

  it("nome: Angellira (validation_summary_json) vence ASPx; sem nome cai no telefone", async () => {
    const { deps, inserts } = makeDeps({
      candidates: [
        row("L1", { validation_summary_json: { driver: { angelira: { displayName: "JOÃO DA SILVA" } } }, aspx_display_name: "IGNORAR" }),
        row("L2", { aspx_display_name: null, pdr_display_name: null, phone: "71911112222" }),
      ],
    });
    const res = await notifyNewQueueDrivers({ deps });
    expect(res.notified).toBe(2);
    expect(inserts[0].title).toContain("JOÃO DA SILVA");
    expect(inserts[1].title).toContain("71911112222");
  });

  it("tabela ausente (42P01) → no-op silencioso (ok:false)", async () => {
    const { deps, inserts } = makeDeps({ throwCode: "42P01" });
    const res = await notifyNewQueueDrivers({ deps });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("table_missing");
    expect(inserts).toHaveLength(0);
  });

  it("fila indisponível (erro qualquer) → no-op silencioso (ok:false)", async () => {
    const { deps } = makeDeps({ throwCode: "57014" });
    const res = await notifyNewQueueDrivers({ deps });
    expect(res.ok).toBe(false);
    expect(res.notified).toBe(0);
  });
});
