import {
  collectMissingDriverClientIds,
  mergeDriverClientsIntoRows,
  type DriverClientBrief,
} from "@/lib/driverClients";

describe("driver client fallback helpers", () => {
  it("collects only client ids that are still missing the joined client payload", () => {
    expect(
      collectMissingDriverClientIds([
        {
          cliente_id: "client-1",
          cliente: null,
        },
        {
          cliente_id: "client-2",
          cliente: {
            id: "client-2",
            nome: "Cliente Resolvido",
            descricao: "Ja veio no join",
          },
        },
        {
          cliente_id: "client-1",
          cliente: null,
        },
        {
          cliente_id: null,
          cliente: null,
        },
      ]),
    ).toEqual(["client-1"]);
  });

  it("merges fallback clients without overwriting a client that already came in the join", () => {
    const shopee: DriverClientBrief = {
      id: "client-shopee",
      nome: "Shopee",
      descricao: "Cliente da planilha",
    };

    expect(
      mergeDriverClientsIntoRows(
        [
          {
            id: "cargo-1",
            cliente_id: "client-shopee",
            cliente: null,
          },
          {
            id: "cargo-2",
            cliente_id: "client-2",
            cliente: {
              id: "client-2",
              nome: "Cliente Original",
              descricao: "Mantem o join",
            },
          },
        ],
        new Map([["client-shopee", shopee]]),
      ),
    ).toEqual([
      {
        id: "cargo-1",
        cliente_id: "client-shopee",
        cliente: shopee,
      },
      {
        id: "cargo-2",
        cliente_id: "client-2",
        cliente: {
          id: "client-2",
          nome: "Cliente Original",
          descricao: "Mantem o join",
        },
      },
    ]);
  });
});
