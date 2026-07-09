import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";

export async function deleteRouteTarifa({
  routeId,
  tarifaId,
  operatorId,
  requestIp,
  correlationId,
}) {
  return withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `
        DELETE FROM public.rota_tarifas
        WHERE id = $1 AND rota_id = $2
        RETURNING id, tipo_veiculo, eixos
      `,
      [tarifaId, routeId],
    );
    if (!rows[0]) throw new NotFoundError("Tarifa nao encontrada nesta rota.");

    await insertSecurityAuditEvent(client, {
      eventType: "operator.route_tarifa.deleted",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "route_tarifa",
      resourceId: tarifaId,
      action: "delete",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        rota_id: routeId,
        perfil: rows[0].tipo_veiculo,
        eixos: rows[0].eixos,
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
