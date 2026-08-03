/**
 * Egress da lista de motoristas do operador (`/api/operator/motoristas`).
 *
 * MEDIÇÃO DE PRODUÇÃO que motivou este arquivo (delta de 1091 s do
 * pg_stat_statements, queryid 5169514305073726344 = varredura de
 * motoristas_historico deste read model): 3 chamadas em 18 minutos, 5.655 linhas
 * — 1.885 linhas POR CHAMADA, praticamente a tabela inteira (~1.862 linhas), com
 * um jsonb de 14 campos por linha. ~448 mil linhas/dia, o maior produtor medido.
 *
 * O micro-cache de 30 s do round anterior não rendeu nada porque as chamadas
 * chegam ESPAÇADAS (~364 s entre as medidas): a tela não faz polling e o próprio
 * cliente já dedup parâmetros iguais por 30 s. Estes testes travam, então, o que
 * de fato reduz o volume por chamada:
 *   1. filtro de origem/status que descarta o HISTÓRICO não lê o HISTÓRICO;
 *   2. busca vira pré-filtro no SQL (superset) em vez de varredura + filtro em JS;
 *   3. a ficha completa (jsonb de 14 campos) só é lida para os itens da PÁGINA;
 *   4. e que a lista produzida é IDÊNTICA em todos esses caminhos — inclusive
 *      dedup entre fontes, busca por nome, busca por CPF, virada de página e
 *      homônimos.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedCliente,
  seedDriverProfile,
  seedLoadClaim,
  seedPublicLead,
  withPgClient as harnessWithPgClient,
} from "./test-harness.js";

// ── instrumentação do client pg ───────────────────────────────────────────────
const dbStats = { queries: 0, rows: 0, byTag: {} };

function resetDbStats() {
  dbStats.queries = 0;
  dbStats.rows = 0;
  dbStats.byTag = {};
}

function snapshotDbStats() {
  return {
    queries: dbStats.queries,
    rows: dbStats.rows,
    byTag: Object.fromEntries(Object.entries(dbStats.byTag).map(([tag, value]) => [tag, { ...value }])),
  };
}

function tagOf(sql) {
  if (sql.includes("motoristas_historico")) {
    return sql.includes("jsonb_build_object") ? "historicoDetails" : "historicoScan";
  }
  if (sql.includes("FROM public.driver_profiles")) return "registeredSummary";
  if (sql.includes("FROM public.load_public_leads AS leads") && sql.includes("GROUP BY")) return "publicSummary";
  if (sql.includes("FROM public.load_public_leads AS leads")) return "publicApplications";
  if (sql.includes("FROM public.load_claims")) return "registeredApplications";
  return "other";
}

function statsFor(stats, tag) {
  return stats.byTag[tag] ?? { queries: 0, rows: 0, bytes: 0, valueBytes: 0 };
}

/**
 * Proxy do protocolo de TEXTO do Postgres: só os VALORES, com o overhead de 4 B
 * do prefixo de tamanho de cada campo (NULL = só o prefixo). Ao contrário do
 * JSON.stringify, não repete o nome da coluna em cada linha — o Postgres manda o
 * RowDescription uma única vez — então é a medida mais fiel de "quanto isso pesa
 * na rede" disponível dentro do pg-mem.
 */
function estimateWireBytes(rows) {
  let total = 0;
  for (const row of rows ?? []) {
    for (const value of Object.values(row)) {
      total += 4;
      if (value === null || value === undefined) continue;
      if (value instanceof Date) {
        total += 29; // '2026-08-03 00:00:00.000000+00'
        continue;
      }
      total += Buffer.byteLength(typeof value === "object" ? JSON.stringify(value) : String(value), "utf8");
    }
  }
  return total;
}

// O pool do pg-mem REUTILIZA clients: sem a guarda de Symbol o mesmo client
// seria envolvido várias vezes e cada consulta contaria em dobro.
const INSTRUMENTED = Symbol.for("egress.instrumented.operator-drivers");

function instrumentClient(client) {
  if (client[INSTRUMENTED]) return client;
  const originalQuery = client.query.bind(client);
  client.query = async (...args) => {
    const result = await originalQuery(...args);
    const sql = typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "");
    const tag = tagOf(sql);
    const rows = result?.rows?.length ?? result?.rowCount ?? 0;
    // Proxy de bytes: tamanho JSON do resultado. Não é o protocolo do Postgres,
    // mas é a única medida de LARGURA de linha disponível em pg-mem — e é a
    // dimensão que muda quando se corta coluna em vez de linha.
    const bytes = Buffer.byteLength(JSON.stringify(result?.rows ?? []), "utf8");
    dbStats.queries += 1;
    dbStats.rows += rows;
    const bucket = (dbStats.byTag[tag] ??= { queries: 0, rows: 0, bytes: 0, valueBytes: 0 });
    bucket.queries += 1;
    bucket.rows += rows;
    bucket.bytes += bytes;
    bucket.valueBytes += estimateWireBytes(result?.rows);
    return result;
  };
  client[INSTRUMENTED] = true;
  return client;
}

