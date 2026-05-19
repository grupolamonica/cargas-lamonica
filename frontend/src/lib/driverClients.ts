
export interface DriverClientBrief {
  id: string;
  nome: string | null;
  descricao: string | null;
}

export interface DriverCargoClientJoinRow {
  cliente_id?: string | null;
  cliente?: DriverClientBrief | null;
}

function normalizeClientId(value?: string | null) {
  const trimmedValue = value?.trim();
  return trimmedValue ? trimmedValue : "";
}

function hasResolvedClient(row: DriverCargoClientJoinRow) {
  return Boolean(row.cliente?.id || row.cliente?.nome?.trim());
}

export function collectMissingDriverClientIds<T extends DriverCargoClientJoinRow>(rows: T[]) {
  return Array.from(
    new Set(
      rows
        .map((row) => (hasResolvedClient(row) ? "" : normalizeClientId(row.cliente_id)))
        .filter((clientId) => clientId !== ""),
    ),
  );
}

export function mergeDriverClientsIntoRows<T extends DriverCargoClientJoinRow>(
  rows: T[],
  clientsById: Map<string, DriverClientBrief>,
) {
  return rows.map((row) => {
    if (hasResolvedClient(row)) {
      return row;
    }

    const clientId = normalizeClientId(row.cliente_id);
    const fallbackClient = clientId ? clientsById.get(clientId) : undefined;

    if (!fallbackClient) {
      return row;
    }

    return {
      ...row,
      cliente: fallbackClient,
    };
  });
}

export async function fetchDriverClientsByIds(
  _supabaseClient: unknown, // kept for backward compat with call sites
  clientIds: string[],
): Promise<Map<string, DriverClientBrief>> {
  if (clientIds.length === 0) {
    return new Map<string, DriverClientBrief>();
  }

  const params = clientIds.map((id) => `ids[]=${encodeURIComponent(id)}`).join("&");
  const response = await fetch(`/api/driver/clientes-brief?${params}`);

  if (!response.ok) {
    throw new Error(`Failed to fetch clientes: ${response.status}`);
  }

  const { clientes } = (await response.json()) as { clientes: DriverClientBrief[] };
  return new Map((clientes || []).map((c) => [c.id, c] as const));
}
