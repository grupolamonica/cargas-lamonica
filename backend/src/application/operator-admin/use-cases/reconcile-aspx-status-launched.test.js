import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reconcileAspxStatusForLaunched } from "./reconcile-aspx-status-launched.js";

// A carga LANÇADA (lh_manual) nunca recebia status: o sync do DC-316 casa por
// sheet_lh. Aqui as mesmas regras rodam sobre o conjunto complementar.

// Linha da aba ASP no formato bruto da Torre (só as chaves que o parse usa).
const aspRow = (lh, status) => ({
  "LH Trip Number": lh,
  "Status Operacional": status,
  "Driver ID": "",
  "Vehicle Plate Number": ",",
});

/**
 * @param {{
 *   cargas?: object[], asp?: object[],
 *   snapshotLhs?: string[],      // LHs presentes no snapshot da planilha
 *   sheetCargoLhs?: string[],    // LHs com carga da planilha materializada (cargas.sheet_lh)
 *   snapshotFails?: boolean,     // simula snapshot ilegível (fail-closed)
 * }} [cfg]
 */
function makeDeps({ cargas = [], asp = [], snapshotLhs = [], sheetCargoLhs = [], snapshotFails = false } = {}) {
  const updates = [];
  const sheetPosts = [];
  const audits = [];
  const selects = [];
  // O SELECT real devolve as colunas CRUAS alloc_motorista/sheet_motorista (usadas
  // para o `hasDriver` com semântica `??`) além do alias `motorista` (COALESCE `||`,
  // usado no write-back). A fixture declara a intenção ("carga com motorista Ana") e
  // o harness materializa a linha realista; teste que exercita o `??` passa as cruas.
  const asDbRow = (c) => ({
    ...c,
    alloc_motorista: c.alloc_motorista !== undefined ? c.alloc_motorista : (c.motorista ?? null),
    sheet_motorista: c.sheet_motorista !== undefined ? c.sheet_motorista : null,
  });
  return {
    updates,
    sheetPosts,
    audits,
    selects,
    deps: {
      fetchSpxTrips: async () => ({ rows: asp }),
      withPgClient: async (cb) =>
        cb({
          query: async (sql, params) => {
            const flat = sql.replace(/\s+/g, " ").trim();
            if (/sheet_monitor_snapshot/i.test(flat)) {
              if (snapshotFails) throw new Error("snapshot ilegível");
              return { rows: [{ rows_json: snapshotLhs.map((lh) => ({ lh })) }] };
            }
            if (/SELECT sheet_lh FROM public\.cargas/i.test(flat)) {
              return { rows: sheetCargoLhs.map((lh) => ({ sheet_lh: lh })) };
            }
            if (/^INSERT INTO public\.security_audit_logs/i.test(flat)) {
              audits.push({ sql: flat, params });
              return { rowCount: 1 };
            }
            if (/^UPDATE/i.test(flat)) {
              updates.push({ sql: flat, params });
              return { rowCount: 1 };
            }
            selects.push(flat);
            return { rows: cargas.map(asDbRow) };
          },
        }),
      writeAllocationsToSheet: async (list) => {
        sheetPosts.push(list);
        return { ok: true, updated: list.length };
      },
      isSheetWritebackEnabled: () => true,
    },
  };
}

