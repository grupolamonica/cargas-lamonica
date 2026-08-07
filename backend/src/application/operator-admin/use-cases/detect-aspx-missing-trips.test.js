import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

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

  // ─── Carona: aceite OBSERVADO ────────────────────────────────────────────────
  // O job já olha o SPX ao vivo pelas mesmas viagens; grava o aceite como FATO
  // OBSERVADO. Regra que rege tudo aqui: só carimba "checado" com resposta
  // conclusiva — desconhecido e ausente não são evidência, e sem checked_at o
  // Monitor NÃO esconde a linha.
  describe("aceite observado", () => {
    afterEach(() => {
      delete process.env.SPX_ACCEPTANCE_OBSERVE_ENABLED;
      delete process.env.SPX_ACCEPTANCE_MAX_HIDE_ABS;
      delete process.env.SPX_ACCEPTANCE_MAX_HIDE_RATIO;
      delete process.env.SPX_ACCEPTANCE_OBSERVE_PAST_DAYS;
      delete process.env.SPX_ACCEPTANCE_RESTAMP_MINUTES;
      delete process.env.ASPX_MISSING_MIN_INDEX_TRIPS;
    });

    /** Índice com o aceite por viagem: { "LT-1": true | false | null }. */
    const indexAceite = (porNumero, { partial = false, truncated = false, byRoute = new Map() } = {}) =>
      async () => ({
        byNumber: new Map(
          Object.entries(porNumero).map(([n, accepted]) => [n, { statusName: "Assigning", driver: "", accepted }]),
        ),
        byRoute,
        truncated,
        partial,
      });

    const aceiteDe = async (id) =>
      (
        await query(
          "SELECT trip_accepted_at, trip_acceptance_checked_at, updated_at FROM public.cargas WHERE id = $1",
          [id],
        )
      ).rows[0];

    it("viagem ACEITA no índice: carimba o aceite e a observação", async () => {
      const carga = await seedLaunched({ clienteId, lh: "LT-ACEITA" });

      const r = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ "LT-ACEITA": true, [ISCA]: null }) },
      });

      expect(r.acceptance).toMatchObject({ conclusivas: 1, aceitas: 1, gravadas: 1, novasAceitas: 1 });
      const a = await aceiteDe(carga.id);
      expect(a.trip_accepted_at).not.toBeNull();
      expect(a.trip_acceptance_checked_at).not.toBeNull();
    });

    it("viagem observada NÃO aceita: carimba só a observação (é ela que autoriza esconder)", async () => {
      const carga = await seedLaunched({ clienteId, lh: "LT-CRUA" });

      const r = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ "LT-CRUA": false, [ISCA]: null }) },
      });

      expect(r.acceptance).toMatchObject({ conclusivas: 1, aceitas: 0, gravadas: 1, novasAceitas: 0 });
      const a = await aceiteDe(carga.id);
      expect(a.trip_accepted_at).toBeNull();
      expect(a.trip_acceptance_checked_at).not.toBeNull();
    });

    it("aceite DESCONHECIDO não é evidência: não carimba nada (a linha continua visível)", async () => {
      const carga = await seedLaunched({ clienteId, lh: "LT-MUDA" });

      const r = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ "LT-MUDA": null, [ISCA]: null }) },
      });

      expect(r.acceptance.conclusivas).toBe(0);
      const a = await aceiteDe(carga.id);
      expect(a.trip_accepted_at).toBeNull();
      expect(a.trip_acceptance_checked_at).toBeNull();
    });

    it("viagem AUSENTE do índice não é observação (ausência é assunto do aspx_missing)", async () => {
      const carga = await seedLaunched({ clienteId, lh: "LT-SUMIDA" });

      const r = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ [ISCA]: true }) },
      });

      expect(r.marked).toBe(1); // o passo A fez o dele
      expect(r.acceptance.conclusivas).toBe(0);
      expect((await aceiteDe(carga.id)).trip_acceptance_checked_at).toBeNull();
    });

    it("não sobrescreve um trip_accepted_at que já existe (o carimbo antigo é o honesto)", async () => {
      const carga = await seedLaunched({ clienteId, lh: "LT-ACEITA" });
      await query(
        "UPDATE public.cargas SET trip_accepted_at = now() - interval '3 days' WHERE id = $1",
        [carga.id],
      );
      const antes = (await aceiteDe(carga.id)).trip_accepted_at;

      await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ "LT-ACEITA": true, [ISCA]: null }) },
      });

      const a = await aceiteDe(carga.id);
      expect(String(a.trip_accepted_at)).toBe(String(antes));
      expect(a.trip_acceptance_checked_at).not.toBeNull(); // a observação, essa sim, é nova
    });

    it("idempotente: o 2º ciclo não reescreve a linha já convergida (nada de dead tuple/realtime)", async () => {
      const carga = await seedLaunched({ clienteId, lh: "LT-ACEITA" });
      const idx = indexAceite({ "LT-ACEITA": true, [ISCA]: null });
      await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: idx } });
      const depoisDoPrimeiro = await aceiteDe(carga.id);

      const r2 = await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: idx } });

      expect(r2.acceptance).toMatchObject({ conclusivas: 1, gravadas: 0, novasAceitas: 0 });
      const agora = await aceiteDe(carga.id);
      expect(String(agora.trip_accepted_at)).toBe(String(depoisDoPrimeiro.trip_accepted_at));
      expect(String(agora.trip_acceptance_checked_at)).toBe(String(depoisDoPrimeiro.trip_acceptance_checked_at));
      expect(String(agora.updated_at)).toBe(String(depoisDoPrimeiro.updated_at));
    });

    it("índice degradado (partial/truncated) não grava aceite nenhum", async () => {
      const carga = await seedLaunched({ clienteId, lh: "LT-ACEITA" });

      const parcial = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ "LT-ACEITA": true }, { partial: true }) },
      });
      const truncado = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ "LT-ACEITA": true }, { truncated: true }) },
      });

      expect(parcial.reason).toBe("partial_index");
      expect(truncado.reason).toBe("truncated_index");
      const a = await aceiteDe(carga.id);
      expect(a.trip_accepted_at).toBeNull();
      expect(a.trip_acceptance_checked_at).toBeNull();
    });

    it("kill-switch SPX_ACCEPTANCE_OBSERVE_ENABLED=false desliga a gravação (o resto do job segue)", async () => {
      process.env.SPX_ACCEPTANCE_OBSERVE_ENABLED = "false";
      const carga = await seedLaunched({ clienteId, lh: "LT-ACEITA" });
      const sumida = await seedLaunched({ clienteId, lh: "LT-SUMIDA" });

      const r = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ "LT-ACEITA": true, [ISCA]: null }) },
      });

      expect(r.acceptance.skipped).toBe("disabled");
      expect(r.marked).toBe(1); // a detecção de "sumiu do ASPX" continua funcionando
      expect((await stateOf(sumida.id)).aspx_missing_since).not.toBeNull();
      const a = await aceiteDe(carga.id);
      expect(a.trip_accepted_at).toBeNull();
      expect(a.trip_acceptance_checked_at).toBeNull();
    });

    // ─── Escopo próprio: a evidência não pode congelar quando a carga carrega ──
    // O passo A só olha "carregamento ainda por vir". Se o observador pegasse carona
    // nas rows dele, a carga que carrega hoje 10:00 sairia da observação às 10:01 e o
    // carimbo dela nunca mais seria revisto — e o read model, que trata evidência
    // velha como DESCONHECIDA (TTL 24h), faria a linha voltar sem ninguém rechecar.

    it("observa a carga cujo carregamento JÁ PASSOU, que o passo A ignora de propósito", async () => {
      const ontem = await seedLaunched({ clienteId, lh: "LT-ONTEM-ACEITA", data: ONTEM });

      const r = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ "LT-ONTEM-ACEITA": true, [ISCA]: null }) },
      });

      expect(r.checked).toBe(0); // passo A: fora do recorte, como sempre foi
      expect(r.acceptance).toMatchObject({ conclusivas: 1, aceitas: 1, novasAceitas: 1 });
      const a = await aceiteDe(ontem.id);
      expect(a.trip_accepted_at).not.toBeNull();
      expect(a.trip_acceptance_checked_at).not.toBeNull();
    });

    it("respeita o horizonte para trás (carga velha sai da observação e sua evidência expira)", async () => {
      const velha = await seedLaunched({ clienteId, lh: "LT-VELHA", data: isoEmDias(-30) });

      const r = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ "LT-VELHA": false, [ISCA]: null }) },
      });

      expect(r.acceptance.conclusivas).toBe(0);
      expect((await aceiteDe(velha.id)).trip_acceptance_checked_at).toBeNull();

      // Configurável: com horizonte maior a mesma carga volta a ser observada.
      process.env.SPX_ACCEPTANCE_OBSERVE_PAST_DAYS = "60";
      const r2 = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ "LT-VELHA": false, [ISCA]: null }) },
      });
      expect(r2.acceptance.conclusivas).toBe(1);
      expect((await aceiteDe(velha.id)).trip_acceptance_checked_at).not.toBeNull();
    });

    it("horizonte com env VAZIA/inválida cai no default de 7 dias, não em zero", async () => {
      // `Number("")` é 0 e passa em `Number.isFinite`. Com o piso em 0, uma linha
      // `SPX_ACCEPTANCE_OBSERVE_PAST_DAYS=` deixada em branco no .env (o jeito mais
      // comum de "não configurar") encolhia a observação para "de hoje em diante" — e
      // some justamente a lançada que já carregou, que é a que mais importa aqui.
      const ontem = await seedLaunched({ clienteId, lh: "LT-ONTEM-VAZIA", data: ONTEM });

      for (const valor of ["", "   ", "abc", "-3"]) {
        process.env.SPX_ACCEPTANCE_OBSERVE_PAST_DAYS = valor;
        await query("UPDATE public.cargas SET trip_acceptance_checked_at = NULL WHERE id = $1", [ontem.id]);

        const r = await detectAspxMissingTrips({
          deps: { withPgClient, fetchTripIndex: indexAceite({ "LT-ONTEM-VAZIA": false, [ISCA]: null }) },
        });

        expect(r.acceptance.conclusivas, `valor ${JSON.stringify(valor)}`).toBe(1);
        expect((await aceiteDe(ontem.id)).trip_acceptance_checked_at).not.toBeNull();
      }

      // Quem quer mesmo "só de hoje em diante" escreve 0 — a intenção explícita vale.
      process.env.SPX_ACCEPTANCE_OBSERVE_PAST_DAYS = "0";
      const zero = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ "LT-ONTEM-VAZIA": false, [ISCA]: null }) },
      });
      expect(zero.acceptance.conclusivas).toBe(0);
    });

    it("ignora lançada mergeada na gêmea (o Monitor também não a mostra)", async () => {
      const mergeada = await seedLaunched({ clienteId, lh: "LT-MERGEADA" });
      await query(
        "UPDATE public.cargas SET alloc_merged_into_cargo_id = $1 WHERE id = $1",
        [mergeada.id],
      );

      const r = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ "LT-MERGEADA": false, [ISCA]: null }) },
      });

      expect(r.acceptance.conclusivas).toBe(0);
      expect((await aceiteDe(mergeada.id)).trip_acceptance_checked_at).toBeNull();
    });

    it("REGRAVA a observação quando ela envelhece (60 min) — evidência eterna esconderia para sempre", async () => {
      const carga = await seedLaunched({ clienteId, lh: "LT-CRUA" });
      const idx = indexAceite({ "LT-CRUA": false, [ISCA]: null });
      await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: idx } });
      const primeira = (await aceiteDe(carga.id)).trip_acceptance_checked_at;

      // Dentro da janela: nada é reescrito (a cicatriz de bloat/egress manda).
      const dentro = await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: idx } });
      expect(dentro.acceptance.gravadas).toBe(0);
      expect(String((await aceiteDe(carga.id)).trip_acceptance_checked_at)).toBe(String(primeira));

      // Envelhecida além de 60 min: regravada, senão o read model (TTL 24h) passaria a
      // ler DESCONHECIDO para uma carga que continuamos observando a cada 10 min.
      await query(
        "UPDATE public.cargas SET trip_acceptance_checked_at = now() - interval '2 hours' WHERE id = $1",
        [carga.id],
      );
      const envelhecida = (await aceiteDe(carga.id)).trip_acceptance_checked_at;
      const fora = await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: idx } });

      expect(fora.acceptance.gravadas).toBe(1);
      expect(fora.acceptance.novasOcultacoes).toBe(0); // já estava escondida: não é ocultação nova
      const depois = (await aceiteDe(carga.id)).trip_acceptance_checked_at;
      expect(Date.parse(String(depois))).toBeGreaterThan(Date.parse(String(envelhecida)));
    });

    // ─── Disjuntor do ESCONDER ────────────────────────────────────────────────
    // Irmão do disjuntor de marcação em massa. O sinal "acceptance_status = 0 = não
    // aceita" nunca foi medido em produção; se o portal devolver 0 para as ~90
    // lançadas, a 1ª passada esconderia as 90 (o incidente do PR #457, agora com
    // carimbo no banco e rollback só por UPDATE manual).

    it("disjuntor: muitas ocultações novas de uma vez → não grava NADA e emite 1 aviso agregado", async () => {
      const cargas = [];
      for (let i = 0; i < 8; i += 1) cargas.push(await seedLaunched({ clienteId, lh: `LT-CRUA-${i}` }));
      const porNumero = Object.fromEntries(cargas.map((_, i) => [`LT-CRUA-${i}`, false]));

      const r = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ ...porNumero, [ISCA]: null }) },
      });

      // teto = max(5, floor(8 * 0.2)) = 5 → 8 ocultações abortam o ciclo inteiro.
      expect(r.acceptance).toMatchObject({
        conclusivas: 8, novasOcultacoes: 8, ocultacoesAbortadas: 8, gravadas: 0, skipped: "mass_hide_aborted",
      });
      for (const c of cargas) expect((await aceiteDe(c.id)).trip_acceptance_checked_at).toBeNull();
      const avisos = await notifications();
      expect(avisos).toHaveLength(1);
      expect(avisos[0].kind).toBe("spx_acceptance_mass_hide");
      expect(avisos[0].metadata.ocultacoes).toBe(8);
      expect(r.notified).toBe(1);

      // Não vira ruído: o ciclo seguinte aborta de novo, sem duplicar o sino.
      const r2 = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ ...porNumero, [ISCA]: null }) },
      });
      expect(r2.acceptance.ocultacoesAbortadas).toBe(8);
      expect(await notifications()).toHaveLength(1);
    });

    it("disjuntor segura TAMBÉM o carimbo de aceite do mesmo ciclo (sinal suspeito é suspeito inteiro)", async () => {
      const cruas = [];
      for (let i = 0; i < 8; i += 1) cruas.push(await seedLaunched({ clienteId, lh: `LT-CRUA-${i}` }));
      const aceita = await seedLaunched({ clienteId, lh: "LT-ACEITA" });
      const porNumero = Object.fromEntries(cruas.map((_, i) => [`LT-CRUA-${i}`, false]));

      const r = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ ...porNumero, "LT-ACEITA": true, [ISCA]: null }) },
      });

      expect(r.acceptance.skipped).toBe("mass_hide_aborted");
      // trip_accepted_at nunca é limpo: se a leitura do portal está sob suspeita, não é
      // hora de gravar fato permanente nenhum. O próximo ciclo (ou o teto ajustado
      // pelo operador) grava.
      expect((await aceiteDe(aceita.id)).trip_accepted_at).toBeNull();
    });

    it("teto configurável: com SPX_ACCEPTANCE_MAX_HIDE_ABS alto o operador libera a gravação", async () => {
      process.env.SPX_ACCEPTANCE_MAX_HIDE_ABS = "50";
      const cargas = [];
      for (let i = 0; i < 8; i += 1) cargas.push(await seedLaunched({ clienteId, lh: `LT-CRUA-${i}` }));
      const porNumero = Object.fromEntries(cargas.map((_, i) => [`LT-CRUA-${i}`, false]));

      const r = await detectAspxMissingTrips({
        deps: { withPgClient, fetchTripIndex: indexAceite({ ...porNumero, [ISCA]: null }) },
      });

      expect(r.acceptance).toMatchObject({ conclusivas: 8, novasOcultacoes: 8, gravadas: 8 });
      expect(r.acceptance.skipped).toBeUndefined();
      for (const c of cargas) expect((await aceiteDe(c.id)).trip_acceptance_checked_at).not.toBeNull();
      expect(await notifications()).toHaveLength(0);
    });

    // ─── Isolamento da carona ─────────────────────────────────────────────────
    // O try/catch da carona é vendido como a garantia de que ela nunca derruba o resto
    // do job. O ramo 42703 (coluna ainda não migrada) é EXATAMENTE o que roda em
    // produção entre o deploy e o migrate — precisa de teste, não de promessa.

    /** Client espião: registra todo SQL e falha os que casarem com `failOn`. */
    const spyPg = ({ failOn = null, code = null } = {}) => {
      const sqls = [];
      const run = async (cb) =>
        withPgClient(async (client) =>
          cb({
            query: async (text, params) => {
              sqls.push(String(text));
              if (failOn && failOn.test(String(text))) {
                const err = new Error("coluna inexistente (simulado)");
                if (code) err.code = code;
                throw err;
              }
              return client.query(text, params);
            },
          }),
        );
      return { run, sqls };
    };

    it("coluna ainda não migrada (42703): a carona pula e o resto do job segue intacto", async () => {
      process.env.ASPX_MISSING_MIN_INDEX_TRIPS = "1"; // deixa o passo B rodar de fato
      const sumida = await seedLaunched({ clienteId, lh: "LT-SUMIDA" });
      await seedLaunched({ clienteId, lh: "LT-PASSADA", data: ONTEM }); // dá trabalho ao passo B
      const spy = spyPg({ failOn: /trip_acceptance_checked_at/, code: "42703" });

      const r = await detectAspxMissingTrips({
        deps: {
          withPgClient: spy.run,
          fetchTripIndex: indexAceite({ [ISCA]: null }, { byRoute: new Map([["a/ba>b/ce", 1]]) }),
        },
      });

      expect(r.ok).toBe(true);
      expect(r.acceptance.skipped).toBe("column_missing");
      // O passo A marcou e avisou normalmente...
      expect(r.marked).toBe(1);
      expect((await stateOf(sumida.id)).aspx_missing_since).not.toBeNull();
      // ...e o passo B rodou DEPOIS da falha: a conexão não ficou inutilizável.
      expect(r.routes.skipped).toBeUndefined();
      const iFalha = spy.sqls.findIndex((s) => /trip_acceptance_checked_at/.test(s));
      expect(iFalha).toBeGreaterThanOrEqual(0);
      expect(spy.sqls.slice(iFalha + 1).length).toBeGreaterThan(0);
    });

    it("erro genérico na carona também não derruba o job (best-effort de verdade)", async () => {
      const sumida = await seedLaunched({ clienteId, lh: "LT-SUMIDA" });
      const spy = spyPg({ failOn: /trip_acceptance_checked_at/ });

      const r = await detectAspxMissingTrips({
        deps: { withPgClient: spy.run, fetchTripIndex: indexAceite({ [ISCA]: null }) },
      });

      expect(r.ok).toBe(true);
      expect(r.acceptance.skipped).toBe("failed");
      expect(r.marked).toBe(1);
      expect((await stateOf(sumida.id)).aspx_missing_since).not.toBeNull();
    });

    it("o job NÃO abre transação (senão o erro da carona deixaria a conexão em 25P02)", async () => {
      // withPgClient (e não withPgTransaction) é o que torna o try/catch da carona
      // suficiente: dentro de uma transação, o primeiro erro aborta tudo o que vier
      // depois. Isto hoje está certo — o teste tranca.
      await seedLaunched({ clienteId, lh: "LT-CRUA" });
      const spy = spyPg();

      await detectAspxMissingTrips({
        deps: { withPgClient: spy.run, fetchTripIndex: indexAceite({ "LT-CRUA": false, [ISCA]: null }) },
      });

      expect(spy.sqls.some((s) => /^\s*(BEGIN|START\s+TRANSACTION)/i.test(s))).toBe(false);
    });
  });
});