vi.mock("../../infrastructure/pg/postgres.js", () => ({
  withPgClient: (callback) => harnessWithPgClient((client) => callback(instrumentClient(client))),
}));

const readModels = await import("./read-models.js");

// ── fixture ──────────────────────────────────────────────────────────────────
const PUSHDOWN_ENV = "OPERATOR_DRIVERS_HISTORICO_PUSHDOWN";
const HISTORICO_TTL_ENV = "OPERATOR_DRIVERS_HISTORICO_CACHE_TTL_MS";
const ROSTER_TTL_ENV = "OPERATOR_DRIVERS_CACHE_TTL_MS";

const CPF_REGISTERED_WITH_CLAIM = "11111111111";
const CPF_REGISTERED_NO_CLAIM = "22222222222";
const CPF_PUBLIC_ONLY = "33333333333";
const CPF_HOMONYM_A = "44444444444";
const CPF_HOMONYM_B = "55555555555";
const CPF_FULL_DETAILS = "66666666666";
const CPF_EXPIRED_VIGENCY = "77777777777";
const FILLER_HISTORICO = 40;

// Total de linhas em motoristas_historico (o que a varredura antiga trazia).
const HISTORICO_ROWS = 7 + FILLER_HISTORICO;

const dayOffsetIso = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

/**
 * Todas as 14 colunas que alimentam o jsonb da ficha Angellira ficam preenchidas:
 * é assim na produção (importação Angellira) e é o que torna honesta a comparação
 * de bytes entre a projeção antiga e a nova (o shim de jsonb_build_object do
 * pg-mem devolve NULL se QUALQUER argumento for nulo).
 */
async function seedHistorico({ cpf, nome, telefone, limitDateIso = null, sentDateIso = null }) {
  await query(
    `
      INSERT INTO public.motoristas_historico
        (cpf, nome, telefone, angellira_limit_date, angellira_sent_date, nascimento, raw_json,
         rg, estado, cidade, cnh, cnh_categoria, cnh_security, cnh_validade)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)
    `,
    [
      cpf,
      nome,
      telefone,
      limitDateIso,
      sentDateIso,
      "1980-01-02",
      JSON.stringify({
        history: {
          driverFather: `Pai de ${nome}`,
          driverMother: `Mae de ${nome}`,
          driverNaturalness: "Salvador",
        },
      }),
      `RG${cpf.slice(-4)}`,
      "BA",
      "Salvador",
      `CNH${cpf.slice(-5)}`,
      "AE",
      `SEC${cpf.slice(-3)}`,
      "2030-01-01",
    ],
  );
}

