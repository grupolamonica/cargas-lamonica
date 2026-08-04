import { describe, expect, it } from "vitest";
import {
  collectNonShopeeSnapshotRows,
  isShopeeSnapshot,
  labelNonShopeeSnapshotRows,
  mergeSnapshotRows,
} from "./monitor-snapshot-merge.js";

const shopeeSnap = {
  source: "shopee",
  synced_at: "2026-08-04T13:34:51.981Z",
  summary_json: { total: 2 },
  rows_json: [
    { lh: "LT1Q8402D53N1", motoristas: "MOTORISTA SHOPEE" },
    { lh: "LT0Q8202C3IT1", motoristas: "" },
  ],
};
// Snapshot histórico da Shopee: source NULO (id=1), não 'shopee'.
const shopeeLegacySnap = { ...shopeeSnap, source: null };
const nestleSnap = {
  source: "nestle",
  synced_at: "2026-08-04T13:32:48.335Z",
  summary_json: { total: 1, clientName: "Produtos Alimentícios" },
  rows_json: [{ lh: "B101464733", motoristas: "MOTORISTA NESTLE" }],
};

describe("isShopeeSnapshot", () => {
  it("trata source nulo e 'shopee' como Shopee; outras fontes não", () => {
    expect(isShopeeSnapshot({ source: null })).toBe(true);
    expect(isShopeeSnapshot({ source: "" })).toBe(true);
    expect(isShopeeSnapshot({ source: "shopee" })).toBe(true);
    expect(isShopeeSnapshot({ source: "nestle" })).toBe(false);
    expect(isShopeeSnapshot({})).toBe(true);
  });
});

describe("labelNonShopeeSnapshotRows", () => {
  it("rotula cliente, namespaceia o rowKey e marca source=planilha", () => {
    const [row] = labelNonShopeeSnapshotRows(nestleSnap);
    expect(row).toMatchObject({
      lh: "B101464733",
      cliente: "Produtos Alimentícios",
      rowKey: "sheet:nestle:B101464733",
      source: "planilha",
    });
  });

  it("cai no nome da fonte quando o summary não tem clientName", () => {
    const [row] = labelNonShopeeSnapshotRows({ ...nestleSnap, summary_json: {} });
    expect(row.cliente).toBe("nestle");
  });

  it("é idempotente: linha que já tem rowKey passa intacta", () => {
    const pronta = { lh: "X", rowKey: "sheet:nestle:X", cliente: "Já rotulado", source: "planilha" };
    const [row] = labelNonShopeeSnapshotRows({ ...nestleSnap, rows_json: [pronta] });
    expect(row).toBe(pronta);
  });

  it("snapshot sem rows_json devolve lista vazia", () => {
    expect(labelNonShopeeSnapshotRows({ source: "nestle" })).toEqual([]);
    expect(labelNonShopeeSnapshotRows(undefined)).toEqual([]);
  });
});

describe("collectNonShopeeSnapshotRows (caminho do refresh)", () => {
  it("junta só as fontes que não são Shopee", () => {
    const rows = collectNonShopeeSnapshotRows([shopeeLegacySnap, nestleSnap]);
    expect(rows).toHaveLength(1);
    expect(rows[0].rowKey).toBe("sheet:nestle:B101464733");
  });

  it("descarta o snapshot da Shopee mesmo se ele escapar do filtro do SELECT", () => {
    expect(collectNonShopeeSnapshotRows([shopeeSnap])).toEqual([]);
    expect(collectNonShopeeSnapshotRows([shopeeLegacySnap])).toEqual([]);
  });

  it("lista vazia / ausente é no-op", () => {
    expect(collectNonShopeeSnapshotRows([])).toEqual([]);
    expect(collectNonShopeeSnapshotRows(undefined)).toEqual([]);
  });
});

describe("mergeSnapshotRows (caminho do read)", () => {
  it("Shopee entra CRUA (sem rótulo nem rowKey) e as outras fontes rotuladas", () => {
    const { baseRows, onlyShopee } = mergeSnapshotRows([shopeeLegacySnap, nestleSnap]);
    expect(onlyShopee).toBe(false);
    expect(baseRows).toHaveLength(3);
    // Shopee preservada byte-a-byte — o buildUnifiedMonitor aplica o cliente dela.
    expect(baseRows[0]).toBe(shopeeLegacySnap.rows_json[0]);
    expect(baseRows[0].rowKey).toBeUndefined();
    expect(baseRows[2].rowKey).toBe("sheet:nestle:B101464733");
  });

  it("só Shopee → onlyShopee true (caller preserva o summary da Shopee)", () => {
    const { baseRows, onlyShopee } = mergeSnapshotRows([shopeeLegacySnap]);
    expect(onlyShopee).toBe(true);
    expect(baseRows).toHaveLength(2);
  });

  it("devolve o synced_at MAIS RECENTE entre as fontes", () => {
    const { latestSyncedAt } = mergeSnapshotRows([nestleSnap, shopeeSnap]);
    expect(latestSyncedAt).toBe(shopeeSnap.synced_at); // 13:34 > 13:32
  });

  it("sem snapshot algum não explode", () => {
    expect(mergeSnapshotRows([])).toEqual({ baseRows: [], latestSyncedAt: null, onlyShopee: true });
    expect(mergeSnapshotRows(undefined).baseRows).toEqual([]);
  });

  // A soma que o refresh faz (Shopee fresca + secundárias do banco) tem de dar o
  // MESMO conjunto que o read monta a partir dos snapshots salvos.
  it("refresh (Shopee fresca + secundárias) == read (todos os snapshots)", () => {
    const doRead = mergeSnapshotRows([shopeeLegacySnap, nestleSnap]).baseRows;
    const doRefresh = [...shopeeLegacySnap.rows_json, ...collectNonShopeeSnapshotRows([nestleSnap])];
    expect(doRefresh).toEqual(doRead);
  });
});
