// backend/src/application/candidatura/use-cases/submit-final.js
//
// Submit final do wizard de candidatura v2 (plan 07-04).
//
// Responsabilidades:
//   1. Idempotency: id_cadastro = 'CAD-V2-' + Idempotency-Key. Replay retorna 200
//      com a row existente (sem ANTT extra, sem audit duplicado).
//   2. Conflito de carga: se outra row aprovada para o mesmo carga_id existe,
//      retornar 409.
//   3. Owner reuse logic (CADASTRO-08):
//        - cavalo.owner_doc == driverCpf  → motorista vira owner (skip C).
//        - carreta.owner_doc == driverCpf → reuse motorista.
//        - carreta.owner_doc == cavalo.owner.doc → reuse cavalo_owner (skip E).
//        - caso contrario: novo cascade ANTT.
//   4. ANTT cascade por owner unico (D-12). Fallback manual (ocr_fallback_manual=true
//      ou cpf_owner_manual=true) NAO impede a cascata — apenas marca o motivo.
//   5. Protocolo via sequence (B-01): formato CAD-YYYY-NNNNN persistido em
//      dados.protocolo (sem nova coluna).
//   6. W-09: dados.motorista.telefone_primario = dados.motorista.telefones[0]
//      antes do INSERT/UPDATE.
//   7. INSERT (ou UPDATE se draft do mesmo driver) preenchendo TODAS as colunas
//      v2: versao_cadastro='v2', pancary_*, dados_bancarios, pis, cor_veiculo,
//      estado_civil, rastreador_detalhes, carga_id, driver_user_id, status='pendente'.
//   8. insertSecurityAuditEvent — metadata SEM `dados` (PII).

import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { resolveAnttCascade } from "./antt-cascade.js";

function stripDocDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * Garante telefone_primario = telefones[0] (W-09).
 * Muta o objeto motorista (caller passa por referencia).
 */
function ensureTelefonePrimarioMirror(motorista) {
  if (motorista && Array.isArray(motorista.telefones) && motorista.telefones.length > 0) {
    motorista.telefone_primario = motorista.telefones[0];
  }
}

/**
 * Aplica owner reuse logic e roda ANTT cascade para cada owner unico.
 * Devolve metadata de reuse + hits para audit + payload pronto para persistir.
 *
 * @param {Object} args
 * @param {Object} args.dados Payload validado pelo schema (mutavel).
 * @param {string} args.driverCpf CPF do driver autenticado (sem mascara).
 * @param {string} [args.correlationId]
 */
