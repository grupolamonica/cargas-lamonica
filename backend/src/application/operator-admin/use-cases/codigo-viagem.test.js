import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedUser,
  withPgClient,
  withPgTransaction,
} from "../test-harness.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgClient, withPgTransaction }));

const { createOperatorCargo } = await import("./create-cargo.js");
const { updateOperatorCargo } = await import("./update-cargo.js");
const { lookupCargoByCodigoViagem } = await import("./lookup-cargo-by-codigo-viagem.js");

const cargoPayload = (over = {}) => ({
  data: "2026-08-01",
  horario: "08:00:00",
  origem: "Campo Grande / MS",
  destino: "Simoes Filho / BA",
  perfil: "CARRETA",
  eixos: null,
  valor: 5000,
  bonus: 0,
  bonus_exigencias: null,
  driver_visibility: "PUBLIC",
  cliente_id: null,
  status: "OPEN",
  is_template: false,
  is_recurring: false,
  recurrence_interval_days: null,
  distancia_km: 100,
  duracao_horas: 2,
  sheet_data_carregamento: null,
  sheet_data_descarga: null,
  codigo_viagem: null,
  ...over,
});

describe("codigo_viagem em cargas", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("cria carga com codigo_viagem e persiste", async () => {
    const op = await seedUser({ email: "op-cv-1@teste.local" });
    const res = await createOperatorCargo({
      operatorId: op.id,
      payload: cargoPayload({ codigo_viagem: "LT-2026-001" }),
      correlationId: "c1",
    });
    expect(res.statusCode).toBe(201);

    const { rows } = await query(`SELECT codigo_viagem FROM public.cargas WHERE id = $1`, [res.payload.id]);
    expect(rows[0].codigo_viagem).toBe("LT-2026-001");
  });

  it("código de viagem duplicado → ConflictError 409", async () => {
    const op = await seedUser({ email: "op-cv-dup@teste.local" });
    await createOperatorCargo({ operatorId: op.id, payload: cargoPayload({ codigo_viagem: "LT-DUP" }), correlationId: "c1" });

    let err;
    try {
      await createOperatorCargo({
        operatorId: op.id,
        payload: cargoPayload({ codigo_viagem: "LT-DUP", origem: "X / BA", destino: "Y / BA" }),
        correlationId: "c2",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe("CONFLICT");
    expect(err.statusCode).toBe(409);
  });

  it("várias cargas SEM código (null) coexistem sem falso conflito", async () => {
    const op = await seedUser({ email: "op-cv-null@teste.local" });
    await createOperatorCargo({ operatorId: op.id, payload: cargoPayload(), correlationId: "c1" });
    const res2 = await createOperatorCargo({ operatorId: op.id, payload: cargoPayload({ origem: "X / BA" }), correlationId: "c2" });
    expect(res2.statusCode).toBe(201);

    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM public.cargas WHERE codigo_viagem IS NULL`);
    expect(rows[0].n).toBe(2);
  });

  it("editar carga para um código já usado por outra → ConflictError 409", async () => {
    const op = await seedUser({ email: "op-cv-upd@teste.local" });
    await createOperatorCargo({ operatorId: op.id, payload: cargoPayload({ codigo_viagem: "LT-A" }), correlationId: "c1" });
    const b = await createOperatorCargo({ operatorId: op.id, payload: cargoPayload({ codigo_viagem: "LT-B", origem: "X / BA" }), correlationId: "c2" });

    let err;
    try {
      await updateOperatorCargo({
        cargoId: b.payload.id,
        operatorId: op.id,
        payload: cargoPayload({ codigo_viagem: "LT-A", origem: "X / BA", status: "OPEN" }),
        correlationId: "c3",
      });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe("CONFLICT");
    expect(err?.statusCode).toBe(409);
  });

  it("lookup retorna a carga existente pelo código e null quando não existe", async () => {
    const op = await seedUser({ email: "op-cv-lookup@teste.local" });
    await createOperatorCargo({ operatorId: op.id, payload: cargoPayload({ codigo_viagem: "LT-FIND" }), correlationId: "c1" });

    const found = await lookupCargoByCodigoViagem({ codigoViagem: "LT-FIND", correlationId: "c2" });
    expect(found.payload.exists).toBe(true);
    expect(found.payload.cargo.codigo_viagem).toBe("LT-FIND");
    expect(found.payload.cargo.origem).toBe("Campo Grande / MS");

    const missing = await lookupCargoByCodigoViagem({ codigoViagem: "NAO-EXISTE", correlationId: "c3" });
    expect(missing.payload.exists).toBe(false);
    expect(missing.payload.cargo).toBeNull();
  });
});
