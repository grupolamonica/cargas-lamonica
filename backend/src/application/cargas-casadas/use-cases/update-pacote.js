import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import {
  PACOTE_STATUS,
  PACOTE_STATUS_TERMINAL,
} from "../../../domain/cargas-casadas/constants.js";
import { ConflictError } from "../../../domain/load-claims/errors.js";
import { auditPacoteEvent, bumpPacoteVersion, selectPacoteForUpdate } from "./_shared.js";

/**
 * Atualiza valor_total do pacote.
 * - Rejeita se pacote em status terminal (concluido/cancelado).
 * - Se status='publicado', incrementa version (D-06: invalida candidaturas).
 */
export async function updatePacote({ operatorId, pacoteId, payload, requestIp, correlationId }) {
  return withPgTransaction(async (client) => {
    const pacote = await selectPacoteForUpdate(client, pacoteId);

    if (PACOTE_STATUS_TERMINAL.includes(pacote.status)) {
      throw new ConflictError(
        `Pacote em status '${pacote.status}' nao pode ser editado.`,
        { pacoteId, status: pacote.status, code: "pacote_terminal" },
      );
    }

    const novoValor = payload.valor_total;
    const isPublicado = pacote.status === PACOTE_STATUS.PUBLICADO;

    if (isPublicado) {
      await client.query(
        `UPDATE public.cargas_casadas
            SET valor_total = $2, version = version + 1, updated_at = now()
          WHERE id = $1`,
        [pacoteId, novoValor],
      );
    } else {
      await client.query(
        `UPDATE public.cargas_casadas
            SET valor_total = $2, updated_at = now()
          WHERE id = $1`,
        [pacoteId, novoValor],
      );
    }

    const { rows } = await client.query(
      `SELECT id, status, valor_total, version, updated_at
         FROM public.cargas_casadas WHERE id = $1`,
      [pacoteId],
    );
    const refreshed = rows[0];

    await auditPacoteEvent(client, {
      eventType: "operator.pacote.updated",
      actorUserId: operatorId,
      pacoteId,
      action: "update",
      requestIp,
      correlationId,
      metadata: {
        valor_total_antes: pacote.valor_total !== null ? Number(pacote.valor_total) : null,
        valor_total_depois: novoValor,
        version_bumped: isPublicado,
      },
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        pacote: {
          id: refreshed.id,
          status: refreshed.status,
          valor_total: refreshed.valor_total !== null ? Number(refreshed.valor_total) : null,
          version: refreshed.version,
          updated_at: refreshed.updated_at,
        },
        meta: { correlationId: correlationId || null },
      },
    };
  });
}
