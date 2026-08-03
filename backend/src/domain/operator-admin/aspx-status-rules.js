// backend/src/domain/operator-admin/aspx-status-rules.js
//
// Regras de decisão do sync de STATUS OPERACIONAL ASPX → sistema/planilha,
// replicando a lógica do script Apps Script `atualizarStatusEDados` (DC-316,
// aba ASP → aba SHOPEE) no backend. FONTE ÚNICA das regras — o use-case
// `reconcile-aspx-status.js` só orquestra (busca a Torre, casa por LH, grava);
// o "quando sobrescrever" mora aqui, puro e testável.
//
// O vocabulário é o "Status Operacional" da Torre /api/spx/asp (DC-136), o mesmo
// que alimenta a aba ASP: AGUARDANDO ACEITE, AGUARDANDO CHEGAR NO CLIENTE,
// AGUARDANDO CARREGAMENTO, CARREGADO, CTE ENVIADO, AGUARDANDO DESCARGA,
// DESCARREGANDO, DESCARREGADO, CANCELADO, DEVOLVIDO, NO SHOW, CTE EM EMISSÃO.
//
// Regras (DC-316):
//  - Intocáveis: NO SHOW e CTE EM EMISSÃO nunca são sobrescritos.
//  - Exceções: CANCELADO / DEVOLVIDO sempre atualizam.
//  - Descarga (AGUARDANDO DESCARGA / DESCARREGANDO / DESCARREGADO) só entra se o
//    status atual for CTE ENVIADO, AGUARDANDO DESCARGA ou DESCARREGANDO.
//  - Anti-regressão: demais status não sobrescrevem CTE ENVIADO nem descarga.
//  - Status vazio: só recebe atualização se o novo status for
//    AGUARDANDO CARREGAMENTO ou CARREGADO.
//
// Além do Bloco 1/2 do DC-316, este módulo é a fonte única da ORDEM do pipeline
// operacional (`STATUS_PIPELINE`) e das duas decisões que dependem dela:
//  - `shouldReleaseAllocStatusOverride`: o override do operador ficou ATRASADO em
//    relação à planilha e deve ser solto (inclui o override VAZIO "", que fazia a
//    carga aparecer SEM status mesmo com a planilha adiantada).
//  - `shouldOverlayLiveSpxStatus`: o status AO VIVO do SPX pode sobrepor o exibido
//    no Monitor — só quando AVANÇA, para não rebaixar `CTE EM EMISSÃO`/`CTE ENVIADO`
//    (vocabulário que o SPX não conhece).

const STATUS_DESCARGA = ["AGUARDANDO DESCARGA", "DESCARREGANDO", "DESCARREGADO"];
const STATUS_PERMITEM_DESCARGA = ["CTE ENVIADO", "AGUARDANDO DESCARGA", "DESCARREGANDO"];
const STATUS_EXCECAO = ["CANCELADO", "DEVOLVIDO"];
const STATUS_INTOCAVEIS = ["NO SHOW", "CTE EM EMISSÃO"];
const STATUS_VAZIO_ACEITA = ["AGUARDANDO CARREGAMENTO", "CARREGADO"];

// Destinos que o override VAZIO ("") NÃO assume automaticamente. Soltar o vazio
// faz o status efetivo virar o da planilha; se lá está um cancelamento, isso
// desmascararia um CANCELADO e a varredura `sweepCancelledCascades`
// (COALESCE(alloc_status, sheet_status) LIKE '%cancel%') dispararia a cascata de
// rota retroativamente — motorista descendo da fila muito depois do fato. O
// desmascaramento de cancelamento é decisão de operação, não de saneamento.
const STATUS_NAO_ASSUMIDOS_DO_VAZIO = [...STATUS_EXCECAO, "NO SHOW"];

// Ordem do pipeline operacional (vocabulário DC-136/DC-316). O índice mede o
// quanto a viagem avançou e serve SÓ para comparar o override do operador com a
// planilha (ver shouldReleaseAllocStatusOverride).
//
// Os estados de EXCEÇÃO (CANCELADO, DEVOLVIDO, NO SHOW) ficam de fora de
// propósito: não têm posição no pipeline, então nunca são soltos automaticamente.
// Em particular CANCELADO, que no Monitor já disparou a cascata de rota
// (cancel-load-cascade — o motorista desce a fila): revertê-lo desincronizaria
// uma cascata que já rodou.
const STATUS_PIPELINE = [
  "AGUARDANDO ACEITE",
  "AGUARDANDO CHEGAR NO CLIENTE",
  "AGUARDANDO CARREGAMENTO",
  "CARREGANDO",
  "CARREGADO",
  "CTE EM EMISSÃO",
  "CTE ENVIADO",
  "AGUARDANDO DESCARGA",
  "DESCARREGANDO",
  "DESCARREGADO",
];

