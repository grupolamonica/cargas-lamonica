import crypto from "node:crypto";

import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { draftTokenMatches, mintDraftToken } from "../../../domain/candidatura/draft-token.js";

// TTL SLIDING: 72 horas desde o ultimo updated_at (D-05 + B-03).
const DRAFT_TTL_MS = 72 * 60 * 60 * 1000;

function computeExpiresAtIso(updatedAt) {
  if (updatedAt instanceof Date) {
    return new Date(updatedAt.getTime() + DRAFT_TTL_MS).toISOString();
  }
  return new Date(new Date(updatedAt).getTime() + DRAFT_TTL_MS).toISOString();
}

function maskCpf(cpf) {
  const digits = String(cpf || "").replace(/\D/g, "");
  if (digits.length === 0) return "***";
  return `${digits.slice(0, 3)}***`;
}

/**
 * Upsert do draft PUBLICO (motorista sem session Supabase) — Bug-8.
 *
 * Identifica o draft por (cpf, status='draft', versao='v2') extraindo o CPF
 * via JSONB path `dados->'motorista'->>'cpf'`. Mantem a regra de 1 draft ativo
 * por CPF, complementar ao indice por driver_user_id usado no fluxo logado.
 *
 * @param {Object} args
 * @param {string} args.cpf CPF normalizado (11 digitos).
 * @param {string} args.cargaId
 * @param {Object} args.dados
 * @param {string} [args.requestIp]
 * @param {string} [args.correlationId]
 */
export async function saveCandidaturaDraftByCpf({
  cpf,
  cargaId,
  dados,
  draftToken,
  requestIp,
  correlationId,
}) {
  // Garante que o CPF do form e o CPF do payload batam — evita confusao
  // entre wizards anonimos abertos lado a lado no mesmo browser.
  const dadosWithCpf = {
    ...(dados || {}),
    motorista: {
      ...((dados && dados.motorista) || {}),
      cpf,
    },
  };

  return withPgTransaction(async (client) => {
    // Lock pessimista por CPF (advisory) pra serializar concorrencia anonima.
    // Hash do CPF em bigint via md5 -> primeiros 16 hex chars -> int64.
    const lockKey = parseInt(
      crypto.createHash("md5").update(`draft-cpf:${cpf}`).digest("hex").slice(0, 15),
      16,
    );
    await client.query("SELECT pg_advisory_xact_lock($1)", [lockKey]);

    const existing = await client.query(
      `
        SELECT id, id_cadastro, draft_token_hash
        FROM public.pending_driver_registrations
        WHERE status = 'draft'
          AND versao_cadastro = 'v2'
          AND driver_user_id IS NULL
          AND dados->'motorista'->>'cpf' = $1
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      [cpf],
    );

    let row;
    let idCadastro;
    // Só volta preenchido quando um token NOVO é emitido (rascunho novo ou
    // adoção de legado). Numa gravação normal o cliente já tem o dele.
    let issuedToken = null;

    if (existing.rows.length > 0) {
      const draftId = existing.rows[0].id;
      idCadastro = existing.rows[0].id_cadastro;
      const storedHash = existing.rows[0].draft_token_hash;

      let tokenHashToPersist = storedHash;

      if (storedHash) {
        // Rascunho já tem dono. Sem o token certo, não se escreve nele — este é
        // o fecho do ALTO-3 (poisoning anônimo de rascunho alheio por CPF).
        if (!draftTokenMatches(draftToken, storedHash)) {
          await insertSecurityAuditEvent(client, {
            eventType: "driver.candidatura.draft_token_rejected",
            actorUserId: null,
            actorRole: "anonymous_driver",
            resourceType: "pending_driver_registration",
            resourceId: draftId,
            action: "update",
            outcome: "denied",
            requestIp,
            correlationId,
            metadata: { cpf_masked: maskCpf(cpf), reason: draftToken ? "token_mismatch" : "token_missing" },
          });

          return {
            statusCode: 403,
            payload: {
              error: "Forbidden",
              message:
                "Este rascunho pertence a outra sessao. Recomece o cadastro neste dispositivo.",
              meta: { correlationId },
            },
          };
        }
      } else {
        // Rascunho LEGADO (criado antes da migration, sem token). Adota: emite
        // um token agora e devolve pro cliente. A janela em que um rascunho
        // legado pode ser adotado por quem souber o CPF é a mesma exposicao que
        // ja existia, e fecha sozinha — rascunho expira em 72h.
        const minted = mintDraftToken();
        issuedToken = minted.token;
        tokenHashToPersist = minted.hash;
      }

      const updated = await client.query(
        `
          UPDATE public.pending_driver_registrations
          SET dados = $2::jsonb,
              carga_id = $3,
              draft_token_hash = $4
          WHERE id = $1
          RETURNING id, updated_at
        `,
        [draftId, JSON.stringify(dadosWithCpf), cargaId, tokenHashToPersist],
      );
      row = updated.rows[0];
    } else {
      idCadastro = `CAD-V2-${crypto.randomUUID()}`;
      const minted = mintDraftToken();
      issuedToken = minted.token;
      const inserted = await client.query(
        `
          INSERT INTO public.pending_driver_registrations (
            id_cadastro,
            status,
            versao_cadastro,
            driver_user_id,
            carga_id,
            dados,
            draft_token_hash
          )
          VALUES ($1, 'draft', 'v2', NULL, $2, $3::jsonb, $4)
          RETURNING id, updated_at
        `,
        [idCadastro, cargaId, JSON.stringify(dadosWithCpf), minted.hash],
      );
      row = inserted.rows[0];
    }

    const id = row.id;
    const expiresAt = computeExpiresAtIso(row.updated_at);

    await insertSecurityAuditEvent(client, {
      eventType: "driver.candidatura.draft_saved_anonymous",
      actorUserId: null,
      actorRole: "anonymous_driver",
      resourceType: "pending_driver_registration",
      resourceId: id,
      action: existing.rows.length > 0 ? "update" : "create",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        id_cadastro: idCadastro,
        carga_id: cargaId,
        cpf_masked: maskCpf(cpf),
      },
    });

    return {
      statusCode: 200,
      payload: {
        id,
        expiresAt,
        // Só presente quando o token acabou de ser emitido. O cliente guarda e
        // reapresenta nas leituras/gravações seguintes.
        ...(issuedToken ? { draftToken: issuedToken } : {}),
        meta: { correlationId },
      },
    };
  });
}
