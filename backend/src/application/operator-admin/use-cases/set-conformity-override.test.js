import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeTestDatabase,
  query,
  resetTestDatabase,
  seedUser,
  withPgTransaction,
} from "../test-harness.js";

vi.mock("../../../infrastructure/pg/postgres.js", () => ({ withPgTransaction }));

const { setConformityOverride } = await import("./set-conformity-override.js");

describe("setConformityOverride", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  it("grava o verdito de motorista por CPF (só dígitos) com observação", async () => {
    const op = await seedUser({ email: "op-conf-1@teste.local" });
    const res = await setConformityOverride({
      subjectType: "DRIVER",
      subjectKey: "123.456.789-00",
      decision: "APPROVED",
      observacao: "documentação conferida na torre",
      operatorId: op.id,
      correlationId: "c-conf-1",
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await query(
      `SELECT subject_type, subject_key, decision, observacao FROM public.angellira_conformity_overrides`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject_type: "DRIVER",
      subject_key: "12345678900", // só dígitos
      decision: "APPROVED",
      observacao: "documentação conferida na torre",
    });
  });

  it("normaliza a placa do veículo e faz upsert (atualiza o mesmo registro)", async () => {
    const op = await seedUser({ email: "op-conf-2@teste.local" });
    await setConformityOverride({
      subjectType: "VEHICLE", subjectKey: "abc-1d23", decision: "APPROVED", observacao: "ok", operatorId: op.id,
    });
    await setConformityOverride({
      subjectType: "VEHICLE", subjectKey: "ABC1D23", decision: "NOT_APPROVED", observacao: "pneu careca", operatorId: op.id,
    });
    const { rows } = await query(
      `SELECT subject_key, decision, observacao FROM public.angellira_conformity_overrides WHERE subject_type = 'VEHICLE'`,
    );
    expect(rows).toHaveLength(1); // upsert, não duplicou
    expect(rows[0]).toMatchObject({ subject_key: "ABC1D23", decision: "NOT_APPROVED", observacao: "pneu careca" });
  });

  it("exige observação ao aprovar/reprovar (não grava sem)", async () => {
    const op = await seedUser({ email: "op-conf-3@teste.local" });
    await expect(
      setConformityOverride({ subjectType: "DRIVER", subjectKey: "111", decision: "APPROVED", observacao: "   ", operatorId: op.id }),
    ).rejects.toThrow(/observa/i);
    const { rows } = await query(`SELECT 1 FROM public.angellira_conformity_overrides`);
    expect(rows).toHaveLength(0);
  });

  it("decision null LIMPA o verdito (DELETE) — volta ao selo derivado", async () => {
    const op = await seedUser({ email: "op-conf-4@teste.local" });
    await setConformityOverride({ subjectType: "DRIVER", subjectKey: "999", decision: "NOT_APPROVED", observacao: "bloqueado", operatorId: op.id });
    let { rows } = await query(`SELECT 1 FROM public.angellira_conformity_overrides`);
    expect(rows).toHaveLength(1);

    const res = await setConformityOverride({ subjectType: "DRIVER", subjectKey: "999", decision: null, operatorId: op.id });
    expect(res.payload.cleared).toBe(true);
    ({ rows } = await query(`SELECT 1 FROM public.angellira_conformity_overrides`));
    expect(rows).toHaveLength(0);
  });

  it("grava set_by_name e MASCARA o CPF no audit (LGPD — não persiste CPF cru no log)", async () => {
    const op = await seedUser({ email: "op-conf-6@teste.local" });
    await setConformityOverride({
      subjectType: "DRIVER", subjectKey: "123.456.789-01", decision: "APPROVED",
      observacao: "ok", operatorId: op.id, operatorName: "Fulano Operador",
    });
    const { rows: over } = await query(`SELECT set_by_name FROM public.angellira_conformity_overrides`);
    expect(over[0].set_by_name).toBe("Fulano Operador");
    const { rows: audit } = await query(
      `SELECT resource_id, resource_type FROM public.security_audit_logs WHERE event_type = 'operator.monitor.conformity_override'`,
    );
    expect(audit[0].resource_type).toBe("driver");
    expect(audit[0].resource_id).toBe("***901"); // CPF mascarado, não "12345678901"
  });

  it("veículo: placa NÃO é mascarada no audit (não é PII sensível)", async () => {
    const op = await seedUser({ email: "op-conf-7@teste.local" });
    await setConformityOverride({
      subjectType: "VEHICLE", subjectKey: "abc-1d23", decision: "NOT_APPROVED", observacao: "pneu", operatorId: op.id,
    });
    const { rows: audit } = await query(
      `SELECT resource_id FROM public.security_audit_logs WHERE event_type = 'operator.monitor.conformity_override'`,
    );
    expect(audit[0].resource_id).toBe("ABC1D23");
  });
});
