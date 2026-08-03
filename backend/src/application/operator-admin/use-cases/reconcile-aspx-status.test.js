import crypto from "node:crypto";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedCliente,
  withPgClient,
} from "../test-harness.js";
import { reconcileAspxStatus } from "./reconcile-aspx-status.js";
import { SpxAspNotConfigured } from "../../../infrastructure/torre/torre-spx-trips-client.js";

// Constrói uma linha crua da aba ASP (Torre) com os nomes de coluna reais.
const aspRow = (o) => ({
  "LH Trip Number": o.lh,
  "Status Operacional": o.status ?? "",
  "Driver ID": o.driver ?? "",
  "Vehicle Plate Number": o.plate ?? ",",
  "ETA ORIGEM PROGRAMADO": o.etaO ?? "",
  "ETA DESTINO PROGRAMADO": o.etaD ?? "",
  "Station_Origem": o.stO ?? "",
  "Station_Destino": o.stD ?? "",
});
const fakeTrips = (rows) => async () => ({ rows });
const baseDeps = (rows, extra = {}) => ({
  withPgClient,
  fetchSpxTrips: fakeTrips(rows),
  isSheetWritebackEnabled: () => true,
  writeAllocationsToSheet: async (u) => ({ ok: true, updated: u.length }),
  ...extra,
});

const rowOf = async (id) =>
  (await query(
    `SELECT sheet_status, sheet_motorista, sheet_cavalo, sheet_carreta, alloc_status
       FROM public.cargas WHERE id = $1`,
    [id],
  )).rows[0];

async function setSheetFields(id, fields) {
  const cols = Object.keys(fields);
  const set = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
  await query(`UPDATE public.cargas SET ${set} WHERE id = $1`, [id, ...cols.map((c) => fields[c])]);
}