describe("reconcileAspxStatusForLaunched", () => {
  beforeEach(() => {
    delete process.env.ASPX_STATUS_LAUNCHED;
  });
  afterEach(() => {
    delete process.env.ASPX_STATUS_LAUNCHED;
    vi.restoreAllMocks();
  });

  it("desligado por padrão → no-op (nem busca a aba ASP)", async () => {
    const fetchSpy = vi.fn();
    const r = await reconcileAspxStatusForLaunched({ deps: { fetchSpxTrips: fetchSpy } });
    expect(r.skipped).toBe("disabled");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("dry: mede o que mudaria e NÃO grava nada", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "dry";
    const { deps, updates, sheetPosts } = makeDeps({
      cargas: [{ id: "c1", lh: "LT-A", sheet_status: null, alloc_status: null, motorista: "Ana" }],
      asp: [aspRow("LT-A", "DESCARREGADO")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.mode).toBe("dry");
    expect(r.updated).toBe(1);
    expect(r.exemplos[0]).toContain('"(vazio)" → "DESCARREGADO"');
    expect(updates).toHaveLength(0);
    expect(sheetPosts).toHaveLength(0);
    expect(r.sheetWrites).toBe(0);
  });

  it("on: grava o espelho e manda o status para a planilha", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, updates, sheetPosts } = makeDeps({
      cargas: [{ id: "c1", lh: "LT-A", sheet_status: null, alloc_status: null, motorista: "Ana", cavalo: "AAA1B22", carreta: "CCC3D44" }],
      asp: [aspRow("LT-A", "CARREGADO")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.updated).toBe(1);
    expect(updates[0].sql).toContain("SET sheet_status = $2");
    expect(updates[0].params).toEqual(["c1", "CARREGADO"]);
    expect(sheetPosts[0][0]).toMatchObject({ lh: "LT-A", status: "CARREGADO", motorista: "Ana", cavalo: "AAA1B22", carreta: "CCC3D44" });
    expect(r.sheetWrites).toBe(1);
  });

  it("on: solta o override do operador quando a planilha passou dele", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, updates } = makeDeps({
      cargas: [{ id: "c1", lh: "LT-A", sheet_status: "AGUARDANDO CHEGAR NO CLIENTE", alloc_status: "AGUARDANDO CARREGAMENTO", motorista: "Ana" }],
      asp: [aspRow("LT-A", "CARREGADO")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.updated).toBe(1);
    expect(r.overridesSoltos).toBe(1);
    expect(updates[0].sql).toContain("alloc_status = NULL");
  });

  // Gravar cancelamento faria sweepCancelledCascades disparar a cascata de rota
  // retroativa (já derrubou 39 motoristas da fila) — fica fora desta passada, mesmo
  // com status atual preenchido (onde a regra 2 do DC-316 permitiria).
  it("cancelamento/NO SHOW no ASP ficam FORA (cascata retroativa) — só contam", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, updates, sheetPosts } = makeDeps({
      cargas: [
        { id: "c1", lh: "LT-A", sheet_status: null, alloc_status: null, motorista: "Ana" },
        { id: "c2", lh: "LT-B", sheet_status: "AGUARDANDO CHEGAR NO CLIENTE", alloc_status: null, motorista: "Bia" },
        { id: "c3", lh: "LT-C", sheet_status: "CARREGADO", alloc_status: null, motorista: "Cida" },
      ],
      asp: [aspRow("LT-A", "CANCELADO"), aspRow("LT-B", "CANCELADO"), aspRow("LT-C", "NO SHOW")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.updated).toBe(0);
    expect(r.excecoesIgnoradas).toBe(3);
    expect(updates).toHaveLength(0);
    expect(sheetPosts).toHaveLength(0);
  });

  it("respeita os intocáveis do DC-316 (NO SHOW / CTE EM EMISSÃO)", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, updates } = makeDeps({
      cargas: [
        { id: "c1", lh: "LT-A", sheet_status: "NO SHOW", alloc_status: null, motorista: "Ana" },
        { id: "c2", lh: "LT-B", sheet_status: "CTE EM EMISSÃO", alloc_status: null, motorista: "Bia" },
      ],
      asp: [aspRow("LT-A", "CARREGADO"), aspRow("LT-B", "CARREGADO")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.updated).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("status já igual ao ASP → nada a fazer", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, updates } = makeDeps({
      cargas: [{ id: "c1", lh: "LT-A", sheet_status: "CARREGADO", alloc_status: null, motorista: "Ana" }],
      asp: [aspRow("LT-A", "CARREGADO")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.updated).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("aba ASP vazia → no-op", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps } = makeDeps({ cargas: [], asp: [] });
    const r = await reconcileAspxStatusForLaunched({ deps });
    expect(r.skipped).toBe("empty-index");
  });
});

// A âncora desta passada é o status EFETIVO da própria carga lançada, e isso só é
// legítimo quando o LH NÃO está na planilha. Na gêmea (LH também na planilha) o
// espelho nasce NULL, a âncora vinha vazia e a REGRA 1 do DC-316 nunca era consultada:
// medido em produção, 104 de 104 candidatas eram gêmeas e 13 teriam a célula regredida
// de "CTE ENVIADO" para "CARREGADO" — o CTE só existe na planilha.
describe("reconcileAspxStatusForLaunched — LH que pertence à planilha fica FORA", () => {
  beforeEach(() => { delete process.env.ASPX_STATUS_LAUNCHED; });
  afterEach(() => { delete process.env.ASPX_STATUS_LAUNCHED; vi.restoreAllMocks(); });

  it("não regride a célula CTE ENVIADO de um LH que está no snapshot da planilha", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, updates, sheetPosts } = makeDeps({
      // Espelho NULL (nasce assim na lançada) → âncora vazia: era o caminho do defeito.
      cargas: [{ id: "c1", lh: "LT-GEMEA", sheet_status: null, alloc_status: null, motorista: "Ana" }],
      asp: [aspRow("LT-GEMEA", "CARREGADO")],
      snapshotLhs: ["LT-GEMEA"],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.updated).toBe(0);
    expect(r.ignoradasNaPlanilha).toBe(1);
    expect(updates).toHaveLength(0);
    expect(sheetPosts).toHaveLength(0);
  });

  it("também fica fora quando existe carga da planilha materializada (cargas.sheet_lh)", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, updates } = makeDeps({
      cargas: [{ id: "c1", lh: "LT-MAT", sheet_status: null, alloc_status: null, motorista: "Ana" }],
      asp: [aspRow("LT-MAT", "DESCARREGADO")],
      sheetCargoLhs: ["LT-MAT"],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.updated).toBe(0);
    expect(r.ignoradasNaPlanilha).toBe(1);
    expect(updates).toHaveLength(0);
  });

  it("lançada FORA da planilha segue sendo sincronizada (a passada não virou no-op cego)", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, updates } = makeDeps({
      cargas: [
        { id: "c1", lh: "LT-GEMEA", sheet_status: null, alloc_status: null, motorista: "Ana" },
        { id: "c2", lh: "LT-SO-SISTEMA", sheet_status: null, alloc_status: null, motorista: "Bia" },
      ],
      asp: [aspRow("LT-GEMEA", "CARREGADO"), aspRow("LT-SO-SISTEMA", "CARREGADO")],
      snapshotLhs: ["LT-GEMEA"],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.updated).toBe(1);
    expect(r.ignoradasNaPlanilha).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toEqual(["c2", "CARREGADO"]);
  });

  it("snapshot ilegível → ABORTA sem escrever (fail-closed)", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, updates, sheetPosts } = makeDeps({
      cargas: [{ id: "c1", lh: "LT-A", sheet_status: null, alloc_status: null, motorista: "Ana" }],
      asp: [aspRow("LT-A", "CARREGADO")],
      snapshotFails: true,
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.skipped).toBe("no-sheet-index");
    expect(r.updated).toBe(0);
    expect(updates).toHaveLength(0);
    expect(sheetPosts).toHaveLength(0);
  });
});

describe("reconcileAspxStatusForLaunched — endurecimento (ciclo, ordem, hasDriver, auditoria)", () => {
  beforeEach(() => { delete process.env.ASPX_STATUS_LAUNCHED; });
  afterEach(() => { delete process.env.ASPX_STATUS_LAUNCHED; vi.restoreAllMocks(); });

  it("a leitura exclui gêmea aposentada e carga não-operável, e é determinística", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "dry";
    const { deps, selects } = makeDeps({
      cargas: [{ id: "c1", lh: "LT-A", sheet_status: null, alloc_status: null, motorista: "Ana" }],
      asp: [aspRow("LT-A", "CARREGADO")],
    });

    await reconcileAspxStatusForLaunched({ deps });

    const sql = selects.find((s) => /FROM public\.cargas/i.test(s) && /lh_manual/i.test(s));
    expect(sql).toBeTruthy();
    expect(sql).toContain("retired_reason IS NULL");
    expect(sql).toMatch(/NOT IN \('CANCELLED', 'DRAFT', 'EXPIRED'\)/);
    expect(sql).toMatch(/ORDER BY/); // sem isso o corte do LIMIT era não-determinístico
  });

  it("hasDriver usa `??`: override de motorista VAZIO não conta como motorista", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    // A linha entra na query (o COALESCE `||` do SQL acha "Ana" na planilha), mas a
    // decisão vê override "" = vazio explícito → sem motorista → âncora vazia só
    // aceita AGUARDANDO CARREGAMENTO/CARREGADO, e DESCARREGADO não passa.
    const { deps, updates } = makeDeps({
      cargas: [{
        id: "c1", lh: "LT-A", sheet_status: null, alloc_status: null,
        alloc_motorista: "", sheet_motorista: "Ana", motorista: "Ana",
      }],
      asp: [aspRow("LT-A", "DESCARREGADO")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.updated).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("com motorista de verdade, o vazio aceita o pipeline inteiro (comportamento do #414 preservado)", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, updates } = makeDeps({
      cargas: [{ id: "c1", lh: "LT-A", sheet_status: null, alloc_status: null, alloc_motorista: "Ana", motorista: "Ana" }],
      asp: [aspRow("LT-A", "DESCARREGADO")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.updated).toBe(1);
    expect(updates[0].params).toEqual(["c1", "DESCARREGADO"]);
  });

  it("soltar o override do operador gera evento de auditoria e bump de updated_at", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    // ASP em CARREGADO (não descarga): passa a REGRA 4 do DC-316 e o override
    // "AGUARDANDO CHEGAR NO CLIENTE" está ATRÁS no pipeline → é solto.
    const { deps, updates, audits } = makeDeps({
      cargas: [{ id: "c1", lh: "LT-A", sheet_status: null, alloc_status: "AGUARDANDO CHEGAR NO CLIENTE", motorista: "Ana" }],
      asp: [aspRow("LT-A", "CARREGADO")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.overridesSoltos).toBe(1);
    expect(updates[0].sql).toContain("updated_at = now()");
    expect(audits).toHaveLength(1);
    const [eventType, , , actorRole, resourceType, resourceId] = audits[0].params;
    expect(eventType).toBe("system.cargo.alloc_status_released");
    expect(actorRole).toBe("system");
    expect(resourceType).toBe("cargo");
    expect(resourceId).toBe("c1");
    expect(audits[0].params[10]).toContain("AGUARDANDO CHEGAR NO CLIENTE");
  });

  it("não audita quando não soltou override", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "on";
    const { deps, audits } = makeDeps({
      cargas: [{ id: "c1", lh: "LT-A", sheet_status: null, alloc_status: null, motorista: "Ana" }],
      asp: [aspRow("LT-A", "CARREGADO")],
    });

    await reconcileAspxStatusForLaunched({ deps });

    expect(audits).toHaveLength(0);
  });

  it("dry NÃO audita nem grava, mesmo quando soltaria o override", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "dry";
    const { deps, updates, audits } = makeDeps({
      cargas: [{ id: "c1", lh: "LT-A", sheet_status: null, alloc_status: "AGUARDANDO CHEGAR NO CLIENTE", motorista: "Ana" }],
      asp: [aspRow("LT-A", "CARREGADO")],
    });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.overridesSoltos).toBe(1);
    expect(updates).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("sinaliza `truncado` quando a leitura bate no LIMIT (população além do lote)", async () => {
    process.env.ASPX_STATUS_LAUNCHED = "dry";
    const cargas = Array.from({ length: 300 }, (_, i) => ({
      id: `c${i}`, lh: `LT-${i}`, sheet_status: null, alloc_status: null, motorista: "Ana",
    }));
    const { deps } = makeDeps({ cargas, asp: cargas.map((c) => aspRow(c.lh, "CARREGADO")) });

    const r = await reconcileAspxStatusForLaunched({ deps });

    expect(r.checked).toBe(300);
    expect(r.truncado).toBe(true);
  });
});
