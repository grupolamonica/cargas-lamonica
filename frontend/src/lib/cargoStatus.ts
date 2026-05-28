const CARGO_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Rascunho",
  OPEN: "Aberta",
  RESERVED: "Reservada",
  BOOKED: "Fechada",
  EXPIRED: "Expirada",
  CANCELLED: "Cancelada",
  COMPLETED: "Concluída",
  FAILED: "Falhou",
};

export function formatCargoStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return CARGO_STATUS_LABELS[status] ?? status;
}
