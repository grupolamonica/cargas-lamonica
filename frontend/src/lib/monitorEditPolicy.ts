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

// Uma carga só é relevante para o ASPX (SPX/Shopee) quando é uma viagem REAL do
// SPX, identificada pelo LH == trip_number "LT…" (mesma regra do backend em
// assign-aspx-allocations). Cargas Nestlé (LH "B101…"), do sistema e lançamentos
// manuais (SPOT/PRIORIDADE/…) NÃO vão para o ASPX — portanto não recebem selo nem
// aviso de "atribuído no ASPX", mesmo tendo status operacional próprio.
export function isSpxTrip(lh: string | null | undefined): boolean {
  return String(lh ?? "").trim().toUpperCase().startsWith("LT");
}

export function allocEditPolicy(row: { status: string; lh?: string | null }): AllocEditPolicy {
  const status = (row.status || "").trim();
  if (!status) return { editable: true, aspxWarning: false }; // disponível / reservado
  // Status operacional efetivo → editável. O aviso de ASPX só vale para viagens
  // reais do SPX (LT…); Nestlé & cia têm status próprio mas não estão no ASPX.
  return { editable: true, aspxWarning: isSpxTrip(row.lh) };
}
