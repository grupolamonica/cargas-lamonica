import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { submitCandidaturaFinal } from "../../candidatura/use-cases/submit-final.js";

/**
 * Submete um rascunho (status='draft') em nome do motorista, acionado pelo
 * operador no painel (resgate de cadastro). Reusa exatamente o pipeline de
 * submissão do motorista (`submitCandidaturaFinal`) — protocolo, cascata ANTT,
 * owner-reuse, idempotência — de modo que o registro 'pendente' resultante é
 * idêntico a uma submissão feita pelo próprio motorista. Ao final, a row de
 * rascunho de origem é consumida (apagada), saindo da aba Rascunhos.
 *
 * Idempotência: a key é derivada do id do rascunho, então reenviar o mesmo
 * rascunho retorna o 'pendente' já criado (sem duplicar) e apenas re-tenta a
 * limpeza da row de origem.
 *
 * @param {object} args
 * @param {string} args.cadastroId  UUID da row de rascunho em pending_driver_registrations.
 * @param {Record<string, unknown>} args.dados  Estado final do wizard (validado no handler).
 * @param {string} [args.operatorId]
 * @param {string} [args.requestIp]
 * @param {string} [args.correlationId]
 */
export async function submitDraftAsOperator({
  cadastroId,
  dados,
  operatorId,
  requestIp,
  correlationId,
}) {
  // 1) Carrega a row de rascunho — fonte de carga_id e driver_user_id.
  const draft = await withPgClient(async (client) => {
    const { rows } = await client.query(
      `
        SELECT id, status, carga_id, driver_user_id, dados
        FROM public.pending_driver_registrations
        WHERE id = $1
      `,
      [cadastroId],
    );
    return rows[0] ?? null;
  });

  if (!draft) {
    return {
      statusCode: 404,
      payload: {
        error: "NotFound",
        message: "Rascunho não encontrado.",
        meta: { correlationId },
      },
    };
  }

  if (draft.status !== "draft") {
    return {
      statusCode: 409,
      payload: {
        error: "Conflict",
        message: "Este cadastro não está mais em rascunho (já foi submetido ou processado).",
        meta: { correlationId },
      },
    };
  }

  const effectiveDados =
    dados && typeof dados === "object" ? dados : draft.dados && typeof draft.dados === "object" ? draft.dados : null;

  const driverCpf = String(effectiveDados?.motorista?.cpf ?? "").replace(/\D/g, "");
  if (driverCpf.length !== 11) {
    return {
      statusCode: 400,
      payload: {
        error: "BadRequest",
        message: "CPF do motorista é obrigatório e deve ter 11 dígitos para submeter.",
        meta: { correlationId },
      },
    };
  }

  // 2) Reusa o pipeline canônico de submissão do motorista.
  const runSubmit = (cargaIdArg) =>
    submitCandidaturaFinal({
      driverUserId: draft.driver_user_id ?? null,
      driverCpf,
      cargaId: cargaIdArg,
      idempotencyKey: cargaIdArg
        ? `op-resgate-${cadastroId}`
        : `op-resgate-standalone-${cadastroId}`,
      dados: effectiveDados,
      requestIp,
      correlationId,
      // Sem driver autenticado declarando o próprio CPF: mesma proteção do fluxo
      // público — não confia em motorista.cpf == cavalo.owner_doc para pular ANTT.
      disableOwnerReuseByDriver: !draft.driver_user_id,
    });

  let result;
  try {
    result = await runSubmit(draft.carga_id ?? null);

    // Resgate: se a carga já foi alocada a outro motorista (409 CargaAlreadyApproved),
    // o objetivo do operador continua sendo finalizar o cadastro do motorista —
    // re-submete em modo standalone (carga_id=NULL). O 'pendente' resultante
    // aparece na aba Pendentes para aprovação (sem vínculo à carga tomada).
    if (result?.statusCode === 409 && draft.carga_id) {
      console.warn("[operator.submit-draft] carga já alocada — submetendo standalone", {
        correlationId,
        operatorId,
        cadastroId,
        cargaId: draft.carga_id,
      });
      result = await runSubmit(null);
    }
  } catch (err) {
    // Surface o erro real (ferramenta interna do operador) + log com stack no
    // servidor, em vez do 500 genérico "Unexpected error".
    console.error("[operator.submit-draft] submit-final lançou exceção", {
      correlationId,
      operatorId,
      cadastroId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return {
      statusCode: 500,
      payload: {
        error: "SubmitFailed",
        message: `Falha ao submeter o cadastro: ${
          err instanceof Error && err.message ? err.message : "erro desconhecido"
        }`,
        meta: { correlationId },
      },
    };
  }

  // 3) Consome o rascunho de origem somente quando o submit foi bem-sucedido.
  //    Guard por status='draft' evita apagar uma row que mudou de estado.
  //    Não toca na row 'pendente' recém-criada (id_cadastro distinto).
  const createdId = result?.payload?.id ?? null;
  if (result?.statusCode === 200 && createdId !== cadastroId) {
    try {
      await withPgClient(async (client) => {
        await client.query(
          `DELETE FROM public.pending_driver_registrations WHERE id = $1 AND status = 'draft'`,
          [cadastroId],
        );
      });
    } catch (err) {
      // Limpeza best-effort: o 'pendente' já existe; o rascunho órfão pode ser
      // removido depois. Não falha o submit por causa disso.
      console.warn("[operator.submit-draft.cleanup]", {
        correlationId,
        operatorId,
        cadastroId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
