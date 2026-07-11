import { withPgClient } from "../../../infrastructure/pg/postgres.js";

// Rótulos amigáveis por tipo de evento — o histórico do modal do Monitor mostra
// "as mudanças feitas em cada etapa" (reserva, aprovação, write-back, etc.).
const EVENT_LABELS = {
  PRE_REGISTERED: "Pré-cadastro do motorista",
  WHATSAPP_CLICKED: "Contato via WhatsApp",
  QUEUED: "Entrou na fila",
  APPROVED: "Motorista reservado",
  CANCELLED: "Cancelado",
  SHEET_WRITEBACK: "Gravado na planilha",
};

/**
 * Histórico de eventos de uma carga (por sheet_lh), para o modal do Monitor.
 * Reúne os eventos de `load_public_lead_events` de todas as cargas com aquele
 * LH (recorrência pode gerar mais de uma), em ordem cronológica.
 *
 * Best-effort: qualquer falha (schema legado, LH sem carga) devolve lista vazia
 * — o modal apenas não mostra histórico, nunca quebra.
 */
export async function fetchCargoHistoryByLh({ lh, correlationId }) {
  return withPgClient(async (client) => {
    let items = [];
    try {
      const { rows } = await client.query(
        `
          SELECT e.event_type, e.event_payload_json, e.actor_type, e.actor_id, e.created_at
          FROM public.load_public_lead_events e
          JOIN public.cargas c ON c.id = e.load_id
          WHERE c.sheet_lh = $1
          ORDER BY e.created_at ASC, e.id ASC
          LIMIT 200
        `,
        [lh],
      );
      items = rows.map((row) => ({
        eventType: row.event_type,
        label: EVENT_LABELS[row.event_type] ?? row.event_type,
        payload: row.event_payload_json ?? {},
        actorType: row.actor_type ?? null,
        createdAt: row.created_at,
      }));
    } catch {
      items = [];
    }

    return {
      statusCode: 200,
      payload: { items, meta: { correlationId } },
    };
  });
}
