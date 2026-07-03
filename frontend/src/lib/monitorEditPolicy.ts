// Regra de quem pode ter motorista/veículo alterados no Monitor.
//
// Só liberam edição: Disponível e Reservado (sem status operacional efetivo) e
// "Aguardando chegar no cliente". Os demais status ficam travados — a carga já
// está sendo atribuída no ASPX. Para "aguardando chegar no cliente" a edição é
// liberada, mas com um aviso (já em atribuição no ASPX).
//
// Recebe o status EFETIVO da linha (COALESCE(alloc_status, sheet_status)).

const AGUARDANDO_CLIENTE_RE = /aguardando\s+chegar/i;

export type AllocEditPolicy = { editable: boolean; aspxWarning: boolean };

export function allocEditPolicy(row: { status: string }): AllocEditPolicy {
  const status = (row.status || "").trim();
  if (!status) return { editable: true, aspxWarning: false };          // disponível / reservado
  if (AGUARDANDO_CLIENTE_RE.test(status)) return { editable: true, aspxWarning: true };
  return { editable: false, aspxWarning: false };
}
