import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedCliente,
  withPgClient,
} from "../test-harness.js";
import { detectAspxMissingTrips } from "./detect-aspx-missing-trips.js";

// Índice do SPX (fetchTripIndex) — `byNumber` tem as viagens VIVAS no portal.
const fakeIndex = (numbers, { partial = false } = {}) =>
  async () => ({
    byNumber: new Map(numbers.map((n) => [n, { statusName: "Assigning", driver: "" }])),
    truncated: false,
    partial,
  });

// Índice vazio é tratado como "não confiável" (no-op) pelo use-case, então os casos
// de "a viagem sumiu" sempre carregam uma viagem-isca — como no portal real.
const ISCA = "LT1Q8102CLES1";
const deps = (numbers, extra = {}) => ({
  withPgClient,
  fetchTripIndex: fakeIndex([...numbers, ISCA]),
  ...extra,
});

// Datas relativas ao "hoje" real: o job só olha carga com carregamento AINDA POR VIR,
// então datas fixas fariam a suíte apodrecer com o passar do tempo.
const isoEmDias = (dias) => new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);
const AMANHA = isoEmDias(1);
const ONTEM = isoEmDias(-1);

/** Carga LANÇADA pela Programação: sheet_lh NULL + lh_manual = viagem "LT…". */
async function seedLaunched({ clienteId, lh, data = AMANHA, status = "OPEN", horario = "08:00:00" }) {
  const carga = await seedCargo({ cliente_id: clienteId, data, horario, status, sheet_lh: null });
  await query("UPDATE public.cargas SET lh_manual = $2 WHERE id = $1", [carga.id, lh]);
  return carga;
}

const stateOf = async (id) =>
  (
    await query(
      `SELECT status, lh_manual, aspx_missing_since, aspx_missing_lh, aspx_missing_notified_at
         FROM public.cargas WHERE id = $1`,
      [id],
    )
  ).rows[0];

const notifications = async () =>
  (await query("SELECT kind, title, body, metadata FROM public.operator_notifications ORDER BY created_at")).rows;

