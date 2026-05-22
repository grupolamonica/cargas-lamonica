// backend/src/application/candidatura/use-cases/verify-document.js
//
// Use case do Bug B (Phase 8, plan 08-20):
// Verifica se um CPF/placa/CPF-proprietario **diferente** do candidatado ja
// existe em cadastro completo/pendente/expirado. Consumido pelo wizard
// cadastro-v2 quando o motorista digita um documento diferente do que veio no
// pre-check inicial (motorista, cavalo, carreta, proprietario cavalo/carreta).
//
// Decisoes locked:
//   * PUBLICO (sem driver-auth) — Tela0 do wizard pode rodar fora de sessao.
//   * Resposta UNIFORME (200 sempre, com `exists: bool`) — reduz enumeration.
//   * 2026-05-18 — Estende com AngelLira + ASPX (era so DB LOCAL). Resiliencia:
//     se ambas as fontes externas falharem, degrada silencioso para DB local.
//   * Nao retorna PII (nome/telefone/endereco). `lastCandidatura` carrega
//     apenas protocolo + datas. `externalRegistration` carrega apenas
//     `source` + `situacao` (e.g. "ATIVO") — nada de nome/cpf.
//
// Tabelas consultadas:
//   * public.pending_driver_registrations (CPF do motorista em dados->>'cpf';
//     placas em dados->'cavalo'->>'placa' e dados->'carretas'[i]->>'placa').
//   * public.vehicles (placa normalizada; angellira_valid_until para vigencia).
//
// Fontes externas:
//   * Angellira: lookupAngelliraDriverByCpf (CPF) / lookupAngelliraPlate (placa).
//   * ASPX: lookupAspxDriverByCpf (CPF) — diretorio populado por job hora-em-hora.
//
// Tipos suportados:
//   * cpf            → CPF do motorista (DB + AngelLira + ASPX).
//   * horsePlate     → placa cavalo (DB + AngelLira).
//   * trailerPlate   → placa carreta (DB + AngelLira).
//   * ownerCpf       → CPF do proprietario do CRLV (DB + AngelLira + ASPX).
//   * ownerCnpj      → CNPJ do proprietario (DB local only — TODO external).
//
// Status mapping retornado:
//   * 'completo'  → status='aprovado' OU dados.protocolo presente E vigencia ok.
//   * 'pendente'  → status in ('pendente','em_revisao','draft','rejeitado').
//   * 'expirado'  → vehicles.angellira_valid_until < now() (somente placas).

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import {
  lookupAngelliraDriverByCpf,
  lookupAngelliraPlate,
} from "../../../infrastructure/angellira/angellira-client.js";
import { lookupAspxDriverByCpf } from "../../../infrastructure/aspx/aspx-directory.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";

const VIGENCIA_DAYS_THRESHOLD = 0; // <= 0 dias significa expirado.

