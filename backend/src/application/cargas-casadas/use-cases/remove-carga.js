import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import {
  PACOTE_STATUS,
  PACOTE_STATUS_EDITAVEIS,
} from "../../../domain/cargas-casadas/constants.js";
import { ConflictError, NotFoundError } from "../../../domain/load-claims/errors.js";
import { auditPacoteEvent, bumpPacoteVersion, selectPacoteForUpdate } from "./_shared.js";

/**
 * Remove uma carga do pacote — UPDATE cargas SET viagem_id=NULL, ordem_viagem=NULL.
 * Ressequencia as cargas restantes (1..N contiguos).
 * Se pacote publicado, incrementa version (D-06).
 */
export async function removeCargaFromPacote({
  operatorId,
  pacoteId,
  cargaId,
  requestIp,
  correlationId,
}) {
  return withPgTransaction(async (client) => {
    const pacote = await selectPacoteForUpdate(client, pacoteId);

    if (!PACOTE_STATUS_EDITAVEIS.includes(pacote.status)) {
      throw new ConflictError(
        `Pacote em status '${pacote.status}' nao pode ter cargas removidas.`,
        { pacoteId, status: pacote.status, code: "pacote_nao_editavel" },
      );
    }

    const { rowCount } = await client.query(
      `UPDATE public.cargas
          SET viagem_id = NULL, ordem_viagem = NULL, updated_at = now()
        WHERE id = $1 AND viagem_id = $2`,
      [cargaId, pacoteId],
    );

    if (rowCount === 0) {
      throw new NotFoundError("Carga nao encontrada nesse pacote.");
    }

    // Ressequenciar restantes — busca em ordem atual, reescreve 1..N.
    const { rows: restantes } = await client.query(
      `SELECT id FROM public.cargas
        WHERE viagem_id = $1
        ORDER BY ordem_viagem ASC NULLS LAST, id ASC
        FOR UPDATE`,
      [pacoteId],
    );

    for (let index = 0; index < restantes.length; index += 1) {
      const novaOrdem = index + 1;
      await client.query(
        `UPDATE public.cargas SET ordem_viagem = $2, updated_at = now() WHERE id = $1`,
        [restantes[index].id, novaOrdem],
      );
    }

    let novaVersion = pacote.version;
    if (pacote.status === PACOTE_STATUS.PUBLICADO) {
      novaVersion = await bumpPacoteVersion(client, pacoteId);
    }

    await auditPacoteEvent(client, {
      eventType: "operator.pacote.carga.removed",
      actorUserId: operatorId,
      pacoteId,
      action: "remove-carga",
      requestIp,
      correlationId,
      metadata: { cargaId, restantes: restantes.length, version: novaVersion },
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        pacoteId,
        cargaId,
        total_cargas: restantes.length,
        version: novaVersion,
        meta: { correlationId: correlationId || null },
      },
    };
  });
}
