/**
 * Janela de carregamento do Monitor (o par de inputs "Carreg.") e a contagem do
 * que essa janela esconde.
 *
 * PROBLEMA MEDIDO EM PRODUÇÃO (06/08/2026): o filtro nascia em "hoje 00:00 → hoje
 * 23:59" e era persistido no localStorage (DC-275) sem NUNCA voltar a ser
 * confrontado com a data corrente. Das 104 cargas de sistema no recorte do
 * Monitor só 12 eram de hoje, e NENHUMA delas ainda estava aberta no /motorista
 * (as de hoje já tinham vencido o horário). As 44 cargas realmente abertas ao
 * motorista estavam em 07/08 (21), 08/08 (11), 09/08 (10) e 10/08 (2). Ou seja: o
 * padrão escondia 100% do que o operador precisava ver, e um valor salvo ontem
 * sobrevivia indefinidamente ao F5, deixando o operador olhando um dia morto.
 *
 * Custo medido de alargar a janela (6285 linhas no total): hoje=39, +1=79, +2=98,
 * +3=111, +6=113, +13=113, +29=113. Não existe NENHUMA carga além de 10/08 — a
 * janela de 7 dias custa 113 linhas (3 páginas) e o teto é estável. Por isso o
 * padrão passa a ser "hoje .. hoje+7": cobre toda a operação acionável sem
 * arrastar as ~6,2k linhas de histórico da planilha para dentro da tabela.
 */

// Sete dias cobrem a operação inteira com folga (ver números acima) e ainda
// deixam a tabela em 3 páginas. Mais que isso não revela nada e menos que isso
// corta cargas já abertas ao motorista.
export const MONITOR_DEFAULT_WINDOW_DAYS = 7;

export type MonitorLoadWindow = { from: string; to: string };

/**
 * 'auto'   = a janela é o padrão operacional e deve ser RECALCULADA a cada
 *            montagem a partir de agora. É isto que torna um valor de ontem no
 *            localStorage logicamente impossível de sobreviver a um F5 — sem
 *            useEffect de correção (que causaria render duplo e o flash da
 *            janela velha antes do reclamp). O modo também é o que autoriza a
 *            tela a reconferir a data no meio da sessão (aba de painel de TV
 *            que passa dias sem reload — ver SheetMonitor).
 * 'manual' = o operador escolheu um recorte; respeitamos o que ele salvou, e
 *            NADA pode sobrescrevê-lo enquanto ele não voltar ao repouso.
 */
export type MonitorDateWindowMode = "auto" | "manual";

// Data no fuso LOCAL do operador (BRT), no formato do <input datetime-local>.
// Local de propósito: é assim que o navegador interpreta o valor do input e é
// assim que `rowMatchesDateRanges` o converte de volta (new Date(valor)).
export function monitorLocalDateKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Janela operacional padrão: hoje 00:00 → hoje+7 23:59.
 *
 * O fim é construído com `new Date(ano, mês, dia + N)` — o construtor local
 * normaliza a virada de mês/ano sozinho (31/12 + 7 → 07/01 do ano seguinte) e,
 * como só lemos ano/mês/dia de volta, não há aritmética de milissegundos para o
 * horário de verão distorcer.
 */
export function defaultLoadWindow(now: Date = new Date()): MonitorLoadWindow {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + MONITOR_DEFAULT_WINDOW_DAYS);
  return { from: `${monitorLocalDateKey(start)}T00:00`, to: `${monitorLocalDateKey(end)}T23:59` };
}

/**
 * Janela inicial na montagem, a partir do que estava no localStorage.
 *
 * Em 'auto' (padrão, e o que qualquer payload antigo/corrompido vira) o que foi
 * persistido é IGNORADO e a janela é recalculada de `now`. Em 'manual' devolve o
 * recorte salvo tal e qual — inclusive vazio, que é um recorte legítimo ("sem
 * limite de data").
 */
export function resolveLoadWindow(
  persisted: Record<string, unknown> | null | undefined,
  now: Date = new Date(),
): MonitorLoadWindow & { mode: MonitorDateWindowMode } {
  if (persisted?.dateWindowMode === "manual") {
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return { from: str(persisted.dateFromFilter), to: str(persisted.dateToFilter), mode: "manual" };
  }
  return { ...defaultLoadWindow(now), mode: "auto" };
}

// ─── Contador de linhas escondidas pela janela ────────────────────────────────

export type HiddenFutureTally = {
  /** Quantas linhas FUTURAS (data ≥ hoje) o filtro de data está escondendo. */
  count: number;
  /** Maior data escondida ("YYYY-MM-DD") — até onde a janela precisa esticar. */
  maxDate: string | null;
};

/**
 * A contagem quebrada por chave de status, porque o contador é um BOTÃO e um botão
 * tem de entregar o que promete.
 *
 * O filtro de data é o último passo de `preStatusRows`; o de status vem DEPOIS, em
 * `filteredRows`. Contando só ali, o operador com o chip "PENDENTE" ligado lia
 * "+5 futuras fora da janela", clicava e ganhava 2 — o número era honesto quanto à
 * data e mentiroso quanto à promessa.
 *
 * Não dá para resolver metendo `statusFilter` nas dependências de `preStatusRows`:
 * cada clique num chip refaria a passada de ~6,3k linhas e trocaria a identidade de
 * `preStatusRows`, invalidando `statusFacets`, `filteredRows` e `routeQueue` — que
 * existem exatamente para NÃO depender do status. Então a passada única guarda um
 * balde por status (dezena de chaves, não milhares de linhas) e o recorte por status
 * vira uma soma de baldes: O(chips selecionados), não O(linhas).
 */
