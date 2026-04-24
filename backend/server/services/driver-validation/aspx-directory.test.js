import { beforeEach, describe, expect, it } from "vitest";

import { lookupAspxDriverByCpf, resetAspxDirectoryStateForTests } from "./aspx-directory.js";

/**
 * Stub mínimo do supabase-js: expõe .from().select().range() e devolve
 * rows configurados pelo teste (ou erro). Simula paginação suficiente para
 * uma única página (todas as fixtures < FETCH_PAGE_SIZE).
 */
function buildSupabaseStub({ rows = [], error = null } = {}) {
  return {
    from() {
      return {
        select() {
          return {
            range(from) {
              if (error) {
                return Promise.resolve({ data: null, error });
              }
              // Sempre devolve todas as linhas na primeira página, [] nas demais.
              if (from === 0) {
                return Promise.resolve({ data: rows, error: null });
              }
              return Promise.resolve({ data: [], error: null });
            },
          };
        },
      };
    },
  };
}

describe("aspx driver directory", () => {
  beforeEach(() => {
    resetAspxDirectoryStateForTests();
  });

  it("finds drivers by normalized CPF from the aspx_drivers table", async () => {
    resetAspxDirectoryStateForTests({
      supabaseClient: buildSupabaseStub({
        rows: [
          { cpf: "12345678901", display_name: "Motorista Atual" },
          { cpf: "99999999999", display_name: "Outro Motorista" },
        ],
      }),
    });

    const result = await lookupAspxDriverByCpf("123.456.789-01", {
      correlationId: "corr-aspx-found",
    });

    expect(result).toMatchObject({
      status: "FOUND",
      found: true,
      availability: "OK",
      displayName: "Motorista Atual",
    });
  });

  it("returns NOT_FOUND when the CPF is not registered", async () => {
    resetAspxDirectoryStateForTests({
      supabaseClient: buildSupabaseStub({
        rows: [{ cpf: "11122233344", display_name: "Motorista Alias" }],
      }),
    });

    const result = await lookupAspxDriverByCpf("00011122233", {
      correlationId: "corr-aspx-not-found",
    });

    expect(result).toMatchObject({
      status: "NOT_FOUND",
      found: false,
      availability: "OK",
      displayName: null,
    });
  });

  it("returns UNAVAILABLE instead of throwing when the supabase fetch fails", async () => {
    resetAspxDirectoryStateForTests({
      supabaseClient: buildSupabaseStub({
        error: { code: "500", message: "internal" },
      }),
    });

    const result = await lookupAspxDriverByCpf("12345678901", {
      correlationId: "corr-aspx-unavailable",
    });

    expect(result).toMatchObject({
      status: "UNAVAILABLE",
      found: false,
      availability: "UNAVAILABLE",
    });
  });
});
