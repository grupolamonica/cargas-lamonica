import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { PACOTE_STATUS } from "../../../domain/cargas-casadas/constants.js";
import { ConflictError, ValidationError } from "../../../domain/load-claims/errors.js";
import {
  auditPacoteEvent,
  selectCargasByPacote,
  selectPacoteForUpdate,
} from "./_shared.js";

/**
 * Publica um pacote. Validacoes (D-05 LOCKED):
 *  - Pacote em status='rascunho' (unico caminho de publish).
 *  - valor_total NOT NULL e > 0.
 *  - >=1 carga vinculada.
 *  - Todas cargas: status='OPEN' AND driver_visibility='PREMIUM'.
 *
 * Em sucesso:
 *  - UPDATE cargas_casadas SET status='publicado', published_at=now(), version=version+1.
 *  - Auditoria 'operator.pacote.published'.
 */
export async function publishPacote({
  operatorId,
  pacoteId,
  requestIp,
  correlationId,
}) {
  return withPgTransaction(async (client) => {
    const pacote = await selectPacoteForUpdate(client, pacoteId);

    if (pacote.status !== PACOTE_STATUS.RASCUNHO) {
      throw new ConflictError(
        `Apenas pacotes em rascunho podem ser publicados (atual: '${pacote.status}').`,
        { pacoteId, status: pacote.status, code: "publish_status_invalido" },
      );
    }

    if (pacote.valor_total === null || Number(pacote.valor_total) <= 0) {
      throw new ValidationError(
        "valor_total deve ser informado e maior que zero para publicar.",
        { pacoteId, valor_total: pacote.valor_total, code: "valor_total_obrigatorio" },
      );
    }

    const cargas = await selectCargasByPacote(client, pacoteId, { forUpdate: true });

    if (cargas.length === 0) {
      throw new ValidationError(
        "Pacote vazio. Adicione ao menos uma carga antes de publicar.",
        { pacoteId, code: "pacote_vazio" },
      );
    }

    const naoPremium = cargas.filter((c) => c.driver_visibility !== "PREMIUM");
    if (naoPremium.length > 0) {
      throw new ValidationError(
        "Todas as cargas do pacote devem ser PREMIUM para publicar (D-05).",
        {
          pacoteId,
          cargas_nao_premium: naoPremium.map((c) => ({ id: c.id, driver_visibility: c.driver_visibility })),
          code: "cargas_nao_premium",
        },
      );
    }

    const naoAbertas = cargas.filter((c) => c.status !== "OPEN");
    if (naoAbertas.length > 0) {
      throw new ValidationError(
        "Todas as cargas do pacote devem estar em status 'OPEN' para publicar.",
        {
          pacoteId,
          cargas_nao_abertas: naoAbertas.map((c) => ({ id: c.id, status: c.status })),
          code: "cargas_nao_abertas",
        },
      );
    }

    const { rows } = await client.query(
      `UPDATE public.cargas_casadas
          SET status = $2, published_at = now(), version = version + 1, updated_at = now()
        WHERE id = $1
        RETURNING id, status, valor_total, version, published_at`,
      [pacoteId, PACOTE_STATUS.PUBLICADO],
    );
    const refreshed = rows[0];

    await auditPacoteEvent(client, {
      eventType: "operator.pacote.published",
      actorUserId: operatorId,
      pacoteId,
      action: "publish",
      requestIp,
      correlationId,
      metadata: {
        total_cargas: cargas.length,
        valor_total: Number(refreshed.valor_total),
        version: refreshed.version,
      },
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        pacote: {
          id: refreshed.id,
          status: refreshed.status,
          valor_total: Number(refreshed.valor_total),
          version: refreshed.version,
          published_at: refreshed.published_at,
        },
        total_cargas: cargas.length,
        meta: { correlationId: correlationId || null },
      },
    };
  });
}
