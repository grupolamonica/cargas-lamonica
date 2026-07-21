import { beforeEach, describe, expect, it, vi } from "vitest";

// Diretório de operadores (id → nome) mockado — evita bater no Supabase auth.
const { dirMock } = vi.hoisted(() => ({ dirMock: vi.fn() }));
vi.mock("./audit-logs-read-model.js", () => ({ resolveOperatorDirectory: dirMock }));

const { attachRodoparStatus } = await import("./attach-rodopar-status.js");

// Client mínimo que imita o supabase-js usado por selectAllParallel:
//   .from(t).select(order, {count,head}) → { count }   (contagem)
//   .from(t).select(cols).order().range() → { data }    (página)
function makeClient(rows) {
  return {
    from() {
      return {
        select(_col, opts) {
          if (opts && opts.head) return Promise.resolve({ count: rows.length, error: null });
          const q = { order: () => q, range: () => Promise.resolve({ data: rows, error: null }) };
          return q;
        },
      };
    },
  };
}

describe("attachRodoparStatus (DC-260 — quem alterou)", () => {
  beforeEach(() => {
    dirMock.mockReset();
  });

  it("resolve status + quem alterou (nome do diretório) + quando, por LH", async () => {
    dirMock.mockResolvedValue(new Map([["op-1", { displayName: "Antonio Cesar", email: "antonio@x.com" }]]));
    const client = makeClient([
      { lh: "LH1", status: 1, updated_at: "2026-07-21T10:00:00Z", updated_by: "op-1" },
      { lh: "LH2", status: 0, updated_at: null, updated_by: null },
    ]);
    const items = [{ lh: "LH1" }, { lh: "LH2" }, { lh: "LH3" }, { lh: "reserva:1", reserva: true }];

    await attachRodoparStatus(client, items, "c1");

    expect(items[0]).toMatchObject({ rodoparStatus: 1, rodoparUpdatedBy: "Antonio Cesar", rodoparUpdatedAt: "2026-07-21T10:00:00Z" });
    // Registro sem updated_by → sem "quem".
    expect(items[1]).toMatchObject({ rodoparStatus: 0, rodoparUpdatedBy: null, rodoparUpdatedAt: null });
    // Sem registro → status 0, sem quem.
    expect(items[2]).toMatchObject({ rodoparStatus: 0, rodoparUpdatedBy: null, rodoparUpdatedAt: null });
    // Reserva é ignorada (não recebe campos de rodopar).
    expect(items[3].rodoparStatus).toBeUndefined();
  });

  it("cai para email e depois null quando o diretório não tem o operador", async () => {
    dirMock.mockResolvedValue(new Map([["op-email", { displayName: null, email: "so-email@x.com" }]]));
    const client = makeClient([
      { lh: "LH-EMAIL", status: 2, updated_at: "2026-07-20T12:00:00Z", updated_by: "op-email" },
      { lh: "LH-UNK", status: 1, updated_at: "2026-07-20T13:00:00Z", updated_by: "desconhecido" },
    ]);
    const items = [{ lh: "LH-EMAIL" }, { lh: "LH-UNK" }];

    await attachRodoparStatus(client, items);

    expect(items[0].rodoparUpdatedBy).toBe("so-email@x.com");
    expect(items[1].rodoparUpdatedBy).toBeNull(); // uuid fora do diretório → null
  });

  it("NÃO consulta o diretório quando nenhum registro tem updated_by", async () => {
    const client = makeClient([{ lh: "LH-A", status: 1, updated_at: "2026-07-20T09:00:00Z", updated_by: null }]);
    const items = [{ lh: "LH-A" }];

    await attachRodoparStatus(client, items);

    expect(dirMock).not.toHaveBeenCalled();
    expect(items[0]).toMatchObject({ rodoparStatus: 1, rodoparUpdatedBy: null });
  });

  it("best-effort: diretório falhando não quebra (quem fica null, status mantém)", async () => {
    dirMock.mockRejectedValue(new Error("auth down"));
    const client = makeClient([{ lh: "LH-Z", status: 2, updated_at: "2026-07-20T09:00:00Z", updated_by: "op-1" }]);
    const items = [{ lh: "LH-Z" }];

    await attachRodoparStatus(client, items);

    expect(items[0]).toMatchObject({ rodoparStatus: 2, rodoparUpdatedBy: null });
  });
});
