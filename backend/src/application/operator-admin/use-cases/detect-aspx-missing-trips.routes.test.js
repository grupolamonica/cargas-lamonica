import crypto from "node:crypto";

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

// PASSO B — rota retirada do ASPX (cobre carga com carregamento JÁ PASSADO, que o
// passo A ignora de propósito).

const isoEmDias = (dias) => new Date(Date.now() + dias * 86_400_000).toISOString().slice(0, 10);
const ROTA = { origem: "Simoes Filho/BA", destino: "Itaitinga/CE" };
const ROTA_KEY = "simoes filho/ba>itaitinga/ce";

// Índice do portal com agrupamento por rota. O piso de saúde exige >= 100 viagens no
// índice, então enchemos com viagens de OUTRA rota (como no portal real).
const indexComRotas = ({ vivas = [], rotasVivas = {}, enchimento = 120 } = {}) =>
  async () => {
    const byNumber = new Map(vivas.map((n) => [n, { statusName: "Assigning", driver: "" }]));
    for (let i = 0; i < enchimento; i += 1) {
      byNumber.set(`LT-ENCHE-${i}`, { statusName: "Assigning", driver: "" });
    }
    const byRoute = new Map(Object.entries(rotasVivas));
    byRoute.set("outra origem/xx>outro destino/yy", enchimento);
    return { byNumber, byRoute, truncated: false, partial: false };
  };

const stateOf = async (id) =>
  (
    await query(
      `SELECT status, aspx_missing_since, aspx_missing_lh, aspx_missing_reason, aspx_missing_notified_at
         FROM public.cargas WHERE id = $1`,
      [id],
    )
  ).rows[0];

const notifications = async () =>
  (await query("SELECT kind, title, body, metadata FROM public.operator_notifications ORDER BY created_at")).rows;

const rotaState = async () =>
  (await query("SELECT route_key, loads_count, first_absent_at, notified_at FROM public.aspx_route_absence")).rows;

/** Envelhece a observação da rota além da janela de confirmação (default 6h). */
const envelheceObservacao = () =>
  query("UPDATE public.aspx_route_absence SET first_absent_at = now() - interval '7 hours'");

