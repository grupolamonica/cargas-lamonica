// Regra de quem pode ter motorista/veículo alterados no Monitor.
//
// Liberam edição: Disponível e Reservado (sem status operacional efetivo) e os
// estágios PRÉ-carregamento do pipeline — "Aguardando carregamento" e
// "Aguardando chegar no cliente" — estes com um aviso (carga já em atribuição
// no ASPX; após editar, use "Atribuir no ASPX" para TROCAR o motorista lá).
// De CARREGADO em diante (descarga, CTE, no show, cancelado…) fica travado:
// a viagem já está em execução e trocar localmente só criaria divergência.
//
// Recebe o status EFETIVO da linha (COALESCE(alloc_status, sheet_status)).

// Pré-carregamento: "aguardando chegar no cliente" + "aguardando carregamento".
// (Não casa "aguardando descarga" — "carreg" ≠ "descarga".)
const PRE_CARREGAMENTO_RE = /aguardando\s+(chegar|carreg)/i;

export type AllocEditPolicy = { editable: boolean; aspxWarning: boolean };

export function allocEditPolicy(row: { status: string }): AllocEditPolicy {
  const status = (row.status || "").trim();
  if (!status) return { editable: true, aspxWarning: false };          // disponível / reservado
  if (PRE_CARREGAMENTO_RE.test(status)) return { editable: true, aspxWarning: true };
  return { editable: false, aspxWarning: false };
}
