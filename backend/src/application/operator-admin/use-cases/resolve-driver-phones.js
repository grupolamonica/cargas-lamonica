import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";

/**
 * Resolve telefone de motoristas a partir do nome, lendo `motoristas_historico`
 * (única fonte com telefone). Normaliza por `lower(btrim(nome))` dos dois lados
 * para casar independente de caixa/espaços.
 *
 * Contrato: NÃO-fatal por design — o telefone é opcional. Este helper deixa a
 * exceção propagar (query/conexão); os CHAMADORES envolvem em try/catch e caem
 * para telefone = null. Mantido simples de propósito.
 *
 * @param {Array<string|null|undefined>} names lista de nomes (pode ter duplicatas/vazios)
 * @returns {Promise<Map<string,string>>} Map<namekey normalizado, telefone>
 */
export async function resolveDriverPhones(names) {
  const keys = new Set();
  for (const name of names ?? []) {
    const key = (name ?? "").toString().toLowerCase().trim();
    if (key) {
      keys.add(key);
    }
  }

  if (keys.size === 0) {
    return new Map();
  }

  const rows = await withPgTransaction(async (client) => {
    const { rows: r } = await client.query(
      `
        SELECT lower(btrim(nome)) AS namekey, telefone
        FROM public.motoristas_historico
        WHERE lower(btrim(nome)) = ANY($1::text[])
          AND btrim(coalesce(telefone, '')) <> ''
      `,
      [Array.from(keys)],
    );
    return r;
  });

  const byName = new Map();
  for (const row of rows) {
    const namekey = (row.namekey ?? "").toString();
    const telefone = (row.telefone ?? "").toString().trim();
    if (namekey && telefone && !byName.has(namekey)) {
      byName.set(namekey, telefone);
    }
  }

  return byName;
}
