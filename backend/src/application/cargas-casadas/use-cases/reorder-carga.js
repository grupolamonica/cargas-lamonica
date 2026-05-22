import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import {
  PACOTE_STATUS,
  PACOTE_STATUS_EDITAVEIS,
} from "../../../domain/cargas-casadas/constants.js";
import { ConflictError, ValidationError } from "../../../domain/load-claims/errors.js";
import {
  auditPacoteEvent,
  bumpPacoteVersion,
  selectCargasByPacote,
  selectPacoteForUpdate,
} from "./_shared.js";

/**
 * Reordena as cargas de um pacote em massa.
 * Payload: { orderings: [{cargaId, ordem}, ...] } com ordens unicas 1..N (validado pelo zod).
 * Adicionalmente exige que o conjunto de cargaIds == cargas atuais do pacote (set equality).
 */
export async function reorderCargasInPacote({
  operatorId,
  pacoteId,
  orderings,
  requestIp,
  correlationId,
}) {
  return withPgTransaction(async (client) => {
    const pacote = await selectPacoteForUpdate(client, pacoteId);

    if (!PACOTE_STATUS_EDITAVEIS.includes(pacote.status)) {
      throw new ConflictError(
        `Pacote em status '${pacote.status}' nao pode ter cargas reordenadas.`,
        { pacoteId, status: pacote.status, code: "pacote_nao_editavel" },
      );
    }

    const cargasAtuais = await selectCargasByPacote(client, pacoteId, { forUpdate: true });
    const idsAtuais = new Set(cargasAtuais.map((row) => row.id));
    const idsPayload = new Set(orderings.map((item) => item.cargaId));

    if (idsAtuais.size !== idsPayload.size || [...idsAtuais].some((id) => !idsPayload.has(id))) {
      throw new ValidationError(
        "orderings deve conter exatamente todas as cargas atuais do pacote.",
        {
          atuais: [...idsAtuais],
          payload: [...idsPayload],
          code: "orderings_cargas_divergentes",
        },
      );
    }

    // Etapa 1: zera ordem_viagem para evitar conflito com indices unicos parciais durante swap.
    await client.query(
      `UPDATE public.cargas SET ordem_viagem = NULL, updated_at = now() WHERE viagem_id = $1`,
      [pacoteId],
    );

    // Etapa 2: aplica a nova ordem.
    for (const item of orderings) {
      await client.query(
        `UPDATE public.cargas
            SET ordem_viagem = $2, updated_at = now()
          WHERE id = $1 AND viagem_id = $3`,
        [item.cargaId, item.ordem, pacoteId],
      );
    }

    let novaVersion = pacote.version;
    if (pacote.status === PACOTE_STATUS.PUBLICADO) {
      novaVersion = await bumpPacoteVersion(client, pacoteId);
    }

    await auditPacoteEvent(client, {
      eventType: "operator.pacote.cargas.reordered",
      actorUserId: operatorId,
      pacoteId,
      action: "reorder-cargas",
      requestIp,
      correlationId,
      metadata: { orderings, version: novaVersion },
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        pacoteId,
        orderings,
        version: novaVersion,
        meta: { correlationId: correlationId || null },
      },
    };
  });
}
