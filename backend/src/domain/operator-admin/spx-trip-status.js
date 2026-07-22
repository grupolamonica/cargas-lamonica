// Tradução do status de viagem do SPX/Shopee (`trip_status_name`) para o vocabulário
// operacional exibido nas telas do operador (Programação e Monitor).
//
// FONTE ÚNICA: as duas telas DEVEM mostrar o mesmo rótulo para o mesmo status, então
// ambas importam daqui — a Programação (get-programacao.js) e o overlay de status ao
// vivo do Monitor (spx-operational-status.js).
//
// Por que esta tradução é confiável (e a da Torre /api/spx/asp não era): o ciclo de
// vida do SPX distingue ORIGEM × DESTINO por si só —
//   loading  = na ORIGEM, carregando        → CARREGANDO
//   departed = saiu da origem                → CARREGADO
//   arrived  = chegou no DESTINO             → AGUARDANDO DESCARGA
// A coluna "Status Operacional" da Torre colapsava esses estados (mapeava "arrived"
// para descarga sem distinguir origem/destino), o que fez o overlay da Torre ser
// desligado no Monitor. Aqui usamos o `trip_status_name` cru do portal SPX.
export const SPX_TRIP_STATUS_LABEL = {
  created: "AGUARDANDO ACEITE",
  pending: "AGUARDANDO ACEITE",
  assigning: "AGUARDANDO CHEGAR NO CLIENTE",
  assigned: "AGUARDANDO CHEGAR NO CLIENTE",
  loading: "CARREGANDO",
  seal: "CARREGANDO",
  departed: "CARREGADO",
  arrived: "AGUARDANDO DESCARGA",
  unseal: "DESCARREGANDO",
  operating: "DESCARREGANDO",
  unloaded: "DESCARREGADO",
  completed: "DESCARREGADO",
  cancelled: "CANCELADO",
};

/** trip_status_name (SPX) → rótulo operacional PT. Desconhecido → UPPERCASE do cru. */
export function spxTripStatusLabel(statusName) {
  const key = String(statusName || "").trim().toLowerCase();
  return SPX_TRIP_STATUS_LABEL[key] || String(statusName || "").toUpperCase();
}
