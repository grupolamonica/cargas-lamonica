import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

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
  supabaseClient: SupabaseClient<Database>,
  clientIds: string[],
) {
  if (clientIds.length === 0) {
    return new Map<string, DriverClientBrief>();
  }

  const { data, error } = await supabaseClient.from("clientes").select("id, nome, descricao").in("id", clientIds);

  if (error) {
    throw error;
  }

  return new Map(
    ((data || []) as DriverClientBrief[]).map((client) => [client.id, client] as const),
  );
}
