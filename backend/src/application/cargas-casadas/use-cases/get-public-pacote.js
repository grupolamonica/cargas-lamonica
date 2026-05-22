import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";

/**
 * getPublicPacote — endpoint driver-facing anonimo (sem auth).
 *
 * Retorna o pacote completo + todas as cargas ordenadas por ordem_viagem.
 * APENAS quando pacote.status IN ('publicado','reservado','em_andamento') —
 * espelha a RLS policy "Public can view published cargas_casadas" (plan 10-01)
 * como defesa em profundidade na application layer.
 *
 * Para qualquer outro status (rascunho, concluido, cancelado) ou pacoteId
 * inexistente: lanca NotFoundError (mesma resposta — nao vazar info).
 *
 * Estrategia anti-N+1: 2 queries totais
 *  1) SELECT pacote_casadas BY id
 *  2) SELECT cargas JOIN clientes WHERE viagem_id = $1 ORDER BY ordem_viagem
 */
const ALLOWED_PUBLIC_STATUSES = new Set(["publicado", "reservado", "em_andamento"]);

export async function getPublicPacote({ pacoteId, correlationId } = {}) {
  return withPgClient(async (client) => {
    const { rows: pacoteRows } = await client.query(
      `SELECT id, status, valor_total, version, published_at
         FROM public.cargas_casadas
        WHERE id = $1`,
      [pacoteId],
    );

    const pacote = pacoteRows[0];
    if (!pacote || !ALLOWED_PUBLIC_STATUSES.has(pacote.status)) {
      throw new NotFoundError("Pacote nao encontrado.");
    }

    const { rows: cargas } = await client.query(
      `SELECT c.id,
              c.ordem_viagem,
              c.status,
              c.driver_visibility,
              c.origem,
              c.destino,
              c.perfil,
              c.valor,
              c.bonus,
              c.bonus_exigencias,
              c.data,
              c.horario,
              c.distancia_km,
              c.duracao_horas,
              c.cliente_id,
              cli.nome AS cliente_nome,
              cli.logo_url AS cliente_logo_url,
              cli.descricao AS cliente_descricao
         FROM public.cargas c
         LEFT JOIN public.clientes cli ON cli.id = c.cliente_id
        WHERE c.viagem_id = $1
        ORDER BY c.ordem_viagem ASC NULLS LAST, c.id ASC`,
      [pacoteId],
    );

    const toNumber = (value) => (value !== null && value !== undefined ? Number(value) : null);

    const cargasMapped = cargas.map((c) => ({
      id: c.id,
      ordem_viagem: c.ordem_viagem,
      status: c.status,
      driver_visibility: c.driver_visibility,
      origem: c.origem,
      destino: c.destino,
      perfil: c.perfil,
      valor: toNumber(c.valor),
      bonus: toNumber(c.bonus),
      bonus_exigencias: c.bonus_exigencias,
      data: c.data,
      horario: c.horario,
      distancia_km: toNumber(c.distancia_km),
      duracao_horas: toNumber(c.duracao_horas),
      cliente: c.cliente_id
        ? {
            id: c.cliente_id,
            nome: c.cliente_nome ?? null,
            logo_url: c.cliente_logo_url ?? null,
            descricao: c.cliente_descricao ?? null,
          }
        : null,
    }));

    return {
      statusCode: 200,
      payload: {
        ok: true,
        pacote: {
          id: pacote.id,
          status: pacote.status,
          valor_total: toNumber(pacote.valor_total),
          version: pacote.version,
          published_at: pacote.published_at,
          total_cargas: cargasMapped.length,
          cargas: cargasMapped,
        },
        meta: { correlationId: correlationId || null },
      },
    };
  });
}
