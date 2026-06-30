import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { consultarBrkPainel } from "../../../infrastructure/brk/brk-client.js";

/**
 * Extrai a MENOR data (a que vence primeiro) dos labels dos componentes do BRK.
 *
 * O robo BRK nao devolve uma data crua de validade — apenas labels textuais por
 * componente, no formato "... vence DD/MM/AAAA". Varremos cada label de
 * `componentes.*.label`, extraimos DD/MM/AAAA via regex, convertemos para ISO
 * (YYYY-MM-DD) e retornamos a menor. Se nenhum label tiver data, retorna null.
 *
 * @param {object|null} componentes - { motorista, cavalo, carreta } (cada um com .label)
 * @returns {string|null} menor data em ISO (YYYY-MM-DD) ou null
 */
export function extractEarliestBrkValidUntil(componentes) {
  if (!componentes || typeof componentes !== "object") {
    return null;
  }

  const isoDates = [];

  for (const componente of Object.values(componentes)) {
    const label = componente && typeof componente.label === "string" ? componente.label : "";
    const match = label.match(/(\d{2})\/(\d{2})\/(\d{4})/);

    if (match) {
      const [, dd, mm, yyyy] = match;
      const iso = `${yyyy}-${mm}-${dd}`;
      // Valida que e uma data real (evita 31/02/2026 virar lixo).
      const parsed = new Date(`${iso}T00:00:00Z`);
      if (!Number.isNaN(parsed.getTime())) {
        isoDates.push(iso);
      }
    }
  }

  if (isoDates.length === 0) {
    return null;
  }

  // ISO YYYY-MM-DD ordena lexicograficamente == cronologicamente.
  isoDates.sort();
  return isoDates[0];
}

/**
 * Consulta o BRK e persiste o resultado no perfil do motorista (driver_profiles),
 * espelhando `syncDriverAngelliraValidation`.
 *
 * - Se availability !== "OK" (UNAVAILABLE/erro/servico fora) -> loga e RETORNA sem
 *   alterar driver_profiles (preserva o ultimo valor bom).
 * - Se OK -> UPDATE das colunas brk_* via matching de CPF identico ao angellira-cache.
 *
 * @param {object} params
 * @param {{ consultarBrkPainel: Function }} [params.client] - injetavel para testes
 * @param {string} params.cpf
 * @param {string[]} [params.placas]
 * @param {string} [params.correlationId]
 */
export async function syncDriverBrkValidation({ client, cpf, placas, correlationId } = {}) {
  const normalizedCpf = String(cpf || "").replace(/\D/g, "");
  if (!normalizedCpf) return { updated: false, reason: "EMPTY_DOCUMENT" };

  const consultar = client?.consultarBrkPainel || consultarBrkPainel;
  const result = await consultar({ cpf: normalizedCpf, placas, correlationId });

  if (!result || result.availability !== "OK") {
    logStructuredEvent("info", "operator-admin.brk-sync.skipped", {
      correlationId: correlationId || null,
      documentNumber: `***${normalizedCpf.slice(-4)}`,
      reason: result?.errorCode || "UNAVAILABLE_RESULT",
    });
    // NAO sobrescreve o ultimo valor bom.
    return { updated: false, reason: result?.errorCode || "UNAVAILABLE_RESULT" };
  }

  const validUntil = extractEarliestBrkValidUntil(result.componentes);
  const detailsJson = result.componentes ? JSON.stringify(result.componentes) : null;
  const conjuntoApto = typeof result.conjunto_apto === "boolean" ? result.conjunto_apto : null;

  return withPgClient(async (pg) => {
    const { rows } = await pg.query(
      `UPDATE public.driver_profiles
       SET
         brk_status = $2,
         brk_conjunto_apto = $3,
         brk_valid_until = $4,
         brk_status_text = $5,
         brk_details = COALESCE($6::jsonb, brk_details),
         brk_checked_at = now(),
         updated_at = now()
       WHERE replace(document_number, '.', '') LIKE '%' || $1 || '%'
         OR replace(replace(document_number, '.', ''), '-', '') = $1
       RETURNING user_id`,
      [
        normalizedCpf,
        result.status || null,
        conjuntoApto,
        validUntil,
        result.label || null,
        detailsJson,
      ],
    );

    const updatedCount = rows.length;
    if (updatedCount > 0) {
      logStructuredEvent("info", "operator-admin.brk-sync.updated", {
        correlationId: correlationId || null,
        documentNumber: `***${normalizedCpf.slice(-4)}`,
        brkStatus: result.status || null,
        conjuntoApto,
        validUntil: validUntil || null,
        matchedDrivers: updatedCount,
      });
    }

    return { updated: updatedCount > 0, matchedDrivers: updatedCount };
  });
}
