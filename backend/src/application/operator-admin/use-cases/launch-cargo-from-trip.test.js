import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedCargo,
  seedCliente,
  seedUser,
  withPgClient,
} from "../test-harness.js";

import { launchCargoFromTrip } from "./launch-cargo-from-trip.js";

const deps = { withPgClient };

// `cargas.data` chega como Date (UTC-midnight) no harness pg-mem e como string
// no Postgres real — normaliza p/ a data de PAREDE nos dois casos.
const dateOnly = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const timeOnly = (v) => String(v ?? "").slice(0, 5);

const validTrip = {
  lh: "LT1ABC",
  origem: "SAO PAULO SP",
  destino: "CAMPINAS SP",
  data: "2026-07-20",
  horario: "08:00",
};

describe("launchCargoFromTrip", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    delete process.env.GOOGLE_SHEET_DEFAULT_CLIENT_NAME; // findSheetClientId → "Shopee"
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("lança nova carga OPEN, LH em lh_manual (NÃO sheet_lh) + cliente Shopee", async () => {
    const cliente = await seedCliente({ nome: "Shopee" });
    const op = await seedUser({ email: "op-prog@test.local" });

    const res = await launchCargoFromTrip({ ...validTrip, operatorId: op.id, correlationId: "c1", deps });

    expect(res.statusCode).toBe(201);
    expect(res.payload.alreadyExists).toBe(false);

    const { rows } = await query(
      "SELECT sheet_lh, lh_manual, status, cliente_id, origem, destino, perfil, sheet_data_carregamento, sheet_synced_at, is_template, driver_visibility FROM public.cargas WHERE id = $1",
      [res.payload.id],
    );
    // LH vai em lh_manual; sheet_lh/sheet_synced_at ficam nulos (não é carga do sync).
    expect(rows[0].lh_manual).toBe("LT1ABC");
    expect(rows[0].sheet_lh).toBeNull();
    expect(rows[0].sheet_synced_at).toBeNull();
    expect(rows[0].status).toBe("OPEN");
    expect(rows[0].cliente_id).toBe(cliente.id);
    expect(rows[0].origem).toBe("SAO PAULO SP");
    expect(rows[0].perfil).toBe("CARRETA");
    expect(rows[0].sheet_data_carregamento).toBe("2026-07-20T08:00");
    expect(rows[0].is_template).toBe(false);
    expect(rows[0].driver_visibility).toBe("PUBLIC");
  });

  // A coluna nao era gravada, entao TODA carga lancada ficava com sheet_source NULL
  // e o write-back roteava por normSource(null) === 'shopee': "puxar reserva" /
  // "reverter" numa carga NESTLE lancada fazia POST na planilha da SHOPEE, que pode
  // ter linha com o mesmo LH (ha LH repetido entre as duas em producao).
  it("grava sheet_source='shopee' na carga lancada (roteia o write-back pela fonte)", async () => {
    await seedCliente({ nome: "Shopee" });
    const op = await seedUser({ email: "op-src-shopee@test.local" });

    const res = await launchCargoFromTrip({ ...validTrip, operatorId: op.id, correlationId: "c-src", deps });

    const { rows } = await query("SELECT sheet_source FROM public.cargas WHERE id = $1", [res.payload.id]);
    expect(rows[0].sheet_source).toBe("shopee");
  });

  // `accepted` governava SÓ o write-back da linha-casca e morria aqui: nada no banco
  // distinguia "ninguém aceitou" de "aceita, esperando motorista", e o Monitor exibia
  // as duas igual. `trip_accepted_at` é o que permite tirar a não-aceita da tela sem
  // levar junto o frete já comprometido com a agência.
  it("persiste o ACEITE da viagem em trip_accepted_at (e deixa NULL quando não aceita)", async () => {
    await seedCliente({ nome: "Shopee" });

    const naoAceita = await launchCargoFromTrip({ ...validTrip, correlationId: "c-acc-0", deps });
    const aceita = await launchCargoFromTrip({ ...validTrip, lh: "LT1XYZ", accepted: true, correlationId: "c-acc-1", deps });

    // pg-mem devolve coluna nula como undefined (o Postgres real devolve null).
    const read = async (id) =>
      (await query("SELECT trip_accepted_at FROM public.cargas WHERE id = $1", [id])).rows[0].trip_accepted_at ?? null;
    expect(await read(naoAceita.payload.id)).toBeNull();
    expect(await read(aceita.payload.id)).toBeInstanceOf(Date);
  });

  it("aceite é de mão única: relançar aceito MARCA, relançar não-aceito não desmarca", async () => {
    await seedCliente({ nome: "Shopee" });
    // pg-mem devolve coluna nula como undefined (o Postgres real devolve null).
    const read = async (id) =>
      (await query("SELECT trip_accepted_at FROM public.cargas WHERE id = $1", [id])).rows[0].trip_accepted_at ?? null;

    // Lançou o spot não-aceito…
    const first = await launchCargoFromTrip({ ...validTrip, correlationId: "c-acc-2", deps });
    expect(await read(first.payload.id)).toBeNull();

    // …aceitou e relançou: marca.
    await launchCargoFromTrip({ ...validTrip, accepted: true, correlationId: "c-acc-3", deps });
    const marcado = await read(first.payload.id);
    expect(marcado).toBeInstanceOf(Date);

    // A Programação relança quando a agenda muda; isso NÃO pode desfazer o aceite
    // (desfazer = a carga sumir do Monitor com o frete já comprometido).
    await launchCargoFromTrip({ ...validTrip, data: "2026-07-25", horario: "09:00", correlationId: "c-acc-4", deps });
    expect(await read(first.payload.id)).toEqual(marcado);
  });

  it("idempotente: carga da planilha (sheet_lh) com o mesmo LH → devolve a existente", async () => {
    await seedCliente({ nome: "Shopee" });
    const existing = await seedCargo({ sheet_lh: "LT1ABC", status: "OPEN", origem: "X", destino: "Y" });

    const res = await launchCargoFromTrip({ ...validTrip, correlationId: "c2", deps });

    expect(res.statusCode).toBe(200);
    expect(res.payload.alreadyExists).toBe(true);
    expect(res.payload.id).toBe(existing.id);

    const { rows } = await query("SELECT id FROM public.cargas WHERE sheet_lh = $1 OR lh_manual = $1", ["LT1ABC"]);
    expect(rows).toHaveLength(1);
  });

  it("idempotente: relançar o mesmo LH (lh_manual) não cria carga duplicada", async () => {
    await seedCliente({ nome: "Shopee" });
    const first = await launchCargoFromTrip({ ...validTrip, correlationId: "c3", deps });
    const second = await launchCargoFromTrip({ ...validTrip, correlationId: "c4", deps });

    expect(second.payload.alreadyExists).toBe(true);
    expect(second.payload.id).toBe(first.payload.id);
    const { rows } = await query("SELECT id FROM public.cargas WHERE lh_manual = $1", ["LT1ABC"]);
    expect(rows).toHaveLength(1);
  });

  it("relançar com agenda NOVA sincroniza data/horario junto com o rótulo", async () => {
    await seedCliente({ nome: "Shopee" });
    const first = await launchCargoFromTrip({ ...validTrip, correlationId: "c5", deps });
    // A viagem foi remarcada no portal: mesma LH, carregamento outro.
    const second = await launchCargoFromTrip({ ...validTrip, data: "2026-07-24", horario: "18:00", correlationId: "c6", deps });

    expect(second.payload.id).toBe(first.payload.id);
    expect(second.payload.updated).toBe(true);
    const { rows } = await query(
      "SELECT data, horario, sheet_data_carregamento, agenda_a_confirmar FROM public.cargas WHERE id = $1",
      [first.payload.id],
    );
    // As colunas canônicas (portal do motorista, expiração, ordenação) acompanham o
    // rótulo denormalizado — antes só o rótulo mudava e as duas divergiam.
    expect(dateOnly(rows[0].data)).toBe("2026-07-24");
    expect(timeOnly(rows[0].horario)).toBe("18:00");
    expect(rows[0].sheet_data_carregamento).toBe("2026-07-24T18:00");
  });

  it("relançar a carga 'a confirmar' com data real confirma a agenda inteira", async () => {
    await seedCliente({ nome: "Shopee" });
    const first = await launchCargoFromTrip({ ...validTrip, data: "", horario: "", deps });
    const { rows: antes } = await query("SELECT agenda_a_confirmar FROM public.cargas WHERE id = $1", [first.payload.id]);
    expect(antes[0].agenda_a_confirmar).toBe(true);

    await launchCargoFromTrip({ ...validTrip, data: "2026-07-28", horario: "07:30", deps });

    const { rows } = await query(
      "SELECT data, horario, sheet_data_carregamento, agenda_a_confirmar FROM public.cargas WHERE id = $1",
      [first.payload.id],
    );
    // A flag cai E o placeholder hoje/00:00 sai com ela: limpar só a flag deixava a
    // carga com data no passado e a tirava do portal do motorista.
    expect(rows[0].agenda_a_confirmar).toBe(false);
    expect(dateOnly(rows[0].data)).toBe("2026-07-28");
    expect(timeOnly(rows[0].horario)).toBe("07:30");
    expect(rows[0].sheet_data_carregamento).toBe("2026-07-28T07:30");
  });

  it("relançar SEM data (ainda 'a confirmar') NÃO mexe na agenda já confirmada pelo operador", async () => {
    await seedCliente({ nome: "Shopee" });
    const first = await launchCargoFromTrip({ ...validTrip, correlationId: "c7", deps });
    await launchCargoFromTrip({ ...validTrip, data: "", horario: "", deps });

    const { rows } = await query(
      "SELECT data, horario, sheet_data_carregamento, agenda_a_confirmar FROM public.cargas WHERE id = $1",
      [first.payload.id],
    );
    expect(dateOnly(rows[0].data)).toBe("2026-07-20");
    expect(timeOnly(rows[0].horario)).toBe("08:00");
    expect(rows[0].sheet_data_carregamento).toBe("2026-07-20T08:00");
    expect(rows[0].agenda_a_confirmar).toBe(false);
  });

  it("rejeita quando o cliente Shopee não está cadastrado", async () => {
    // sem seedCliente → findSheetClientId devolve null
    await expect(launchCargoFromTrip({ ...validTrip, deps })).rejects.toThrow(/Shopee/);
  });

  it("sem data → lança 'a confirmar' (placeholder + flag), não rejeita", async () => {
    await seedCliente({ nome: "Shopee" });
    const res = await launchCargoFromTrip({ ...validTrip, data: "", horario: "", dataDescarga: "", deps });

    expect(res.statusCode).toBe(201);
    expect(res.payload.aConfirmar).toBe(true);
    const { rows } = await query(
      "SELECT agenda_a_confirmar, sheet_data_carregamento, sheet_data_descarga, horario, status FROM public.cargas WHERE id = $1",
      [res.payload.id],
    );
    expect(rows[0].agenda_a_confirmar).toBe(true);
    expect(rows[0].sheet_data_carregamento).toBe("A confirmar");
    expect(rows[0].sheet_data_descarga).toBeNull();
    expect(rows[0].status).toBe("OPEN");
  });

  it("rejeita origem/destino ausentes", async () => {
    await seedCliente({ nome: "Shopee" });
    await expect(launchCargoFromTrip({ ...validTrip, origem: "", deps })).rejects.toThrow();
  });

  it("rejeita LH vazio", async () => {
    await expect(launchCargoFromTrip({ ...validTrip, lh: "  ", deps })).rejects.toThrow();
  });

  // ── Linha-casca na planilha (só quando ACEITA) ───────────────────────────
  it("accepted=true (nova carga do sistema) → escreve linha-casca (createOnly, sem motorista)", async () => {
    await seedCliente({ nome: "Shopee" });
    const writeSpy = vi.fn(async () => ({ ok: true }));
    const res = await launchCargoFromTrip({
      ...validTrip,
      accepted: true,
      correlationId: "c-acc",
      deps: { withPgClient, writeAllocationsToSheet: writeSpy },
    });
    expect(res.statusCode).toBe(201);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const arg = writeSpy.mock.calls[0][0][0];
    expect(arg.lh).toBe("LT1ABC");
    expect(arg.createOnly).toBe(true);
    expect(arg.motorista).toBe(""); // lançamento não tem motorista
    expect(arg.origem).toBe("SAO PAULO SP");
    expect(arg.destino).toBe("CAMPINAS SP");
    expect(arg.dataCarregamento).toBe("20/07/2026 08:00"); // ISO → formato da planilha
    expect(arg.source).toBe("shopee");
  });

  it("não aceita (accepted ausente) → NÃO escreve na planilha (só portal)", async () => {
    await seedCliente({ nome: "Shopee" });
    const writeSpy = vi.fn(async () => ({ ok: true }));
    const res = await launchCargoFromTrip({
      ...validTrip,
      correlationId: "c-noacc",
      deps: { withPgClient, writeAllocationsToSheet: writeSpy },
    });
    expect(res.statusCode).toBe(201);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("accepted=true mas carga da PLANILHA (sheet_lh) → NÃO escreve casca (o sync já cobre)", async () => {
    await seedCliente({ nome: "Shopee" });
    await seedCargo({ sheet_lh: "LT1ABC", status: "OPEN", origem: "X", destino: "Y" });
    const writeSpy = vi.fn(async () => ({ ok: true }));
    const res = await launchCargoFromTrip({
      ...validTrip,
      accepted: true,
      correlationId: "c-sheet",
      deps: { withPgClient, writeAllocationsToSheet: writeSpy },
    });
    expect(res.payload.alreadyExists).toBe(true);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
