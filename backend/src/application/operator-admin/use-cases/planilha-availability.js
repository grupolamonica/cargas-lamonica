// Regra de "Disponível" para as linhas da PLANILHA no Monitor.
//
// Antes: uma linha da planilha aparecia como "Disponível" (status vazio) sempre
// que o STATUS da planilha estava vazio e não havia motorista — mesmo quando a
// carga estava, de fato, FECHADA para o motorista (passada, expirada, privada,
// não-publicada). Isso mostrava centenas de cargas como "Disponível" sem estarem
// abertas de verdade.
//
// Agora: uma linha só é "Disponível" se a carga está REALMENTE aberta pro
// motorista — a MESMA regra do /motorista (buildDriverLoadFilters): status OPEN,
// pública, futura e sem motorista efetivo. O caller passa o conjunto `openLhSet`
// com os sheet_lh que satisfazem essa regra (uma query só, idêntica à do portal).
//
// As linhas que apareceriam "Disponível" mas NÃO estão abertas passam a mostrar:
//   - "Expirada"  → carregamento no passado (relógio de São Paulo)
//   - "Fechada"   → futura/sem data, porém fechada (não-publicada, privada, etc.)
//
// NÃO mexe em: linhas com status operacional da planilha (ex.: "AGUARDANDO
// CARREGAMENTO") nem em linhas com motorista efetivo (badge mostra "Reservado").

/** Motorista efetivo = override do operador (alloc) ?? motorista da planilha.
 *  alloc_motorista "" (não-nulo) é vazio EXPLÍCITO — sobrepõe a planilha. */
function effectiveDriver(row, allocByLh) {
  const alloc = allocByLh ? allocByLh[row.lh] : null;
  const v = alloc && alloc.alloc_motorista != null ? alloc.alloc_motorista : row.motoristas ?? "";
  return String(v).trim();
}

/**
 * Ajusta o status EXIBIDO de uma linha da planilha aplicando a regra de "aberta
 * pro motorista". Pura/testável. Retorna a linha (possivelmente com status novo).
 *
 * @param {object} row linha do Monitor (shape da planilha)
 * @param {{ openLhSet: Set<string>|null, allocByLh?: Record<string, any>, now?: {todayIso:string, nowTimeIso:string}|null }} ctx
 */
export function applyPlanilhaAvailabilityStatus(row, { openLhSet, allocByLh = {}, now = null } = {}) {
  // Sem o conjunto (falha ao ler as cargas abertas) → não aplica a regra, mantém
  // o comportamento atual (melhor não esconder linhas do que quebrar o Monitor).
  if (!openLhSet) return row;
  // Status operacional da planilha (não vazio) → mostra como está.
  if ((row.status || "").trim() !== "") return row;
  // Tem motorista efetivo → o badge já mostra "Reservado" (status vazio). Não mexe.
  if (effectiveDriver(row, allocByLh) !== "") return row;
  // Sem motorista + status vazio: SÓ é "Disponível" se estiver aberta pro motorista.
  if (row.lh && openLhSet.has(row.lh)) return row;
  // Fechada: rotula por data — passada = Expirada; futura/sem data = Fechada.
  const dateStr = row.data ? String(row.data).slice(0, 10) : null;
  const timeStr = row.horario ? String(row.horario).slice(0, 5) : null;
  const isPast =
    !!now &&
    !!dateStr &&
    (dateStr < now.todayIso || (dateStr === now.todayIso && !!timeStr && timeStr < now.nowTimeIso));
  return { ...row, status: isPast ? "Expirada" : "Fechada", isAvailable: false };
}
