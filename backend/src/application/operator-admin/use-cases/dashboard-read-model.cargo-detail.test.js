/**
 * Detalhe de carga do portal do motorista (GET /api/driver/cargas/:id).
 *
 * Contexto: a tela /motorista/cargas/:id lia o banco DIRETO do navegador com a
 * chave anônima — SELECT enriquecido em `cargas` + JOIN de `clientes`, consulta
 * ao `route_metrics_cache`, fallback de distância em `cargas` e resolução de
 * `clientes` — até 4 idas navegador→pooler por abertura. Estes testes medem o
 * custo REAL em consultas/linhas no servidor (proxy direto de egress) e travam
 * duas coisas: a redução com o cache e a FIDELIDADE do payload (os campos que a
 * tela consome, nos tipos que ela espera).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedCliente,
  seedRoute,
  withPgClient as harnessWithPgClient,
  withPgTransaction,
} from "../test-harness.js";

// Contador de consultas + linhas trafegadas (proxy de egress).
const dbStats = { queries: 0, rows: 0 };

function resetDbStats() {
  dbStats.queries = 0;
  dbStats.rows = 0;
}

// O pool do pg-mem REUTILIZA clients, então o wrapper precisa ser idempotente:
// envolver duas vezes o mesmo client contaria cada consulta em dobro.
const INSTRUMENTED = Symbol.for("egress.instrumented");

function instrumentClient(client) {
  if (client[INSTRUMENTED]) return client;
  const originalQuery = client.query.bind(client);
  client.query = async (...args) => {
    const result = await originalQuery(...args);
    dbStats.queries += 1;
    dbStats.rows += result?.rows?.length ?? result?.rowCount ?? 0;
    return result;
  };
  client[INSTRUMENTED] = true;
  return client;
}

vi.mock("../../../infrastructure/pg/postgres.js", () => ({
  withPgClient: (callback) => harnessWithPgClient((client) => callback(instrumentClient(client))),
  withPgTransaction,
}));

const readModel = await import("./dashboard-read-model.js");

const CARGO_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

/** Simula o link da carga aberto por N motoristas (cada um 1× o detalhe). */
async function simulateDetailOpens(count, cargoId = CARGO_ID) {
  resetDbStats();
  const results = [];
  for (let i = 0; i < count; i += 1) {
    results.push(
      await readModel.fetchDriverCargoDetail({ cargoId, correlationId: `corr-detail-${i}` }),
    );
  }
  return { stats: { ...dbStats }, results };
}

const DRIVERS = 20;

