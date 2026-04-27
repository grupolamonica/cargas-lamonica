import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { writeCargo } from "./_shared.js";

export async function updateOperatorCargo({ cargoId, operatorId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const result = await writeCargo(client, { cargoId, operatorId, payload, requestIp, correlationId });
    return {
      statusCode: 200,
      payload: { ok: true, warnings: result.warnings, meta: { correlationId } },
    };
  });
}
