import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { recordSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { ValidationError } from "../../../domain/load-claims/errors.js";
import {
  fetchAssignableTrips,
  fetchAssignableDrivers,
  assignTrip,
  isAspxWriteEnabled,
} from "../../../infrastructure/spx/spx-allocation-client.js";

function normName(v) {
  return (v ?? "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
}

async function defaultListByLhs(lhs) {
  return withPgClient(async (client) => {
    const { rows } = await client.query(
      `SELECT sheet_lh,
              COALESCE(alloc_motorista, sheet_motorista, '') AS motorista,
              COALESCE(alloc_cavalo,    sheet_cavalo,    '') AS cavalo,
              COALESCE(alloc_carreta,   sheet_carreta,   '') AS carreta
       FROM public.cargas
       WHERE sheet_lh = ANY($1::text[])`,
      [lhs],
    );
    return rows;
  });
}

/**
 * Confirma a atribuição no ASPX das cargas selecionadas (LHs). Re-resolve trip_id
 * (LH=trip_number) e driver_id (por nome) no servidor — não confia no cliente.
 *
 * Segurança: o envio REAL só ocorre com SPX_ALLOC_WRITE_ENABLED=true. Caso
 * contrário (ou dryRun=true) roda em dry_run — o sidecar monta o body e não toca
 * o ASPX. Se o sidecar estiver fora → resultado "simulado" (nada enviado).
 *
 * @param {{ lhs: string[], operatorId: string, dryRun?: boolean, requestIp?: string, correlationId?: string, deps?: object }} args
 */
export async function assignAspxAllocations({ lhs, operatorId, dryRun = false, requestIp, correlationId, deps = {} }) {
  if (!Array.isArray(lhs) || lhs.length === 0) {
    throw new ValidationError("Nenhuma carga selecionada para atribuir.");
  }

  const listByLhs = deps.listByLhs || defaultListByLhs;
  const getTrips = deps.fetchTrips || fetchAssignableTrips;
  const getDrivers = deps.fetchDrivers || fetchAssignableDrivers;
  const sendAssign = deps.assignTrip || assignTrip;

  const writeEnabled = isAspxWriteEnabled();
  const effectiveDryRun = dryRun || !writeEnabled; // kill switch: write off → força dry_run

  const cargas = await listByLhs(lhs);
  const byLh = new Map(cargas.map((c) => [c.sheet_lh, c]));

  let trips = null;
  let drivers = null;
  let simulated = false;
  try {
    [trips, drivers] = await Promise.all([getTrips(), getDrivers()]);
  } catch {
    // Falha de LEITURA do sidecar (fora do ar / sem login / 5xx) → simula, não
    // envia nada. O envio real só acontece na chamada assignTrip mais abaixo.
    simulated = true;
  }

  const tripByLh = new Map((trips || []).map((t) => [String(t.trip_number ?? "").trim(), t]));
  const driverByName = new Map((drivers || []).map((d) => [normName(d.name), d.driver_id]));

  const results = [];
  for (const lh of lhs) {
    const c = byLh.get(lh);
    if (!c || !c.motorista) {
      results.push({ lh, state: "pending", reason: "carga sem motorista no sistema" });
      continue;
    }
    if (simulated) {
      results.push({ lh, state: "simulated", reason: "sidecar SPX indisponível — nada enviado" });
      continue;
    }
    const trip = tripByLh.get(String(lh).trim());
    const driverId = driverByName.get(normName(c.motorista)) ?? null;
    if (!trip) { results.push({ lh, state: "skipped", reason: "não atribuível (provavelmente já atribuída)" }); continue; }
    if (!driverId) { results.push({ lh, state: "pending", reason: "motorista não encontrado no ASPX" }); continue; }

    const plates = [c.cavalo, c.carreta].filter((p) => (p || "").trim() !== "");
    try {
      const r = await sendAssign({ tripId: trip.trip_id, driverIds: [driverId], vehiclePlates: plates, dryRun: effectiveDryRun });
      results.push({ lh, state: effectiveDryRun ? "dry_run" : "assigned", tripId: trip.trip_id, driverId, sidecar: r });
    } catch (err) {
      results.push({ lh, state: "error", reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const summary = {
    assigned: results.filter((r) => r.state === "assigned").length,
    dryRun: results.filter((r) => r.state === "dry_run").length,
    simulated: results.filter((r) => r.state === "simulated").length,
    pending: results.filter((r) => r.state === "pending").length,
    skipped: results.filter((r) => r.state === "skipped").length,
    error: results.filter((r) => r.state === "error").length,
  };

  await recordSecurityAuditEvent({
    eventType: "operator.cargo.aspx_assign",
    actorUserId: operatorId,
    actorRole: "operator",
    resourceType: "cargo",
    resourceId: null,
    action: "update",
    outcome: "success",
    requestIp,
    correlationId,
    metadata: { count: lhs.length, writeEnabled, dryRun: effectiveDryRun, simulated, summary },
  });

  return {
    statusCode: 200,
    payload: { ok: true, writeEnabled, dryRun: effectiveDryRun, simulated, summary, results, meta: { correlationId } },
  };
}
