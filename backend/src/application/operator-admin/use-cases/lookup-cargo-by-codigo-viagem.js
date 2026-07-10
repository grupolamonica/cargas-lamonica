import { withPgClient } from "../../../infrastructure/pg/postgres.js";

/**
 * Busca uma carga pelo código de viagem (único). Usado pelo modal de carga
 * para, ao criar, detectar se o código já existe e perguntar ao operador se
 * quer atualizar a viagem existente ou trocar o código.
 *
 * Retorna `{ exists: false, cargo: null }` quando não há correspondência — não
 * lança 404 (o cliente usa a resposta para decidir o fluxo). Tolera o schema
 * legado sem a coluna `codigo_viagem` (devolve exists=false).
 */
export async function lookupCargoByCodigoViagem({ codigoViagem, correlationId }) {
  return withPgClient(async (client) => {
    let cargo = null;
    try {
      const { rows } = await client.query(
        `
          SELECT id, origem, destino, data, horario, status, perfil, codigo_viagem
          FROM public.cargas
          WHERE codigo_viagem = $1
          LIMIT 1
        `,
        [codigoViagem],
      );
      cargo = rows[0] ?? null;
    } catch (error) {
      const message = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
      if (!message.includes("codigo_viagem")) throw error;
      // Schema sem a coluna ainda (migration não aplicada) — trata como inexistente.
      cargo = null;
    }

    return {
      statusCode: 200,
      payload: {
        exists: cargo !== null,
        cargo,
        meta: { correlationId },
      },
    };
  });
}
