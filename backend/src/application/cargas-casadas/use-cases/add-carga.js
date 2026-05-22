import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import {
  MAX_CARGAS_POR_PACOTE,
  PACOTE_STATUS,
  PACOTE_STATUS_EDITAVEIS,
} from "../../../domain/cargas-casadas/constants.js";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../../domain/load-claims/errors.js";
import {
  auditPacoteEvent,
  bumpPacoteVersion,
  countCargasByPacote,
  selectCargaForUpdate,
  selectPacoteForUpdate,
} from "./_shared.js";

/**
 * Adiciona uma carga avulsa a um pacote.
 *
 * Regras (D-04 + D-05 + CONTEXT edge cases):
 *  1. Pacote deve estar em status editavel (rascunho ou publicado).
 *  2. COUNT(cargas com viagem_id=pacoteId) < MAX_CARGAS_POR_PACOTE (=3).
 *  3. Carga: viagem_id IS NULL (avulsa) + sem candidatura ativa (reserved_driver_id IS NULL).
 *  4. Carga: status IN ('DRAFT','OPEN') — operacional/finalizada e bloqueada.
 *  5. Se pacote publicado, todas as cargas precisam ser PREMIUM (D-05). Como esta carga
 *     entrara no pacote em estado publicado, ela tambem precisa ser PREMIUM nesse caso.
 *  6. Se pacote publicado, incrementa version (D-06).
 */
export async function addCargaToPacote({
  operatorId,
  pacoteId,
  cargaId,
  ordem,
  requestIp,
  correlationId,
}) {
  return withPgTransaction(async (client) => {
    const pacote = await selectPacoteForUpdate(client, pacoteId);

    if (!PACOTE_STATUS_EDITAVEIS.includes(pacote.status)) {
      throw new ConflictError(
        `Pacote em status '${pacote.status}' nao aceita novas cargas.`,
        { pacoteId, status: pacote.status, code: "pacote_nao_editavel" },
      );
    }

    const totalCargas = await countCargasByPacote(client, pacoteId);
    if (totalCargas >= MAX_CARGAS_POR_PACOTE) {
      throw new ConflictError(
        `Pacote ja tem ${totalCargas} cargas. Limite e ${MAX_CARGAS_POR_PACOTE}.`,
        {
          pacoteId,
          atual: totalCargas,
          limite: MAX_CARGAS_POR_PACOTE,
          code: "limite_cargas_excedido",
        },
      );
    }

    const carga = await selectCargaForUpdate(client, cargaId);
    if (!carga) {
      throw new NotFoundError("Carga nao encontrada.");
    }

    if (carga.viagem_id !== null) {
      throw new ConflictError(
        "Carga ja pertence a outro pacote.",
        { cargaId, viagem_atual: carga.viagem_id, code: "carga_ja_em_pacote" },
      );
    }

    if (carga.reserved_driver_id !== null || carga.booked_driver_id !== null) {
      throw new ConflictError(
        "Carga tem candidatura ativa. Cancele a reserva antes de incluir no pacote.",
        {
          cargaId,
          reserved_driver_id: carga.reserved_driver_id,
          booked_driver_id: carga.booked_driver_id,
          code: "carga_com_reserva_ativa",
        },
      );
    }

    const ALLOWED_CARGO_STATUSES = ["DRAFT", "OPEN"];
    if (!ALLOWED_CARGO_STATUSES.includes(carga.status)) {
      throw new ValidationError(
        `Carga em status '${carga.status}' nao pode ser adicionada ao pacote.`,
        {
          cargaId,
          status: carga.status,
          permitidos: ALLOWED_CARGO_STATUSES,
          code: "carga_status_invalido",
        },
      );
    }

    // D-05: pacote publicado exige todas cargas PREMIUM + OPEN.
    if (pacote.status === PACOTE_STATUS.PUBLICADO) {
      if (carga.driver_visibility !== "PREMIUM") {
        throw new ValidationError(
          "Pacote publicado exige cargas PREMIUM (D-05).",
          {
            cargaId,
            driver_visibility: carga.driver_visibility,
            code: "carga_nao_premium",
          },
        );
      }
      if (carga.status !== "OPEN") {
        throw new ValidationError(
          "Pacote publicado exige cargas em status 'OPEN'.",
          { cargaId, status: carga.status, code: "carga_nao_aberta" },
        );
      }
    }

    const ordemFinal = ordem ?? totalCargas + 1;

    // Verifica se a ordem solicitada ja esta ocupada por outra carga do pacote.
    if (typeof ordem === "number") {
      const { rows: conflict } = await client.query(
        `SELECT id FROM public.cargas WHERE viagem_id = $1 AND ordem_viagem = $2`,
        [pacoteId, ordemFinal],
      );
      if (conflict.length > 0) {
        throw new ConflictError(
          `Ordem ${ordemFinal} ja esta ocupada nesse pacote.`,
          { pacoteId, ordem: ordemFinal, code: "ordem_em_uso" },
        );
      }
    }

    await client.query(
      `UPDATE public.cargas
          SET viagem_id = $2, ordem_viagem = $3, updated_at = now()
        WHERE id = $1`,
      [cargaId, pacoteId, ordemFinal],
    );

    let novaVersion = pacote.version;
    if (pacote.status === PACOTE_STATUS.PUBLICADO) {
      novaVersion = await bumpPacoteVersion(client, pacoteId);
    }

    await auditPacoteEvent(client, {
      eventType: "operator.pacote.carga.added",
      actorUserId: operatorId,
      pacoteId,
      action: "add-carga",
      requestIp,
      correlationId,
      metadata: { cargaId, ordem: ordemFinal, version: novaVersion },
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        pacoteId,
        cargaId,
        ordem: ordemFinal,
        version: novaVersion,
        total_cargas: totalCargas + 1,
        meta: { correlationId: correlationId || null },
      },
    };
  });
}