/** Normaliza para comparação: string, trim, UPPERCASE (a Torre já devolve maiúsculo). */
export function normalizeAspxStatus(value) {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * Decide se o `novoStatus` (vindo do ASPX) deve sobrescrever o `statusAtual`
 * (o que está hoje na coluna STATUS da planilha / `cargas.sheet_status`).
 * Puro — replica exatamente o Bloco 1 + a regra de status vazio do DC-316.
 *
 * STATUS VAZIO + MOTORISTA (`hasDriver`): a regra estrita ("vazio só aceita
 * AGUARDANDO CARREGAMENTO/CARREGADO") existe para não estampar estado avançado numa
 * linha DISPONÍVEL da planilha. Numa carga que JÁ tem motorista não há nada a
 * proteger — e a linha ficava vazia para sempre quando ela nasceu depois de a
 * viagem avançar (medido em prod 03/08/2026: 266 cargas lançadas com status vazio
 * no sistema e status no ASP). Com motorista, o vazio aceita qualquer estado do
 * PIPELINE; exceções (CANCELADO/DEVOLVIDO/NO SHOW) continuam fora, porque assumir
 * cancelamento aqui dispararia a cascata de rota retroativa
 * (`sweepCancelledCascades` casa COALESCE(alloc_status, sheet_status) LIKE
 * '%cancel%') — mesma proteção de `shouldReleaseAllocStatusOverride`.
 *
 * @param {string} statusAtual  status atual (planilha)
 * @param {string} novoStatus   status novo (ASPX / aba ASP)
 * @param {{ hasDriver?: boolean }} [opts] hasDriver = há motorista na alocação EFETIVA
 * @returns {boolean} true se deve gravar `novoStatus`
 */
export function shouldUpdateAspxStatus(statusAtual, novoStatus, { hasDriver = false } = {}) {
  const cur = normalizeAspxStatus(statusAtual);
  const nw = normalizeAspxStatus(novoStatus);

  // Sem status novo → nada a fazer.
  if (!nw) return false;

  // Status VAZIO: só aceita AGUARDANDO CARREGAMENTO ou CARREGADO — salvo com
  // motorista, quando aceita o pipeline inteiro (ver doc acima).
  if (!cur) {
    if (STATUS_VAZIO_ACEITA.includes(nw)) return true;
    if (!hasDriver) return false;
    return !STATUS_NAO_ASSUMIDOS_DO_VAZIO.includes(nw) && !nw.includes("CANCEL") && STATUS_PIPELINE.includes(nw);
  }

  // Já igual → não faz nada.
  if (cur === nw) return false;

  // REGRA 1: intocáveis.
  if (STATUS_INTOCAVEIS.includes(cur)) return false;

  // REGRA 2: exceções sempre atualizam.
  if (STATUS_EXCECAO.includes(nw)) return true;

  // REGRA 3: descarga só a partir de CTE ENVIADO / descarga.
  if (STATUS_DESCARGA.includes(nw)) return STATUS_PERMITEM_DESCARGA.includes(cur);

  // REGRA 4: demais — anti-regressão (não sobrescreve CTE ENVIADO nem descarga).
  return cur !== "CTE ENVIADO" && !STATUS_DESCARGA.includes(cur);
}

/**
 * O OVERRIDE do operador (`cargas.alloc_status`) está ATRASADO em relação à
 * planilha e deve ser solto? Usado pelo sync ASPX e pelo saneamento — o modal do
 * Monitor gravava o status EXIBIDO como override sem o operador ter escolhido
 * nada (race do prefill) e nada automático limpa `alloc_status`, então o valor
 * congelado sobreviveria para sempre.
 *
 * A pergunta aqui NÃO é a de `shouldUpdateAspxStatus`. Aquela decide se um valor
 * vindo do ASPX pode sobrescrever a planilha, e por isso é conservadora com a
 * descarga (regra 3: `AGUARDANDO DESCARGA`/`DESCARREGANDO`/`DESCARREGADO` só
 * entram a partir do CTE) — ela protege a planilha contra o ASPX. Aqui o alvo é
 * a PRÓPRIA planilha, a fonte que aquela regra protege: soltar o override faz o
 * status efetivo AVANÇAR até ela, que é justamente o movimento permitido.
 * Reusá-la deixaria congelado o caso mais comum (override na chegada × planilha
 * já descarregada).
 *
 * Critério: soltar quando a planilha está À FRENTE do override no pipeline.
 * Assim `CTE EM EMISSÃO`/`CTE ENVIADO` continuam valendo enquanto a planilha não
 * passa deles (o ASPX não conhece esse vocabulário), e cedem quando ela passa.
 * Exceções (CANCELADO/DEVOLVIDO/NO SHOW) nunca são soltas: não estão no pipeline.
 *
 * OVERRIDE VAZIO (""): é o SEGUNDO sintoma do mesmo defeito. O editor inline
 * mandava `status: allocStatus ?? ""` ao salvar só motorista/veículo, gravando um
 * vazio EXPLÍCITO — e `COALESCE(alloc_*, sheet_*)` devolve "" (não cai para a
 * planilha), então a carga passava a aparecer SEM status mesmo com a planilha em
 * DESCARREGADO. "" também é uma ação legítima ("Disponível", reabrir para o
 * motorista), e as duas se distinguem pelo MOTORISTA: o backend recusa deixar
 * Disponível uma carga com motorista (updateMonitorAllocation/updateMonitorCargo),
 * logo "" + motorista efetivo só pode ser o artefato. Daí o `hasDriver`.
 *
 * IMPORTANTE: só decide sobre o OVERRIDE. A decisão sobre `sheet_status` continua
 * ancorada no próprio `sheet_status` (via `shouldUpdateAspxStatus`) — ancorá-la no
 * efetivo (`alloc ?? sheet`) faria um override velho derrubar a proteção do CTE na
 * coluna L da planilha.
 *
 * @param {string|null} allocStatus       override atual (null = sem override, "" = vazio explícito)
 * @param {string} novoStatusPlanilha     status da planilha JÁ reconciliado nesta rodada
 * @param {{ hasDriver?: boolean }} [opts] hasDriver = há motorista na alocação EFETIVA
 *   (COALESCE(alloc_motorista, sheet_motorista)); só então o override "" é artefato.
 * @returns {boolean} true se o override deve ser limpo (→ NULL)
 */
export function shouldReleaseAllocStatusOverride(allocStatus, novoStatusPlanilha, { hasDriver = false } = {}) {
  const cur = normalizeAspxStatus(allocStatus);
  const nw = normalizeAspxStatus(novoStatusPlanilha);

  // Sem override (null = "sem decisão"): não há o que soltar.
  if (allocStatus == null) return false;

  // Planilha sem status: não há valor melhor para assumir → preserva o override.
  if (!nw) return false;

  // Override VAZIO ("" = artefato do editor inline OU "Disponível" deliberado).
  // Só solta com motorista na alocação efetiva — sem motorista, "" é a reabertura
  // deliberada da carga e mexer nela devolveria status a uma carga disponível.
  if (!cur) {
    if (!hasDriver) return false;
    // Nunca assume cancelamento/NO SHOW vindo da planilha (ver
    // STATUS_NAO_ASSUMIDOS_DO_VAZIO): dispararia a cascata de rota retroativa.
    if (STATUS_NAO_ASSUMIDOS_DO_VAZIO.includes(nw) || nw.includes("CANCEL")) return false;
    return true;
  }

  // Já alinhado com a planilha → o override é inócuo, não mexe.
  if (cur === nw) return false;

  return isAheadInPipeline(nw, cur);
}

/**
 * Posição no pipeline operacional, ou -1 para status FORA dele (exceções
 * CANCELADO/DEVOLVIDO/NO SHOW, rótulos legados, vazio). Fonte única da ordem.
 */
export function statusPipelinePosition(status) {
  return STATUS_PIPELINE.indexOf(normalizeAspxStatus(status));
}

/** `candidato` está estritamente À FRENTE de `referencia`? Fora do pipeline (qualquer
 *  lado) → false: não há como afirmar avanço, então preserva o que já está. */
function isAheadInPipeline(candidato, referencia) {
  const a = statusPipelinePosition(candidato);
  const b = statusPipelinePosition(referencia);
  if (a < 0 || b < 0) return false;
  return a > b;
}

/**
 * O status AO VIVO do SPX deve SOBREPOR o status exibido no Monitor?
 *
 * O overlay ao vivo (spx-operational-status.js) foi desligado em produção porque
 * sobrepunha SEMPRE: o vocabulário do SPX não conhece `CTE EM EMISSÃO`/`CTE ENVIADO`
 * (só existem na planilha), então uma carga em CTE era REBAIXADA para o rótulo do
 * SPX (`departed` → CARREGADO). Com o overlay desligado, porém, as cargas do
 * SISTEMA (lançadas na Programação, `lh_manual`) ficaram SEM fonte de status: o sync
 * ASPX casa por `sheet_lh` e nunca as visita, então o painel mostrava vazio mesmo
 * com a viagem andando no SPX.
 *
 * Regra: o SPX só AVANÇA, nunca rebaixa.
 *  - tela VAZIA → qualquer rótulo do SPX é melhor que nada (é o caso das cargas do
 *    sistema, e o que motivou religar o overlay);
 *  - ambos no pipeline → sobrepõe só se o SPX estiver à FRENTE;
 *  - exibido FORA do pipeline (`NO SHOW`, `CANCELADO`, rótulo legado) → decisão
 *    deliberada do operador, preservada.
 *
 * @param {string|null|undefined} statusExibido  status EFETIVO hoje (alloc_status ?? planilha)
 * @param {string|null|undefined} spxLabel       rótulo traduzido do SPX (spxTripStatusLabel)
 * @returns {boolean} true se o rótulo do SPX deve virar o status exibido
 */
export function shouldOverlayLiveSpxStatus(statusExibido, spxLabel) {
  const cur = normalizeAspxStatus(statusExibido);
  const nw = normalizeAspxStatus(spxLabel);

  if (!nw) return false;      // sem status ao vivo → nada a sobrepor
  if (!cur) return true;      // tela vazia → mostra o SPX (inclusive CANCELADO)
  if (cur === nw) return false;

  return isAheadInPipeline(nw, cur);
}

// ── Campos de DADOS (Bloco 2 do DC-316) ──────────────────────────────────────
// A trava é sobre o STATUS ATUAL (o que está na planilha antes desta rodada):
//  - Motorista/cavalo/carreta/origem/destino: só atualizam em AGUARDANDO
//    CARREGAMENTO ou CARREGADO.
//  - Datas (carregamento/descarga): também atualizam em AGUARDANDO CHEGAR NO CLIENTE.
const STATUS_GATE_DADOS = ["AGUARDANDO CARREGAMENTO", "CARREGADO"];
const STATUS_GATE_DATAS = ["AGUARDANDO CHEGAR NO CLIENTE", "AGUARDANDO CARREGAMENTO", "CARREGADO"];

/**
 * Quais grupos de dados podem ser atualizados a partir do STATUS ATUAL (DC-316 Bloco 2).
 * @param {string} statusAtual status atual (planilha)
 * @returns {{ dados: boolean, datas: boolean }} dados = motorista/placas/origem/destino
 */
export function shouldUpdateAspxData(statusAtual) {
  const cur = normalizeAspxStatus(statusAtual);
  return {
    dados: STATUS_GATE_DADOS.includes(cur),
    datas: STATUS_GATE_DATAS.includes(cur),
  };
}

// Colunas da aba ASP (Torre /api/spx/asp) — os mesmos nomes usados pelo DC-316.
const ASP_COL = {
  lh: "LH Trip Number",
  status: "Status Operacional",
  driver: "Driver ID",
  plate: "Vehicle Plate Number",
  etaOrigem: "ETA ORIGEM PROGRAMADO",
  etaDestino: "ETA DESTINO PROGRAMADO",
  stationOrigem: "Station_Origem",
  stationDestino: "Station_Destino",
};

/**
 * Converte uma linha crua da aba ASP (Torre) no registro normalizado usado pelo
 * sync — replicando o parse do DC-316 (limpa "[...]" do motorista/estações, quebra
 * a placa em cavalo + carreta por vírgula).
 * @param {Record<string, unknown>} row
 * @returns {{ lh, status, motorista, cavalo, carreta, dataCarregamento, dataDescarga, origem, destino }}
 */
export function parseAspTripRow(row) {
  const get = (k) => row?.[k];
  const platesRaw = String(get(ASP_COL.plate) ?? ",");
  const plates = platesRaw.split(",");
  const cavalo = (plates.shift() ?? "").trim();
  const carreta = plates.join("/").trim();
  return {
    lh: String(get(ASP_COL.lh) ?? "").trim(),
    status: String(get(ASP_COL.status) ?? "").trim(),
    // Driver ID vem como "[id] Nome" → tira o primeiro "[...]" (não-global, igual DC-316).
    motorista: String(get(ASP_COL.driver) ?? "").replace(/\[.*?\]\s*/, "").trim(),
    cavalo,
    carreta,
    dataCarregamento: String(get(ASP_COL.etaOrigem) ?? "").trim(),
    dataDescarga: String(get(ASP_COL.etaDestino) ?? "").trim(),
    // Station_* pode ter vários "[...]" → limpa todos (global, igual DC-316).
    origem: String(get(ASP_COL.stationOrigem) ?? "").replace(/\[.*?\]\s*/g, "").trim(),
    destino: String(get(ASP_COL.stationDestino) ?? "").replace(/\[.*?\]\s*/g, "").trim(),
  };
}

export const __TEST__ = {
  STATUS_DESCARGA,
  STATUS_PERMITEM_DESCARGA,
  STATUS_EXCECAO,
  STATUS_INTOCAVEIS,
  STATUS_PIPELINE,
  STATUS_NAO_ASSUMIDOS_DO_VAZIO,
  STATUS_VAZIO_ACEITA,
  STATUS_GATE_DADOS,
  STATUS_GATE_DATAS,
  ASP_COL,
};
