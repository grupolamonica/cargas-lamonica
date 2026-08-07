// Marca de "houve escrita que muda o que o motorista vê".
//
// POR QUE EXISTE: o read model do motorista tem cache de 8 s (colapsa a query pesada,
// maior consumidor de egress do pooler num incidente anterior) e esse cache só expirava
// por TEMPO. Combinado com a sondagem do digest, isso abria uma janela em que o motorista
// ficava preso em dado velho — não por 8 s, por até um `staleTime` inteiro:
//
//   t+0s  o motorista busca a lista        → entrada de cache criada
//   t+1s  o operador marca "Disponível"    → a carga vira OPEN no banco
//   t+2s  a sondagem do digest MUDA        → o portal invalida e refaz a busca
//         ...mas a entrada de cache tem 2 s de idade (< 8 s) e é servida como está,
//         ou seja, SEM a carga nova. A query volta a ser considerada "fresca" pelo
//         TanStack e o digest não vai mudar de novo — nada mais dispara refetch.
//
// A correção é invalidar por EVENTO, não só por tempo: quem escreve carimba aqui, e o
// cache descarta qualquer entrada anterior ao carimbo. É o mesmo efeito de versionar a
// chave do cache, com uma comparação de timestamp em vez de um contador na chave.
//
// LIMITAÇÃO ACEITA (mesma de todo estado em memória do backend hoje — rate limiters,
// idempotency, circuit breakers): é por processo, não cluster-safe. Com uma réplica, que
// é a topologia atual, funciona; com várias, cada uma invalida só o próprio cache e o
// pior caso volta a ser o TTL de 8 s. Redis está rastreado em DC-95.
//
// COBERTURA HONESTA: carimbam aqui os caminhos de escrita do Monitor (é de onde o
// operador libera carga para o motorista, o problema relatado). Outros escritores — o
// sync da planilha, jobs periódicos — seguem dependendo do TTL de 8 s, que para eles é
// suficiente porque o portal só descobre a mudança pela sondagem do digest de 30 s.

let _lastDriverVisibleWriteAt = 0;

/**
 * Registra que uma escrita alterou o que o motorista pode ver (ex.: carga reaberta).
 * Barato de propósito: só move um número, sem I/O — pode ser chamado no caminho quente.
 */
export function markDriverVisibleWrite() {
  _lastDriverVisibleWriteAt = Date.now();
}

/** Instante da última escrita relevante (0 se nenhuma neste processo). */
export function lastDriverVisibleWriteAt() {
  return _lastDriverVisibleWriteAt;
}

/** Só para os testes não vazarem estado entre casos. */
export function resetDriverVisibleWriteMarkForTests() {
  _lastDriverVisibleWriteAt = 0;
}