async function applyOwnerReuseAndCascade({ dados, driverCpf, correlationId, disableOwnerReuseByDriver = false }) {
  // A2 fix — no fluxo publico (sem login), o CPF declarado pelo cliente nao e
  // source-of-truth. Forcamos normalizedDriverCpf="" para que owner-reuse-by-
  // driver nunca dispare; cavalo/carreta owner sempre roda cascata ANTT (D-12).
  const normalizedDriverCpf = disableOwnerReuseByDriver ? "" : stripDocDigits(driverCpf);

  const cavaloOwnerDoc = stripDocDigits(dados.cavalo?.owner_doc);
  const cavaloOwnerIsDriver = cavaloOwnerDoc === normalizedDriverCpf && normalizedDriverCpf.length > 0;

  const reuse = {
    cavalo_owner_is_driver: cavaloOwnerIsDriver,
    carreta_owners_reused: [],
  };
  const anttHits = [];

  // ── Cascada ANTT para owner do cavalo ─────────────────────────────────────
  if (!cavaloOwnerIsDriver && dados.cavalo?.owner_doc) {
    const cascadeResult = await resolveAnttCascade({
      docType: dados.cavalo.owner_doc_type || "cpf",
      doc: dados.cavalo.owner_doc,
      placa: dados.cavalo.placa,
      correlationId,
    });

    const cascadeTitularDoc = cascadeResult.titular_doc
      ? stripDocDigits(cascadeResult.titular_doc)
      : "";
    const cascadeTitularDiff =
      cascadeTitularDoc.length > 0 && cascadeTitularDoc !== cavaloOwnerDoc;

    anttHits.push({
      owner_doc: cavaloOwnerDoc,
      placa: dados.cavalo.placa,
      source: cascadeResult.source,
      requires_upload: cascadeResult.requiresUpload === true,
      cascade_titular_diff: cascadeTitularDiff,
      cascade_titular_doc: cascadeTitularDoc || null,
    });

    // Se ja existe cavalo_owner com rntrc preenchido manualmente (upload), respeitar.
    // Caso contrario, anexar resultado da cascade ao cavalo_owner.
    if (dados.cavalo_owner) {
      if (!dados.cavalo_owner.rntrc && cascadeResult.rntrc) {
        dados.cavalo_owner.rntrc = cascadeResult.rntrc;
        dados.cavalo_owner.rntrc_via = "antt";
      }

      // FEAT-ANTT-TITULAR — quando o frontend enviou antt_titular, rodamos uma
      // segunda cascade para confirmar que o RNTRC esta ATIVO na ANTT em nome
      // daquele titular. Resultado anexado ao bloco antt_titular do cavalo_owner.
      if (dados.cavalo_owner.antt_titular?.doc) {
        const titularCascade = await resolveAnttCascade({
          docType: dados.cavalo_owner.antt_titular.tipo === "pj" ? "cnpj" : "cpf",
          doc: dados.cavalo_owner.antt_titular.doc,
          placa: dados.cavalo.placa,
          correlationId,
        });
        anttHits.push({
          owner_doc: stripDocDigits(dados.cavalo_owner.antt_titular.doc),
          placa: dados.cavalo.placa,
          source: titularCascade.source,
          requires_upload: titularCascade.requiresUpload === true,
          via: "antt_titular_cavalo",
        });
        if (titularCascade.rntrc && !dados.cavalo_owner.antt_titular.rntrc) {
          dados.cavalo_owner.antt_titular.rntrc = titularCascade.rntrc;
        }
      }
    }
  }

  // ── Cascada ANTT para cada carreta_owner UNICO ───────────────────────────
  const carretas = Array.isArray(dados.carretas) ? dados.carretas : [];
  const carretaOwners = Array.isArray(dados.carreta_owners) ? dados.carreta_owners : [];

  for (let i = 0; i < carretas.length; i++) {
    const carreta = carretas[i];
    const carretaOwnerDoc = stripDocDigits(carreta.owner_doc);

    let reuseFlag = "none";
    if (carretaOwnerDoc === normalizedDriverCpf && normalizedDriverCpf.length > 0) {
      reuseFlag = "driver";
    } else if (carretaOwnerDoc === cavaloOwnerDoc && cavaloOwnerDoc.length > 0) {
      reuseFlag = "cavalo_owner";
    }
    reuse.carreta_owners_reused.push(reuseFlag);

    if (reuseFlag === "none") {
      const cascadeResult = await resolveAnttCascade({
        docType: carreta.owner_doc_type || "cpf",
        doc: carreta.owner_doc,
        placa: carreta.placa,
        correlationId,
      });

      const cascadeTitularDoc = cascadeResult.titular_doc
        ? stripDocDigits(cascadeResult.titular_doc)
        : "";
      const cascadeTitularDiff =
        cascadeTitularDoc.length > 0 && cascadeTitularDoc !== carretaOwnerDoc;

      anttHits.push({
        owner_doc: carretaOwnerDoc,
        placa: carreta.placa,
        source: cascadeResult.source,
        requires_upload: cascadeResult.requiresUpload === true,
        cascade_titular_diff: cascadeTitularDiff,
        cascade_titular_doc: cascadeTitularDoc || null,
      });

      const carretaOwner = carretaOwners[i];
      if (carretaOwner) {
        if (!carretaOwner.rntrc && cascadeResult.rntrc) {
          carretaOwner.rntrc = cascadeResult.rntrc;
          carretaOwner.rntrc_via = "antt";
        }

        // FEAT-ANTT-TITULAR — segunda cascade quando frontend enviou antt_titular.
        if (carretaOwner.antt_titular?.doc) {
          const titularCascade = await resolveAnttCascade({
            docType: carretaOwner.antt_titular.tipo === "pj" ? "cnpj" : "cpf",
            doc: carretaOwner.antt_titular.doc,
            placa: carreta.placa,
            correlationId,
          });
          anttHits.push({
            owner_doc: stripDocDigits(carretaOwner.antt_titular.doc),
            placa: carreta.placa,
            source: titularCascade.source,
            requires_upload: titularCascade.requiresUpload === true,
            via: `antt_titular_carreta_${i}`,
          });
          if (titularCascade.rntrc && !carretaOwner.antt_titular.rntrc) {
            carretaOwner.antt_titular.rntrc = titularCascade.rntrc;
          }
        }
      }
    }
  }

  return { reuse, anttHits };
}

