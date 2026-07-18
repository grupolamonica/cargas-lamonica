import { recordSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { ValidationError } from "../../../domain/load-claims/errors.js";
import {
  fetchTripIndex,
  acceptTrip,
  isAspxAcceptWriteEnabled,
} from "../../../infrastructure/spx/spx-allocation-client.js";

// Só line-hauls reais do SPX (código LT…) são aceitáveis no ASPX. Códigos que não
// começam com LT (manuais / sem viagem no portal) nunca são enviados.
function isAspxLinehaul(lh) {
  return String(lh ?? "").trim().toUpperCase().startsWith("LT");
}

/**
 * Aceita (reserva) viagens line_haul no ASPX — POST /api/line_haul/agency/trip/accept.
 *
 * Aceitar é o passo ANTERIOR ao assign: move acceptance_status 0→1 e coloca a
 * viagem no pool atribuível (viagem não aceita não pode receber motorista). A
 * evidência da base ao vivo: nenhuma viagem "Assigned" existe com acceptance_status=0.
 *
 * Entrada: `tripIds` (ids diretos do SPX) e/ou `lhs` (trip_number "LT…", resolvidos
 * p/ trip_id via índice do sidecar — não confia no cliente pra mapear).
 *
 * Segurança: o envio REAL só ocorre com SPX_ACCEPT_WRITE_ENABLED=true. Caso
 * contrário (ou dryRun=true) roda em dry_run — o sidecar monta o body e NÃO toca o
 * ASPX. Se o sidecar estiver fora do ar durante a resolução por LH, o erro propaga
 * (nada é enviado). Kill-switch separado do de alocação: aceitar compromete a carga
 * com a agência (impacto SLA/financeiro).
 *
 * @param {{ tripIds?: number[], lhs?: string[], operatorId: string, dryRun?: boolean, requestIp?: string, correlationId?: string, deps?: object }} args
 */
export async function acceptAspxTrips({
  tripIds = [],
  lhs = [],
  operatorId,
  dryRun = false,
  requestIp,
  correlationId,
  deps = {},
}) {
  const ids = Array.isArray(tripIds) ? tripIds.filter((n) => Number.isInteger(n) && n > 0) : [];
  const lhList = Array.isArray(lhs) ? lhs.map((s) => String(s ?? "").trim()).filter(Boolean) : [];
  if (ids.length === 0 && lhList.length === 0) {
    throw new ValidationError("Nenhuma viagem selecionada para aceitar (informe tripIds ou lhs).");
  }

  const getIndex = deps.fetchIndex || fetchTripIndex;
  const sendAccept = deps.acceptTrip || acceptTrip;

  const writeEnabled = isAspxAcceptWriteEnabled();
  const effectiveDryRun = dryRun || !writeEnabled; // kill switch: write off → força dry_run

  // Fila de aceite: { key, tripId|null, reason? }. key = LH (quando veio por LH) ou
  // o próprio trip_id, para rastrear cada item no resultado.
  const queue = ids.map((tripId) => ({ key: String(tripId), tripId }));

  // Resolve LH → trip_id pelo índice REAL do sidecar (só quando houver LHs). O
  // índice varre as abas Planejado(1)+Aceito(2); viagens pendentes de aceite
  // (acceptance_status=0, status Assigning) vivem na Planejado.
  if (lhList.length > 0) {
    let index = null;
    try {
      index = await getIndex();
    } catch (err) {
      await recordSecurityAuditEvent({
        eventType: "operator.cargo.aspx_accept",
        actorUserId: operatorId,
        actorRole: "operator",
        resourceType: "cargo",
        resourceId: null,
        action: "update",
        outcome: "failure",
        requestIp,
        correlationId,
        metadata: { tripIds: ids.length, lhs: lhList.length, writeEnabled, reason: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
    const byNumber = index?.byNumber instanceof Map ? index.byNumber : new Map();
    for (const lh of lhList) {
      if (!isAspxLinehaul(lh)) {
        queue.push({ key: lh, tripId: null, reason: "não é linehaul SPX (código não começa com LT) — não aceitável no ASPX" });
        continue;
      }
      const tripId = byNumber.get(lh)?.tripId ?? null;
      queue.push({ key: lh, tripId, reason: tripId == null ? "não encontrada no índice do ASPX" : undefined });
    }
  }

  const results = [];
  for (const item of queue) {
    if (item.tripId == null) {
      results.push({ key: item.key, tripId: null, state: "skipped", reason: item.reason || "trip_id ausente" });
      continue;
    }
    try {
      const r = await sendAccept({ tripId: item.tripId, dryRun: effectiveDryRun });
      results.push({ key: item.key, tripId: item.tripId, state: effectiveDryRun ? "dry_run" : "accepted", sidecar: r });
    } catch (err) {
      results.push({ key: item.key, tripId: item.tripId, state: "error", reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const summary = {
    accepted: results.filter((r) => r.state === "accepted").length,
    dryRun: results.filter((r) => r.state === "dry_run").length,
    skipped: results.filter((r) => r.state === "skipped").length,
    error: results.filter((r) => r.state === "error").length,
  };

  await recordSecurityAuditEvent({
    eventType: "operator.cargo.aspx_accept",
    actorUserId: operatorId,
    actorRole: "operator",
    resourceType: "cargo",
    resourceId: null,
    action: "update",
    outcome: "success",
    requestIp,
    correlationId,
    metadata: { tripIds: ids.length, lhs: lhList.length, writeEnabled, dryRun: effectiveDryRun, summary },
  });

  return {
    statusCode: 200,
    payload: { ok: true, writeEnabled, dryRun: effectiveDryRun, summary, results, meta: { correlationId } },
  };
}
