// Rótulos que a LEITURA do Monitor DERIVA para exibir — e que nunca são status
// operacional armazenável.
//
// POR QUE ISTO EXISTE (incidente medido em produção 07/08/2026): 18 cargas ficaram com
// `alloc_status = "Reservado"`. Nenhum código grava esse valor: "Reservado" é o rótulo
// que a leitura deriva do CICLO DE VIDA (BOOKED/RESERVED → "Reservado", em
// `list-system-cargas-monitor.js`), e "Fechado" vem de `planilha-availability.js`.
//
// O caminho do vazamento: a linha exibe o rótulo derivado → o modal do Monitor
// pré-preenche o select de status com ele → o dropdown ainda o oferece como opção
// (passthrough de "valor fora da lista canônica") → o operador toca no select e o
// RÓTULO é persistido como decisão real.
//
// O dano é silencioso e duradouro: o status efetivo é
// COALESCE(alloc_status, sheet_status), então o rótulo mascara o status VERDADEIRO para
// sempre. Nas 18 cargas o `sheet_status` dizia corretamente "CANCELADO" (o sync tinha
// funcionado) e a tela mostrava "Reservado" — carga cancelada há semanas ocupando o
// Monitor como se estivesse reservada.
//
// É a MESMA classe de defeito que `editableDriver` já corrige para o motorista: o modal
// pré-preenche a partir do rótulo exibido e o save reenvia o campo, persistindo o rótulo.
// O campo de status nunca recebeu o mesmo tratamento.
//
// ESCOPO DA LISTA: só rótulos que NÃO são status operacional legítimo. "CANCELADO" e
// "Disponível" ficam FORA de propósito — o primeiro é status real do pipeline; o segundo
// é a AÇÃO de reabrir (grava "" e força OPEN), e barrá-lo quebraria a reabertura.

/** Comparação sem acento/caixa/espaço — a tela usa "Disponivel" e "Expirada" com e sem acento. */
function normalizar(valor) {
  return String(valor ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Rótulos derivados, normalizados. Nenhum deles é status operacional válido. */
const ROTULOS_DERIVADOS = new Set(["reservado", "fechado", "em aberto", "rascunho", "expirada"]);

/**
 * O valor é um rótulo de EXIBIÇÃO (derivado pela leitura), e não um status operacional?
 *
 * Usado nos dois caminhos de escrita do Monitor para tratar o valor como campo AUSENTE
 * (preserva o que já está lá) em vez de gravar o artefato. Degradar para "ausente" é
 * deliberado: não grava lixo e também não destrói um override legítimo.
 */
export function isDerivedStatusLabel(valor) {
  return ROTULOS_DERIVADOS.has(normalizar(valor));
}

export const __TEST__ = { ROTULOS_DERIVADOS, normalizar };
