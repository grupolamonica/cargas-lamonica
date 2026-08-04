import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock do banco: withPgClient injeta um client cujo query() decide a resposta
// pelo texto do SQL (eventos do lead vs. alocação atual).
//
// `canned.liveEvents` (opcional) desvia a query dos EVENTOS para o pg-mem: o SQL
// REAL do use case roda contra um banco de verdade (prova a projeção server-side do
// validation_summary_json e permite medir bytes). Sem ele, tudo segue mockado.
// `canned.resolved` são as cargas que representam o LH/cargoId (planilha e/ou
// sistema); `canned.cascade`, os eventos de lote (remanejar/desfazer) sem resource_id.
const canned = { events: [], allocs: [], audit: [], cascade: [], resolved: [], liveEvents: null };
// SQL de cada consulta, capturado p/ os testes de resolução da carga.
const seenSql = { resolve: null, events: null, allocs: null };
const seenParams = { resolve: null, events: null, allocs: null, audit: null };
vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) =>
    cb({
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("load_public_lead_events")) {
          seenSql.events = text;
          seenParams.events = params;
          return canned.liveEvents ? canned.liveEvents(text, params) : { rows: canned.events };
        }
        if (text.includes("alloc_motorista")) {
          seenSql.allocs = text;
          seenParams.allocs = params;
          return { rows: canned.allocs };
        }
        if (text.includes("security_audit_logs")) {
          if (text.includes("resource_id IS NULL")) return { rows: canned.cascade };
          seenParams.audit = params;
          return { rows: canned.audit };
        }
        if (text.includes("FROM public.cargas")) {
          seenSql.resolve = text;
          seenParams.resolve = params;
          return { rows: canned.resolved };
        }
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
const { createSheetLoadId } = await import("../../google-sheets/google-sheet-loads.js");

describe("fetchCargoHistoryByLh", () => {
  beforeEach(() => {
    canned.events = [];
    canned.allocs = [];
    canned.audit = [];
    canned.cascade = [];
    canned.resolved = [];
    canned.liveEvents = null;
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
        angellira_display_name: "Valdenio Gomes",
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
        angellira_display_name: "Valdenio Gomes",
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
        angellira_display_name: null,
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
        angellira_display_name: null,
      },
    ];
    const { items } = (await fetchCargoHistoryByLh({ lh: "LT4", correlationId: "c4" })).payload;
    expect(items[0].detalhe).toBe("Motorista (final 5678)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Identificação da carga
//
// Um LH do Monitor pode viver em MAIS DE UMA carga — a da planilha (sheet_lh, id
// determinístico) e a do SISTEMA lançada na Programação (lh_manual, id aleatório) —
// e a carga do sistema pode nem ter LH. Ler só `sheet_lh = lh` e
// `resource_id = createSheetLoadId(lh)` deixou 297 cargas de produção com o
// histórico vazio ou pela metade: o registro estava na OUTRA carga do mesmo LH.
// ─────────────────────────────────────────────────────────────────────────────
describe("fetchCargoHistoryByLh · qual carga o LH representa", () => {
  beforeEach(() => {
    canned.events = [];
    canned.allocs = [];
    canned.audit = [];
    canned.cascade = [];
    canned.resolved = [];
    canned.liveEvents = null;
    directory.current = new Map();
    seenSql.resolve = null;
    seenSql.events = null;
    seenSql.allocs = null;
    seenParams.resolve = null;
    seenParams.events = null;
    seenParams.allocs = null;
    seenParams.audit = null;
  });

  it("procura a carga LANÇADA (lh_manual) além da carga da planilha", async () => {
    await fetchCargoHistoryByLh({ lh: "LT0Q7R02CH001", correlationId: "c-l1" });

    // Eventos e alocação passam a casar a carga do SISTEMA lançada na Programação.
    expect(seenSql.events).toContain("c.lh_manual = $1");
    expect(seenSql.allocs).toContain("c.lh_manual = $1");
    expect(seenParams.events[0]).toBe("LT0Q7R02CH001");
    // A carga da planilha entra pelo id determinístico (namespace da fonte).
    expect(seenParams.events).toContain(createSheetLoadId("LT0Q7R02CH001"));
  });

  it("NÃO casa por sheet_lh: o mesmo LH existe em duas planilhas (Shopee e Nestlé)", async () => {
    // `sheet_lh` é único só POR fonte. Um ramo `OR sheet_lh = <LH>` traria a carga da
    // OUTRA fonte junto e o modal mostraria o histórico de outra carga. A fonte está
    // no id (`createSheetLoadId(lh, source)`) — é ela que desambigua.
    await fetchCargoHistoryByLh({ lh: "B101454518", correlationId: "c-l5" });
    expect(seenSql.events).not.toContain("c.sheet_lh = $1");
    expect(seenSql.allocs).not.toContain("c.sheet_lh = $1");
    expect(seenSql.resolve).not.toContain("sheet_lh = $1");
  });

  it("ancora a auditoria nos ids REAIS da carga (planilha + sistema), não só no id determinístico", async () => {
    // Resolução devolve a carga do SISTEMA (id aleatório) que carrega este LH.
    canned.resolved = [{ id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" }];
    canned.audit = [
      {
        event_type: "operator.cargo.allocation_updated",
        actor_user_id: null,
        created_at: "2026-07-27T10:00:00.000Z",
        metadata: { changes: [{ field: "motorista", label: "Motorista", before: null, after: "MATHEUS" }] },
      },
    ];

    const { items } = (await fetchCargoHistoryByLh({ lh: "LT0Q7R02CH001", correlationId: "c-l2" })).payload;

    // O id aleatório da carga do sistema entra na busca do audit log.
    expect(seenParams.audit[0]).toContain("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
    expect(items.map((i) => i.tipo)).toContain("ALLOC_AUDIT");
  });

  it("aceita cargoId sem LH (carga do sistema que o front não conseguia consultar)", async () => {
    canned.resolved = [{ id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" }];
    canned.audit = [
      {
        event_type: "operator.cargo.monitor_system_updated",
        actor_user_id: null,
        created_at: "2026-08-03T12:00:00.000Z",
        metadata: { changes: [{ field: "status", label: "Status", before: "", after: "CARREGADO" }] },
      },
    ];

    const { items } = (
      await fetchCargoHistoryByLh({ cargoId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", correlationId: "c-l3" })
    ).payload;

    // Sem LH, o SQL não compara lh_manual com string vazia — casa só por id.
    expect(seenSql.events).not.toContain("c.lh_manual = $1");
    expect(seenSql.events).toContain("c.id = $2");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ titulo: "Carga editada no Monitor" });
  });

  it("não duplica a alocação quando a carga gêmea (planilha + sistema) repete o mesmo motorista", async () => {
    const alloc = {
      alloc_motorista: "PAULO ERIVALDO",
      alloc_cavalo: "AAA1B11",
      alloc_carreta: "CCC2D22",
      alloc_descricao: null,
      alloc_updated_by: null,
      alloc_updated_at: "2026-08-01T09:00:00.000Z",
    };
    canned.allocs = [
      { id: "1111", ...alloc },
      { id: "2222", ...alloc },
    ];

    const { items } = (await fetchCargoHistoryByLh({ lh: "LT0Q8102C0G21", correlationId: "c-l4" })).payload;
    expect(items.filter((i) => i.tipo === "ALLOC_OPERADOR")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cobertura das ações
//
// O histórico mostrava 1 de 15 tipos de evento de carga (`allocation_updated`).
// Cancelar em cascata, editar a carga, ligar/desligar pro motorista, descer na
// fila: tudo isso é "o que aconteceu com a carga" e não aparecia.
// ─────────────────────────────────────────────────────────────────────────────
describe("fetchCargoHistoryByLh · ações registradas na auditoria", () => {
  beforeEach(() => {
    canned.events = [];
    canned.allocs = [];
    canned.audit = [];
    canned.cascade = [];
    canned.resolved = [];
    canned.liveEvents = null;
    directory.current = new Map();
  });

  it("mostra cancelamento em cascata, edição da carga e mudança de disponibilidade", async () => {
    directory.current = new Map([["op-3", { displayName: "Rita Alves", email: "rita@x.com" }]]);
    canned.audit = [
      {
        event_type: "operator.cargo.cancel_cascade",
        actor_user_id: "op-3",
        created_at: "2026-08-01T10:00:00.000Z",
        metadata: { motivo: "motorista desistiu" },
      },
      {
        event_type: "operator.cargo.status_toggled",
        actor_user_id: "op-3",
        created_at: "2026-08-01T11:00:00.000Z",
        metadata: { changes: [{ field: "status", label: "Status", before: "OPEN", after: "BOOKED" }] },
      },
      {
        event_type: "operator.cargo.queue_descended",
        actor_user_id: "op-3",
        created_at: "2026-08-01T12:00:00.000Z",
        metadata: { count: 3 },
      },
    ];

    const { items } = (await fetchCargoHistoryByLh({ lh: "LT9", correlationId: "c-a1" })).payload;

    expect(items.map((i) => i.titulo)).toEqual([
      "Carga cancelada (motorista desceu)",
      "Disponibilidade para o motorista alterada",
      "Motorista desceu na fila",
    ]);
    expect(items[0].detalhe).toBe("motivo: motorista desistiu");
    expect(items[0].por).toBe("Rita Alves");
    expect(items[1].detalhe).toBe("Status: OPEN → BOOKED");
  });

  it("tipo desconhecido aparece sem jargão técnico (tela do operador)", async () => {
    canned.audit = [
      { event_type: "operator.cargo.algo_novo", actor_user_id: null, created_at: "2026-08-02T10:00:00.000Z", metadata: {} },
    ];
    const { items } = (await fetchCargoHistoryByLh({ lh: "LT10", correlationId: "c-a2" })).payload;
    expect(items).toHaveLength(1);
    expect(items[0].titulo).toBe("Alteração registrada na carga");
    expect(items[0].titulo).not.toContain("operator.cargo");
  });

  it("no remanejamento em lote, mostra só o trecho DESTA carga", async () => {
    canned.cascade = [
      {
        event_type: "operator.cargo.allocation_reassigned",
        actor_user_id: null,
        created_at: "2026-08-02T14:00:00.000Z",
        metadata: {
          count: 2,
          moves: [
            { lh: "LT-OUTRA", motorista: "OUTRO MOTORISTA", cavalo: "ZZZ9Z99", carreta: "" },
            { lh: "LT-MINHA", motorista: "MEU MOTORISTA", cavalo: "AAA1A11", carreta: "BBB2B22" },
          ],
        },
      },
    ];

    const { items } = (await fetchCargoHistoryByLh({ lh: "LT-MINHA", correlationId: "c-a3" })).payload;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ titulo: "Fila remanejada", tipo: "operator.cargo.allocation_reassigned" });
    expect(items[0].detalhe).toBe("MEU MOTORISTA — cavalo AAA1A11 · carreta BBB2B22");
    expect(items[0].detalhe).not.toContain("OUTRO MOTORISTA");
  });

  it("ignora o evento de lote que não menciona esta carga", async () => {
    canned.cascade = [
      {
        event_type: "operator.cargo.allocation_reassigned",
        actor_user_id: null,
        created_at: "2026-08-02T14:00:00.000Z",
        metadata: { moves: [{ lh: "LT-OUTRA", motorista: "OUTRO" }] },
      },
    ];
    const { items } = (await fetchCargoHistoryByLh({ lh: "LT-MINHA", correlationId: "c-a4" })).payload;
    expect(items).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Projeção server-side do validation_summary_json (egress)
//
// A query dos eventos passou a extrair SÓ o nome do Angellira
// (`validation_summary_json->'driver'->'angelira'->>'displayName'`) em vez de descer o
// JSON INTEIRO — a coluna mais larga do banco (~1,5 KB/lead), que o LEFT JOIN repetia
// em CADA evento do lead (o modal lê até 200). Aqui o SQL REAL do use case roda contra
// o pg-mem p/ provar: (a) extrai o MESMO nome que a leitura antiga em JS, (b) o blob
// não desce mais, (c) o texto exibido no modal não mudou.
// ─────────────────────────────────────────────────────────────────────────────
const harness = await import("../test-harness.js");

// Query ANTERIOR à mudança — mantida SÓ como baseline de egress (não roda em produção).
const LEGACY_EVENTS_SQL = `
  SELECT e.event_type, e.event_payload_json, e.actor_type, e.actor_id, e.created_at,
         l.horse_plate, l.trailer_plate, l.phone, l.validation_summary_json
  FROM public.load_public_lead_events e
  JOIN public.cargas c ON c.id = e.load_id
  LEFT JOIN public.load_public_leads l ON l.id = e.lead_id
  WHERE c.sheet_lh = $1
  ORDER BY e.created_at ASC, e.id ASC
  LIMIT 200
`;

// Leitura ANTIGA do nome, em JS, a partir do JSON inteiro — referência de equivalência.
function legacyAngelliraDisplayName(validationSummaryJson) {
  let summary = validationSummaryJson;
  if (typeof summary === "string") {
    try {
      summary = JSON.parse(summary);
    } catch {
      summary = null;
    }
  }
  const name = summary?.driver?.angelira?.displayName;
  return typeof name === "string" && name.trim() ? name.trim() : "";
}

// Instrumentação do client do pg-mem (proxy de egress: consultas/linhas/bytes).
// O Symbol é obrigatório: o pool do pg-mem REUSA o mesmo client entre connect()s —
// sem a marca, cada medição embrulharia query() de novo e contaria em dobro.
const QUERY_INSTRUMENTED = Symbol("fetch-cargo-history.query-instrumented");
let activeCounter = null;

function newCounter() {
  return { queries: 0, rows: 0, bytes: 0 };
}

async function runOnPgMem(sql, params) {
  return harness.withPgClient(async (client) => {
    if (!client[QUERY_INSTRUMENTED]) {
      const original = client.query.bind(client);
      client.query = async (text, args) => {
        const res = await original(text, args);
        if (activeCounter) {
          activeCounter.queries += 1;
          activeCounter.rows += res.rows.length;
          // JSON.stringify das linhas = proxy dos bytes que atravessam a conexão.
          activeCounter.bytes += JSON.stringify(res.rows).length;
        }
        return res;
      };
      client[QUERY_INSTRUMENTED] = true;
    }
    return client.query(sql, params);
  });
}

// JSON realista: ~1,5 KB de ficha de validação + o único campo que o modal usa.
function fatSummary(displayName) {
  return {
    schemaVersion: 1,
    checkedAt: "2026-07-10T09:00:00.000Z",
    driver: {
      angelira: {
        status: "FOUND",
        found: true,
        displayName,
        statusText: "Cadastro ativo",
        validUntil: "2026-12-31",
        raw: { padding: "x".repeat(900) },
      },
      aspx: { found: true, displayName, raw: { padding: "y".repeat(400) } },
    },
    vehicles: { horse: { padding: "z".repeat(200) } },
  };
}

async function seedHistory(lh, summaryJson, { phone = "71999999999", events = ["PRE_REGISTERED", "QUEUED", "WHATSAPP_CLICKED", "APPROVED"] } = {}) {
  // `id` determinístico como o sync grava em produção — é por ele que a leitura
  // encontra a carga da planilha (o LH sozinho não identifica: `sheet_lh` é único
  // só por fonte).
  const cargo = await harness.seedCargo({ id: createSheetLoadId(lh), sheet_lh: lh, status: "RESERVED" });
  const lead = await harness.seedPublicLead({
    load_id: cargo.id,
    phone,
    horse_plate: "ABC1D23",
    trailer_plate: "XYZ9K88",
    validation_summary_json: summaryJson,
  });
  for (const [i, type] of events.entries()) {
    await harness.query(
      `INSERT INTO public.load_public_lead_events
         (load_id, lead_id, event_type, event_payload_json, actor_type, actor_id, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [
        cargo.id,
        lead.id,
        type,
        JSON.stringify({ correlation_id: "c-egress" }),
        "public-driver",
        "12345678901",
        new Date(Date.UTC(2026, 6, 10, 10 + i)).toISOString(),
      ],
    );
  }
  return { cargo, lead };
}

describe("fetch-cargo-history · projeção server-side do nome do Angellira (egress)", () => {
  beforeEach(async () => {
    await harness.resetTestDatabase();
    canned.events = [];
    canned.allocs = [];
    canned.audit = [];
    canned.cascade = [];
    canned.resolved = [];
    canned.liveEvents = null;
    directory.current = new Map();
    activeCounter = null;
  });

  afterAll(async () => {
    await harness.closeTestDatabase();
  });

  it("extrai no SQL o MESMO nome que a leitura antiga em JS, em todas as formas do JSON", async () => {
    const casos = [
      ["LT-NOME", fatSummary("Valdenio Gomes"), "Valdenio Gomes"],
      ["LT-ESPACO", fatSummary("  Valdenio Gomes  "), "Valdenio Gomes"],
      ["LT-VAZIO", fatSummary(""), ""],
      ["LT-NULO", fatSummary(null), ""],
      ["LT-SEM-ANGELIRA", { schemaVersion: 1, driver: { aspx: { found: true } } }, ""],
      ["LT-SEM-DRIVER", { schemaVersion: 1 }, ""],
      ["LT-JSON-VAZIO", {}, ""],
    ];
    for (const [lh, summary] of casos) {
      await seedHistory(lh, summary, { events: ["QUEUED"] });
    }

    for (const [lh, , esperado] of casos) {
      // Novo caminho: SQL real do use case (capturado pelo mock) → nome projetado.
      let capturado = null;
      canned.liveEvents = async (sql, params) => {
        capturado = await runOnPgMem(sql, params);
        return capturado;
      };
      await fetchCargoHistoryByLh({ lh, correlationId: "c-eq" });
      const novo = capturado.rows.map((r) => r.angellira_display_name ?? null);

      // Caminho antigo: JSON inteiro + extração em JS.
      const legado = await runOnPgMem(LEGACY_EVENTS_SQL, [lh]);
      const antigo = legado.rows.map((r) => legacyAngelliraDisplayName(r.validation_summary_json));

      expect(novo).toHaveLength(antigo.length);
      novo.forEach((n, i) => {
        const normalizado = typeof n === "string" && n.trim() ? n.trim() : "";
        expect(normalizado, `caso ${lh}`).toBe(antigo[i]);
        expect(normalizado, `caso ${lh}`).toBe(esperado);
      });
    }
  });

  it("o modal mostra os MESMOS textos rodando o SQL real (nome, veículos, fallback de telefone)", async () => {
    await seedHistory("LT-MODAL", fatSummary("Valdenio Gomes"));
    await seedHistory("LT-ANONIMO", fatSummary(null), { phone: "5511912345678", events: ["PRE_REGISTERED"] });
    canned.liveEvents = (sql, params) => runOnPgMem(sql, params);

    const comNome = (await fetchCargoHistoryByLh({ lh: "LT-MODAL", correlationId: "c-m1" })).payload.items;
    expect(comNome.map((i) => i.tipo)).toEqual(["PRE_REGISTERED", "QUEUED", "WHATSAPP_CLICKED", "APPROVED"]);
    // `por` = "Sistema (automático)" porque o actor_type gravado em produção é
    // "public-driver" (actorLabel só traduz "driver"/"public") — comportamento
    // pré-existente, preservado aqui de propósito p/ o teste refletir o dado real.
    expect(comNome[0]).toMatchObject({ titulo: "Cadastro iniciado", detalhe: "Valdenio Gomes", por: "Sistema (automático)" });
    expect(comNome[1].detalhe).toBe("Valdenio Gomes — cavalo ABC1D23 · carreta XYZ9K88");
    expect(comNome[3].detalhe).toBe("Valdenio Gomes — cavalo ABC1D23 · carreta XYZ9K88");

    const semNome = (await fetchCargoHistoryByLh({ lh: "LT-ANONIMO", correlationId: "c-m2" })).payload.items;
    expect(semNome[0].detalhe).toBe("Motorista (final 5678)");
  });

  it("não desce mais o validation_summary_json: menos bytes, MESMAS linhas", async () => {
    // 6 eventos do mesmo lead = o JSON gordo repetido 6x na resposta antiga.
    await seedHistory("LT-BYTES", fatSummary("Valdenio Gomes"), {
      events: ["PRE_REGISTERED", "QUEUED", "WHATSAPP_CLICKED", "APPROVED", "CANCELLED", "SHEET_WRITEBACK"],
    });

    const atual = newCounter();
    let capturado = null;
    canned.liveEvents = async (sql, params) => {
      activeCounter = atual;
      capturado = await runOnPgMem(sql, params);
      activeCounter = null;
      return capturado;
    };
    await fetchCargoHistoryByLh({ lh: "LT-BYTES", correlationId: "c-bytes" });

    const legado = newCounter();
    activeCounter = legado;
    const legadoRes = await runOnPgMem(LEGACY_EVENTS_SQL, ["LT-BYTES"]);
    activeCounter = null;

    // O Symbol impede o duplo-embrulho (o pool do pg-mem reusa o client): 1 query = 1 contagem.
    expect(atual.queries).toBe(1);
    expect(legado.queries).toBe(1);

    // Mesmas linhas (nada de filtro novo) — só a largura da linha mudou.
    expect(atual.rows).toBe(6);
    expect(legado.rows).toBe(6);
    expect(atual.rows).toBe(legado.rows);

    // O blob não atravessa mais: sem a coluna e sem o padding que ela carregava.
    expect(Object.keys(capturado.rows[0])).not.toContain("validation_summary_json");
    expect(JSON.stringify(capturado.rows)).not.toContain("x".repeat(900));
    expect(Object.keys(legadoRes.rows[0])).toContain("validation_summary_json");

    // Redução medida (JSON.stringify das linhas como proxy dos bytes).
    console.log(
      `[egress] eventos do histórico: antes ${legado.bytes} B → depois ${atual.bytes} B ` +
        `(-${(100 - (atual.bytes / legado.bytes) * 100).toFixed(1)}%, ${atual.rows} linhas)`,
    );
    expect(atual.bytes).toBeLessThan(legado.bytes / 5);
  });
});