describe("detalhe de carga do motorista — cache + single-flight", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    readModel.__resetDriverCargoDetailCache();
    delete process.env.DRIVER_CARGO_DETAIL_CACHE_TTL_MS;

    const cliente = await seedCliente({
      nome: "Embarcador Detalhe",
      descricao: "Cliente do detalhe",
      forma_pagamento: "PIX 7 dias",
      prazo_pagamento: "7 dias",
      observacoes: "Chegar com 1h de antecedência.",
      exige_antt: true,
      exige_rastreamento: true,
      reputacao_bom_pagador: true,
    });

    await seedRoute({ tempo_estimado_horas: 26 });
    await seedCargo({
      id: CARGO_ID,
      cliente_id: cliente.id,
      status: "OPEN",
      data: "2099-06-02",
      horario: "08:00:00",
      valor: 7200,
      bonus: 300,
      bonus_exigencias: "Lona nova\nRastreador ativo",
      distancia_km: 1500,
      duracao_horas: 24,
    });
  });

  afterAll(async () => {
    delete process.env.DRIVER_CARGO_DETAIL_CACHE_TTL_MS;
    await closeTestDatabase();
  });

  it("SEM cache (TTL=0): cada abertura do link custa a mesma sequência de consultas", async () => {
    process.env.DRIVER_CARGO_DETAIL_CACHE_TTL_MS = "0";
    readModel.__resetDriverCargoDetailCache();

    const single = await simulateDetailOpens(1);
    const many = await simulateDetailOpens(DRIVERS);

    expect(single.results[0].statusCode).toBe(200);
    // Custo cresce linearmente com o nº de motoristas — o problema medido.
    expect(many.stats.queries).toBe(single.stats.queries * DRIVERS);
    expect(many.stats.rows).toBe(single.stats.rows * DRIVERS);

    console.log(
      `[egress] detalhe SEM cache: ${DRIVERS} aberturas => ${many.stats.queries} consultas, ${many.stats.rows} linhas`,
    );
  });

  it("COM cache: N aberturas do mesmo link custam UMA execução", async () => {
    process.env.DRIVER_CARGO_DETAIL_CACHE_TTL_MS = "8000";
    readModel.__resetDriverCargoDetailCache();

    const baseline = await simulateDetailOpens(1);
    readModel.__resetDriverCargoDetailCache();
    const cached = await simulateDetailOpens(DRIVERS);

    expect(cached.stats.queries).toBe(baseline.stats.queries);
    expect(cached.stats.rows).toBe(baseline.stats.rows);
    cached.results.forEach((result) => expect(result.statusCode).toBe(200));

    const reduction = 1 - cached.stats.rows / (baseline.stats.rows * DRIVERS);
    expect(reduction).toBeGreaterThan(0.9);

    console.log(
      `[egress] detalhe COM cache: ${DRIVERS} aberturas => ${cached.stats.queries} consultas, ${cached.stats.rows} linhas ` +
        `(reducao de ${(reduction * 100).toFixed(1)}%)`,
    );
  });

  it("single-flight: rajada concorrente no mesmo link compartilha UMA execução", async () => {
    process.env.DRIVER_CARGO_DETAIL_CACHE_TTL_MS = "8000";
    readModel.__resetDriverCargoDetailCache();

    const baseline = await simulateDetailOpens(1);
    readModel.__resetDriverCargoDetailCache();

    resetDbStats();
    const results = await Promise.all(
      Array.from({ length: DRIVERS }, (_, i) =>
        readModel.fetchDriverCargoDetail({ cargoId: CARGO_ID, correlationId: `corr-burst-${i}` }),
      ),
    );

    expect(dbStats.queries).toBe(baseline.stats.queries);
    results.forEach((result) => {
      expect(result.statusCode).toBe(200);
      expect(result.payload.cargo.id).toBe(CARGO_ID);
    });
  });

  it("chave do cache = cargoId (carga B nunca é servida no lugar da A)", async () => {
    process.env.DRIVER_CARGO_DETAIL_CACHE_TTL_MS = "8000";
    readModel.__resetDriverCargoDetailCache();

    const outroCliente = await seedCliente({ nome: "Embarcador B" });
    const otherId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
    await seedCargo({
      id: otherId,
      cliente_id: outroCliente.id,
      status: "OPEN",
      origem: "Campo Grande / MS",
      destino: "Feira de Santana / BA",
      valor: 9100,
    });

    const first = await readModel.fetchDriverCargoDetail({ cargoId: CARGO_ID, correlationId: "a" });
    const second = await readModel.fetchDriverCargoDetail({ cargoId: otherId, correlationId: "b" });

    expect(first.payload.cargo.id).toBe(CARGO_ID);
    expect(second.payload.cargo.id).toBe(otherId);
    expect(second.payload.cargo.origem).toBe("Campo Grande / MS");
    expect(second.payload.cargo.cliente.nome).toBe("Embarcador B");
  });

  it("preserva o resultado: payload cacheado é idêntico ao não-cacheado (só muda o meta)", async () => {
    process.env.DRIVER_CARGO_DETAIL_CACHE_TTL_MS = "0";
    readModel.__resetDriverCargoDetailCache();
    const uncached = await readModel.fetchDriverCargoDetail({
      cargoId: CARGO_ID,
      correlationId: "corr-uncached",
    });

    process.env.DRIVER_CARGO_DETAIL_CACHE_TTL_MS = "8000";
    readModel.__resetDriverCargoDetailCache();
    await readModel.fetchDriverCargoDetail({ cargoId: CARGO_ID, correlationId: "corr-warm" });
    const hit = await readModel.fetchDriverCargoDetail({
      cargoId: CARGO_ID,
      correlationId: "corr-hit",
    });

    expect(hit.statusCode).toBe(200);
    expect(hit.payload.cargo).toEqual(uncached.payload.cargo);
    expect(hit.payload.routeFallback).toEqual(uncached.payload.routeFallback);
    expect(hit.payload.historyDistanciaKm).toEqual(uncached.payload.historyDistanciaKm);
    // O correlationId do chamador atual é preservado (não vaza o da 1ª chamada).
    expect(hit.payload.meta).toEqual({ correlationId: "corr-hit", cached: true });
  });

  it("expira ao fim do TTL (não serve dado velho indefinidamente)", async () => {
    process.env.DRIVER_CARGO_DETAIL_CACHE_TTL_MS = "8000";
    readModel.__resetDriverCargoDetailCache();

    const first = await readModel.fetchDriverCargoDetail({ cargoId: CARGO_ID, correlationId: "t0" });
    expect(first.statusCode).toBe(200);

    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(Date.now() + 9_000);
      resetDbStats();
      const afterTtl = await readModel.fetchDriverCargoDetail({
        cargoId: CARGO_ID,
        correlationId: "t9",
      });
      expect(dbStats.queries).toBeGreaterThan(0);
      expect(afterTtl.statusCode).toBe(200);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("não cacheia 404 (carga que aparece depois não fica presa no cache)", async () => {
    process.env.DRIVER_CARGO_DETAIL_CACHE_TTL_MS = "8000";
    readModel.__resetDriverCargoDetailCache();

    const rascunhoId = "cccccccc-3333-4333-8333-cccccccccccc";
    await seedCargo({ id: rascunhoId, status: "DRAFT" });

    const denied = await readModel.fetchDriverCargoDetail({
      cargoId: rascunhoId,
      correlationId: "draft",
    });
    expect(denied.statusCode).toBe(404);

    // Carga sai de rascunho → a próxima abertura precisa consultar o banco.
    await query("UPDATE public.cargas SET status = 'OPEN' WHERE id = $1", [rascunhoId]);
    resetDbStats();
    const allowed = await readModel.fetchDriverCargoDetail({
      cargoId: rascunhoId,
      correlationId: "open",
    });
    expect(dbStats.queries).toBeGreaterThan(0);
    expect(allowed.statusCode).toBe(200);
  });
});

