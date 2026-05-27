// backend/src/application/candidatura/use-cases/get-existing-cavalo.js
//
// Skip-Step-B fix — motoristas que ja tem o cavalo (placa) com cadastro
// vigente pulam o Step B do wizard v2, mas o submit-final exige
// `dados.cavalo` completo (cavaloSchema strict: placa, owner_doc,
// owner_doc_type obrigatorios).
//
// Este use case busca o `dados.cavalo` (+ `dados.cavalo_owner`) mais
// recente persistido para o par (driver, placa) e devolve para mesclar
// no payload do submit ANTES da validacao zod.
//
// Fonte de dados: `public.pending_driver_registrations`. Preferimos rows
// `versao_cadastro='v2'` e status `aprovado`/`pendente`. Sem PII em logs.

import { withPgClient } from "../../../infrastructure/pg/postgres.js";

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizePlate(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Busca o objeto `dados.cavalo` (+ `dados.cavalo_owner` quando presente)
 * mais recente para o par (driver, placa). Usado quando o wizard pulou o
 * Step B porque o pre-check classificou a placa como cadastro vigente.
 *
 * @param {Object} args
 * @param {string|null} [args.driverUserId] UUID auth.users.id (preferido).
 * @param {string|null} [args.driverCpf] CPF (11 digitos) — usado quando user_id ausente.
 * @param {string} args.placa Placa do cavalo (normalizada — letras/digitos).
 * @returns {Promise<{ cavalo: Object, cavalo_owner: Object|null }|null>}
 */
export async function getExistingCavalo({
  driverUserId = null,
  driverCpf = null,
  placa = "",
} = {}) {
  const normalizedCpf = digitsOnly(driverCpf);
  const normalizedPlate = normalizePlate(placa);

  if (!normalizedPlate) return null;
  if (!driverUserId && normalizedCpf.length !== 11) return null;

  return withPgClient(async (client) => {
    let rows;

    if (driverUserId) {
      const result = await client.query(
        `
          SELECT dados
          FROM public.pending_driver_registrations
          WHERE driver_user_id = $1
            AND dados ? 'cavalo'
            AND upper(regexp_replace(coalesce(dados->'cavalo'->>'placa',''), '[^A-Za-z0-9]', '', 'g')) = $2
            AND status IN ('pendente', 'aprovado')
          ORDER BY
            CASE WHEN versao_cadastro = 'v2' THEN 0 ELSE 1 END,
            updated_at DESC
          LIMIT 1
        `,
        [driverUserId, normalizedPlate],
      );
      rows = result.rows;
    } else {
      const result = await client.query(
        `
          SELECT dados
          FROM public.pending_driver_registrations
          WHERE dados ? 'cavalo'
            AND regexp_replace(coalesce(dados->'motorista'->>'cpf',''), '\\D', '', 'g') = $1
            AND upper(regexp_replace(coalesce(dados->'cavalo'->>'placa',''), '[^A-Za-z0-9]', '', 'g')) = $2
            AND status IN ('pendente', 'aprovado')
          ORDER BY
            CASE WHEN versao_cadastro = 'v2' THEN 0 ELSE 1 END,
            updated_at DESC
          LIMIT 1
        `,
        [normalizedCpf, normalizedPlate],
      );
      rows = result.rows;
    }

    // Fallback — quando o driver atual nao tem cadastro prior pra essa placa,
    // procura por QUALQUER cadastro aprovado com mesma placa. Necessario quando
    // o pre-check classifica como "completo" via Angellira (vigencia publica)
    // mas o driver nunca cadastrou esse veiculo. Reusa apenas owner_doc /
    // owner_doc_type / metadados publicos do CRLV (placa, renavam, chassi).
    if (!rows || rows.length === 0) {
      const fallback = await client.query(
        `
          SELECT dados
          FROM public.pending_driver_registrations
          WHERE dados ? 'cavalo'
            AND upper(regexp_replace(coalesce(dados->'cavalo'->>'placa',''), '[^A-Za-z0-9]', '', 'g')) = $1
            AND status = 'aprovado'
          ORDER BY updated_at DESC
          LIMIT 1
        `,
        [normalizedPlate],
      );
      rows = fallback.rows;
    }

    if (!rows || rows.length === 0) return null;

    const dados = rows[0].dados;
    const cavalo = dados?.cavalo;
    if (!cavalo || typeof cavalo !== "object") return null;

    const cavalo_owner =
      dados?.cavalo_owner && typeof dados.cavalo_owner === "object"
        ? dados.cavalo_owner
        : null;

    return { cavalo, cavalo_owner };
  });
}
