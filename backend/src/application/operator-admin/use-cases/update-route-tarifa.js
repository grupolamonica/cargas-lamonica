import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { ConflictError, NotFoundError } from "../../../domain/load-claims/errors.js";

const DUPLICATE_TARIFA_MESSAGE =
  "Ja existe uma tarifa para este perfil e nº de eixos nesta rota. Edite a existente em vez de mover para uma combinacao duplicada.";

export async function updateRouteTarifa({
  routeId,
  tarifaId,
  operatorId,
  payload,
  requestIp,
  correlationId,
}) {
  return withPgTransaction(async (client) => {
    await client.query("SET LOCAL statement_timeout = '5000'");

    const { rows: existing } = await client.query(
      `SELECT id FROM public.rota_tarifas WHERE id = $1 AND rota_id = $2 FOR UPDATE`,
      [tarifaId, routeId],
    );
    if (!existing[0]) throw new NotFoundError("Tarifa nao encontrada nesta rota.");

    try {
      await client.query(
        `
          UPDATE public.rota_tarifas
          SET
            tipo_veiculo    = $3,
            eixos           = $4,
            valor_frete     = $5,
            bonus           = $6,
            bonus_exigencias = $7,
            observacoes     = $8,
            ativa           = $9,
            updated_at      = now()
          WHERE id = $1 AND rota_id = $2
        `,
        [
          tarifaId,
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
    } catch (error) {
      if (error?.code === "23505") throw new ConflictError(DUPLICATE_TARIFA_MESSAGE);
      throw error;
    }

    await insertSecurityAuditEvent(client, {
      eventType: "operator.route_tarifa.updated",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "route_tarifa",
      resourceId: tarifaId,
      action: "update",
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
      statusCode: 200,
      payload: {
        ok: true,
        id: tarifaId,
        rota_id: routeId,
        meta: { correlationId },
      },
    };
  });
}