describe("detectAspxMissingTrips", () => {
  let clienteId;
  beforeEach(async () => {
    await resetTestDatabase();
    clienteId = (await seedCliente({ nome: "E-COMMERCE" })).id;
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("marca a carga, avisa o operador e NÃO apaga nem muda o status quando a viagem sai do ASPX", async () => {
    const carga = await seedLaunched({ clienteId, lh: "LT1Q8102CLEN1" });

    const r = await detectAspxMissingTrips({ deps: deps([]) });

    expect(r.ok).toBe(true);
    expect(r.checked).toBe(1);
    expect(r.marked).toBe(1);
    expect(r.notified).toBe(1);

    const state = await stateOf(carga.id);
    expect(state.aspx_missing_since).not.toBeNull();
    expect(state.aspx_missing_lh).toBe("LT1Q8102CLEN1");
    expect(state.aspx_missing_notified_at).not.toBeNull();
    // A carga continua no sistema, com o mesmo status — quem decide é o operador.
    expect(state.status).toBe("OPEN");
    expect(state.lh_manual).toBe("LT1Q8102CLEN1");

    const [aviso] = await notifications();
    expect(aviso.kind).toBe("aspx_trip_missing");
    expect(aviso.title).toContain("LT1Q8102CLEN1");
    expect(aviso.metadata.cargo_id).toBe(carga.id);
    expect(aviso.metadata.lh).toBe("LT1Q8102CLEN1");
  });

  it("não reavisa no ciclo seguinte (janela de re-aviso) e não duplica a marca", async () => {
    const carga = await seedLaunched({ clienteId, lh: "LT1Q8102CLEN1" });
    await detectAspxMissingTrips({ deps: deps([]) });
    const primeira = (await stateOf(carga.id)).aspx_missing_since;

    const r = await detectAspxMissingTrips({ deps: deps([]) });

    expect(r.marked).toBe(0);
    expect(r.renotified).toBe(0);
    expect(r.notified).toBe(0);
    expect((await notifications())).toHaveLength(1);
    expect(String((await stateOf(carga.id)).aspx_missing_since)).toBe(String(primeira));
  });

  it("re-avisa quando o último aviso passou da janela (avisar sempre)", async () => {
    const carga = await seedLaunched({ clienteId, lh: "LT1Q8102CLEN1" });
    await detectAspxMissingTrips({ deps: deps([]) });
    // Envelhece o último aviso em 7h (janela default = 6h).
    await query(
      "UPDATE public.cargas SET aspx_missing_notified_at = now() - interval '7 hours' WHERE id = $1",
      [carga.id],
    );

    const r = await detectAspxMissingTrips({ deps: deps([]) });

    expect(r.renotified).toBe(1);
    expect(r.marked).toBe(0);
    const avisos = await notifications();
    expect(avisos).toHaveLength(2);
    expect(avisos[1].kind).toBe("aspx_trip_missing");
    expect(avisos[1].metadata.renotify).toBe(true);
  });

  it("limpa a marca e avisa quando a viagem volta ao portal", async () => {
    const carga = await seedLaunched({ clienteId, lh: "LT1Q8102CLEN1" });
    await detectAspxMissingTrips({ deps: deps([]) });

    const r = await detectAspxMissingTrips({ deps: deps(["LT1Q8102CLEN1"]) });

    expect(r.cleared).toBe(1);
    const state = await stateOf(carga.id);
    expect(state.aspx_missing_since).toBeNull();
    expect(state.aspx_missing_lh).toBeNull();
    expect(state.aspx_missing_notified_at).toBeNull();
    const avisos = await notifications();
    expect(avisos.at(-1).kind).toBe("aspx_trip_restored");
  });

  it("não marca nada quando o índice do SPX vem incompleto ou vazio (anti-falso-positivo)", async () => {
    const carga = await seedLaunched({ clienteId, lh: "LT1Q8102CLEN1" });

    const parcial = await detectAspxMissingTrips({
      deps: { withPgClient, fetchTripIndex: fakeIndex(["LT-OUTRA"], { partial: true }) },
    });
    expect(parcial.ok).toBe(false);
    expect(parcial.reason).toBe("partial_index");

    const vazio = await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: fakeIndex([]) } });
    expect(vazio.ok).toBe(false);
    expect(vazio.reason).toBe("empty_index");

    expect((await stateOf(carga.id)).aspx_missing_since).toBeNull();
    expect(await notifications()).toHaveLength(0);
  });

  it("disjuntor: índice degradado (quase tudo 'sumiu') não marca ninguém e emite 1 aviso agregado", async () => {
    // 8 cargas lançadas, nenhuma no índice → acima do limite (max(5, 30%)) → aborta.
    const cargas = [];
    for (let i = 0; i < 8; i += 1) {
      cargas.push(await seedLaunched({ clienteId, lh: `LT-MASSA-${i}` }));
    }

    const r = await detectAspxMissingTrips({ deps: deps([]) });

    expect(r.ok).toBe(true);
    expect(r.checked).toBe(8);
    expect(r.marked).toBe(0);
    expect(r.massMarkAborted).toBe(8);
    for (const c of cargas) {
      expect((await stateOf(c.id)).aspx_missing_since).toBeNull();
    }
    const avisos = await notifications();
    expect(avisos).toHaveLength(1);
    expect(avisos[0].metadata.bulk).toBe(true);
    expect(avisos[0].title).toContain("8 cargas");

    // Não repete o agregado no ciclo seguinte (dedup pela janela de re-aviso).
    const r2 = await detectAspxMissingTrips({ deps: deps([]) });
    expect(r2.massMarkAborted).toBe(8);
    expect(r2.notified).toBe(0);
    expect(await notifications()).toHaveLength(1);
  });

  it("disjuntor não atrapalha o caso normal: poucas viagens sumidas são marcadas", async () => {
    const somem = [await seedLaunched({ clienteId, lh: "LT-SOME-1" }), await seedLaunched({ clienteId, lh: "LT-SOME-2" })];
    const ficam = [];
    for (let i = 0; i < 8; i += 1) ficam.push(await seedLaunched({ clienteId, lh: `LT-VIVA-${i}` }));

    const r = await detectAspxMissingTrips({ deps: deps(ficam.map((_, i) => `LT-VIVA-${i}`)) });

    expect(r.checked).toBe(10);
    expect(r.marked).toBe(2);
    expect(r.massMarkAborted).toBe(0);
    for (const c of somem) expect((await stateOf(c.id)).aspx_missing_since).not.toBeNull();
    for (const c of ficam) expect((await stateOf(c.id)).aspx_missing_since).toBeNull();
  });

  it("no-op quando o sidecar do SPX está fora do ar", async () => {
    const carga = await seedLaunched({ clienteId, lh: "LT1Q8102CLEN1" });

    const r = await detectAspxMissingTrips({
      deps: {
        withPgClient,
        fetchTripIndex: async () => {
          throw new Error("sidecar down");
        },
      },
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe("spx_unavailable");
    expect((await stateOf(carga.id)).aspx_missing_since).toBeNull();
  });

  it("ignora carga da planilha, Nestlé/manual e template (só viagem LT lançada)", async () => {
    const planilha = await seedCargo({ cliente_id: clienteId, sheet_lh: "LT1Q8102CLEN1", data: AMANHA });
    const nestle = await seedLaunched({ clienteId, lh: "NESTLE-B101462743" });
    const template = await seedCargo({ cliente_id: clienteId, data: AMANHA, is_template: true });
    await query("UPDATE public.cargas SET lh_manual = 'LT1Q8102CLZZ1' WHERE id = $1", [template.id]);

    const r = await detectAspxMissingTrips({ deps: deps(["LT-OUTRA"]) });

    expect(r.checked).toBe(0);
    expect(r.marked).toBe(0);
    for (const c of [planilha, nestle, template]) {
      expect((await stateOf(c.id)).aspx_missing_since).toBeNull();
    }
  });

  it("ignora carga cujo carregamento JÁ PASSOU (presença dependeria da aba Concluído)", async () => {
    // Ontem e um dia bem antigo: a carga já rodou — histórico, não é acionável, e
    // provar ausência dependeria da janela/paginação do Concluído (falso positivo).
    const ontem = await seedLaunched({ clienteId, lh: "LT-ONTEM-1", data: ONTEM });
    const antiga = await seedLaunched({ clienteId, lh: "LT-ANTIGA-1", data: "2025-01-10" });

    const r = await detectAspxMissingTrips({ deps: deps(["LT-OUTRA"]) });

    expect(r.checked).toBe(0);
    expect((await stateOf(ontem.id)).aspx_missing_since).toBeNull();
    expect((await stateOf(antiga.id)).aspx_missing_since).toBeNull();
  });

  it("ignora carga já expirada (não está no Monitor nem em /cargas — avisar é ruído)", async () => {
    const expirada = await seedLaunched({ clienteId, lh: "LT-EXPIRADA-1", status: "EXPIRED" });

    const r = await detectAspxMissingTrips({ deps: deps(["LT-OUTRA"]) });

    expect(r.checked).toBe(0);
    expect((await stateOf(expirada.id)).aspx_missing_since).toBeNull();
  });

  it("no-op quando o portal TRUNCOU a resposta (índice incompleto)", async () => {
    const carga = await seedLaunched({ clienteId, lh: "LT1Q8102CLEN1" });

    const r = await detectAspxMissingTrips({
      deps: {
        withPgClient,
        fetchTripIndex: async () => ({
          byNumber: new Map([["LT-OUTRA", { statusName: "Assigning", driver: "" }]]),
          truncated: true,
          partial: false,
        }),
      },
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toBe("truncated_index");
    expect((await stateOf(carga.id)).aspx_missing_since).toBeNull();
  });

  it("ignora carga já cancelada pelo operador", async () => {
    const cancelada = await seedLaunched({ clienteId, lh: "LT1Q8102CLEN1", status: "CANCELLED" });

    const r = await detectAspxMissingTrips({ deps: deps(["LT-OUTRA"]) });

    expect(r.checked).toBe(0);
    expect((await stateOf(cancelada.id)).aspx_missing_since).toBeNull();
  });
});
