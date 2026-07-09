import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { ConflictError, NotFoundError } from "../../../domain/load-claims/errors.js";

// Ja existe tarifa (rota + perfil + eixos) — Postgres 23505 no UNIQUE
// rota_tarifas_rota_veiculo_eixos_unique. Devolve 409 claro em vez de 500.
const DUPLICATE_TARIFA_MESSAGE =
  "Ja existe uma tarifa para este perfil e nº de eixos nesta rota. Edite a existente em vez de criar duplicada.";

export async function createRouteTarifa({
  routeId,
  operatorId,
  payload,
  requestIp,
  correlationId,
}) {
  return withPgTransaction(async (client) => {
    const { rows: rotaRows } = await client.query(
      `SELECT id FROM public.rotas WHERE id = $1 FOR UPDATE`,
      [routeId],
    );
    if (!rotaRows[0]) throw new NotFoundError("Rota nao encontrada.");

    let tarifaId = null;
    try {
      const { rows } = await client.query(
        `
          INSERT INTO public.rota_tarifas (
            rota_id, tipo_veiculo, eixos, valor_frete, bonus,
            bonus_exigencias, observacoes, ativa
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id
        `,
        [
          routeId,
          payload.perfil,
          payload.eixos ?? 0,
          payload.valor,
          payload.bonus,
          payload.bonus_exigencias,
          payload.observacoes,
          payload.ativa,
        ],
      );
      tarifaId = rows[0]?.id ?? null;
    } catch (error) {
      if (error?.code === "23505") throw new ConflictError(DUPLICATE_TARIFA_MESSAGE);
      throw error;
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.route_tarifa.created",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "route_tarifa",
      resourceId: tarifaId,
      action: "create",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        rota_id: routeId,
        perfil: payload.perfil,
        eixos: payload.eixos ?? 0,
      },
    });

    return {
      statusCode: 201,
      payload: {
        ok: true,
        id: tarifaId,
        rota_id: routeId,
        meta: { correlationId },
      },
    };
  });
}