async function seedFixture() {
  const cliente = await seedCliente({ nome: "Cliente Egress Motoristas" });

  const cargoRecife = await seedCargo({
    cliente_id: cliente.id,
    origem: "Salvador / BA",
    destino: "Recife / PE",
    status: "OPEN",
    perfil: "CARRETA",
  });
  const cargoCampinas = await seedCargo({
    cliente_id: cliente.id,
    origem: "Feira de Santana / BA",
    destino: "Campinas / SP",
    status: "OPEN",
    perfil: "TRUCK",
  });

  // (1) Motorista cadastrado COM candidatura (tem data -> topo da ordenação).
  const registeredWithClaim = await seedDriverProfile({
    full_name: "Maria Santos",
    phone: "71911111111",
    document_number: CPF_REGISTERED_WITH_CLAIM,
    vehicle_profile: "CARRETA",
  });
  await seedLoadClaim({
    load_id: cargoRecife.id,
    driver_id: registeredWithClaim.user_id,
    status: "CONFIRMED",
    queue_position: null,
    claimed_at: "2026-04-14T09:00:00.000Z",
    created_at: "2026-04-14T09:00:00.000Z",
  });

  // (2) Motorista cadastrado SEM candidatura (sem data -> cai na cauda por nome,
  //     misturado com o HISTÓRICO).
  await seedDriverProfile({
    full_name: "Carlos Souza",
    phone: "71922222222",
    document_number: CPF_REGISTERED_NO_CLAIM,
    vehicle_profile: "TRUCK",
  });

  // (3) Lead público só na fila pública.
  await seedPublicLead({
    load_id: cargoCampinas.id,
    cpf: CPF_PUBLIC_ONLY,
    phone: "71933333333",
    vehicle_type: "TRUCK",
    status: "QUEUED",
  });

  // (4) DEDUP entre fontes: o MESMO CPF do motorista cadastrado também aparece
  //     como lead público -> tem de sair uma única vez, como REGISTERED.
  await seedPublicLead({
    load_id: cargoRecife.id,
    cpf: CPF_REGISTERED_WITH_CLAIM,
    phone: "71911111111",
    vehicle_type: "CARRETA",
    status: "QUEUED",
  });

  // (5) HISTÓRICO: homônimos (mesmo primeiro nome, CPFs distintos).
  await seedHistorico({
    cpf: CPF_HOMONYM_A,
    nome: "Joao Alves Bernardes",
    telefone: "71944444444",
    limitDateIso: dayOffsetIso(200),
    sentDateIso: dayOffsetIso(-10),
  });
  await seedHistorico({
    cpf: CPF_HOMONYM_B,
    nome: "Joao Alves Cardoso",
    telefone: "71955555555",
    limitDateIso: dayOffsetIso(10),
    sentDateIso: dayOffsetIso(-5),
  });

  // (6) HISTÓRICO com ficha completa e vigência vencida.
  await seedHistorico({
    cpf: CPF_FULL_DETAILS,
    nome: "Ana Lima",
    telefone: "71966666666",
    limitDateIso: dayOffsetIso(400),
    sentDateIso: dayOffsetIso(-2),
  });
  await seedHistorico({
    cpf: CPF_EXPIRED_VIGENCY,
    nome: "Zilda Rocha",
    telefone: "71977777777",
    limitDateIso: dayOffsetIso(-30),
    sentDateIso: dayOffsetIso(-400),
  });

  // (7) HISTÓRICO deduplicado por CPF já presente em outras fontes.
  await seedHistorico({ cpf: CPF_REGISTERED_WITH_CLAIM, nome: "Maria Santos (historico)", telefone: "71911111111" });
  await seedHistorico({ cpf: CPF_PUBLIC_ONLY, nome: "Lead Publico (historico)", telefone: "71933333333" });
  await seedHistorico({ cpf: CPF_REGISTERED_NO_CLAIM, nome: "Carlos Souza (historico)", telefone: "71922222222" });

  // (8) Massa: dá volume à varredura e cria fronteira de página.
  for (let index = 0; index < FILLER_HISTORICO; index += 1) {
    await seedHistorico({
      cpf: String(80000000000 + index),
      nome: `Motorista Massa ${String(index).padStart(2, "0")}`,
      telefone: `7190000${String(1000 + index)}`,
      limitDateIso: dayOffsetIso(60 + index),
      sentDateIso: dayOffsetIso(-20),
    });
  }
}

async function runList(requestQuery, { pushdown = true } = {}) {
  if (pushdown) {
    delete process.env[PUSHDOWN_ENV];
  } else {
    process.env[PUSHDOWN_ENV] = "off";
  }
  readModels.__resetOperatorDriverSummaryCaches();
  resetDbStats();
  const response = await readModels.fetchOperatorDriversListReadModel({
    query: requestQuery,
    correlationId: "corr-drivers-egress",
  });
  return { response, stats: snapshotDbStats() };
}

const namesOf = (response) => response.payload.items.map((item) => item.displayName);

