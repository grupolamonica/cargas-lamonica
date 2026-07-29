import { describe, expect, it, vi } from "vitest";
import { revalidateDriversAngellira, revalidateDriverAngelliraByCpf } from "./revalidate-drivers-angellira.js";

// db falso: captura o SELECT e os UPDATEs sem precisar de Postgres real.
function makeDb(driverRows) {
  const selects = [];
  const updates = [];
  return {
    selects,
    updates,
    async query(sql, params) {
      const s = String(sql);
      if (/^\s*SELECT/i.test(s)) {
        selects.push({ sql: s, params });
        return { rows: driverRows };
      }
      if (/UPDATE\s+public\.motoristas_historico/i.test(s)) {
        updates.push({ sql: s, params });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    },
  };
}

const RESULTS = {
  "11111111111": { availability: "OK", status: "FOUND", found: true, queryId: "q1", validUntil: "2026-10-14", lastSeenAt: "2026-07-01T00:00:00Z", displayName: "CARLEANDRO WAGNER" },
  "22222222222": { availability: "OK", status: "NOT_FOUND", found: false },
  "33333333333": { availability: "UNAVAILABLE", status: "UNAVAILABLE" },
};
const lookup = async (cpf) => RESULTS[cpf] ?? { availability: "UNAVAILABLE", status: "UNAVAILABLE" };

describe("revalidateDriversAngellira", () => {
  it("FOUND grava data fresca; NOT_FOUND zera; UNAVAILABLE não grava", async () => {
    const db = makeDb([{ cpf: "11111111111", nome: "A" }, { cpf: "22222222222", nome: "B" }, { cpf: "33333333333", nome: "C" }]);
    const syncDriver = vi.fn().mockResolvedValue({ updated: true });

    const summary = await revalidateDriversAngellira({ db, lookup, syncDriver, limit: 10, staleHours: null, concurrency: 2 });

    expect(summary).toEqual({ checked: 3, found: 1, notFound: 1, unavailable: 1 });

    // UNAVAILABLE (333) NUNCA gera UPDATE (não rebaixa dado bom).
    expect(db.updates.some((u) => u.params[0] === "33333333333")).toBe(false);

    // FOUND (111): UPDATE com limit_date = validUntil (param $4).
    const found = db.updates.find((u) => u.params[0] === "11111111111");
    expect(found).toBeTruthy();
    expect(found.params[3]).toBe("2026-10-14");

    // NOT_FOUND (222): UPDATE que zera (só o CPF nos params).
    const notFound = db.updates.find((u) => u.params[0] === "22222222222");
    expect(notFound).toBeTruthy();
    expect(notFound.params).toHaveLength(1);
    expect(notFound.sql).toMatch(/angellira_limit_date\s*=\s*NULL/i);

    // driver_profiles só é sincronizado no FOUND.
    expect(syncDriver).toHaveBeenCalledTimes(1);
    expect(syncDriver.mock.calls[0][0].documentNumber).toBe("11111111111");
  });

  it("aplica filtro de frescor (staleHours) e teto (limit) no SELECT", async () => {
    const db = makeDb([]);
    await revalidateDriversAngellira({ db, lookup, syncDriver: vi.fn(), limit: 50, staleHours: 20, concurrency: 1 });
    const sel = db.selects[0];
    expect(sel.sql).toMatch(/updated_at\s*<\s*now\(\)\s*-/i);
    expect(sel.params).toContain(20);
    expect(sel.params).toContain(50);
  });

  it("staleHours=null e limit=null revalidam a base inteira (sem filtros)", async () => {
    const db = makeDb([]);
    await revalidateDriversAngellira({ db, lookup, syncDriver: vi.fn(), limit: null, staleHours: null });
    const sel = db.selects[0];
    expect(sel.sql).not.toMatch(/updated_at\s*<\s*now/i);
    expect(sel.sql).not.toMatch(/LIMIT\s+\$/i); // cláusula LIMIT $n (não a coluna angellira_limit_date)
    expect(sel.params).toHaveLength(0);
  });
});

describe("revalidateDriverAngelliraByCpf", () => {
  it("CPF vazio → SKIP, sem consulta", async () => {
    const db = makeDb([]);
    const lookupSpy = vi.fn();
    const r = await revalidateDriverAngelliraByCpf(db, "", { lookup: lookupSpy });
    expect(r.status).toBe("SKIP");
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("lookup que lança → UNAVAILABLE, sem UPDATE", async () => {
    const db = makeDb([]);
    const r = await revalidateDriverAngelliraByCpf(db, "44444444444", {
      lookup: async () => { throw new Error("timeout"); },
      syncDriver: vi.fn(),
    });
    expect(r.status).toBe("UNAVAILABLE");
    expect(db.updates).toHaveLength(0);
  });
});