/**
 * Gera protocolo via sequence cadastro_protocolo_seq.
 * Falha (sequence ausente) lanca erro com mensagem clara.
 */
async function mintProtocolo(client) {
  try {
    const { rows } = await client.query(
      `SELECT to_char(now(),'YYYY')||'-'||LPAD(nextval('public.cadastro_protocolo_seq')::text,5,'0') AS protocolo`,
    );
    return rows[0]?.protocolo || null;
  } catch (err) {
    const message =
      "Falha ao gerar protocolo: sequence cadastro_protocolo_seq ausente ou inacessivel. Verifique a migration do plan 01.";
    const wrapped = new Error(message);
    wrapped.cause = err;
    wrapped.code = "PROTOCOLO_SEQUENCE_UNAVAILABLE";
    throw wrapped;
  }
}

/**
 * Use case principal: persiste candidatura submetida com idempotency, ANTT cascade
 * e audit. Mantem 100% de backcompat com v1 (rows pre-existentes ignoram colunas v2).
 *
 * @param {Object} args
 * @param {string} args.driverUserId UUID do motorista (auth.users.id, D-01).
 * @param {string} args.driverCpf CPF do driver (driver_profiles.document_number, D-02).
 * @param {string} args.cargaId  ID da carga em contexto (D-03/D-10).
 * @param {string} args.idempotencyKey Header Idempotency-Key.
 * @param {Object} args.dados Payload validado pelo zod schema.
 * @param {string} [args.requestIp]
 * @param {string} [args.correlationId]
 */
