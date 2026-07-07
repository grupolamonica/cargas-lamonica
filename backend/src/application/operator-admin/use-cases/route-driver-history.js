import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { createRouteLookupKeys } from "../../../domain/operator-admin/route-utils.js";
import { resolveDriverPhones } from "./resolve-driver-phones.js";

/**
 * Histórico de motoristas que já rodaram uma rota (origem → destino), para
 * sugerir quem colocar numa reserva. Lê direto do pg (não supabase-js) para não
 * bater no cap de 1000 linhas do PostgREST — o histórico de cargas é grande.
 *
 * Match de rota via createRouteLookupKeys (mesma normalização usada no resto do
 * Monitor): dedup por nome de motorista (mais recente vence), com contagem de
 * corridas por motorista.
 *
 * @param {{ origem: string, destino: string, correlationId?: string }} args
 */
export async function getRouteDriverHistory({ origem, destino, correlationId }) {
  const rows = await withPgTransaction(async (client) => {
    const { rows: cargoRows } = await client.query(
      `
        SELECT id, origem, destino, sheet_motorista, sheet_cavalo, sheet_carreta,
               data, horario, sheet_data_carregamento, status
        FROM public.cargas
        WHERE sheet_motorista IS NOT NULL
          AND btrim(sheet_motorista) <> ''
          AND status <> 'OPEN'
        ORDER BY data DESC NULLS LAST, horario DESC NULLS LAST
        LIMIT 5000
      `,
    );
    return cargoRows;
  });

  const wanted = new Set(createRouteLookupKeys(origem, destino));

  // Rows já vêm ordenadas por data/horário DESC → a primeira ocorrência de cada
  // motorista é a mais recente. Acumula runCount por motorista.
  const byDriver = new Map();
  for (const row of rows) {
    const keys = createRouteLookupKeys(row.origem, row.destino);
    if (!keys.some((k) => wanted.has(k))) {
      continue;
    }
    const nomeRaw = (row.sheet_motorista ?? "").toString().trim();
    if (!nomeRaw) {
      continue;
    }
    const dedupeKey = nomeRaw.toLowerCase();
    const existing = byDriver.get(dedupeKey);
    if (existing) {
      existing.runCount += 1;
      continue;
    }
    byDriver.set(dedupeKey, {
      motorista: nomeRaw,
      cavalo: (row.sheet_cavalo ?? "").toString().trim(),
      carreta: (row.sheet_carreta ?? "").toString().trim(),
      ultimaData: row.data ?? null,
      ultimoHorario: row.horario ?? null,
      ultimaAgendaLabel: row.sheet_data_carregamento || null,
      runCount: 1,
      telefone: null,
    });
  }

  const drivers = Array.from(byDriver.values());

  // Telefone é opcional (só existe em motoristas_historico). Resolve por nome e
  // anexa; se falhar (query/conexão), mantém telefone = null — não quebra o histórico.
  let phones = new Map();
  try {
    phones = await resolveDriverPhones(drivers.map((d) => d.motorista));
  } catch {
    /* phone é opcional */
  }
  for (const d of drivers) {
    d.telefone = phones.get(d.motorista.toLowerCase().trim()) ?? null;
  }

  return {
    statusCode: 200,
    payload: { drivers, meta: { correlationId } },
  };
}
