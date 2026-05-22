// backend/src/application/candidatura/use-cases/get-existing-motorista.js
//
// Bug 7 fix (Phase 08-cadastro-v2-hardening) — motoristas que retornam (ja cadastrados)
// pulam o Step A do wizard v2, mas o submit-final exige `dados.motorista` completo
// (motoristaSchema strict: nome, telefones, telefone_primario, endereco,
// tag_pedagio, pancary_autodeclaration).
//
// Este use case busca o motorista mais recente persistido para o driver (por
// `driver_user_id` quando autenticado, ou `dados->motorista->cpf` no fluxo
// publico/no-auth) e devolve o objeto `motorista` pronto para mesclar no
// payload do submit ANTES da validacao zod.
//
// Fonte de dados: `public.pending_driver_registrations` — versao_cadastro='v2'
// preferida; se nao houver v2 cai para v1 (status IN ('aprovado','pendente')).
//
// Sem PII em logs. Devolve null se nada encontrado.

import { withPgClient } from "../../../infrastructure/pg/postgres.js";

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * Busca o motorista (objeto `dados.motorista`) mais recente do driver para uso
 * em re-submit (Step A pulado no wizard v2). Prioriza row v2 com status nao-draft;
 * fallback para qualquer row anterior (v1 ou aprovado).
 *
 * @param {Object} args
 * @param {string|null} [args.driverUserId] UUID auth.users.id (preferido).
 * @param {string|null} [args.driverCpf] CPF (11 digitos) — usado quando user_id ausente.
 * @returns {Promise<Object|null>} Objeto motorista persistido ou null.
 */
export async function getExistingMotorista({ driverUserId = null, driverCpf = null } = {}) {
  const normalizedCpf = digitsOnly(driverCpf);

  if (!driverUserId && normalizedCpf.length !== 11) {
    return null;
  }

  return withPgClient(async (client) => {
    // Estrategia: ORDER BY status_priority (pendente/aprovado antes de draft),
    // versao_cadastro v2 antes de v1, mais recente primeiro.
    let rows;

    if (driverUserId) {
      const result = await client.query(
        `
          SELECT dados
          FROM public.pending_driver_registrations
          WHERE driver_user_id = $1
            AND dados ? 'motorista'
            AND status IN ('pendente', 'aprovado')
          ORDER BY
            CASE WHEN versao_cadastro = 'v2' THEN 0 ELSE 1 END,
            updated_at DESC
          LIMIT 1
        `,
        [driverUserId],
      );
      rows = result.rows;
    } else {
      // Fluxo publico (no-auth) — match por CPF dentro do JSON.
      const result = await client.query(
        `
          SELECT dados
          FROM public.pending_driver_registrations
          WHERE dados ? 'motorista'
            AND regexp_replace(coalesce(dados->'motorista'->>'cpf',''), '\\D', '', 'g') = $1
            AND status IN ('pendente', 'aprovado')
          ORDER BY
            CASE WHEN versao_cadastro = 'v2' THEN 0 ELSE 1 END,
            updated_at DESC
          LIMIT 1
        `,
        [normalizedCpf],
      );
      rows = result.rows;
    }

    if (!rows || rows.length === 0) return null;

    const dados = rows[0].dados;
    const motorista = dados?.motorista;
    if (!motorista || typeof motorista !== "object") return null;

    return motorista;
  });
}
