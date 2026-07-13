// Regra de quem pode ter motorista/veículo alterados no Monitor.
//
// DC-224: a edição/substituição de motorista, cavalo e carreta é permitida em
// QUALQUER status da viagem (inclusive pós-carregamento — motorista substituto).
//   - Disponível / Reservado (sem status operacional efetivo): edita sem aviso.
//   - Qualquer status operacional: edita COM aviso (a carga já está em
//     atribuição/execução no ASPX; após editar, use "Atribuir no ASPX" para
//     TROCAR o motorista lá). O modal de confirmação exige o motivo da troca,
//     que é gravado no log de auditoria.
//
// Recebe o status EFETIVO da linha (COALESCE(alloc_status, sheet_status)).

export type AllocEditPolicy = { editable: boolean; aspxWarning: boolean };

export function allocEditPolicy(row: { status: string }): AllocEditPolicy {
  const status = (row.status || "").trim();
  if (!status) return { editable: true, aspxWarning: false }; // disponível / reservado
  // Status operacional efetivo → editável, com aviso de ASPX.
  return { editable: true, aspxWarning: true };
}