describe("reconcileAspxStatus (DC-316 completo)", () => {
  let clienteId;
  beforeEach(async () => {
    await resetTestDatabase();
    clienteId = (await seedCliente({ nome: "Shopee" })).id;
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("no-op quando a Torre não está configurada (throw) ou não devolve linhas", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-1" });
    await setSheetFields(carga.id, { sheet_status: "AGUARDANDO CARREGAMENTO", sheet_source: "shopee" });

    const semChave = await reconcileAspxStatus({
      deps: baseDeps([], { fetchSpxTrips: async () => { throw new SpxAspNotConfigured(); } }),
    });
    expect(semChave).toMatchObject({ ok: true, skipped: true, reason: "no-index" });

    const vazio = await reconcileAspxStatus({ deps: baseDeps([]) });
    expect(vazio).toMatchObject({ ok: true, skipped: true, reason: "empty-index" });
    expect((await rowOf(carga.id)).sheet_status).toBe("AGUARDANDO CARREGAMENTO");
  });

  it("sob o gate (AGUARDANDO CARREGAMENTO): sincroniza status + motorista/placas + datas + origem/destino na planilha", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-100", origem: "Rota / Catalogo", destino: "Rota / Catalogo" });
    await setSheetFields(carga.id, {
      sheet_status: "AGUARDANDO CARREGAMENTO",
      sheet_source: "shopee",
      sheet_motorista: "ANTIGO",
      sheet_cavalo: "OLD0A00",
    });

    const writes = [];
    const r = await reconcileAspxStatus({
      deps: baseDeps(
        [aspRow({
          lh: "LT-100", status: "CARREGADO", driver: "[9] JOAO DA SILVA",
          plate: "ABC1D23,XYZ9Z88", etaO: "27/07/2026 08:00", etaD: "28/07/2026 10:00",
          stO: "[HUB] Sao Paulo", stD: "[DEST] Salvador",
        })],
        { writeAllocationsToSheet: async (u) => { writes.push(...u); return { ok: true, updated: u.length }; } },
      ),
    });

    expect(r).toMatchObject({ ok: true, checked: 1, updated: 1, sheetWrites: 1 });
    const row = await rowOf(carga.id);
    // Sistema: espelha status + motorista/placas (NÃO datas/origem/destino).
    expect(row.sheet_status).toBe("CARREGADO");
    expect(row.sheet_motorista).toBe("JOAO DA SILVA");
    expect(row.sheet_cavalo).toBe("ABC1D23");
    expect(row.sheet_carreta).toBe("XYZ9Z88");
    // cargas.origem/destino (rota do catálogo) NÃO é tocado.
    expect((await query("SELECT origem, destino FROM public.cargas WHERE id = $1", [carga.id])).rows[0]).toMatchObject({
      origem: "Rota / Catalogo", destino: "Rota / Catalogo",
    });
    // Planilha (write-back): tudo, incl. datas + origem/destino limpos do "[...]".
    expect(writes[0]).toMatchObject({
      lh: "LT-100", source: "shopee", status: "CARREGADO",
      motorista: "JOAO DA SILVA", cavalo: "ABC1D23", carreta: "XYZ9Z88",
      dataCarregamento: "27/07/2026 08:00", dataDescarga: "28/07/2026 10:00",
      origem: "Sao Paulo", destino: "Salvador",
    });
  });

  it("gate FECHADO (AGUARDANDO DESCARGA): só o status muda; motorista/datas NÃO; write-back não apaga motorista", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-DE" });
    await setSheetFields(carga.id, {
      sheet_status: "AGUARDANDO DESCARGA",
      sheet_source: "shopee",
      sheet_motorista: "MOTORISTA VIVO",
      sheet_cavalo: "VIV0A00",
    });

    const writes = [];
    const r = await reconcileAspxStatus({
      deps: baseDeps(
        [aspRow({ lh: "LT-DE", status: "DESCARREGANDO", driver: "[1] OUTRO", plate: "NEW1A11,NEW2B22", etaO: "27/07/2026 09:00", stO: "[X] Nova" })],
        { writeAllocationsToSheet: async (u) => { writes.push(...u); return { ok: true, updated: u.length }; } },
      ),
    });

    expect(r).toMatchObject({ ok: true, updated: 1 });
    const row = await rowOf(carga.id);
    expect(row.sheet_status).toBe("DESCARREGANDO"); // descarga permitida a partir de descarga
    expect(row.sheet_motorista).toBe("MOTORISTA VIVO"); // gate fechado → não troca motorista
    // write-back manda o motorista EFETIVO atual (não vazio) + status; SEM datas/origem/destino
    expect(writes[0]).toMatchObject({ lh: "LT-DE", status: "DESCARREGANDO", motorista: "MOTORISTA VIVO", cavalo: "VIV0A00" });
    expect(writes[0].dataCarregamento).toBeUndefined();
    expect(writes[0].origem).toBeUndefined();
    expect(writes[0].destino).toBeUndefined();
  });

  it("CTE ENVIADO vem da planilha: ASPX não regride para CARREGADO (nada muda, sem write)", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-CTE" });
    await setSheetFields(carga.id, { sheet_status: "CTE ENVIADO", sheet_source: "shopee", sheet_motorista: "M" });

    const writes = [];
    const r = await reconcileAspxStatus({
      deps: baseDeps(
        [aspRow({ lh: "LT-CTE", status: "CARREGADO", driver: "[1] X", plate: "AAA1A11," })],
        { writeAllocationsToSheet: async (u) => { writes.push(...u); return { ok: true, updated: u.length }; } },
      ),
    });

    expect(r).toMatchObject({ ok: true, checked: 1, updated: 0, sheetWrites: 0 });
    expect((await rowOf(carga.id)).sheet_status).toBe("CTE ENVIADO");
    expect(writes).toHaveLength(0);
  });

  it("CTE ENVIADO → AGUARDANDO DESCARGA: quando 'não é CTE', vem do ASPX", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-CTE2" });
    await setSheetFields(carga.id, { sheet_status: "CTE ENVIADO", sheet_source: "shopee", sheet_motorista: "M" });

    const r = await reconcileAspxStatus({
      deps: baseDeps([aspRow({ lh: "LT-CTE2", status: "AGUARDANDO DESCARGA" })]),
    });
    expect(r).toMatchObject({ ok: true, updated: 1 });
    expect((await rowOf(carga.id)).sheet_status).toBe("AGUARDANDO DESCARGA");
  });

  it("solta o override congelado que ficou atrás da planilha", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-OVR" });
    await setSheetFields(carga.id, {
      sheet_status: "AGUARDANDO CARREGAMENTO",
      sheet_source: "shopee",
      // Gravado pelo modal do Monitor no instante da alocação, sem o operador ter
      // escolhido nada (race do prefill) — e a viagem seguiu desde então.
      alloc_status: "AGUARDANDO CHEGAR NO CLIENTE",
    });

    const r = await reconcileAspxStatus({ deps: baseDeps([aspRow({ lh: "LT-OVR", status: "CARREGADO" })]) });

    expect(r).toMatchObject({ ok: true, updated: 1 });
    const row = await rowOf(carga.id);
    expect(row.sheet_status).toBe("CARREGADO");
    expect(row.alloc_status).toBeNull(); // volta a refletir a planilha sozinha
  });

  it("override congelado NÃO derruba a proteção de CTE EM EMISSÃO na planilha", async () => {
    // Regressão: ancorar a decisão no status EFETIVO (alloc ?? sheet) faria o
    // job apagar o CTE da coluna L. A decisão da planilha fica em sheet_status.
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-OVR-CTE" });
    await setSheetFields(carga.id, {
      sheet_status: "CTE EM EMISSÃO",
      sheet_source: "shopee",
      alloc_status: "AGUARDANDO CHEGAR NO CLIENTE",
    });

    const writes = [];
    const r = await reconcileAspxStatus({
      deps: baseDeps(
        [aspRow({ lh: "LT-OVR-CTE", status: "CARREGADO" })],
        { writeAllocationsToSheet: async (u) => { writes.push(...u); return { ok: true, updated: u.length }; } },
      ),
    });

    expect(r).toMatchObject({ ok: true, updated: 1, sheetWrites: 0 });
    const row = await rowOf(carga.id);
    expect(row.sheet_status).toBe("CTE EM EMISSÃO"); // intocável, preservado
    expect(row.alloc_status).toBeNull(); // override solto → painel mostra o CTE
    expect(writes).toHaveLength(0); // só banco: nada a espelhar na planilha
  });

  it("override deliberado de CTE EM EMISSÃO é preservado (ASPX não conhece esse vocabulário)", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-OVR-KEEP" });
    await setSheetFields(carga.id, {
      sheet_status: "AGUARDANDO CARREGAMENTO",
      sheet_source: "shopee",
      alloc_status: "CTE EM EMISSÃO",
    });

    const r = await reconcileAspxStatus({ deps: baseDeps([aspRow({ lh: "LT-OVR-KEEP", status: "CARREGADO" })]) });

    expect(r).toMatchObject({ ok: true, updated: 1 });
    const row = await rowOf(carga.id);
    expect(row.sheet_status).toBe("CARREGADO"); // planilha avança normalmente
    expect(row.alloc_status).toBe("CTE EM EMISSÃO"); // override do operador vence
  });

  it("override vazio SEM motorista ('Disponível' deliberado) não é tocado", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-OVR-VAZIO" });
    await setSheetFields(carga.id, {
      sheet_status: "AGUARDANDO CARREGAMENTO",
      sheet_source: "shopee",
      alloc_status: "",
    });

    await reconcileAspxStatus({ deps: baseDeps([aspRow({ lh: "LT-OVR-VAZIO", status: "CARREGADO" })]) });

    expect((await rowOf(carga.id)).alloc_status).toBe(""); // reabertura deliberada
  });

  it("override vazio COM motorista é artefato do editor inline → solta (carga aparecia sem status)", async () => {
    // `status: allocStatus ?? ""` do editor inline gravava vazio EXPLÍCITO; como
    // COALESCE(alloc_*, sheet_*) devolve "", a carga ficava SEM status na tela
    // mesmo com a planilha já em DESCARREGADO.
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-OVR-VZ-MOT" });
    await setSheetFields(carga.id, {
      sheet_status: "DESCARREGADO",
      sheet_source: "shopee",
      sheet_motorista: "JOAO DA SILVA",
      alloc_status: "",
    });

    const r = await reconcileAspxStatus({ deps: baseDeps([aspRow({ lh: "LT-OVR-VZ-MOT", status: "DESCARREGADO" })]) });

    expect(r).toMatchObject({ ok: true, updated: 1, sheetWrites: 0 });
    const row = await rowOf(carga.id);
    expect(row.alloc_status).toBeNull(); // volta a mostrar DESCARREGADO
    expect(row.sheet_status).toBe("DESCARREGADO"); // planilha intocada
  });

  it("override vazio com motorista REMOVIDO ('' explícito) não é tocado", async () => {
    // alloc_motorista = "" vence sheet_motorista (semântica do Monitor): carga sem
    // motorista → o "" de status é a reabertura deliberada.
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-OVR-VZ-SEM" });
    await setSheetFields(carga.id, {
      sheet_status: "CARREGADO",
      sheet_source: "shopee",
      sheet_motorista: "JOAO DA SILVA",
      alloc_motorista: "",
      alloc_status: "",
    });

    await reconcileAspxStatus({ deps: baseDeps([aspRow({ lh: "LT-OVR-VZ-SEM", status: "CARREGADO" })]) });

    expect((await rowOf(carga.id)).alloc_status).toBe("");
  });

  it("override vazio NÃO assume CANCELADO da planilha (não dispara cascata retroativa)", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-OVR-VZ-CANC" });
    await setSheetFields(carga.id, {
      sheet_status: "CANCELADO",
      sheet_source: "shopee",
      sheet_motorista: "JOAO DA SILVA",
      alloc_status: "",
    });

    await reconcileAspxStatus({ deps: baseDeps([aspRow({ lh: "LT-OVR-VZ-CANC", status: "CANCELADO" })]) });

    expect((await rowOf(carga.id)).alloc_status).toBe(""); // segue mascarado de propósito
  });

  it("write-back desligado: sistema atualiza, planilha não é chamada", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-OFF" });
    await setSheetFields(carga.id, { sheet_status: "AGUARDANDO CARREGAMENTO", sheet_source: "shopee" });

    let called = false;
    const r = await reconcileAspxStatus({
      deps: baseDeps([aspRow({ lh: "LT-OFF", status: "CARREGADO" })], {
        isSheetWritebackEnabled: () => false,
        writeAllocationsToSheet: async () => { called = true; return { ok: true }; },
      }),
    });

    expect(r).toMatchObject({ ok: true, updated: 1, sheetWrites: 0 });
    expect((await rowOf(carga.id)).sheet_status).toBe("CARREGADO");
    expect(called).toBe(false);
  });

  it("ignora LHs do ASPX sem carga no sistema", async () => {
    const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-EX" });
    await setSheetFields(carga.id, { sheet_status: "AGUARDANDO CARREGAMENTO", sheet_source: "shopee" });

    const r = await reconcileAspxStatus({
      deps: baseDeps([
        aspRow({ lh: "LT-EX", status: "CARREGADO" }),
        aspRow({ lh: "LT-FANTASMA", status: "CARREGADO" }),
      ]),
    });
    expect(r).toMatchObject({ ok: true, checked: 1, updated: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pré-filtro de LINHAS (egress) — medido em produção: 845 linhas/chamada,
// ~335.000 linhas/dia, num job que roda a cada 3min. O ganho NÃO vem de cache
// (um TTL curto é inútil contra um timer de 3min): vem de ler só as cargas em
// que o ciclo pode escrever algo.
//
// Instrumentação: envolve client.query UMA vez por client. O pool do pg-mem
// REUSA clients — sem a guarda de Symbol o wrapper viraria wrapper-de-wrapper e
// contaria cada query duas vezes. O destino do log é um holder mutável, senão um
// client reusado seguiria escrevendo no array do teste ANTERIOR.
// ─────────────────────────────────────────────────────────────────────────────
const QUERY_WRAPPED = Symbol.for("lmc.test.reconcileAspxStatus.queryWrapped");
const queryLog = { current: [] };

async function countingWithPgClient(cb) {
  return withPgClient(async (client) => {
    if (!client[QUERY_WRAPPED]) {
      const original = client.query.bind(client);
      client.query = async (...args) => {
        const result = await original(...args);
        queryLog.current.push({ sql: String(args[0] ?? ""), rows: result?.rows?.length ?? 0 });
        return result;
      };
      client[QUERY_WRAPPED] = true;
    }
    return cb(client);
  });
}

// A leitura das cargas é a única query que projeta as colunas alloc_*.
const CARGO_READ_MARK = "alloc_motorista, alloc_cavalo, alloc_carreta";
const cargoReads = () =>
  queryLog.current.filter((q) => q.sql.includes("SELECT") && q.sql.includes(CARGO_READ_MARK));
const cargoRowsRead = () => cargoReads().reduce((sum, q) => sum + q.rows, 0);

describe("reconcileAspxStatus — pré-filtro de linhas (egress)", () => {
  let clienteId;
  let writes;

  const depsCounting = (rows, extra = {}) => {
    // Captura o array de writes POR VALOR, no momento em que as deps são criadas.
    //
    // Por que não usar `writes` direto: um teste que estoura o timeout é
    // ABANDONADO pelo vitest, mas o trabalho assíncrono dele CONTINUA rodando. Se
    // o closure lesse o binding `writes` (reatribuído no `beforeEach`), o
    // write-back órfão cairia no array do teste SEGUINTE — que então enxerga
    // writes fantasma e falha por um motivo que não é o dele. Reproduzido baixando
    // o timeout deste arquivo de propósito: o teste seguinte via 11 writes em vez
    // de 3 (3 legítimos + 8 do órfão). Capturando por valor, cada órfão fica preso
    // ao seu próprio array. No caminho feliz é idêntico: as deps são sempre criadas
    // depois do último `writes = []` da fase.
    //
    // Isto fecha UM canal de contaminação, não todos: o banco pg-mem do harness é
    // module-level e `resetTestDatabase()` troca o pool por baixo do órfão, então
    // um teste que estoura o timeout ainda pode sujar o vizinho pelo BANCO. A
    // defesa real contra isso é não estourar o timeout — por isso os dois testes
    // A/B pesados deste arquivo declaram `30_000` explicitamente.
    const sink = writes;
    return {
      withPgClient: countingWithPgClient,
      fetchSpxTrips: fakeTrips(rows),
      isSheetWritebackEnabled: () => true,
      writeAllocationsToSheet: async (u) => {
        sink.push(...u);
        return { ok: true, updated: u.length };
      },
      ...extra,
    };
  };

  beforeEach(async () => {
    await resetTestDatabase();
    clienteId = (await seedCliente({ nome: "Shopee" })).id;
    queryLog.current = [];
    writes = [];
    delete process.env.ASPX_STATUS_RECONCILE_PREFILTER;
  });
  afterEach(() => {
    delete process.env.ASPX_STATUS_RECONCILE_PREFILTER;
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  // Fixture "convergida": 10 cargas cujo espelho do sistema JÁ é igual à aba ASP
  // — o estado normal de qualquer tick depois do primeiro. Inclui o caso duro:
  // gate FECHADO com motorista/placa diferentes no ASP (o JS não pode tocar, logo
  // a linha não precisa ser lida).
  async function seedConverged() {
    const asp = [];
    for (let i = 0; i < 8; i += 1) {
      const lh = `LT-OK-${i}`;
      const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: lh });
      await setSheetFields(carga.id, {
        sheet_status: "CARREGADO",
        sheet_source: "shopee",
        sheet_motorista: `MOTORISTA ${i}`,
        sheet_cavalo: `AAA1A1${i}`,
        sheet_carreta: `BBB2B2${i}`,
      });
      asp.push(
        aspRow({ lh, status: "CARREGADO", driver: `[${i}] MOTORISTA ${i}`, plate: `AAA1A1${i},BBB2B2${i}` }),
      );
    }
    // Gate FECHADO + status igual + dados DIFERENTES no ASP → nada a fazer.
    for (const [i, status] of ["AGUARDANDO DESCARGA", "DESCARREGADO"].entries()) {
      const lh = `LT-GATEOFF-${i}`;
      const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: lh });
      await setSheetFields(carga.id, {
        sheet_status: status,
        sheet_source: "shopee",
        sheet_motorista: "QUEM ESTAVA",
        sheet_cavalo: "OLD1A11",
      });
      asp.push(aspRow({ lh, status, driver: "[9] OUTRO NOME", plate: "NEW1A11,NEW2B22" }));
    }
    return asp;
  }

  it("tick em regime (nada mudou): lê ZERO linhas de cargas e `checked` continua exato", async () => {
    const asp = await seedConverged();

    const r = await reconcileAspxStatus({ deps: depsCounting(asp) });

    // Comportamento idêntico: nada mudou, nada escrito.
    expect(r).toMatchObject({ ok: true, checked: 10, updated: 0, sheetWrites: 0 });
    expect(writes).toHaveLength(0);
    // Egress: a leitura das cargas trouxe 0 linhas (antes: 10).
    expect(cargoReads()).toHaveLength(1);
    expect(cargoRowsRead()).toBe(0);
  });

  it("as linhas que o pré-filtro exclui são provadamente no-op no caminho ANTIGO", async () => {
    const asp = await seedConverged();

    // Kill-switch: volta a ler TODAS as cargas casadas (comportamento anterior).
    process.env.ASPX_STATUS_RECONCILE_PREFILTER = "false";
    const r = await reconcileAspxStatus({ deps: depsCounting(asp) });

    // O caminho antigo trafegou as 10 linhas e não escreveu NADA — é exatamente o
    // `continue` do laço. Logo excluí-las da leitura não muda comportamento.
    expect(cargoRowsRead()).toBe(10);
    expect(r).toMatchObject({ ok: true, checked: 10, updated: 0, sheetWrites: 0 });
    expect(writes).toHaveLength(0);
  });

  // Superconjunto: toda carga em que o JS ATUAL mexeria continua sendo lida.
  const supersetCases = [
    {
      name: "status difere (regra permite)",
      sheet: { sheet_status: "AGUARDANDO CARREGAMENTO" },
      asp: { status: "CARREGADO" },
      expectUpdated: 1,
    },
    {
      name: "status difere mas a regra PROÍBE (NO SHOW intocável) — lida ainda assim",
      sheet: { sheet_status: "NO SHOW" },
      asp: { status: "CARREGADO" },
      expectUpdated: 0,
    },
    {
      name: "gate aberto, status igual, MOTORISTA difere",
      sheet: { sheet_status: "CARREGADO", sheet_motorista: "ANTIGO" },
      asp: { status: "CARREGADO", driver: "[7] NOVO NOME" },
      expectUpdated: 1,
    },
    {
      name: "gate aberto, status igual, CAVALO difere",
      sheet: { sheet_status: "CARREGADO", sheet_cavalo: "OLD1A11" },
      asp: { status: "CARREGADO", plate: "NEW1A11," },
      expectUpdated: 1,
    },
    {
      name: "gate aberto, status igual, CARRETA difere",
      sheet: { sheet_status: "CARREGADO", sheet_carreta: "OLD2B22" },
      asp: { status: "CARREGADO", plate: ",NEW2B22" },
      expectUpdated: 1,
    },
    {
      name: "gate aberto, status igual em CAIXA DIFERENTE (normalizeAspxStatus) — lida ainda assim",
      sheet: { sheet_status: "carregado", sheet_motorista: "ANTIGO" },
      asp: { status: "CARREGADO", driver: "[7] NOVO NOME" },
      expectUpdated: 1,
    },
    // (C) O disjunto do OVERRIDE. Este caso é o que ¬(A) ∧ ¬(B) descartaria:
    // sheet_status IGUAL ao do ASP e nenhum dado divergindo — a única razão para
    // gravar é soltar o override congelado (auto-cura do #397/DC-316). Sem
    // `OR alloc_status IS NOT NULL` no pré-filtro, esta linha não seria lida e o
    // bug do status operacional congelado voltaria em silêncio.
    {
      name: "(C) tudo igual, mas OVERRIDE congelado precisa ser solto (auto-cura #397)",
      sheet: { sheet_status: "CARREGADO", alloc_status: "AGUARDANDO ACEITE" },
      asp: { status: "CARREGADO" },
      expectUpdated: 1,
    },
  ];

  for (const c of supersetCases) {
    it(`pré-filtro NÃO descarta: ${c.name}`, async () => {
      const carga = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT-SUP" });
      await setSheetFields(carga.id, { sheet_source: "shopee", ...c.sheet });

      const r = await reconcileAspxStatus({
        deps: depsCounting([aspRow({ lh: "LT-SUP", ...c.asp })]),
      });

      // A linha CHEGOU ao JS (é o que o superconjunto garante)...
      expect(cargoRowsRead()).toBe(1);
      // ...e a decisão final é a das regras, inalterada.
      expect(r).toMatchObject({ checked: 1, updated: c.expectUpdated });
    });
  }

  // Os dois testes A/B abaixo comparam o caminho ANTIGO com o NOVO. Cada passo usa
  // seu PRÓPRIO namespace de LH e ambos os fixtures coexistem no banco — nada de
  // `resetTestDatabase()` no meio do teste. Isso não é cosmético: com o reset no
  // meio, um estouro do timeout deixava o `seed` órfão rodando e ele inseria no
  // banco JÁ recriado pelo `beforeEach` do teste seguinte, contaminando-o (só
  // aparecia ao rodar a pasta inteira, sob concorrência).
  //
  // Semear em LOTE (um único INSERT) em vez de ~200 seedCargo+UPDATE também tira o
  // teste da zona do timeout default de 5s.
  async function bulkSeedCargos(specs) {
    const values = [];
    const params = [];
    specs.forEach((spec, index) => {
      const base = index * 7;
      values.push(
        `($${base + 1}::uuid, $${base + 2}::uuid, '2026-04-08'::date, '08:00:00'::time,` +
          ` 'Origem', 'Destino', $${base + 3}, $${base + 4}, 'shopee',` +
          ` $${base + 5}, $${base + 6}, $${base + 7})`,
      );
      params.push(
        crypto.randomUUID(),
        clienteId,
        spec.lh,
        spec.sheet_status ?? null,
        spec.sheet_motorista ?? null,
        spec.sheet_cavalo ?? null,
        spec.sheet_carreta ?? null,
      );
    });
    await query(
      `INSERT INTO public.cargas
         (id, cliente_id, data, horario, origem, destino, sheet_lh, sheet_status, sheet_source,
          sheet_motorista, sheet_cavalo, sheet_carreta)
       VALUES ${values.join(", ")}`,
      params,
    );
  }

  // Fixture com a FORMA da produção: a aba ASP cobre 45 dias atrás + 30 à frente,
  // então a esmagadora maioria das viagens já convergiu há muito tempo e só um
  // punhado muda de status dentro de uma janela de 3min.
  async function seedProdShaped(prefix) {
    const specs = [];
    const asp = [];
    const add = (lh, sheet, aspFields) => {
      specs.push({ lh: `${prefix}${lh}`, ...sheet });
      asp.push(aspRow({ lh: `${prefix}${lh}`, ...aspFields }));
    };

    // 180 convergidas sob o gate (espelho == ASP).
    for (let i = 0; i < 180; i += 1) {
      add(
        `LT-CONV-${i}`,
        { sheet_status: "CARREGADO", sheet_motorista: `M${i}`, sheet_cavalo: `AAA1A${i}`, sheet_carreta: `BBB2B${i}` },
        { status: "CARREGADO", driver: `[${i}] M${i}`, plate: `AAA1A${i},BBB2B${i}` },
      );
    }
    // 10 terminais com gate FECHADO: o ASP traz motorista/placa diferentes, mas as
    // regras proíbem tocar → não precisam ser lidas.
    for (let i = 0; i < 10; i += 1) {
      add(
        `LT-FIM-${i}`,
        { sheet_status: "DESCARREGADO", sheet_motorista: "QUEM ERA", sheet_cavalo: "OLD1A11" },
        { status: "DESCARREGADO", driver: "[9] OUTRO", plate: "NEW1A11,NEW2B22" },
      );
    }
    // 5 mudaram de status nesta janela.
    for (let i = 0; i < 5; i += 1) {
      add(`LT-MOV-${i}`, { sheet_status: "AGUARDANDO CARREGAMENTO" }, { status: "CARREGADO" });
    }
    // 3 trocaram de motorista sob o gate.
    for (let i = 0; i < 3; i += 1) {
      add(
        `LT-SWAP-${i}`,
        { sheet_status: "CARREGADO", sheet_motorista: "ANTIGO" },
        { status: "CARREGADO", driver: `[${i}] NOVO ${i}` },
      );
    }
    // 2 do PISO PERMANENTE: "CTE EM EMISSÃO" só existe na planilha, então o ASP
    // sempre discorda e a regra sempre proíbe → estas voltam em TODO ciclo. É o
    // limite inferior honesto do ganho; o pré-filtro não as elimina (nem deve).
    for (let i = 0; i < 2; i += 1) {
      add(`LT-PISO-${i}`, { sheet_status: "CTE EM EMISSÃO", sheet_motorista: "FIXO" }, { status: "CARREGADO" });
    }

    await bulkSeedCargos(specs);
    return asp;
  }

  it("fixture com a forma da produção: 200 cargas casadas → 10 linhas lidas (mesmas 8 escritas)", async () => {
    // (1) Comportamento ANTIGO, no namespace "OFF-".
    const aspOff = await seedProdShaped("OFF-");
    process.env.ASPX_STATUS_RECONCILE_PREFILTER = "false";
    const rOld = await reconcileAspxStatus({ deps: depsCounting(aspOff) });
    const rowsOld = cargoRowsRead();
    const writesOld = writes.length;

    // (2) Comportamento NOVO, no namespace "ON-" (fixture virgem, mesmo conteúdo).
    queryLog.current = [];
    writes = [];
    delete process.env.ASPX_STATUS_RECONCILE_PREFILTER;
    const aspOn = await seedProdShaped("ON-");
    const rNew = await reconcileAspxStatus({ deps: depsCounting(aspOn) });
    const rowsNew = cargoRowsRead();

    // MESMO trabalho: 8 cargas mudam (5 status + 3 motorista); as 2 do piso e as
    // 10 de gate fechado continuam intocadas.
    expect(rNew.updated).toBe(8);
    expect(rNew.updated).toBe(rOld.updated);
    expect(writes.length).toBe(writesOld);
    // `checked` (observabilidade) intacto nos dois caminhos — e escopado ao
    // namespace, porque o ASP de cada passo só lista os LHs dele.
    expect(rNew.checked).toBe(200);
    expect(rOld.checked).toBe(200);

    // Egress: 200 → 10 linhas (-95%). As 10 = 5 status + 3 motorista + 2 do piso.
    expect(rowsOld).toBe(200);
    expect(rowsNew).toBe(10);
    console.info(`[medido] cargas lidas por ciclo: ${rowsOld} -> ${rowsNew} (${((1 - rowsNew / rowsOld) * 100).toFixed(1)}% menos linhas)`);
  }, 30_000);

  it("equivalência total: pré-filtro LIGADO e DESLIGADO produzem o MESMO banco e o MESMO write-back", async () => {
    // Fixture mista: convergida + cada tipo de mudança + intocáveis + gate fechado.
    const MIXED = [
      ["LT-M-OK", { sheet_status: "CARREGADO", sheet_motorista: "IGUAL", sheet_cavalo: "AAA1A11" },
        { status: "CARREGADO", driver: "[1] IGUAL", plate: "AAA1A11," }],
      ["LT-M-ST", { sheet_status: "AGUARDANDO CARREGAMENTO" },
        { status: "CARREGADO", driver: "[2] NOVO", plate: "BBB1B11,CCC2C22", etaO: "27/07/2026 08:00" }],
      ["LT-M-MO", { sheet_status: "CARREGADO", sheet_motorista: "ANTIGO" },
        { status: "CARREGADO", driver: "[3] TROCADO", plate: "DDD1D11," }],
      ["LT-M-NS", { sheet_status: "NO SHOW", sheet_motorista: "FIXO" },
        { status: "CARREGADO", driver: "[4] IGNORADO" }],
      ["LT-M-CT", { sheet_status: "CTE ENVIADO", sheet_motorista: "FIXO2" },
        { status: "CARREGADO", driver: "[5] IGNORADO" }],
      ["LT-M-DE", { sheet_status: "AGUARDANDO DESCARGA", sheet_motorista: "VIVO" },
        { status: "DESCARREGANDO", driver: "[6] IGNORADO", plate: "EEE1E11," }],
    ];

    const seedMixed = async (prefix) => {
      await bulkSeedCargos(MIXED.map(([lh, sheet]) => ({ lh: `${prefix}${lh}`, ...sheet })));
      return MIXED.map(([lh, , aspFields]) => aspRow({ lh: `${prefix}${lh}`, ...aspFields }));
    };

    // Snapshot ESCOPADO ao namespace (nunca `SELECT * FROM cargas` sem filtro — o
    // outro namespace está no mesmo banco), com o prefixo removido para comparar.
    const snapshot = async (prefix) => {
      const lhs = MIXED.map(([lh]) => `${prefix}${lh}`);
      const { rows } = await query(
        `SELECT sheet_lh, sheet_status, sheet_motorista, sheet_cavalo, sheet_carreta
           FROM public.cargas WHERE sheet_lh = ANY($1::text[]) ORDER BY sheet_lh`,
        [lhs],
      );
      return rows.map((r) => ({ ...r, sheet_lh: r.sheet_lh.slice(prefix.length) }));
    };
    const normalizeWrites = (list, prefix) =>
      [...list]
        .map((u) => ({ ...u, lh: u.lh.slice(prefix.length) }))
        .sort((a, b) => a.lh.localeCompare(b.lh))
        .map((u) => JSON.stringify(u));

    // (1) Caminho ANTIGO (kill-switch).
    const aspOff = await seedMixed("OFF-");
    process.env.ASPX_STATUS_RECONCILE_PREFILTER = "false";
    const rOld = await reconcileAspxStatus({ deps: depsCounting(aspOff) });
    const stateOld = await snapshot("OFF-");
    const writesOld = normalizeWrites(writes, "OFF-");
    const rowsOld = cargoRowsRead();

    // (2) Mesmo fixture, caminho NOVO.
    queryLog.current = [];
    writes = [];
    delete process.env.ASPX_STATUS_RECONCILE_PREFILTER;
    const aspOn = await seedMixed("ON-");
    const rNew = await reconcileAspxStatus({ deps: depsCounting(aspOn) });
    const stateNew = await snapshot("ON-");
    const writesNew = normalizeWrites(writes, "ON-");
    const rowsNew = cargoRowsRead();

    // Comportamento IDÊNTICO: banco, write-back e contadores do retorno.
    expect(stateNew).toEqual(stateOld);
    expect(writesNew).toEqual(writesOld);
    expect(rNew).toEqual(rOld);
    // 3 cargas mudam: status (LT-M-ST), motorista (LT-M-MO) e a transição de
    // descarga permitida (LT-M-DE). NO SHOW e CTE ENVIADO são travados pelas regras.
    expect(rNew).toMatchObject({ checked: 6, updated: 3 });

    // Egress: a convergida (LT-M-OK) sai da leitura. NO SHOW e CTE ENVIADO
    // CONTINUAM sendo lidas — o predicado é superconjunto de propósito: quem
    // decide travar é a regra em JS, não o SQL.
    expect(rowsOld).toBe(6);
    expect(rowsNew).toBe(5);
    expect(rowsNew).toBeLessThan(rowsOld);
  }, 30_000);
});
