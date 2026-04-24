export interface DriverCargoClientVisibility {
  observacoes?: string | null;
  exige_antt?: boolean | null;
  exige_carga_monitorada?: boolean | null;
  exige_rastreamento?: boolean | null;
  exige_seguro?: boolean | null;
}

const requirementLabels = [
  { label: "Rastreamento", activeKey: "exige_rastreamento" },
  { label: "ANTT", activeKey: "exige_antt" },
  { label: "Seguro", activeKey: "exige_seguro" },
  { label: "Carga monitorada", activeKey: "exige_carga_monitorada" },
] as const;

export function getVisibleDriverCargoRequirementLabels(client?: DriverCargoClientVisibility | null) {
  if (!client) {
    return [];
  }

  return requirementLabels
    .filter((item) => client[item.activeKey])
    .map((item) => item.label);
}

export function hasVisibleDriverCargoClientNotes(notes?: string | null) {
  return Boolean(notes?.trim());
}