export async function submitCandidaturaFinal({
  driverUserId,
  driverCpf,
  cargaId,
  idempotencyKey,
  dados,
  requestIp,
  correlationId,
  disableOwnerReuseByDriver = false,
}) {
  if (!idempotencyKey) {
    throw new Error("submitCandidaturaFinal exige idempotencyKey.");
  }

  const idCadastro = `CAD-V2-${idempotencyKey}`;

  return withPgTransaction(async (client) => {
    // A3 fix — advisory lock por carga_id serializa submits concorrentes para
    // a mesma carga, eliminando race condition no conflict-check abaixo. Lock
    // e auto-released no COMMIT/ROLLBACK (xact scope).
    // Best-effort: se a query falhar (ex.: mock de teste), seguimos sem bloquear.
    try {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('carga:' || $1::text))`,
        [cargaId],
      );
    } catch {
      /* advisory lock best-effort */
    }

    // ── 1) Idempotency check ──────────────────────────────────────────────
    const existing = await client.query(
      `
        SELECT id, dados->>'protocolo' AS protocolo, status
        FROM public.pending_driver_registrations
        WHERE id_cadastro = $1
      `,
      [idCadastro],
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      return {
        statusCode: 200,
        payload: {
          id: row.id,
          protocolo: row.protocolo,
          meta: { correlationId, idempotentReplay: true },
        },
      };
    }

    // ── 2) Conflito de carga (alguem ja aprovado para o mesmo carga_id) ──
    const conflict = await client.query(
      `
        SELECT id
        FROM public.pending_driver_registrations
        WHERE carga_id = $1
          AND status = 'aprovado'
        LIMIT 1
      `,
      [cargaId],
    );

    if (conflict.rows.length > 0) {
      return {
        statusCode: 409,
        payload: {
          error: "CargaAlreadyApproved",
          message:
            "Esta carga ja foi alocada para outro motorista. Atualize a lista de cargas.",
          meta: { correlationId },
        },
      };
    }

    // ── 2b) Iter #7: Duplicate detection por (cpf, horsePlate) ────────────
    // Antes de criar nova row, checa se ja existe cadastro pendente para a
    // MESMA combinacao (cpf, placa cavalo) nos ultimos 30 dias. Se sim,
    // reaproveita: cria APENAS o lead/claim na carga atual (caller faz isso
    // separadamente), mas NAO duplica a row em pending_driver_registrations.
    const cpfDigits = String(driverCpf || "").replace(/\D/g, "");
    const horsePlate = String(dados?.cavalo?.placa || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (cpfDigits.length === 11 && horsePlate.length >= 7) {
      const dup = await client.query(
        `
          SELECT id, status, dados->>'protocolo' AS protocolo
          FROM public.pending_driver_registrations
          WHERE dados->'motorista'->>'cpf' = $1
            AND dados->'cavalo'->>'placa' = $2
            AND status IN ('pendente', 'em_revisao', 'em_analise')
            AND created_at > now() - interval '30 days'
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [cpfDigits, horsePlate],
      );
      if (dup.rows.length > 0) {
        const existingRow = dup.rows[0];
        // Audit do reuse — actor pode ser null (publico) ou driver autenticado.
        await insertSecurityAuditEvent(client, {
          eventType: "driver.candidatura.reused_existing_pending",
          actorUserId: driverUserId,
          actorRole: driverUserId ? "driver" : "anonymous_driver",
          resourceType: "pending_driver_registration",
          resourceId: existingRow.id,
          action: "reuse",
          outcome: "success",
          requestIp,
          correlationId,
          metadata: {
            existing_id: existingRow.id,
            existing_status: existingRow.status,
            carga_id: cargaId,
            cpf_masked: `${cpfDigits.slice(0, 3)}***`,
          },
        });
        return {
          statusCode: 200,
          payload: {
            id: existingRow.id,
            protocolo: existingRow.protocolo || null,
            reusedExisting: true,
            existingStatus: existingRow.status,
            message:
              "Cadastro existente reaproveitado — voce nao precisa enviar tudo de novo.",
            meta: { correlationId },
          },
        };
      }
    }

    // ── 3) Owner reuse + ANTT cascade ────────────────────────────────────
    // TODO A4 (P1) — applyOwnerReuseAndCascade roda fetch HTTP ao sidecar ANTT
    // DENTRO da transacao (segura pool/locks por ate ~180s). Refactor sugerido:
    // rodar cascata ANTES do BEGIN e passar resultados como argumento.
    const { reuse, anttHits } = await applyOwnerReuseAndCascade({
      dados,
      driverCpf,
      correlationId,
      disableOwnerReuseByDriver,
    });

    // ── 4) W-09: garantir telefone_primario espelho de telefones[0] ──────
    ensureTelefonePrimarioMirror(dados.motorista);

    // ── 5) Protocolo via sequence ────────────────────────────────────────
    const protocolo = await mintProtocolo(client);
    if (!protocolo) {
      return {
        statusCode: 500,
        payload: {
          error: "ProtocoloUnavailable",
          message: "Nao foi possivel gerar o protocolo de candidatura.",
          meta: { correlationId },
        },
      };
    }

    // Anexa protocolo + flags ao payload JSONB que sera persistido.
    dados.protocolo = protocolo;
    dados.owner_reuse = reuse;

    // ── 6) Monta colunas dedicadas v2 ────────────────────────────────────
    const pancaryAutodeclaration = dados.motorista?.pancary_autodeclaration || null;
    const corVeiculo = dados.cavalo?.cor || null;
    const pis = dados.cavalo_owner?.pis || null;
    const estadoCivil = dados.cavalo_owner?.estado_civil || null;
    const rastreadorDetalhes = dados.motorista?.rastreador || null;

    // dados_bancarios JSONB: array com cavalo_owner + carreta_owners (apenas owners nao-reused).
    const dadosBancariosArr = [];
    if (!reuse.cavalo_owner_is_driver && dados.cavalo_owner?.dados_bancarios) {
      dadosBancariosArr.push({
        owner_doc: dados.cavalo_owner.doc,
        owner_role: "cavalo",
        ...dados.cavalo_owner.dados_bancarios,
      });
    }
    if (Array.isArray(dados.carreta_owners)) {
      dados.carreta_owners.forEach((owner, i) => {
        if (reuse.carreta_owners_reused[i] === "none" && owner?.dados_bancarios) {
          dadosBancariosArr.push({
            owner_doc: owner.doc,
            owner_role: `carreta_${i}`,
            ...owner.dados_bancarios,
          });
        }
      });
    }
    const dadosBancariosJson = dadosBancariosArr.length > 0 ? dadosBancariosArr : null;

    // ── 7) Update se draft do mesmo driver existe; senao INSERT novo. ────
    // No-auth flow: driverUserId=null → draft lookup retorna zero rows (safe).
    const draftExisting = driverUserId
      ? await client.query(
          `
          SELECT id
          FROM public.pending_driver_registrations
          WHERE driver_user_id = $1
            AND status = 'draft'
            AND versao_cadastro = 'v2'
          FOR UPDATE
        `,
          [driverUserId],
        )
      : { rows: [] };

    let rowId;
    if (draftExisting.rows.length > 0) {
      rowId = draftExisting.rows[0].id;
      await client.query(
        `
          UPDATE public.pending_driver_registrations
          SET id_cadastro             = $1,
              status                  = 'pendente',
              dados                   = $2::jsonb,
              carga_id                = $3,
              pancary_autodeclaration = $4,
              pancary_validation_source = 'autodeclaration',
              dados_bancarios         = $5::jsonb,
              pis                     = $6,
              cor_veiculo             = $7,
              estado_civil            = $8,
              rastreador_detalhes     = $9::jsonb
          WHERE id = $10
        `,
        [
          idCadastro,
          JSON.stringify(dados),
          cargaId,
          pancaryAutodeclaration,
          dadosBancariosJson ? JSON.stringify(dadosBancariosJson) : null,
          pis,
          corVeiculo,
          estadoCivil,
          rastreadorDetalhes ? JSON.stringify(rastreadorDetalhes) : null,
          rowId,
        ],
      );
    } else {
      const inserted = await client.query(
        `
          INSERT INTO public.pending_driver_registrations (
            id_cadastro,
            status,
            versao_cadastro,
            driver_user_id,
            carga_id,
            dados,
            pancary_autodeclaration,
            pancary_validation_source,
            dados_bancarios,
            pis,
            cor_veiculo,
            estado_civil,
            rastreador_detalhes
          )
          VALUES (
            $1, 'pendente', 'v2', $2, $3, $4::jsonb,
            $5, 'autodeclaration', $6::jsonb, $7, $8, $9, $10::jsonb
          )
          RETURNING id
        `,
        [
          idCadastro,
          driverUserId,
          cargaId,
          JSON.stringify(dados),
          pancaryAutodeclaration,
          dadosBancariosJson ? JSON.stringify(dadosBancariosJson) : null,
          pis,
          corVeiculo,
          estadoCivil,
          rastreadorDetalhes ? JSON.stringify(rastreadorDetalhes) : null,
        ],
      );
      rowId = inserted.rows[0]?.id;
    }

    // ── 8) Audit (SEM `dados` no metadata — PII) ─────────────────────────
    await insertSecurityAuditEvent(client, {
      eventType: "driver.candidatura.submitted",
      actorUserId: driverUserId,
      actorRole: "driver",
      resourceType: "pending_driver_registration",
      resourceId: rowId,
      action: "create",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        id: rowId,
        id_cadastro: idCadastro,
        protocolo,
        carga_id: cargaId,
        owner_reuse: reuse,
        antt_hits: anttHits,
      },
    });

    return {
      statusCode: 201,
      payload: {
        id: rowId,
        protocolo,
        meta: { correlationId },
      },
    };
  });
}