describe("detectAspxMissingTrips — passo B (rota retirada do ASPX)", () => {
  let clienteId;

  async function seedPassada({ lh, dias = 3, motorista = null, reservaLead = null, rota = ROTA }) {
    const carga = await seedCargo({
      cliente_id: clienteId,
      data: isoEmDias(-dias),
      horario: "08:00:00",
      status: "OPEN",
      sheet_lh: null,
    });
    await query(
      `UPDATE public.cargas
          SET lh_manual = $2, origem = $3, destino = $4, alloc_motorista = $5, reserved_public_lead_id = $6
        WHERE id = $1`,
      [carga.id, lh, rota.origem, rota.destino, motorista, reservaLead],
    );
    return carga;
  }

  async function seedFutura({ lh }) {
    const carga = await seedCargo({
      cliente_id: clienteId,
      data: isoEmDias(2),
      horario: "08:00:00",
      status: "OPEN",
      sheet_lh: null,
    });
    await query("UPDATE public.cargas SET lh_manual = $2 WHERE id = $1", [carga.id, lh]);
    return carga;
  }

  beforeEach(async () => {
    await resetTestDatabase();
    clienteId = (await seedCliente({ nome: "E-COMMERCE" })).id;
    process.env.ASPX_MISSING_ROUTE_DRYRUN = "false"; // os testes exercitam o efeito real
  });

  afterAll(async () => {
    delete process.env.ASPX_MISSING_ROUTE_DRYRUN;
    await closeTestDatabase();
  });

  it("1º ciclo apenas OBSERVA; o seguinte marca e emite UM aviso por rota", async () => {
    const cargas = [];
    for (let i = 0; i < 4; i += 1) cargas.push(await seedPassada({ lh: `LT-ROTA-${i}` }));

    const c1 = await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: indexComRotas() } });
    expect(c1.routes.observando).toBe(1);
    expect(c1.routes.rotasRemovidas).toBe(0);
    for (const c of cargas) expect((await stateOf(c.id)).aspx_missing_since).toBeNull();
    expect((await rotaState())[0].route_key).toBe(ROTA_KEY);
    expect(await notifications()).toHaveLength(0);

    await envelheceObservacao();
    const c2 = await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: indexComRotas() } });

    expect(c2.routes.rotasRemovidas).toBe(1);
    expect(c2.routes.cargasMarcadas).toBe(4);
    for (const c of cargas) {
      const st = await stateOf(c.id);
      expect(st.aspx_missing_since).not.toBeNull();
      expect(st.aspx_missing_reason).toBe("route_removed");
      expect(st.status).toBe("OPEN"); // política: nunca muda status
    }
    const avisos = await notifications();
    expect(avisos).toHaveLength(1); // UM por rota, não um por carga
    expect(avisos[0].kind).toBe("aspx_route_missing");
    expect(avisos[0].title).toContain("Itaitinga/CE");
    expect(avisos[0].metadata.cargas).toBe(4);
    expect(avisos[0].metadata.marcadas).toBe(4);
  });

  it("NÃO marca carga com motorista ou reserva — preserva e conta no aviso", async () => {
    const livres = [await seedPassada({ lh: "LT-LIVRE-1" }), await seedPassada({ lh: "LT-LIVRE-2" })];
    const comMotorista = await seedPassada({ lh: "LT-MOT-1", motorista: "JOAO SILVA" });
    const comReserva = await seedPassada({ lh: "LT-RES-1", reservaLead: crypto.randomUUID() });

    await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: indexComRotas() } });
    await envelheceObservacao();
    const r = await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: indexComRotas() } });

    expect(r.routes.cargasMarcadas).toBe(2);
    expect(r.routes.cargasPreservadas).toBe(2);
    for (const c of livres) expect((await stateOf(c.id)).aspx_missing_since).not.toBeNull();
    expect((await stateOf(comMotorista.id)).aspx_missing_since).toBeNull();
    expect((await stateOf(comReserva.id)).aspx_missing_since).toBeNull();
    expect((await notifications()).at(-1).metadata.preservadas).toBe(2);
  });

  it("rota que ainda tem viagem no portal nunca entra no passo B, mesmo com carregamento passado", async () => {
    const cargas = [];
    for (let i = 0; i < 4; i += 1) cargas.push(await seedPassada({ lh: `LT-VIVA-${i}` }));

    const idx = indexComRotas({ rotasVivas: { [ROTA_KEY]: 3 } });
    await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: idx } });
    const r = await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: idx } });

    expect(r.routes.rotasRemovidas).toBe(0);
    expect(r.routes.observando).toBe(0);
    for (const c of cargas) expect((await stateOf(c.id)).aspx_missing_since).toBeNull();
    expect(await rotaState()).toHaveLength(0);
  });

  it("dry-run: avisa e loga, mas NÃO marca nenhuma carga", async () => {
    process.env.ASPX_MISSING_ROUTE_DRYRUN = "true";
    const cargas = [];
    for (let i = 0; i < 4; i += 1) cargas.push(await seedPassada({ lh: `LT-DRY-${i}` }));

    await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: indexComRotas() } });
    await envelheceObservacao();
    const r = await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: indexComRotas() } });

    expect(r.routes.rotasRemovidas).toBe(1);
    expect(r.routes.cargasMarcadas).toBe(0);
    expect(r.routes.dryRun).toBe(true);
    for (const c of cargas) expect((await stateOf(c.id)).aspx_missing_since).toBeNull();
    const aviso = (await notifications()).at(-1);
    expect(aviso.metadata.dry_run).toBe(true);
    expect(aviso.body).toContain("OBSERVAÇÃO");
  });

  it("rota que volta ao portal limpa as marcas de route_removed e avisa", async () => {
    const cargas = [];
    for (let i = 0; i < 4; i += 1) cargas.push(await seedPassada({ lh: `LT-VOLTA-${i}` }));
    await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: indexComRotas() } });
    await envelheceObservacao();
    await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: indexComRotas() } });
    for (const c of cargas) expect((await stateOf(c.id)).aspx_missing_since).not.toBeNull();

    const vivas = cargas.map((_, i) => `LT-VOLTA-${i}`);
    const r = await detectAspxMissingTrips({
      deps: { withPgClient, fetchTripIndex: indexComRotas({ vivas, rotasVivas: { [ROTA_KEY]: 4 } }) },
    });

    expect(r.routes.restauradas).toBe(4);
    for (const c of cargas) {
      const st = await stateOf(c.id);
      expect(st.aspx_missing_since).toBeNull();
      expect(st.aspx_missing_reason).toBeNull();
    }
    expect(await rotaState()).toHaveLength(0);
    expect((await notifications()).some((n) => n.kind === "aspx_route_restored")).toBe(true);
  });

  it("marca NÃO fica presa se o estado da rota for perdido: portal presente limpa mesmo sem observação", async () => {
    const cargas = [];
    for (let i = 0; i < 4; i += 1) cargas.push(await seedPassada({ lh: `LT-ORFA-${i}` }));
    await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: indexComRotas() } });
    await envelheceObservacao();
    await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: indexComRotas() } });
    // Simula perda do estado (linha da rota apagada / banco restaurado).
    await query("DELETE FROM public.aspx_route_absence");

    const r = await detectAspxMissingTrips({
      deps: { withPgClient, fetchTripIndex: indexComRotas({ rotasVivas: { [ROTA_KEY]: 2 } }) },
    });

    expect(r.routes.restauradas).toBe(4);
    for (const c of cargas) expect((await stateOf(c.id)).aspx_missing_since).toBeNull();
  });

  it("índice pequeno (portal degradado) não deixa o passo B rodar", async () => {
    const cargas = [];
    for (let i = 0; i < 4; i += 1) cargas.push(await seedPassada({ lh: `LT-PEQ-${i}` }));

    const r = await detectAspxMissingTrips({
      deps: { withPgClient, fetchTripIndex: indexComRotas({ enchimento: 10 }) },
    });

    expect(r.routes.skipped).toBe("index_too_small");
    for (const c of cargas) expect((await stateOf(c.id)).aspx_missing_since).toBeNull();
  });

  it("kill-switch desliga o passo B sem afetar o passo A", async () => {
    process.env.ASPX_MISSING_ROUTE_ENABLED = "false";
    try {
      const passada = await seedPassada({ lh: "LT-OFF-1" });
      for (let i = 0; i < 3; i += 1) await seedPassada({ lh: `LT-OFF-${i + 2}` });
      const futura = await seedFutura({ lh: "LT-FUTURA-1" });

      const r = await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: indexComRotas() } });

      expect(r.routes.skipped).toBe("disabled");
      expect((await stateOf(passada.id)).aspx_missing_since).toBeNull();
      // passo A segue intacto: carga futura ausente é marcada individualmente
      expect((await stateOf(futura.id)).aspx_missing_since).not.toBeNull();
      expect((await stateOf(futura.id)).aspx_missing_reason).toBeNull();
    } finally {
      delete process.env.ASPX_MISSING_ROUTE_ENABLED;
    }
  });

  it("respeita o teto de rotas por ciclo (a maior primeiro; o resto no próximo tick)", async () => {
    process.env.ASPX_MISSING_MAX_ROUTES_PER_RUN = "1";
    try {
      for (let i = 0; i < 5; i += 1) await seedPassada({ lh: `LT-R1-${i}` });
      const rota2 = { origem: "Salvador Retiro/BA", destino: "Maceio/AL" };
      for (let i = 0; i < 3; i += 1) await seedPassada({ lh: `LT-R2-${i}`, rota: rota2 });

      await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: indexComRotas() } });
      await envelheceObservacao();
      const r = await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: indexComRotas() } });

      expect(r.routes.rotasRemovidas).toBe(1);
      expect(r.routes.cargasMarcadas).toBe(5); // a rota maior primeiro
    } finally {
      delete process.env.ASPX_MISSING_MAX_ROUTES_PER_RUN;
    }
  });

  it("carga fora da janela para trás (mais antiga que ASPX_MISSING_PAST_DAYS) não é avaliada", async () => {
    const antiga = await seedPassada({ lh: "LT-ANTIGA-1", dias: 40 });
    for (let i = 0; i < 3; i += 1) await seedPassada({ lh: `LT-RECENTE-${i}`, dias: 2 });

    await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: indexComRotas() } });
    await envelheceObservacao();
    const r = await detectAspxMissingTrips({ deps: { withPgClient, fetchTripIndex: indexComRotas() } });

    expect(r.routes.cargasMarcadas).toBe(3);
    expect((await stateOf(antiga.id)).aspx_missing_since).toBeNull();
  });
});