function normalizeCpf(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeCnpj(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizePlate(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Mapeia row de pending_driver_registrations para status canonico:
 *   - aprovado          → 'completo'
 *   - pendente|em_revisao|draft|rejeitado → 'pendente'
 *   - (qualquer outro)  → 'pendente' (fallback defensivo)
 */
function mapRegistrationStatus(rowStatus) {
  const normalized = String(rowStatus || "").trim().toLowerCase();
  if (normalized === "aprovado") return "completo";
  return "pendente";
}

function buildLastCandidatura(row) {
  if (!row) return null;
  // PII-free summary: apenas protocolo (gerado server-side) + datas.
  const protocolo =
    (row.dados && typeof row.dados === "object" && row.dados.protocolo) || null;
  return {
    protocolo: protocolo || null,
    candidatedAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    lastUpdatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/**
 * Procura a candidatura mais recente para o CPF informado.
 * CPF e gravado em dados->'motorista'->>'cpf' (com ou sem mascara).
 * Comparamos pela versao normalizada via regexp_replace.
 */
async function findLatestCandidaturaByCpf(client, cpfDigits) {
  const sql = `
    SELECT id, status, created_at, updated_at, dados
    FROM public.pending_driver_registrations
    WHERE regexp_replace(COALESCE(dados->'motorista'->>'cpf',''), '\\D', '', 'g') = $1
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const { rows } = await client.query(sql, [cpfDigits]);
  return rows[0] || null;
}

/**
 * Procura candidatura mais recente onde o owner do CRLV (cavalo OU carretas)
 * bate com o doc informado (CPF ou CNPJ). Caminhos JSON cobertos:
 *   - dados->'cavalo'->'owner'->>'doc'
 *   - dados->'carretas'[i]->'owner'->>'doc'
 * Comparamos pela versao normalizada (regexp_replace).
 */
async function findLatestCandidaturaByOwnerDoc(client, docDigits) {
  const sql = `
    SELECT id, status, created_at, updated_at, dados
    FROM public.pending_driver_registrations
    WHERE
      regexp_replace(COALESCE(dados->'cavalo'->'owner'->>'doc',''), '\\D', '', 'g') = $1
      OR regexp_replace(COALESCE(dados->'cavalo'->'owner'->>'documento',''), '\\D', '', 'g') = $1
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(dados->'carretas','[]'::jsonb)) AS carreta
        WHERE
          regexp_replace(COALESCE(carreta->'owner'->>'doc',''), '\\D', '', 'g') = $1
          OR regexp_replace(COALESCE(carreta->'owner'->>'documento',''), '\\D', '', 'g') = $1
      )
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const { rows } = await client.query(sql, [docDigits]);
  return rows[0] || null;
}

/**
 * Procura candidatura mais recente cujo cavalo OU alguma carreta bate com a placa.
 * Comparamos uppercase + remove non-alphanum para tolerar variacoes.
 */
async function findLatestCandidaturaByPlate(client, plateNormalized) {
  const sql = `
    SELECT id, status, created_at, updated_at, dados
    FROM public.pending_driver_registrations
    WHERE
      regexp_replace(upper(COALESCE(dados->'cavalo'->>'placa','')), '[^A-Z0-9]', '', 'g') = $1
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(dados->'carretas','[]'::jsonb)) AS carreta
        WHERE regexp_replace(upper(COALESCE(carreta->>'placa','')), '[^A-Z0-9]', '', 'g') = $1
      )
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const { rows } = await client.query(sql, [plateNormalized]);
  return rows[0] || null;
}

/**
 * Consulta vehicles.angellira_valid_until para a placa.
 * Retorna { found: bool, expired: bool, validUntil: Date|null }.
 */
async function lookupVehicleVigency(client, plateNormalized) {
  const sql = `
    SELECT plate, angellira_valid_until
    FROM public.vehicles
    WHERE plate = $1
    LIMIT 1
  `;
  const { rows } = await client.query(sql, [plateNormalized]);
  if (rows.length === 0) {
    return { found: false, expired: false, validUntil: null };
  }
  const row = rows[0];
  const validUntil = row.angellira_valid_until ? new Date(row.angellira_valid_until) : null;
  if (!validUntil || Number.isNaN(validUntil.getTime())) {
    return { found: true, expired: false, validUntil: null };
  }
  // expired se valid_until < hoje (truncar para data-only).
  const todayUtc = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );
  const validUtc = Date.UTC(
    validUntil.getUTCFullYear(),
    validUntil.getUTCMonth(),
    validUntil.getUTCDate(),
  );
  const daysDelta = Math.round((validUtc - todayUtc) / 86_400_000);
  return {
    found: true,
    expired: daysDelta <= VIGENCIA_DAYS_THRESHOLD,
    validUntil,
  };
}

/**
 * Resolve `externalRegistration` consultando AngelLira + ASPX em paralelo.
 * Resiliencia: erros internos das infra ja sao capturados pelo proprio cliente
 * (retornam { availability: 'UNAVAILABLE' }). Aqui apenas combinamos os flags
 * `found`.
 *
 * @returns {Promise<{ source: 'angellira'|'aspx'|'both', situacao: string|null } | null>}
 */
async function resolveExternalDriverRegistration(cpfDigits, { correlationId } = {}) {
  // Paralelo — ambas as fontes ja tem circuit-breaker proprio e nao se bloqueiam.
  const [angellira, aspx] = await Promise.all([
    lookupAngelliraDriverByCpf(cpfDigits, { correlationId }).catch((err) => {
      logStructuredEvent("warn", "candidatura.verify-document.angellira.error", {
        correlationId: correlationId || null,
        message: err instanceof Error ? err.message : String(err),
      });
      return { availability: "UNAVAILABLE", found: false };
    }),
    lookupAspxDriverByCpf(cpfDigits, { correlationId }).catch((err) => {
      logStructuredEvent("warn", "candidatura.verify-document.aspx.error", {
        correlationId: correlationId || null,
        message: err instanceof Error ? err.message : String(err),
      });
      return { availability: "UNAVAILABLE", found: false };
    }),
  ]);

  const angelliraFound = Boolean(angellira?.found);
  const aspxFound = Boolean(aspx?.found);

  if (!angelliraFound && !aspxFound) {
    return null;
  }

  const source = angelliraFound && aspxFound ? "both" : angelliraFound ? "angellira" : "aspx";
  // `situacao`: usa `statusText` do AngelLira quando disponivel; ASPX nao expoe.
  const situacao = angelliraFound && typeof angellira.statusText === "string"
    ? angellira.statusText
    : null;

  return { source, situacao };
}

/**
 * Resolve `externalRegistration` por placa via AngelLira.
 * ASPX nao tem lookup por placa — somente AngelLira.
 */
async function resolveExternalPlateRegistration(plateNormalized, { correlationId } = {}) {
  const angellira = await lookupAngelliraPlate(plateNormalized, { correlationId }).catch((err) => {
    logStructuredEvent("warn", "candidatura.verify-document.angellira-plate.error", {
      correlationId: correlationId || null,
      message: err instanceof Error ? err.message : String(err),
    });
    return { availability: "UNAVAILABLE", found: false };
  });

  if (!angellira?.found) {
    return null;
  }

  const situacao = typeof angellira.statusText === "string" ? angellira.statusText : null;
  return { source: "angellira", situacao };
}

/**
 * @param {Object} args
 * @param {'cpf'|'horsePlate'|'trailerPlate'|'ownerCpf'|'ownerCnpj'} args.type
 * @param {string} args.value
 * @param {string} [args.correlationId]
 * @returns {Promise<{
 *   exists: boolean,
 *   status: 'completo'|'pendente'|'expirado'|null,
 *   lastCandidatura: object|null,
 *   externalRegistration?: { source: 'angellira'|'aspx'|'both', situacao: string|null } | null,
 * }>}
 */
export async function verifyDocument({ type, value, correlationId }) {
  // ── CPF do motorista / CPF do proprietario do CRLV ────────────────────
  if (type === "cpf" || type === "ownerCpf") {
    const cpfDigits = normalizeCpf(value);
    if (cpfDigits.length !== 11) {
      return { exists: false, status: null, lastCandidatura: null };
    }

    return withPgClient(async (client) => {
      // Para `cpf` (motorista) consultamos lookup do motorista. Para `ownerCpf`
      // (proprietario do CRLV) procuramos onde esse CPF aparece como dono do
      // veiculo no JSON da candidatura.
      const localRowPromise =
        type === "cpf"
          ? findLatestCandidaturaByCpf(client, cpfDigits)
          : findLatestCandidaturaByOwnerDoc(client, cpfDigits);

      const externalPromise = resolveExternalDriverRegistration(cpfDigits, {
        correlationId,
      });

      const [row, external] = await Promise.all([localRowPromise, externalPromise]);

      // Nao existe em lugar nenhum.
      if (!row && !external) {
        return { exists: false, status: null, lastCandidatura: null };
      }

      // External presente sem candidatura local → consideramos como cadastro
      // "completo" (motorista ja existe no provedor externo) sem PII no
      // payload. Ainda permite o motorista continuar — apenas informativo.
      if (!row && external) {
        return {
          exists: true,
          status: "completo",
          lastCandidatura: null,
          externalRegistration: external,
        };
      }

      const baseResult = {
        exists: true,
        status: mapRegistrationStatus(row.status),
        lastCandidatura: buildLastCandidatura(row),
      };
      if (external) {
        baseResult.externalRegistration = external;
      }
      return baseResult;
    });
  }

  // ── CNPJ do proprietario do CRLV ──────────────────────────────────────
  // Nao ha lookup externo de CNPJ implementado (AngelLira e ASPX so cobrem
  // CPF de motorista). Mantemos DB local + log de TODO para nao perder o
  // sinal em metrica.
  if (type === "ownerCnpj") {
    const cnpjDigits = normalizeCnpj(value);
    if (cnpjDigits.length !== 14) {
      return { exists: false, status: null, lastCandidatura: null };
    }
    logStructuredEvent("info", "candidatura.verify-document.cnpj.external_skipped", {
      correlationId: correlationId || null,
      reason: "EXTERNAL_CNPJ_LOOKUP_NOT_IMPLEMENTED",
    });
    return withPgClient(async (client) => {
      const row = await findLatestCandidaturaByOwnerDoc(client, cnpjDigits);
      if (!row) {
        return { exists: false, status: null, lastCandidatura: null };
      }
      return {
        exists: true,
        status: mapRegistrationStatus(row.status),
        lastCandidatura: buildLastCandidatura(row),
      };
    });
  }

  // ── Placas (cavalo ou carreta) ────────────────────────────────────────
  if (type === "horsePlate" || type === "trailerPlate") {
    const plate = normalizePlate(value);
    if (plate.length < 7) {
      return { exists: false, status: null, lastCandidatura: null };
    }

    return withPgClient(async (client) => {
      const [candidaturaRow, vigency, external] = await Promise.all([
        findLatestCandidaturaByPlate(client, plate),
        lookupVehicleVigency(client, plate),
        resolveExternalPlateRegistration(plate, { correlationId }),
      ]);

      const hasAnyRegistration =
        Boolean(candidaturaRow) || vigency.found || Boolean(external);

      if (!hasAnyRegistration) {
        return { exists: false, status: null, lastCandidatura: null };
      }

      // Vigencia expirada tem prioridade — o motorista precisa renovar mesmo
      // que o cadastro esteja 'aprovado'.
      if (vigency.expired) {
        const result = {
          exists: true,
          status: "expirado",
          lastCandidatura: buildLastCandidatura(candidaturaRow),
        };
        if (external) result.externalRegistration = external;
        return result;
      }

      if (candidaturaRow) {
        const result = {
          exists: true,
          status: mapRegistrationStatus(candidaturaRow.status),
          lastCandidatura: buildLastCandidatura(candidaturaRow),
        };
        if (external) result.externalRegistration = external;
        return result;
      }

      // Vehicles row OU external presente sem candidatura associada.
      const result = {
        exists: true,
        status: "pendente",
        lastCandidatura: null,
      };
      if (external) result.externalRegistration = external;
      return result;
    });
  }

  // Type fora do enum (defesa em profundidade — o zod schema ja bloquearia).
  return { exists: false, status: null, lastCandidatura: null };
}