describe("operator-admin — egress da lista de motoristas", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
    readModels.__resetOperatorDriverSummaryCaches();
    delete process.env[PUSHDOWN_ENV];
    delete process.env[HISTORICO_TTL_ENV];
    delete process.env[ROSTER_TTL_ENV];
    await seedFixture();
  });

  afterEach(() => {
    delete process.env[PUSHDOWN_ENV];
    delete process.env[HISTORICO_TTL_ENV];
    delete process.env[ROSTER_TTL_ENV];
  });

  afterAll(async () => {
    delete process.env[PUSHDOWN_ENV];
    delete process.env[HISTORICO_TTL_ENV];
    delete process.env[ROSTER_TTL_ENV];
    await closeTestDatabase();
  });

  it("o cenário medido é válido: as 3 fontes aparecem e o dedup por CPF funciona", async () => {
    const { response } = await runList({ page: "1", pageSize: "50" });

    expect(response.statusCode).toBe(200);

    const documents = response.payload.items.map((item) => item.contact.document);
    // CPF repetido em 3 fontes sai UMA vez, como cadastrado.
    expect(documents.filter((document) => document === CPF_REGISTERED_WITH_CLAIM)).toHaveLength(1);
    expect(
      response.payload.items.find((item) => item.contact.document === CPF_REGISTERED_WITH_CLAIM)?.sourceType,
    ).toBe("REGISTERED");
    // Idem para o CPF que está no lead público e no histórico.
    expect(documents.filter((document) => document === CPF_PUBLIC_ONLY)).toHaveLength(1);
    expect(response.payload.items.find((item) => item.contact.document === CPF_PUBLIC_ONLY)?.sourceType).toBe(
      "PUBLIC_LEAD",
    );
    // O "Maria Santos (historico)" e os outros dedupados não vazam.
    expect(namesOf(response)).not.toContain("Maria Santos (historico)");
    expect(namesOf(response)).not.toContain("Carlos Souza (historico)");

    // 3 fontes + massa, sem as 3 linhas dedupadas do histórico.
    expect(response.payload.summary.totalDrivers).toBe(2 + 1 + (HISTORICO_ROWS - 3));

    // O item do lead público mantém rótulo, perfil ausente e vigência ausente —
    // constantes que saíram do SELECT e voltaram a ser montadas em JS.
    const publicItem = response.payload.items.find((item) => item.contact.document === CPF_PUBLIC_ONLY);
    expect(publicItem.displayName).toBe("Motorista sem cadastro no app");
    expect(publicItem.registrationStatus).toBe("PUBLIC_ONLY");
    expect(publicItem.contact.phone).toBe("71933333333");
    expect(publicItem.profile).toEqual({
      vehicleProfile: "TRUCK",
      active: null,
      documentsValid: null,
      anttValid: null,
      trackingEnabled: null,
      insuranceValid: null,
      monitoringCapable: null,
      operationalBlocked: null,
    });
    expect(publicItem.angelliraVigency).toBeNull();
    expect(publicItem.brkVigency).toBeNull();
    expect(publicItem.spxVigency).toBeNull();
    expect(publicItem.angelliraDetails).toBeNull();
    expect(publicItem.stats.confirmedApplications).toBe(0);
    expect(publicItem.stats.totalApplications).toBe(1);
    expect(publicItem.applications).toHaveLength(1);
    expect(publicItem.applications[0].load.destino).toBe("Campinas / SP");

    // O motorista cadastrado com CPF repetido em outras fontes recebe também a
    // candidatura pública sobreposta (não se perde no dedup).
    const registeredItem = response.payload.items.find(
      (item) => item.contact.document === CPF_REGISTERED_WITH_CLAIM,
    );
    expect(registeredItem.applications.map((application) => application.source).sort()).toEqual([
      "CLAIM",
      "PUBLIC_LEAD",
    ]);
  });

  it("ANTES (pushdown off): cada chamada varre motoristas_historico INTEIRO", async () => {
    const { stats } = await runList({ page: "1", pageSize: "8" }, { pushdown: false });

    expect(statsFor(stats, "historicoScan").queries).toBe(1);
    expect(statsFor(stats, "historicoScan").rows).toBe(HISTORICO_ROWS);
  });

  it("filtro de origem que não pede o HISTÓRICO não lê o HISTÓRICO", async () => {
    for (const source of ["cadastrados", "publicos"]) {
      const before = await runList({ page: "1", pageSize: "8", source }, { pushdown: false });
      const after = await runList({ page: "1", pageSize: "8", source });

      expect(statsFor(before.stats, "historicoScan").rows).toBe(HISTORICO_ROWS);
      expect(statsFor(after.stats, "historicoScan").queries).toBe(0);
      expect(statsFor(after.stats, "historicoScan").rows).toBe(0);
      // E a lista é a mesma.
      expect(after.response.payload).toEqual(before.response.payload);
    }
  });

  it("filtro de status da candidatura descarta o HISTÓRICO em JS — agora nem lê", async () => {
    for (const applicationStatus of ["fila", "reservado", "confirmado"]) {
      const before = await runList({ page: "1", pageSize: "8", applicationStatus }, { pushdown: false });
      const after = await runList({ page: "1", pageSize: "8", applicationStatus });

      expect(statsFor(before.stats, "historicoScan").rows).toBe(HISTORICO_ROWS);
      expect(statsFor(after.stats, "historicoScan").rows).toBe(0);
      expect(after.response.payload).toEqual(before.response.payload);
    }
  });

  it("busca por NOME vira pré-filtro no SQL: punhado de linhas em vez da tabela", async () => {
    const before = await runList({ page: "1", pageSize: "8", search: "cardoso" }, { pushdown: false });
    const after = await runList({ page: "1", pageSize: "8", search: "cardoso" });

    expect(statsFor(before.stats, "historicoScan").rows).toBe(HISTORICO_ROWS);
    expect(statsFor(after.stats, "historicoScan").rows).toBe(1);
    expect(after.response.payload).toEqual(before.response.payload);
    expect(namesOf(after.response)).toEqual(["Joao Alves Cardoso"]);
  });

  it("busca por CPF vira pré-filtro no SQL", async () => {
    const before = await runList({ page: "1", pageSize: "8", search: CPF_HOMONYM_B }, { pushdown: false });
    const after = await runList({ page: "1", pageSize: "8", search: CPF_HOMONYM_B });

    expect(statsFor(before.stats, "historicoScan").rows).toBe(HISTORICO_ROWS);
    expect(statsFor(after.stats, "historicoScan").rows).toBe(1);
    expect(after.response.payload).toEqual(before.response.payload);
    expect(namesOf(after.response)).toEqual(["Joao Alves Cardoso"]);
  });

  it("busca que casa texto de candidatura (não do histórico) continua funcionando", async () => {
    // "Recife" só existe no destino da carga da candidatura do motorista cadastrado.
    const before = await runList({ page: "1", pageSize: "8", search: "recife" }, { pushdown: false });
    const after = await runList({ page: "1", pageSize: "8", search: "recife" });

    expect(after.response.payload).toEqual(before.response.payload);
    expect(namesOf(after.response)).toEqual(["Maria Santos"]);
    // Nenhuma linha do histórico casa "recife" -> o pré-filtro devolve zero.
    expect(statsFor(after.stats, "historicoScan").rows).toBe(0);
  });

  it("busca por texto FIXO da vigência cai na varredura completa (superset, sem falso negativo)", async () => {
    const before = await runList({ page: "1", pageSize: "50", search: "vigente" }, { pushdown: false });
    const after = await runList({ page: "1", pageSize: "50", search: "vigente" });

    expect(after.response.payload).toEqual(before.response.payload);
    // 'Conforme'/'vigencia vigente' não estão em coluna nenhuma: varre igual.
    expect(statsFor(after.stats, "historicoScan").rows).toBe(HISTORICO_ROWS);
    expect(after.response.payload.items.length).toBeGreaterThan(0);
  });

  it("a ficha completa (jsonb de 14 campos) só é lida para os itens da PÁGINA", async () => {
    const { response, stats } = await runList({ page: "1", pageSize: "8", source: "historico" });

    const historicoItems = response.payload.items.filter((item) => item.sourceType === "HISTORICO");
    expect(historicoItems.length).toBeGreaterThan(0);
    expect(statsFor(stats, "historicoDetails").queries).toBe(1);
    expect(statsFor(stats, "historicoDetails").rows).toBe(historicoItems.length);
    expect(statsFor(stats, "historicoDetails").rows).toBeLessThanOrEqual(8);

    // E a ficha chega preenchida, igual à projeção antiga.
    historicoItems.forEach((item) => {
      expect(item.angelliraDetails).not.toBeNull();
      expect(item.angelliraDetails.name).toBe(item.displayName);
    });
  });

  it("colunas: a varredura nova carrega uma fração dos bytes da projeção antiga", async () => {
    // Projeção ANTIGA, verbatim (24 colunas por linha, incluindo o jsonb de 14
    // campos), contra a MESMA fixture.
    const legacy = await query(`
      SELECT
        'HISTORICO'::text AS source_type,
        NULL::text AS user_id,
        mh.nome AS display_name,
        mh.telefone AS raw_phone,
        mh.cpf AS raw_document,
        NULL::text AS vehicle_profile,
        NULL::boolean AS active,
        NULL::boolean AS documents_valid,
        NULL::boolean AS antt_valid,
        NULL::boolean AS tracking_enabled,
        NULL::boolean AS insurance_valid,
        NULL::boolean AS monitoring_capable,
        NULL::boolean AS operational_blocked,
        'FOUND'::text AS angellira_status,
        mh.angellira_limit_date::date AS angellira_valid_until,
        'Conforme'::text AS angellira_status_text,
        mh.angellira_sent_date AS angellira_checked_at,
        jsonb_build_object(
          'name',           mh.nome,
          'cpf',            mh.cpf,
          'birthDate',      mh.nascimento::text,
          'rg',             mh.rg,
          'uf',             mh.estado,
          'fatherName',     mh.raw_json->'history'->>'driverFather',
          'motherName',     mh.raw_json->'history'->>'driverMother',
          'cnhNumber',      mh.cnh,
          'cnhCategory',    mh.cnh_categoria,
          'cnhSecurityCode',mh.cnh_security,
          'cnhValidity',    mh.cnh_validade::text,
          'phone',          mh.telefone,
          'city',           mh.cidade,
          'naturalness',    mh.raw_json->'history'->>'driverNaturalness'
        ) AS angellira_details,
        0::int AS total_applications,
        0::int AS queued_applications,
        0::int AS reserved_applications,
        0::int AS confirmed_applications,
        NULL::timestamptz AS latest_application_at
      FROM public.motoristas_historico AS mh
    `);
    const legacyBytes = Buffer.byteLength(JSON.stringify(legacy.rows), "utf8");
    const legacyWireBytes = estimateWireBytes(legacy.rows);
    expect(legacy.rows.length).toBe(HISTORICO_ROWS);
    // A fixture preenche as 14 colunas da ficha, senão o shim do pg-mem
    // devolveria NULL e a comparação de bytes seria injusta.
    expect(legacy.rows[0].angellira_details).not.toBeNull();

    const { stats } = await runList({ page: "1", pageSize: "8" });
    const scan = statsFor(stats, "historicoScan");
    const details = statsFor(stats, "historicoDetails");
    const newBytes = scan.bytes + details.bytes;

    const legacyBytesPerRow = legacyBytes / legacy.rows.length;
    const scanBytesPerRow = scan.bytes / Math.max(scan.rows, 1);

    // A LARGURA da linha varrida é a medida independente do tamanho da fixture:
    // é ela que multiplica pelas ~1.862 linhas da tabela em produção.
    // Piso conservador: nesta fixture os valores da ficha são mais curtos do que
    // os de produção (nomes/endereços reais), então a redução medida aqui é o
    // limite INFERIOR do que se espera em produção.
    const widthReduction = 1 - scanBytesPerRow / legacyBytesPerRow;
    expect(widthReduction).toBeGreaterThan(0.75);

    // No total desta fixture (47 linhas), a ficha da página pesa relativamente
    // muito mais do que pesaria em produção (1.862 linhas contra a mesma página).
    const reduction = 1 - newBytes / legacyBytes;
    expect(reduction).toBeGreaterThan(0.7);

    // Mesma conta no proxy do protocolo de texto (só valores, sem repetir nome de
    // coluna por linha) — é a estimativa mais próxima do que trafega de fato.
    const legacyWirePerRow = legacyWireBytes / legacy.rows.length;
    const scanWirePerRow = scan.valueBytes / Math.max(scan.rows, 1);
    const wireWidthReduction = 1 - scanWirePerRow / legacyWirePerRow;
    expect(wireWidthReduction).toBeGreaterThan(0.75);

    const prodRows = 1862;
    const projectedLegacy = legacyWirePerRow * prodRows;
    const projectedNew = scanWirePerRow * prodRows + details.valueBytes;

    console.log(
      `[egress] motoristas_historico por chamada: ANTES ${legacy.rows.length} linhas / ` +
        `${legacyBytes} B em JSON (${legacyBytesPerRow.toFixed(0)} B/linha) => DEPOIS ` +
        `${scan.rows} linhas de varredura (${scan.bytes} B, ${scanBytesPerRow.toFixed(0)} B/linha) + ` +
        `${details.rows} fichas da página (${details.bytes} B) = ${newBytes} B ` +
        `(-${(reduction * 100).toFixed(1)}%; largura da linha -${(widthReduction * 100).toFixed(1)}%).\n` +
        `[egress] no proxy do protocolo de texto: ${legacyWirePerRow.toFixed(0)} B/linha => ` +
        `${scanWirePerRow.toFixed(0)} B/linha (-${(wireWidthReduction * 100).toFixed(1)}%). ` +
        `Projetado para as ${prodRows} linhas de produção: ${(projectedLegacy / 1024).toFixed(0)} KB => ` +
        `${(projectedNew / 1024).toFixed(0)} KB por chamada`,
    );
  });

  it("PLACAR de linhas por chamada (antes × depois) em cada forma de requisição", async () => {
    const shapes = [
      { label: "página 1, sem busca (padrão da tela)", query: { page: "1", pageSize: "8" } },
      { label: "página 3", query: { page: "3", pageSize: "8" } },
      { label: "busca por nome", query: { page: "1", pageSize: "8", search: "cardoso" } },
      { label: "busca por CPF", query: { page: "1", pageSize: "8", search: CPF_HOMONYM_B } },
      { label: "origem=cadastrados", query: { page: "1", pageSize: "8", source: "cadastrados" } },
      { label: "origem=historico", query: { page: "1", pageSize: "8", source: "historico" } },
      { label: "status=fila", query: { page: "1", pageSize: "8", applicationStatus: "fila" } },
      {
        label: "origem=historico + status=fila",
        query: { page: "1", pageSize: "8", source: "historico", applicationStatus: "fila" },
      },
      {
        label: "origem=historico + busca por nome",
        query: { page: "1", pageSize: "8", source: "historico", search: "zilda" },
      },
    ];

    const lines = [];
    for (const shape of shapes) {
      const before = await runList(shape.query, { pushdown: false });
      const after = await runList(shape.query);

      // Toda forma de requisição preserva a lista.
      expect(after.response.payload).toEqual(before.response.payload);

      const beforeHistorico = statsFor(before.stats, "historicoScan").rows;
      const afterHistorico = statsFor(after.stats, "historicoScan").rows;
      const afterDetails = statsFor(after.stats, "historicoDetails").rows;
      expect(afterHistorico).toBeLessThanOrEqual(beforeHistorico);

      lines.push(
        `  ${shape.label.padEnd(38)} histórico ${String(beforeHistorico).padStart(3)} -> ` +
          `${String(afterHistorico).padStart(3)} linhas (+${afterDetails} fichas da página) | ` +
          `total ${String(before.stats.rows).padStart(3)} -> ${String(after.stats.rows).padStart(3)} linhas, ` +
          `${before.stats.queries} -> ${after.stats.queries} consultas`,
      );
    }

    console.log(`[egress] linhas por chamada (tabela de histórico com ${HISTORICO_ROWS} linhas):\n${lines.join("\n")}`);
  });

  it("EQUIVALÊNCIA na virada de página: páginas concatenadas = lista inteira", async () => {
    const full = await runList({ page: "1", pageSize: "50", source: "historico" });
    const totalPages = full.response.payload.meta.totalPages;
    expect(totalPages).toBe(1);

    const paged = [];
    for (let page = 1; page <= 5; page += 1) {
      const { response } = await runList({ page: String(page), pageSize: "3", source: "historico" });
      expect(response.payload.summary).toEqual(full.response.payload.summary);
      expect(response.payload.meta.totalCount).toBe(full.response.payload.meta.totalCount);
      paged.push(...response.payload.items);
    }

    expect(paged).toEqual(full.response.payload.items.slice(0, 15));
  });

  it("EQUIVALÊNCIA na fronteira de página com e sem o pushdown", async () => {
    for (const page of ["1", "2", "3"]) {
      const before = await runList({ page, pageSize: "3" }, { pushdown: false });
      const after = await runList({ page, pageSize: "3" });
      expect(after.response.payload).toEqual(before.response.payload);
    }
  });

  it("homônimos: mesmo primeiro nome saem os dois, com documentos distintos e ordem estável", async () => {
    const before = await runList({ page: "1", pageSize: "50", search: "joao alves" }, { pushdown: false });
    const after = await runList({ page: "1", pageSize: "50", search: "joao alves" });

    expect(after.response.payload).toEqual(before.response.payload);
    expect(namesOf(after.response)).toEqual(["Joao Alves Bernardes", "Joao Alves Cardoso"]);
    expect(after.response.payload.items.map((item) => item.contact.document)).toEqual([
      CPF_HOMONYM_A,
      CPF_HOMONYM_B,
    ]);
    // Busca com espaço: o pré-filtro usa o 1º token ("joao"), superset do termo.
    expect(statsFor(after.stats, "historicoScan").rows).toBe(2);
  });

  it("EQUIVALÊNCIA da ficha e da vigência do HISTÓRICO com a projeção antiga", async () => {
    const { response } = await runList({ page: "1", pageSize: "50", search: "ana lima" });
    const item = response.payload.items.find((candidate) => candidate.contact.document === CPF_FULL_DETAILS);

    expect(item).toBeDefined();
    expect(item.sourceType).toBe("HISTORICO");
    expect(item.registrationStatus).toBe("PUBLIC_ONLY");
    expect(item.angelliraDetails).toEqual({
      name: "Ana Lima",
      cpf: CPF_FULL_DETAILS,
      birthDate: "1980-01-02",
      rg: `RG${CPF_FULL_DETAILS.slice(-4)}`,
      uf: "BA",
      fatherName: "Pai de Ana Lima",
      motherName: "Mae de Ana Lima",
      cnhNumber: `CNH${CPF_FULL_DETAILS.slice(-5)}`,
      cnhCategory: "AE",
      cnhSecurityCode: `SEC${CPF_FULL_DETAILS.slice(-3)}`,
      cnhValidity: "2030-01-01",
      phone: "71966666666",
      city: "Salvador",
      naturalness: "Salvador",
    });
    // Vigência: mesmas constantes de antes ('FOUND'/'Conforme') + a data da coluna.
    expect(item.angelliraVigency.status).toBe("FOUND");
    expect(item.angelliraVigency.statusText).toBe("Conforme");
    expect(item.angelliraVigency.alertLevel).toBe("OK");
    expect(item.profile).toEqual({
      vehicleProfile: null,
      active: null,
      documentsValid: null,
      anttValid: null,
      trackingEnabled: null,
      insuranceValid: null,
      monitoringCapable: null,
      operationalBlocked: null,
    });
    expect(item.stats).toEqual({
      totalApplications: 0,
      queuedApplications: 0,
      reservedApplications: 0,
      confirmedApplications: 0,
      latestApplicationAt: null,
    });

    // Vigência vencida também preservada.
    const expired = await runList({ page: "1", pageSize: "50", search: "zilda" });
    const expiredItem = expired.response.payload.items[0];
    expect(expiredItem.contact.document).toBe(CPF_EXPIRED_VIGENCY);
    expect(expiredItem.angelliraVigency.alertLevel).toBe("EXPIRED");
  });

  it("cache do HISTÓRICO: TTL maior que o intervalo real entre chamadas corta as leituras", async () => {
    // Intervalo REAL medido em produção entre chamadas: ~364 s.
    const GAP_MS = 364_000;
    const CALLS = 3;

    const measure = async (ttlMs) => {
      process.env[HISTORICO_TTL_ENV] = String(ttlMs);
      delete process.env[PUSHDOWN_ENV];
      readModels.__resetOperatorDriverSummaryCaches();
      resetDbStats();
      const t0 = Date.now();
      const nowSpy = vi.spyOn(Date, "now");
      try {
        for (let call = 0; call < CALLS; call += 1) {
          nowSpy.mockReturnValue(t0 + call * GAP_MS);
          await readModels.fetchOperatorDriversListReadModel({
            query: { page: "1", pageSize: "8" },
            correlationId: "corr-drivers-cache",
          });
        }
      } finally {
        nowSpy.mockRestore();
      }
      return snapshotDbStats();
    };

    // TTL de 30 s (o do round anterior) contra 6 min entre chamadas: zero acerto.
    const shortTtl = await measure(30_000);
    expect(statsFor(shortTtl, "historicoScan").queries).toBe(CALLS);

    // TTL de 10 min: 3 chamadas em 728 s custam 2 leituras (a 3ª cai fora da
    // janela). Ou seja: nem um TTL de 10 min "resolve" essa cadência — ele corta
    // ~1/3. É por isso que a redução de verdade tinha que vir da própria consulta.
    const longTtl = await measure(600_000);
    expect(statsFor(longTtl, "historicoScan").queries).toBe(2);
    expect(statsFor(longTtl, "historicoScan").rows).toBe(HISTORICO_ROWS * 2);

    // Já uma rajada (várias chamadas dentro da janela) o cache colapsa por completo.
    const burst = await (async () => {
      process.env[HISTORICO_TTL_ENV] = "600000";
      readModels.__resetOperatorDriverSummaryCaches();
      resetDbStats();
      for (let call = 0; call < CALLS; call += 1) {
        await readModels.fetchOperatorDriversListReadModel({
          query: { page: String(call + 1), pageSize: "3" },
          correlationId: "corr-drivers-burst",
        });
      }
      return snapshotDbStats();
    })();
    expect(statsFor(burst, "historicoScan").queries).toBe(1);

    console.log(
      `[egress] ${CALLS} chamadas a ${GAP_MS / 1000}s de intervalo (cadência medida em produção): ` +
        `TTL 30s => ${statsFor(shortTtl, "historicoScan").rows} linhas de histórico; ` +
        `TTL 600s => ${statsFor(longTtl, "historicoScan").rows} linhas; ` +
        `mesmas ${CALLS} chamadas em rajada => ${statsFor(burst, "historicoScan").rows} linhas`,
    );
  });

  it("cache do HISTÓRICO é por busca e não contamina o resultado de outra busca", async () => {
    process.env[HISTORICO_TTL_ENV] = "600000";
    readModels.__resetOperatorDriverSummaryCaches();

    const cardoso = await readModels.fetchOperatorDriversListReadModel({
      query: { page: "1", pageSize: "8", search: "cardoso" },
      correlationId: "corr-cache-a",
    });
    const zilda = await readModels.fetchOperatorDriversListReadModel({
      query: { page: "1", pageSize: "8", search: "zilda" },
      correlationId: "corr-cache-b",
    });

    expect(cardoso.payload.items.map((item) => item.displayName)).toEqual(["Joao Alves Cardoso"]);
    expect(zilda.payload.items.map((item) => item.displayName)).toEqual(["Zilda Rocha"]);
  });

  it("single-flight: chamadas concorrentes do mesmo caminho fazem UMA varredura", async () => {
    process.env[HISTORICO_TTL_ENV] = "600000";
    process.env[ROSTER_TTL_ENV] = "600000";
    readModels.__resetOperatorDriverSummaryCaches();
    resetDbStats();

    await Promise.all(
      [1, 2, 3, 4].map((page) =>
        readModels.fetchOperatorDriversListReadModel({
          query: { page: String(page), pageSize: "3" },
          correlationId: `corr-concurrent-${page}`,
        }),
      ),
    );

    expect(statsFor(snapshotDbStats(), "historicoScan").queries).toBe(1);
    expect(statsFor(snapshotDbStats(), "registeredSummary").queries).toBe(1);
  });
});
