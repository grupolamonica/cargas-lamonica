import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { createSupabaseAdminClient } from "../../../infrastructure/supabase/admin-client.js";
import { buildPaginationMeta } from "../../../domain/operator-admin/route-utils.js";

const AUDIT_LOGS_DEFAULT_PAGE_SIZE = 50;
const AUDIT_LOGS_MAX_PAGE_SIZE = 200;

// Cache in-memory de user_id -> { email, displayName } para evitar listUsers
// em toda chamada ao audit-logs. TTL curto (60s) é suficiente.
//
// AUDIT.md M-05 follow-up: in-memory cache aceitável em single-replica
// (CLAUDE.md confirma); virar Redis quando passar a multi-replica (DC-95).
const OPERATOR_DIRECTORY_TTL_MS = 60_000;
let operatorDirectoryCache = { at: 0, map: new Map() };

export async function resolveOperatorDirectory() {
  const now = Date.now();
  if (now - operatorDirectoryCache.at < OPERATOR_DIRECTORY_TTL_MS) {
    return operatorDirectoryCache.map;
  }
  try {
    const admin = createSupabaseAdminClient();
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const map = new Map();
    for (const user of data?.users || []) {
      const email = user.email || null;
      const localPart = email ? email.split("@")[0] : "";
      const prettyName = localPart
        ? localPart.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
        : null;
      const role = user?.app_metadata?.role || user?.user_metadata?.role || null;
      const accessLevelRaw =
        user?.app_metadata?.access_level || user?.user_metadata?.access_level || null;
      const accessLevel =
        accessLevelRaw === "advanced" || accessLevelRaw === "intermediate"
          ? accessLevelRaw
          : role === "operator"
            ? "advanced"
            : null;
      map.set(user.id, { email, displayName: prettyName, role, accessLevel });
    }
    operatorDirectoryCache = { at: now, map };
    return map;
  } catch (error) {
    console.error("[operator-directory] Failed to refresh — returning stale cache:", {
      message: error instanceof Error ? error.message : String(error),
      code: error?.code,
    });
    return operatorDirectoryCache.map;
  }
}

function parseAuditLogsQuery(query) {
  const rawPage = Number.parseInt(query?.page || "", 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawPageSize = Number.parseInt(query?.pageSize || "", 10);
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0
    ? Math.min(rawPageSize, AUDIT_LOGS_MAX_PAGE_SIZE)
    : AUDIT_LOGS_DEFAULT_PAGE_SIZE;

  const dateFrom = typeof query?.dateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.dateFrom.trim())
    ? new Date(`${query.dateFrom.trim()}T00:00:00.000Z`)
    : null;
  const dateToRaw = typeof query?.dateTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.dateTo.trim())
    ? new Date(`${query.dateTo.trim()}T00:00:00.000Z`)
    : null;
  const dateToExclusive = dateToRaw ? new Date(dateToRaw.getTime() + 86_400_000) : null;

  const operatorId = typeof query?.operatorId === "string" && query.operatorId.trim() !== ""
    ? query.operatorId.trim()
    : null;

  return { page, pageSize, offset: (page - 1) * pageSize, dateFrom, dateToExclusive, operatorId };
}

/**
 * Lista paginada de logs do painel (security_audit_logs) com diretório
 * de operadores enriquecido. Use-case extraído de read-models.js em
 * AUDIT Wave 4 (split god module).
 */
export async function fetchOperatorAuditLogsReadModel({ query, correlationId }) {
  const { page, pageSize, offset, dateFrom, dateToExclusive, operatorId } = parseAuditLogsQuery(query);

  return withPgClient(async (client) => {
    const whereClauses = [];
    const values = [];
    let index = 1;

    if (dateFrom) {
      values.push(dateFrom);
      whereClauses.push(`created_at >= $${index}`);
      index += 1;
    }
    if (dateToExclusive) {
      values.push(dateToExclusive);
      whereClauses.push(`created_at < $${index}`);
      index += 1;
    }
    if (operatorId) {
      values.push(operatorId);
      whereClauses.push(`actor_user_id = $${index}`);
      index += 1;
    }

    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

    const [itemsResult, countResult] = await Promise.all([
      client.query(
        `
        SELECT
          id,
          event_type,
          severity,
          actor_user_id,
          actor_role,
          resource_type,
          resource_id,
          action,
          outcome,
          request_ip,
          correlation_id,
          metadata,
          created_at
        FROM public.security_audit_logs
        ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${index} OFFSET $${index + 1}
      `,
        [...values, pageSize, offset],
      ),
      client.query(
        `SELECT COUNT(*)::int AS total FROM public.security_audit_logs ${whereSql}`,
        values,
      ),
    ]);
    const totalCount = Number(countResult.rows[0]?.total) || 0;

    const directory = await resolveOperatorDirectory();

    return {
      statusCode: 200,
      payload: {
        items: itemsResult.rows.map((row) => {
          const resolved = row.actor_user_id ? directory.get(row.actor_user_id) : null;
          return {
            id: row.id,
            eventType: row.event_type,
            severity: row.severity,
            actorUserId: row.actor_user_id,
            actorEmail: resolved?.email || null,
            actorDisplayName: resolved?.displayName || null,
            actorRole: row.actor_role,
            resourceType: row.resource_type,
            resourceId: row.resource_id,
            action: row.action,
            outcome: row.outcome,
            requestIp: row.request_ip,
            correlationId: row.correlation_id,
            metadata: row.metadata || null,
            createdAt: row.created_at,
          };
        }),
        meta: buildPaginationMeta(page, pageSize, totalCount, AUDIT_LOGS_MAX_PAGE_SIZE, correlationId),
        // Lista completa de operadores do diretório (auth), independente de
        // terem gerado logs no período. Antes vinha de DISTINCT actor_user_id
        // dos próprios audit logs e escondia operadores sem atividade.
        operators: Array.from(directory.entries())
          .filter(([, info]) => info?.role === "operator")
          .map(([id, info]) => ({
            id,
            email: info.email || null,
            displayName: info.displayName || null,
            accessLevel: info.accessLevel || null,
          }))
          .sort((a, b) => {
            const aLabel = (a.displayName || a.email || a.id).toLowerCase();
            const bLabel = (b.displayName || b.email || b.id).toLowerCase();
            return aLabel.localeCompare(bLabel);
          }),
      },
    };
  });
}
