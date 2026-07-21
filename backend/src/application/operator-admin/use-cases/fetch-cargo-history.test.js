import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock do banco: withPgClient injeta um client cujo query() decide a resposta
// pelo texto do SQL (eventos do lead vs. alocação atual).
const canned = { events: [], allocs: [], audit: [] };
vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) =>
    cb({
      query: async (sql) => {
        if (String(sql).includes("load_public_lead_events")) return { rows: canned.events };
        if (String(sql).includes("DISTINCT ON (sheet_lh)")) return { rows: canned.allocs };
        if (String(sql).includes("security_audit_logs")) return { rows: canned.audit };
        return { rows: [] };
      },
    }),
}));

// Diretório de operadores: id -> { displayName, email }.
const directory = { current: new Map() };
vi.mock("./audit-logs-read-model.js", () => ({
  resolveOperatorDirectory: async () => directory.current,
}));

const { fetchCargoHistoryByLh } = await import("./fetch-cargo-history.js");

describe("fetchCargoHistoryByLh", () => {
  beforeEach(() => {
    canned.events = [];
    canned.allocs = [];
    canned.audit = [];
    directory.current = new Map();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("devolve lista vazia sem erro quando não há nada", async () => {
    const res = await fetchCargoHistoryByLh({ lh: "LT1", correlationId: "c1" });
    expect(res.statusCode).toBe(200);
    expect(res.payload.items).toEqual([]);
  });

  it("traduz eventos do lead para linguagem do operador (motorista + veículos + quem)", async () => {
    directory.current = new Map([["op-1", { displayName: "Ana Paula", email: "ana@x.com" }]]);
    canned.events = [
      {
        event_type: "QUEUED",
        event_payload_json: {},
        actor_type: "driver",
        actor_id: null,
        created_at: "2026-07-10T12:00:00.000Z",
        horse_plate: "ABC1D23",
        trailer_plate: "XYZ9K88",
        phone: "5511999998888",
        validation_summary_json: { driver: { angelira: { displayName: "Valdenio Gomes" } } },
      },
      {
        event_type: "APPROVED",
        event_payload_json: {},
        actor_type: "operator",
        actor_id: "op-1",
        created_at: "2026-07-10T13:00:00.000Z",
        horse_plate: "ABC1D23",
        trailer_plate: "XYZ9K88",
        phone: "5511999998888",
        validation_summary_json: { driver: { angelira: { displayName: "Valdenio Gomes" } } },
      },
    ];

    const { items } = (await fetchCargoHistoryByLh({ lh: "LT1", correlationId: "c1" })).payload;

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      titulo: "Entrou na fila de candidatos",
      detalhe: "Valdenio Gomes — cavalo ABC1D23 · carreta XYZ9K88",
      por: "Motorista (pelo portal)",
      tipo: "QUEUED",
    });
    expect(items[1]).toMatchObject({
      titulo: "Reservado para o motorista",
      por: "Ana Paula",
      tipo: "APPROVED",
    });
  });

  it("inclui a alocação atual do sistema com nome do operador e motivo", async () => {
    directory.current = new Map([["op-2", { displayName: "Carlos Dias", email: "carlos@x.com" }]]);
    canned.allocs = [
      {
        alloc_motorista: "Leonardo Lima",
        alloc_cavalo: "AAA1B11",
        alloc_carreta: "CCC2D22",
        alloc_descricao: "troca de rota",
        alloc_updated_by: "op-2",
        alloc_updated_at: "2026-07-11T09:00:00.000Z",
      },
    ];

    const { items } = (await fetchCargoHistoryByLh({ lh: "LT2", correlationId: "c2" })).payload;

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      titulo: "Motorista alocado no sistema",
      por: "Carlos Dias",
      tipo: "ALLOC_OPERADOR",
    });
    expect(items[0].detalhe).toContain("Leonardo Lima");
    expect(items[0].detalhe).toContain("cavalo AAA1B11");
    expect(items[0].detalhe).toContain("motivo: troca de rota");
  });

  it("ordena por data crescente (evento antigo antes da alocação recente)", async () => {
    canned.events = [
      {
        event_type: "APPROVED",
        event_payload_json: {},
        actor_type: "operator",
        actor_id: null,
        created_at: "2026-07-10T13:00:00.000Z",
        validation_summary_json: null,
      },
    ];
    canned.allocs = [
      {
        alloc_motorista: "Leonardo Lima",
        alloc_updated_by: null,
        alloc_updated_at: "2026-07-11T09:00:00.000Z",
      },
    ];

    const { items } = (await fetchCargoHistoryByLh({ lh: "LT3", correlationId: "c3" })).payload;
    expect(items.map((i) => i.tipo)).toEqual(["APPROVED", "ALLOC_OPERADOR"]);
  });

  it("inclui as mudanças de alocação do operador (audit log): set e remoção do motorista", async () => {
    directory.current = new Map([["op-9", { displayName: "Marina Reis", email: "marina@x.com" }]]);
    canned.audit = [
      {
        event_type: "operator.cargo.allocation_updated",
        actor_user_id: "op-9",
        created_at: "2026-07-17T20:57:59.000Z",
        metadata: { changes: [{ field: "motorista", label: "Motorista", before: null, after: "FERNANDO" }] },
      },
      {
        event_type: "operator.cargo.allocation_updated",
        actor_user_id: "op-9",
        created_at: "2026-07-21T15:51:50.000Z",
        metadata: { changes: [{ field: "motorista", label: "Motorista", before: "FERNANDO", after: null }] },
      },
      // Update sem mudança real → ignorado (ruído).
      { event_type: "operator.cargo.allocation_updated", actor_user_id: "op-9", created_at: "2026-07-21T15:56:40.000Z", metadata: { changes: [] } },
    ];

    const { items } = (await fetchCargoHistoryByLh({ lh: "LT0Q7M02BME81", correlationId: "c9" })).payload;
    const alloc = items.filter((i) => i.tipo === "ALLOC_AUDIT");
    expect(alloc).toHaveLength(2); // o de changes vazio foi pulado
    expect(alloc[0]).toMatchObject({ titulo: "Alocação alterada no sistema", por: "Marina Reis" });
    expect(alloc[0].detalhe).toBe("Motorista: vazio → FERNANDO");
    expect(alloc[1].detalhe).toBe("Motorista: FERNANDO → vazio");
  });

  it("cai no rótulo 'Motorista (final NNNN)' quando não há nome do Angellira", async () => {
    canned.events = [
      {
        event_type: "PRE_REGISTERED",
        event_payload_json: {},
        actor_type: "driver",
        actor_id: null,
        created_at: "2026-07-10T10:00:00.000Z",
        phone: "5511912345678",
        validation_summary_json: null,
      },
    ];
    const { items } = (await fetchCargoHistoryByLh({ lh: "LT4", correlationId: "c4" })).payload;
    expect(items[0].detalhe).toBe("Motorista (final 5678)");
  });
});
