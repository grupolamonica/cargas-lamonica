import { withPgClient } from "../../infrastructure/pg/postgres.js";

/** CPF só com dígitos. */
export function normalizeCpf(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * Deduplicação por CPF (PRD §7) — a espinha da "entidade única de motorista".
 * Um motorista é UMA entidade, independentemente do canal (WhatsApp/Repom, wizard
 * web, operação manual). Esta função SÓ LÊ (não cria/atualiza nada) e consulta:
 *
 *   - public.driver_profiles              → motorista já OFICIAL (aprovar gera este registro);
 *   - public.pending_driver_registrations → cadastro em curso (CPF em dados->'motorista'->>'cpf').
 *
 * O CPF é casado pela versão só-dígitos (regexp_replace), tolerando máscara —
 * mesmo padrão de candidatura/verify-document.
 *
 * Casos (espelham o §7 do PRD):
 *   0 invalid          CPF ≠ 11 dígitos
 *   1 create           CPF não existe em lugar nenhum → criar novo
 *   2 continue         cadastro incompleto (draft) → continuar
 *   3 resume           cadastro em andamento (pendente/em_revisao) → retomar
 *   4 inform_approved  já é motorista oficial / cadastro aprovado → informar (nunca duplicar)
 *   5 reopen           cadastro rejeitado → reabrir/corrigir (sem criar 2º)
 *
 * @param {{cpf: string}} args
 * @param {object} [client] client pg já aberto (para compor em transação); senão abre um.
 * @returns {Promise<{case:number, action:string, cpf:string, driverUserId?:string|null,
 *   operationalBlocked?:boolean|null, registrationId?:string|null, registrationStatus?:string|null}>}
 */
export async function resolveCpfDedup({ cpf }, client = null) {
  const cpfDigits = normalizeCpf(cpf);
  if (cpfDigits.length !== 11) {
    return { case: 0, action: "invalid", cpf: cpfDigits };
  }

  const run = async (c) => {
    // Sequencial de propósito: um client pg não aceita queries concorrentes.
    // Comparamos o CPF nas duas formas comuns de armazenamento — só-dígitos e
    // máscara padrão "000.000.000-00" — via IN. Evitamos regexp_replace/replace
    // de propósito (o pg-mem dos testes não os suporta); IN cobre os formatos
    // reais e funciona igual em Postgres/prod.
    const masked = `${cpfDigits.slice(0, 3)}.${cpfDigits.slice(3, 6)}.${cpfDigits.slice(6, 9)}-${cpfDigits.slice(9, 11)}`;
    const { rows: drvRows } = await c.query(
      `SELECT user_id, active, operational_blocked
         FROM public.driver_profiles
        WHERE document_number IN ($1, $2)
        LIMIT 1`,
      [cpfDigits, masked],
    );
    const { rows: regRows } = await c.query(
      `SELECT id, status
         FROM public.pending_driver_registrations
        WHERE dados->'motorista'->>'cpf' IN ($1, $2)
        ORDER BY created_at DESC
        LIMIT 1`,
      [cpfDigits, masked],
    );
    const driver = drvRows[0] || null;
    const reg = regRows[0] || null;

    // Já é motorista oficial (ou cadastro aprovado) → informar; nunca duplicar.
    if (driver || reg?.status === "aprovado") {
      return {
        case: 4,
        action: "inform_approved",
        cpf: cpfDigits,
        driverUserId: driver?.user_id ?? null,
        operationalBlocked: driver?.operational_blocked ?? null,
        registrationId: reg?.id ?? null,
        registrationStatus: reg?.status ?? null,
      };
    }
    if (reg) {
      if (reg.status === "rejeitado") {
        return { case: 5, action: "reopen", cpf: cpfDigits, registrationId: reg.id, registrationStatus: reg.status };
      }
      if (reg.status === "draft") {
        return { case: 2, action: "continue", cpf: cpfDigits, registrationId: reg.id, registrationStatus: reg.status };
      }
      // pendente | em_revisao → em andamento
      return { case: 3, action: "resume", cpf: cpfDigits, registrationId: reg.id, registrationStatus: reg.status };
    }
    return { case: 1, action: "create", cpf: cpfDigits };
  };

  return client ? run(client) : withPgClient(run);
}
