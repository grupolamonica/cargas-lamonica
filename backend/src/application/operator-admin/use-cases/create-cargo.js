import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { writeCargo } from "./_shared.js";

export async function createOperatorCargo({ operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const result = await writeCargo(client, { operatorId, payload, requestIp, correlationId });
    return {
      statusCode: 201,
      payload: { ok: true, id: result.cargoId, cargo: { id: result.cargoId }, warnings: result.warnings, meta: { correlationId } },
    };
  });
}
