import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { lookupMotorista } from "../../../infrastructure/cadastro-bots/spx-bot-client.js";

/**
 * Mapeia a resposta do lookup read-only do SPX (POST /spx/motorista/lookup) para
 * a SITUACAO do motorista que alimenta o badge do operador.
 *
 * O SPX nao devolve uma data de validade — o sinal util e o situacional. Ordem de
 * prioridade (do mais bloqueante ao menos): bloqueado > inativo > pendente >
 * ativo (na nossa agencia) > outra agencia > cadastrado (generico) > nao cadastrado.
 *
 * Retorna `null` quando o resultado e INCONCLUSIVO (ex.: lookup usou placeholder de
 * CNH/telefone e colidiu) — nesse caso NAO se deve sobrescrever o ultimo valor bom.
 *
 * @param {object|null} lookup - corpo do lookup ({ok, encontrado, na_minha_agencia,
 *   outra_agencia, inativo, bloqueado, request_pendente, inconclusivo, retcode, ...})
 * @returns {{status:string, statusText:string, encontrado:boolean, details:object}|null}
 */
export function mapSpxLookupToVigency(lookup) {
  if (!lookup || lookup.ok !== true || lookup.inconclusivo === true) {
    return null;
  }

  const encontrado = Boolean(lookup.encontrado);
  const details = {
    na_minha_agencia: lookup.na_minha_agencia ?? null,
    outra_agencia: lookup.outra_agencia ?? null,
    inativo: lookup.inativo ?? null,
    bloqueado: lookup.bloqueado ?? null,
    request_pendente: lookup.request_pendente ?? null,
    retcode: lookup.retcode ?? null,
  };

  let status;
  let statusText;

  if (lookup.bloqueado === true) {
    status = "bloqueado";
    statusText = "Bloqueado";
  } else if (lookup.inativo === true) {
    status = "inativo";
    statusText = "Inativo — reativar";
  } else if (lookup.request_pendente === true) {
    status = "pendente";
    statusText = "Solicitação em andamento";
  } else if (lookup.na_minha_agencia === true) {
    status = "ativo";
    statusText = "Ativo na agência";
  } else if (lookup.outra_agencia === true) {
    status = "outra_agencia";
    statusText = "Cadastrado em outra agência";
  } else if (encontrado) {
    status = "cadastrado";
    statusText = "Cadastrado";
  } else {
    status = "nao_cadastrado";
    statusText = "Não cadastrado";
  }

  return { status, statusText, encontrado, details };
}

/**
 * Consulta a situacao do motorista no SPX (read-only) e persiste no perfil
 * (driver_profiles), espelhando `syncDriverBrkValidation`.
 *
 * - Se o lookup falhar (sidecar fora, sessao expirada) ou vier INCONCLUSIVO ->
 *   loga e RETORNA sem alterar driver_profiles (preserva o ultimo valor bom).
 * - Caso contrario -> UPDATE das colunas spx_vigency_* via matching de CPF
 *   identico ao brk-cache/angellira-cache.
 *
 * @param {object} params
 * @param {{ lookupMotorista: Function }} [params.client] - injetavel para testes
 * @param {string} params.cpf
 * @param {string} [params.contactNumber] - telefone real (reduz "inconclusivo")
 * @param {string} [params.correlationId]
 */
export async function syncDriverSpxValidation({ client, cpf, contactNumber, correlationId } = {}) {
  const normalizedCpf = String(cpf || "").replace(/\D/g, "");
  if (!normalizedCpf) return { updated: false, reason: "EMPTY_DOCUMENT" };

  const lookup = client?.lookupMotorista || lookupMotorista;

  let result;
  try {
    result = await lookup({ cpf: normalizedCpf, contactNumber: contactNumber || "", correlationId });
  } catch (error) {
    // Falha transiente (sidecar fora, sessao expirada, CPF invalido) -> nao sobrescreve.
    logStructuredEvent("info", "operator-admin.spx-vigency-sync.skipped", {
      correlationId: correlationId || null,
      documentNumber: `***${normalizedCpf.slice(-4)}`,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { updated: false, reason: "LOOKUP_FAILED" };
  }

  const vigency = mapSpxLookupToVigency(result);
  if (!vigency) {
    logStructuredEvent("info", "operator-admin.spx-vigency-sync.skipped", {
      correlationId: correlationId || null,
      documentNumber: `***${normalizedCpf.slice(-4)}`,
      reason: "INCONCLUSIVE_RESULT",
    });
    return { updated: false, reason: "INCONCLUSIVE_RESULT" };
  }

  const detailsJson = vigency.details ? JSON.stringify(vigency.details) : null;

  return withPgClient(async (pg) => {
    const { rows } = await pg.query(
      `UPDATE public.driver_profiles
       SET
         spx_vigency_status = $2,
         spx_vigency_status_text = $3,
         spx_vigency_encontrado = $4,
         spx_vigency_details = COALESCE($5::jsonb, spx_vigency_details),
         spx_vigency_checked_at = now(),
         updated_at = now()
       WHERE replace(document_number, '.', '') LIKE '%' || $1 || '%'
         OR replace(replace(document_number, '.', ''), '-', '') = $1
       RETURNING user_id`,
      [
        normalizedCpf,
        vigency.status || null,
        vigency.statusText || null,
        vigency.encontrado,
        detailsJson,
      ],
    );

    const updatedCount = rows.length;
    if (updatedCount > 0) {
      logStructuredEvent("info", "operator-admin.spx-vigency-sync.updated", {
        correlationId: correlationId || null,
        documentNumber: `***${normalizedCpf.slice(-4)}`,
        spxStatus: vigency.status || null,
        encontrado: vigency.encontrado,
        matchedDrivers: updatedCount,
      });
    }

    return { updated: updatedCount > 0, matchedDrivers: updatedCount };
  });
}