export type HiddenFutureByStatus = {
  /** Sem filtro de status ligado — o total. */
  total: HiddenFutureTally;
  /**
   * Um balde por chave de status; MESMA chave dos chips (status || "Sem status").
   * SEM protótipo (`Object.create(null)`): a chave vem de dado da planilha, e num
   * objeto literal um status chamado "constructor" ou "toString" devolveria a
   * função herdada em vez de `undefined` — a soma viraria NaN e o contador
   * mostraria "+NaN futuras". Não é hipótese elegante: o status é texto livre.
   */
  byStatus: Record<string, HiddenFutureTally>;
};

/** Uma linha escondida, na forma mínima que a contagem precisa. */
export type HiddenLoadSample = { data: string | null | undefined; statusKey: string };

/**
 * A linha escondida é FUTURA? Compara só a DATA, nunca o horário — mesma
 * convenção do `routeQueue`: uma carga de hoje cujo horário já passou continua
 * acionável (ainda dá para alocar/descer a fila), então não é "histórico".
 * Linha sem data cai fora: não sabemos se é futura, e um número inflado por
 * palpite é pior que um número menor e confiável.
 */
export function isFutureLoadDate(data: string | null | undefined, todayKey: string): boolean {
  const d = String(data ?? "").slice(0, 10);
  return d.length === 10 && d >= todayKey;
}

/**
 * Acumulador de uma passada só. Existe porque a contagem tem de acontecer DENTRO
 * do mesmo `for` que aplica o filtro de data em `preStatusRows` (~6,3k linhas por
 * tecla digitada na busca) — uma segunda passada só para contar seria desperdício
 * puro. A única alocação é o balde de status, e só na PRIMEIRA linha escondida de
 * cada status (~10 objetos no pior caso, contra as ~74 futuras medidas).
 */
export function createHiddenFutureTally(todayKey: string) {
  let count = 0;
  let maxDate: string | null = null;
  const byStatus: Record<string, HiddenFutureTally> = Object.create(null);
  return {
    add(data: string | null | undefined, statusKey: string) {
      if (!isFutureLoadDate(data, todayKey)) return;
      const d = String(data).slice(0, 10);
      count += 1;
      if (maxDate === null || d > maxDate) maxDate = d;
      const bucket = byStatus[statusKey];
      if (bucket === undefined) byStatus[statusKey] = { count: 1, maxDate: d };
      else {
        bucket.count += 1;
        if (bucket.maxDate === null || d > bucket.maxDate) bucket.maxDate = d;
      }
    },
    result(): HiddenFutureByStatus {
      return { total: { count, maxDate }, byStatus };
    },
  };
}

/** Versão declarativa do acumulador — usada nos testes e em chamadas frias. */
export function tallyHiddenFuture(
  hidden: ReadonlyArray<HiddenLoadSample>,
  todayKey: string,
): HiddenFutureByStatus {
  const tally = createHiddenFutureTally(todayKey);
  for (const h of hidden) tally.add(h.data, h.statusKey);
  return tally.result();
}

/**
 * O número que o contador mostra: o que o clique REALMENTE vai entregar sob os
 * filtros ligados agora.
 *
 * Sem chip de status ligado (o caso comum) devolve o total — mesma resposta de
 * antes, sem custo nenhum. Com chips ligados soma só os baldes escolhidos, e o
 * `maxDate` acompanha: a janela estica exatamente até a última futura que o
 * operador vai de fato ver, não até a de um status que ele filtrou fora.
 *
 * Chave desconhecida (status que sumiu do dataset) simplesmente não soma — 0 é a
 * resposta honesta, e o botão nem aparece.
 */
export function selectHiddenFuture(
  tally: HiddenFutureByStatus,
  statusFilter: readonly string[],
): HiddenFutureTally {
  if (statusFilter.length === 0) return tally.total;
  let count = 0;
  let maxDate: string | null = null;
  for (const key of statusFilter) {
    const bucket = tally.byStatus[key];
    if (bucket === undefined) continue;
    count += bucket.count;
    if (bucket.maxDate !== null && (maxDate === null || bucket.maxDate > maxDate)) maxDate = bucket.maxDate;
  }
  return { count, maxDate };
}

/**
 * Janela que o clique no contador aplica: a UNIÃO da janela atual com
 * hoje 00:00 → última futura escondida 23:59.
 *
 * Por que esticar em vez de LIMPAR o filtro: limpar joga o operador de ~113 para
 * 6285 linhas (126 páginas), 6171 delas histórico morto da planilha — o remédio
 * seria pior que a doença. Esticar até `maxDate` revela exatamente o que o
 * contador prometeu e nada além disso.
 *
 * Por que UNIÃO e não substituição: o contador diz "+N futuras fora do filtro" e
 * o operador clica esperando GANHAR N linhas. Trocando a janela por
 * hoje..maxDate, quem estivesse num recorte manual à frente (ex.: 10/08..12/08,
 * olhando 20 linhas) via a janela virar 06/08..08/08 e PERDIA as 20 que estava
 * olhando — o botão prometia somar e subtraía. A união nunca encolhe nenhuma das
 * duas pontas, então o clique só pode adicionar.
 */
export function revealFutureWindow(
  todayKey: string,
  maxDate: string | null,
  atual?: Partial<MonitorLoadWindow> | null,
): MonitorLoadWindow {
  const end = maxDate && maxDate > todayKey ? maxDate : todayKey;
  const alvo = { from: `${todayKey}T00:00`, to: `${end}T23:59` };
  // Ponta vazia = sem limite daquele lado; esticar seria ENCOLHER. Preserva o vazio.
  const from = atual?.from === "" ? "" : atual?.from && atual.from < alvo.from ? atual.from : alvo.from;
  const to = atual?.to === "" ? "" : atual?.to && atual.to > alvo.to ? atual.to : alvo.to;
  return { from, to };
}
