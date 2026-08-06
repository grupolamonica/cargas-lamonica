import { describe, expect, it } from "vitest";

import { fetchTripIndex } from "./spx-allocation-client.js";

// `fetchImpl` falso: devolve as viagens da ABA (query_type) pedida na URL. É por aba
// que o aceite se decide, então o fake precisa distinguir uma da outra.
function fakeFetch(porAba) {
  return async (url) => ({
    ok: true,
    json: async () => ({ trips: porAba[Number(new URL(url).searchParams.get("query_type"))] ?? [] }),
  });
}

const viagem = (num, over = {}) => ({
  trip_number: num,
  trip_id: 501,
  trip_status: 2,
  trip_status_name: "Assigning",
  driver_name: "",
  origem: "LM Hub_BA_Simoes Filho",
  destino: "SoC_CE_Juazeiro do Norte",
  ...over,
});

const index = (porAba, params = {}) => fetchTripIndex(params, { fetchImpl: fakeFetch(porAba) });

describe("fetchTripIndex — aceite observado por aba", () => {
  it("Planejado(1): acceptance_status 1 = aceita, 0 = NÃO aceita, ausente = desconhecido", async () => {
    const { byNumber } = await index({
      1: [
        viagem("LT-ACEITA", { acceptance_status: 1 }),
        viagem("LT-CRUA", { acceptance_status: 0 }),
        viagem("LT-MUDA"), // sidecar não devolveu o campo
      ],
      2: [],
    });

    expect(byNumber.get("LT-ACEITA").accepted).toBe(true);
    expect(byNumber.get("LT-CRUA").accepted).toBe(false);
    // Desconhecido é null — e é ESSE estado que impede o job de carimbar "checado".
    expect(byNumber.get("LT-MUDA").accepted).toBeNull();
  });

  it("Aceito(2) é aceite por si só, e Concluído(3) só quando a viagem CONCLUIU de verdade", async () => {
    const { byNumber } = await index(
      {
        1: [],
        2: [viagem("LT-NA-ABA-ACEITO")],
        // TRIP_STATUS do sidecar: 90 = Completed (rodou), 100 = Cancelled.
        3: [viagem("LT-CONCLUIDA", { trip_status: 90 })],
      },
      { includeConcluido: true },
    );

    expect(byNumber.get("LT-NA-ABA-ACEITO").accepted).toBe(true);
    expect(byNumber.get("LT-CONCLUIDA").accepted).toBe(true);
  });

  it("Concluído(3) CANCELADA nunca vira aceite — nem quando o portal omite o acceptance_status", async () => {
    // A aba Concluído é o /trip/history/list e devolve Completed E Cancelled juntas. O
    // `if (qt === 3) return true` original gravava trip_accepted_at (campo que NUNCA é
    // limpo) para viagem cancelada que talvez jamais tenha sido aceita — o mesmo erro
    // das 270 marcas fabricadas que a migration 20260806150000 documenta.
    const { byNumber } = await index(
      {
        1: [],
        2: [],
        3: [
          viagem("LT-CANCELADA-CRUA", { trip_status: 100, acceptance_status: 0 }),
          viagem("LT-CANCELADA-MUDA", { trip_status: 100 }), // sem acceptance_status
          viagem("LT-CANCELADA-ACEITA", { trip_status: 100, acceptance_status: 1 }),
          viagem("LT-STATUS-ESTRANHO", { trip_status: 70 }), // nem Completed nem Cancelled
        ],
      },
      { includeConcluido: true },
    );

    // Sinal explícito do portal manda: cancelada sem aceite é NÃO aceita.
    expect(byNumber.get("LT-CANCELADA-CRUA").accepted).toBe(false);
    // Sem sinal explícito e sem conclusão real: DESCONHECIDO (nunca `true`).
    expect(byNumber.get("LT-CANCELADA-MUDA").accepted).toBeNull();
    expect(byNumber.get("LT-STATUS-ESTRANHO").accepted).toBeNull();
    // Cancelada DEPOIS de aceita continua sendo aceite observado.
    expect(byNumber.get("LT-CANCELADA-ACEITA").accepted).toBe(true);
  });

  it("promoção MONOTÔNICA: Planejado(0) + Aceito promove p/ aceita (a 1ª aba não nega a 2ª)", async () => {
    // O dedup faz a primeira aba vencer, e a Planejado vem ANTES da Aceito. Sem a
    // promoção, esta viagem ficaria accepted=false — negando a prova da aba Aceito.
    const { byNumber } = await index({
      1: [viagem("LT-DUPLA", { acceptance_status: 0, driver_name: "JOAO" })],
      2: [viagem("LT-DUPLA", { driver_name: "MARIA", trip_status_name: "Assigned" })],
    });

    const e = byNumber.get("LT-DUPLA");
    expect(e.accepted).toBe(true);
    // Só o ACEITE sobe: o resto do registro continua sendo o da primeira aba.
    expect(e.driver).toBe("JOAO");
    expect(e.statusName).toBe("Assigning");
  });

  it("o aceite nunca DESCE: viagem aceita na Planejado não é rebaixada por aba posterior", async () => {
    const { byNumber } = await index(
      {
        1: [viagem("LT-JA-ACEITA", { acceptance_status: 1 })],
        2: [],
        // Mesma viagem no histórico como CANCELADA e com acceptance_status 0: o dedup
        // é monotônico, então o `false` da aba posterior não apaga a prova da anterior.
        3: [viagem("LT-JA-ACEITA", { trip_status: 100, acceptance_status: 0 })],
      },
      { includeConcluido: true },
    );

    expect(byNumber.get("LT-JA-ACEITA").accepted).toBe(true);
  });

  it("dedup segue contando a rota UMA vez (byRoute não infla com a viagem repetida)", async () => {
    const { byRoute, byNumber, truncated, partial } = await index({
      1: [viagem("LT-DUPLA", { acceptance_status: 0 })],
      2: [viagem("LT-DUPLA")],
    });

    expect(byNumber.size).toBe(1);
    expect(byRoute.get("simoes filho/ba>juazeiro do norte/ce")).toBe(1);
    expect(truncated).toBe(false);
    expect(partial).toBe(false);
  });

  it("aba que falha não derruba o índice, mas marca partial (contrato preservado)", async () => {
    const fetchImpl = async (url) => {
      if (Number(new URL(url).searchParams.get("query_type")) === 1) throw new Error("portal fora");
      return { ok: true, json: async () => ({ trips: [viagem("LT-VIVA")] }) };
    };

    const r = await fetchTripIndex({}, { fetchImpl });

    expect(r.partial).toBe(true);
    expect(r.byNumber.get("LT-VIVA").accepted).toBe(true);
  });
});
