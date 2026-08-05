// Rede de segurança de RESERVA para as linhas do SISTEMA no Monitor.
//
// Gêmea de `applyPlanilhaAvailabilityStatus` (planilha-availability.js), que já
// injeta o motorista do lead aprovado nas linhas da PLANILHA. As linhas do
// sistema não tinham equivalente: uma carga LANÇADA (sheet_lh NULL, lh_manual)
// reservada pela Fila só aparecia com motorista quando `alloc_motorista` havia
// sido gravado — e o aceite só grava esse campo quando consegue resolver o NOME
// do motorista. Sem nome resolvido, a carga ficava RESERVED no banco e a linha do
// Monitor saía sem motorista, como se ninguém a tivesse pegado (relato do
// operador nas cargas Nestlé, que existem SÓ como carga lançada).
//
// Por que a rede da planilha não cobria: o mapa `reservedByLh` é chaveado por
// `cargas.sheet_lh` (NULL na carga lançada) e é aplicado somente sobre as linhas
// da planilha. Aqui a chave é o `cargoId` da própria linha — não depende de LH,
// então cobre também a carga sem LH nenhum.
//
// NÃO mexe no status: o rótulo "Reservado" da linha do sistema vem do ciclo de
// vida (SYSTEM_LIFECYCLE_LABEL em list-system-cargas-monitor.js) e um status
// operacional (alloc_status, ex. "CARREGADO") deve continuar mandando na exibição.
// Só preenche o que estava vazio.
//
// Limite conhecido: quando a carga tem alocação com VAZIO EXPLÍCITO
// (`alloc_motorista = ''` + `alloc_updated_at` preenchido — operador esvaziou num
// arrasto/cascata), o cliente reaplica esse vazio por cima no `mergeAllocIntoRow`
// (frontend/src/lib/monitorAllocOverlay.ts) e a linha volta a ficar sem motorista.
// É a semântica de "vazio deliberado" do Monitor (ausente = preserva, "" = vazio),
// e a decisão explícita do operador ganha da rede de segurança. Zero ocorrências
// em produção quando isto foi escrito.

/**
 * Injeta motorista/placas da reserva da Fila numa linha do SISTEMA que está sem
 * motorista. Pura/testável. Devolve a linha (possivelmente nova).
 *
 * O valor injetado é VIEW-ONLY (mesma convenção da rede da planilha): descreve
 * quem reservou, não é uma alocação gravada em `cargas.alloc_motorista`.
 *
 * @param {object} row linha do Monitor no shape do sistema (source: "sistema")
 * @param {{ reservedByCargoId?: Record<string, {motorista?: string, cavalo?: string, carreta?: string}> }} [ctx]
 */
export function applySystemReservationStatus(row, { reservedByCargoId = {} } = {}) {
  if (!row || row.source !== "sistema") return row;
  // Já tem motorista efetivo (alloc_motorista) → o badge já mostra a reserva.
  if (String(row.motoristas ?? "").trim() !== "") return row;

  const rsv = row.cargoId ? reservedByCargoId[row.cargoId] : undefined;
  if (!rsv) return row;

  const motorista = String(rsv.motorista ?? "").trim();
  if (!motorista) return row;

  return {
    ...row,
    motoristas: motorista,
    // Placas do lead só entram no que está vazio — nunca sobrescrevem o que o
    // operador já gravou na alocação.
    cavalo: String(row.cavalo ?? "").trim() || String(rsv.cavalo ?? "").trim(),
    carreta: String(row.carreta ?? "").trim() || String(rsv.carreta ?? "").trim(),
    hasDriver: true,
    isAvailable: false,
    // O valor injetado DESCREVE quem reservou; não é uma alocação gravada. A flag
    // impede que a UI o use como valor de partida de um campo editável: os modais
    // pré-preenchem o campo de motorista com `row.motoristas` e o save SEMPRE
    // reenvia esse campo, então o rótulo ("Reservado (fila) · <telefone>", ou até um
    // nome que veio do lead e não da alocação) seria PERSISTIDO como motorista real
    // ao salvar qualquer outra coisa na carga.
    motoristaViewOnly: true,
  };
}
