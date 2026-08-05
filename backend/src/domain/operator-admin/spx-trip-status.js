// Tradução do status de viagem do SPX/Shopee (`trip_status_name`) para o vocabulário
// operacional exibido nas telas do operador (Programação e Monitor).
//
// FONTE ÚNICA: as duas telas DEVEM mostrar o mesmo rótulo para o mesmo status, então
// ambas importam daqui — a Programação (get-programacao.js) e o overlay de status ao
// vivo do Monitor (spx-operational-status.js).
//
// `arrived` = chegou NO CLIENTE (a ponta de CARREGAMENTO), não no destino.
//
// Este arquivo afirmava o contrário — `arrived: "AGUARDANDO DESCARGA"`, com o comentário
// "chegou no DESTINO" — e era a causa do chamado GLPI #40: "motoristas que estão
// confirmando chegada, a planilha está atualizando como aguardando descarga; o correto
// seria aguardando carregamento". A ironia é que o overlay da Torre foi DESLIGADO por
// exatamente este erro ("mapeava arrived para descarga sem distinguir origem/destino") e
// a substituição o repetiu, só trocando a fonte.
//
// EVIDÊNCIA (medida em produção 2026-08-05, não suposição):
//
// 1. Snapshot ao vivo do SPX: das 12 viagens com `trip_status = 50` (Arrived), ONZE
//    tinham a chegada programada na ORIGEM ainda no FUTURO — incluindo 06/08 e 07/08.
//    `carregamento_ts` é a STA da ORIGEM (bots/spx/backend/spx_robo/trips.py, `_norm_trip`),
//    ou seja a chegada para carregar. Uma viagem não pode estar no destino antes de ter
//    chegado à origem. Contraste: as 13 `Departed` (40) tinham 13/13 essa chegada no
//    passado — coerente com "saiu carregado".
//
// 2. A planilha da Shopee (6168 linhas, a fonte da verdade da operação) NUNCA usa
//    "AGUARDANDO DESCARGA": o vocabulário real é AGUARDANDO CHEGAR NO CLIENTE (28) →
//    AGUARDANDO CARREGAMENTO (12) → DESCARREGADO (4794) → CTE ENVIADO (13). O rótulo
//    antigo era inventado por este mapa e não existia em nenhuma linha real.
//
// 3. A ponta de DESCARGA já tem códigos próprios no enum do portal
//    (60 Unseal / 70 Operating / 80 Unloaded / 90 Completed → DESCARREGANDO/DESCARREGADO),
//    então remapear o 50 não deixa lacuna nenhuma no ciclo.
//
// O ciclo, do jeito que a operação entende: o motorista é atribuído (AGUARDANDO CHEGAR
// NO CLIENTE), chega no cliente (AGUARDANDO CARREGAMENTO), carrega (CARREGANDO), sai
// (CARREGADO) e descarrega no destino (DESCARREGANDO → DESCARREGADO).
//
// FONTE ÚNICA: as duas telas DEVEM mostrar o mesmo rótulo para o mesmo status, então
// ambas importam daqui — a Programação (get-programacao.js) e o overlay de status ao
// vivo do Monitor (spx-operational-status.js).
export const SPX_TRIP_STATUS_LABEL = {
  created: "AGUARDANDO ACEITE",
  pending: "AGUARDANDO ACEITE",
  assigning: "AGUARDANDO CHEGAR NO CLIENTE",
  assigned: "AGUARDANDO CHEGAR NO CLIENTE",
  // Chegou no cliente para CARREGAR — ver o bloco de evidência acima.
  arrived: "AGUARDANDO CARREGAMENTO",
  loading: "CARREGANDO",
  seal: "CARREGANDO",
  departed: "CARREGADO",
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
