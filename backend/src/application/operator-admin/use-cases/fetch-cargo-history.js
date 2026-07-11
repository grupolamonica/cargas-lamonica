import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { resolveOperatorDirectory } from "./audit-logs-read-model.js";

// ── Helpers de apresentação (linguagem do operador, sem jargão técnico) ──────

function angelliraDisplayName(validationSummaryJson) {
  let summary = validationSummaryJson;
  if (typeof summary === "string") {
    try {
      summary = JSON.parse(summary);
    } catch {
      summary = null;
    }
  }
  const name = summary?.driver?.angelira?.displayName;
  return typeof name === "string" && name.trim() ? name.trim() : "";
}

function driverLabel({ name, phone }) {
  if (name) return name;
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length >= 4) return `Motorista (final ${digits.slice(-4)})`;
  return "Motorista";
}

function vehicleLabel(cavalo, carreta) {
  const parts = [];
  if (cavalo && String(cavalo).trim()) parts.push(`cavalo ${String(cavalo).trim()}`);
  if (carreta && String(carreta).trim()) parts.push(`carreta ${String(carreta).trim()}`);
  return parts.join(" · ");
}

function withVehicle(base, cavalo, carreta) {
  const v = vehicleLabel(cavalo, carreta);
  return v ? `${base} — ${v}` : base;
}

// Nome de quem agiu, em linguagem clara. Operador → nome/e-mail do diretório;
// motorista pelo portal e ações automáticas do sistema recebem rótulos amigáveis.
function actorLabel({ actorType, actorId }, directory) {
  if (actorType === "operator") {
    const info = actorId ? directory.get(actorId) : null;
    return info?.displayName || info?.email || "Operador";
  }
  if (actorType === "driver" || actorType === "public") return "Motorista (pelo portal)";
  return "Sistema (automático)";
}

/**
 * Histórico de uma carga (por sheet_lh) para o modal do Monitor, em linguagem
 * do operador: o que aconteceu em cada etapa, QUEM fez, QUEM foi alocado e os
 * VEÍCULOS. Junta os eventos do lead (fila, reserva, cancelamento, gravação na
 * planilha) com a alocação atual feita no sistema pelo operador.
 *
 * Best-effort: qualquer falha devolve o que conseguiu (nunca quebra o modal).
 */
export async function fetchCargoHistoryByLh({ lh, correlationId }) {
  return withPgClient(async (client) => {
    let eventRows = [];
    let allocRows = [];
    try {
      const events = await client.query(
        `
          SELECT e.event_type, e.event_payload_json, e.actor_type, e.actor_id, e.created_at,
                 l.horse_plate, l.trailer_plate, l.phone, l.validation_summary_json
          FROM public.load_public_lead_events e
          JOIN public.cargas c ON c.id = e.load_id
          LEFT JOIN public.load_public_leads l ON l.id = e.lead_id
          WHERE c.sheet_lh = $1
          ORDER BY e.created_at ASC, e.id ASC
          LIMIT 200
        `,
        [lh],
      );
      eventRows = events.rows;

      const allocs = await client.query(
        `
          SELECT DISTINCT ON (sheet_lh)
                 alloc_motorista, alloc_cavalo, alloc_carreta, alloc_descricao,
                 alloc_updated_by, alloc_updated_at
          FROM public.cargas
          WHERE sheet_lh = $1 AND COALESCE(TRIM(alloc_motorista), '') <> ''
          ORDER BY sheet_lh, alloc_updated_at DESC NULLS LAST
        `,
        [lh],
      );
      allocRows = allocs.rows;
    } catch {
      eventRows = [];
      allocRows = [];
    }

    // Diretório de operadores (id → nome). Best-effort — se indisponível, cai
    // no rótulo "Operador".
    let directory = new Map();
    try {
      directory = await resolveOperatorDirectory();
    } catch {
      directory = new Map();
    }

    const items = [];

    for (const row of eventRows) {
      const por = actorLabel({ actorType: row.actor_type, actorId: row.actor_id }, directory);
      const nome = driverLabel({ name: angelliraDisplayName(row.validation_summary_json), phone: row.phone });
      const payload = row.event_payload_json ?? {};

      let titulo = null;
      let detalhe = null;
      const tipo = row.event_type;

      switch (row.event_type) {
        case "PRE_REGISTERED":
          titulo = "Cadastro iniciado";
          detalhe = nome;
          break;
        case "QUEUED":
          titulo = "Entrou na fila de candidatos";
          detalhe = withVehicle(nome, row.horse_plate, row.trailer_plate);
          break;
        case "WHATSAPP_CLICKED":
          titulo = "Chamou no WhatsApp";
          detalhe = nome;
          break;
        case "APPROVED":
          titulo = "Reservado para o motorista";
          detalhe = withVehicle(nome, row.horse_plate, row.trailer_plate);
          break;
        case "CANCELLED":
          titulo = "Reserva/candidatura cancelada";
          detalhe = nome;
          break;
        case "SHEET_WRITEBACK": {
          titulo = "Gravado na planilha";
          const m = typeof payload.motorista === "string" && payload.motorista.trim() ? payload.motorista.trim() : nome;
          detalhe = withVehicle(m, payload.cavalo, payload.carreta);
          break;
        }
        default:
          titulo = row.event_type;
          detalhe = nome;
      }

      items.push({ quando: row.created_at, titulo, detalhe, por, tipo });
    }

    // Alocação atual feita no sistema (operador escolheu motorista/veículo).
    for (const a of allocRows) {
      const por = a.alloc_updated_by
        ? directory.get(a.alloc_updated_by)?.displayName || directory.get(a.alloc_updated_by)?.email || "Operador"
        : "Operador";
      let detalhe = withVehicle(String(a.alloc_motorista).trim(), a.alloc_cavalo, a.alloc_carreta);
      if (a.alloc_descricao && String(a.alloc_descricao).trim()) {
        detalhe += ` · motivo: ${String(a.alloc_descricao).trim()}`;
      }
      items.push({
        quando: a.alloc_updated_at,
        titulo: "Motorista alocado no sistema",
        detalhe,
        por,
        tipo: "ALLOC_OPERADOR",
      });
    }

    // Ordena cronologicamente (mais antigo → mais novo). Entradas sem data ao fim.
    items.sort((x, y) => {
      const tx = x.quando ? new Date(x.quando).getTime() : Number.POSITIVE_INFINITY;
      const ty = y.quando ? new Date(y.quando).getTime() : Number.POSITIVE_INFINITY;
      return tx - ty;
    });

    return {
      statusCode: 200,
      payload: { items, meta: { correlationId } },
    };
  });
}