describe("detalhe de carga do motorista — visibilidade anônima e payload", () => {
  let clienteId;

  beforeEach(async () => {
    await resetTestDatabase();
    readModel.__resetDriverCargoDetailCache();
    delete process.env.DRIVER_CARGO_DETAIL_CACHE_TTL_MS;

    const cliente = await seedCliente({
      nome: "Embarcador Detalhe",
      descricao: "Cliente do detalhe",
      forma_pagamento: "PIX 7 dias",
      prazo_pagamento: "7 dias",
      observacoes: "Chegar com 1h de antecedência.",
      exige_antt: true,
      exige_carga_monitorada: false,
      exige_rastreamento: true,
      exige_seguro: false,
      reputacao_bom_pagador: true,
      reputacao_boa_comunicacao: true,
    });
    clienteId = cliente.id;

    await seedRoute({ tempo_estimado_horas: 26 });
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  it("devolve TODOS os campos que a tela consome, nos tipos que ela espera", async () => {
    await seedCargo({
      id: CARGO_ID,
      cliente_id: clienteId,
      status: "OPEN",
      data: "2099-06-02",
      horario: "08:00:00",
      valor: 7200,
      bonus: 300,
      bonus_exigencias: "Lona nova\nRastreador ativo",
      distancia_km: 1500,
      duracao_horas: 24,
      sheet_data_carregamento: "2099-06-02 08:00",
      sheet_data_descarga: "2099-06-03 12:00",
    });

    const { payload } = await readModel.fetchDriverCargoDetail({
      cargoId: CARGO_ID,
      correlationId: "shape",
    });

    // DATE volta como "YYYY-MM-DD" (era o que o PostgREST entregava ao
    // navegador); TIME como "HH:MM:SS".
    expect(payload.cargo.data).toBe("2099-06-02");
    expect(payload.cargo.horario).toBe("08:00:00");

    // NUMERIC como NÚMERO: a tela faz `typeof x === "number"` em valor/bonus/
    // distancia_km. String aqui quebraria o "Pagamento total" e o "Percurso".
    expect(typeof payload.cargo.valor).toBe("number");
    expect(payload.cargo.valor).toBe(7200);
    expect(typeof payload.cargo.bonus).toBe("number");
    expect(payload.cargo.bonus).toBe(300);
    expect(typeof payload.cargo.distancia_km).toBe("number");
    expect(payload.cargo.distancia_km).toBe(1500);
    expect(payload.cargo.duracao_horas).toBe(24);

    expect(payload.cargo).toMatchObject({
      id: CARGO_ID,
      origem: "Salvador / BA",
      destino: "Simoes Filho / BA",
      perfil: "CARRETA",
      status: "OPEN",
      cliente_id: clienteId,
      bonus_exigencias: "Lona nova\nRastreador ativo",
      sheet_data_carregamento: "2099-06-02 08:00",
      sheet_data_descarga: "2099-06-03 12:00",
      viagem_id: null,
      ordem_viagem: null,
    });

    // Cliente aninhado com os campos das seções "Cliente da carga",
    // "Exigências" e "Reputação do cliente".
    expect(payload.cargo.cliente).toMatchObject({
      id: clienteId,
      nome: "Embarcador Detalhe",
      descricao: "Cliente do detalhe",
      forma_pagamento: "PIX 7 dias",
      prazo_pagamento: "7 dias",
      observacoes: "Chegar com 1h de antecedência.",
      exige_antt: true,
      exige_carga_monitorada: false,
      exige_rastreamento: true,
      exige_seguro: false,
      reputacao_bom_pagador: true,
      reputacao_boa_comunicacao: true,
      reputacao_carga_organizada: false,
      reputacao_liberacao_rapida: false,
      reputacao_pagamento_rapido: false,
    });
    expect(payload.cargo.cliente).toHaveProperty("custom_reputacoes");
    expect(payload.cargo.cliente).toHaveProperty("custom_exigencias");
  });

  it("resolve o catálogo de rotas no servidor (mesmos campos que o navegador lia)", async () => {
    await seedCargo({ id: CARGO_ID, cliente_id: clienteId, status: "OPEN", data: "2099-06-02" });

    const { payload } = await readModel.fetchDriverCargoDetail({
      cargoId: CARGO_ID,
      correlationId: "route",
    });

    expect(payload.routeFallback).toEqual({
      distancia_km: 1500,
      duracao_horas: 24,
      tempo_estimado_horas: 26,
      perfil_padrao: "CARRETA",
      eixos: 0,
      valor_padrao: 7200,
      bonus_padrao: 300,
    });
    // `ativa` NÃO vai no payload: a lista usa esse flag para esconder a carga, o
    // detalhe nunca aplicou — incluir convidaria a mudar o comportamento.
    expect(payload.routeFallback).not.toHaveProperty("ativa");
  });

  it("fallback de distância: usa o histórico do trecho quando carga e catálogo não têm", async () => {
    // Trecho sem rota no catálogo e carga sem distancia_km — mesmas condições em
    // que o navegador disparava a 3ª consulta.
    await seedCargo({
      cliente_id: clienteId,
      status: "OPEN",
      origem: "Camacari / BA",
      destino: "Jaboatao dos Guararapes / PE",
      distancia_km: 812,
      created_at: "2026-01-01T00:00:00.000Z",
    });
    await seedCargo({
      id: CARGO_ID,
      cliente_id: clienteId,
      status: "OPEN",
      origem: "Camacari / BA",
      destino: "Jaboatao dos Guararapes / PE",
      created_at: "2026-02-01T00:00:00.000Z",
    });
    // seedCargo aplica `?? 1500` em distancia_km, então null tem que vir por UPDATE.
    await query("UPDATE public.cargas SET distancia_km = NULL WHERE id = $1", [CARGO_ID]);

    const { payload } = await readModel.fetchDriverCargoDetail({
      cargoId: CARGO_ID,
      correlationId: "dist",
    });

    expect(payload.cargo.distancia_km).toBeNull();
    expect(payload.routeFallback).toBeNull();
    expect(payload.historyDistanciaKm).toBe(812);
  });

  it("não consulta o histórico de distância quando a carga já tem a própria", async () => {
    await seedCargo({ id: CARGO_ID, cliente_id: clienteId, status: "OPEN", distancia_km: 1500 });

    const { payload } = await readModel.fetchDriverCargoDetail({
      cargoId: CARGO_ID,
      correlationId: "no-dist-fallback",
    });

    expect(payload.cargo.distancia_km).toBe(1500);
    expect(payload.historyDistanciaKm).toBeNull();
  });

  it("carga sem cliente: cliente = null (a tela cai nos rótulos 'não informado')", async () => {
    await seedCargo({ id: CARGO_ID, cliente_id: null, status: "OPEN" });

    const { payload } = await readModel.fetchDriverCargoDetail({
      cargoId: CARGO_ID,
      correlationId: "no-cliente",
    });

    expect(payload.cargo.cliente_id).toBeNull();
    expect(payload.cargo.cliente).toBeNull();
  });

  it("expõe apenas os status que a policy anônima já liberava", async () => {
    const cases = [
      { status: "OPEN", expected: 200 },
      { status: "RESERVED", expected: 200 },
      { status: "BOOKED", expected: 200 },
      { status: "DRAFT", expected: 404 },
      { status: "EXPIRED", expected: 404 },
      { status: "CANCELLED", expected: 404 },
    ];

    for (const testCase of cases) {
      const id = crypto.randomUUID();
      await seedCargo({ id, cliente_id: clienteId, status: testCase.status });
      const result = await readModel.fetchDriverCargoDetail({
        cargoId: id,
        correlationId: `status-${testCase.status}`,
      });
      expect(result.statusCode, `status ${testCase.status}`).toBe(testCase.expected);
    }
  });

  it("carga inexistente e carga invisível respondem o MESMO 404 (não vaza existência)", async () => {
    const rascunhoId = crypto.randomUUID();
    await seedCargo({ id: rascunhoId, cliente_id: clienteId, status: "DRAFT" });

    const inexistente = await readModel.fetchDriverCargoDetail({
      cargoId: crypto.randomUUID(),
      correlationId: "missing",
    });
    const invisivel = await readModel.fetchDriverCargoDetail({
      cargoId: rascunhoId,
      correlationId: "hidden",
    });

    expect(inexistente.statusCode).toBe(404);
    expect(invisivel.statusCode).toBe(404);
    expect(invisivel.payload.code).toBe(inexistente.payload.code);
    expect(invisivel.payload.message).toBe(inexistente.payload.message);
  });

  it("carga de pacote: devolve viagem_id/ordem_viagem (a tela troca para viagem casada)", async () => {
    const pacoteId = crypto.randomUUID();
    await query(
      "INSERT INTO public.cargas_casadas (id, status, valor_total, version) VALUES ($1, 'publicado', 12500, 1)",
      [pacoteId],
    );
    await seedCargo({
      id: CARGO_ID,
      cliente_id: clienteId,
      status: "OPEN",
      viagem_id: pacoteId,
      ordem_viagem: 2,
    });

    const { payload } = await readModel.fetchDriverCargoDetail({
      cargoId: CARGO_ID,
      correlationId: "pacote",
    });

    expect(payload.cargo.viagem_id).toBe(pacoteId);
    expect(payload.cargo.ordem_viagem).toBe(2);
  });
});
