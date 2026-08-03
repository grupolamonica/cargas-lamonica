import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock do banco: withPgClient injeta um client cujo query() decide a resposta
// pelo texto do SQL (eventos do lead vs. alocação atual).
//
// `canned.liveEvents` (opcional) desvia a query dos EVENTOS para o pg-mem: o SQL
// REAL do use case roda contra um banco de verdade (prova a projeção server-side do
// validation_summary_json e permite medir bytes). Sem ele, tudo segue mockado.
const canned = { events: [], allocs: [], audit: [], liveEvents: null };
vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: async (cb) =>
    cb({
      query: async (sql, params) => {
        const text = String(sql);
        if (text.includes("load_public_lead_events")) {
          return canned.liveEvents ? canned.liveEvents(text, params) : { rows: canned.events };
        }
        if (text.includes("DISTINCT ON (sheet_lh)")) return { rows: canned.allocs };
        if (text.includes("security_audit_logs")) return { rows: canned.audit };
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
  const cargo = await harness.seedCargo({ sheet_lh: lh, status: "RESERVED" });
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
