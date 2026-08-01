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
// Além do Bloco 1/2 do DC-316, este módulo decide quando o OVERRIDE do operador
// (`cargas.alloc_status`) pode ceder e voltar a refletir a planilha —
// `shouldReleaseAllocStatusOverride`, que reusa as regras acima.

const STATUS_DESCARGA = ["AGUARDANDO DESCARGA", "DESCARREGANDO", "DESCARREGADO"];
const STATUS_PERMITEM_DESCARGA = ["CTE ENVIADO", "AGUARDANDO DESCARGA", "DESCARREGANDO"];
const STATUS_EXCECAO = ["CANCELADO", "DEVOLVIDO"];
const STATUS_INTOCAVEIS = ["NO SHOW", "CTE EM EMISSÃO"];
const STATUS_VAZIO_ACEITA = ["AGUARDANDO CARREGAMENTO", "CARREGADO"];

// Intocáveis ao soltar o OVERRIDE do operador (`cargas.alloc_status`). Além dos
// intocáveis do Bloco 1, inclui CANCELADO: cancelar no Monitor dispara a cascata
// de rota (cancel-load-cascade — o motorista desce a fila), então reverter esse
// status pelo ASPX desincronizaria a cascata que já rodou.
const STATUS_OVERRIDE_INTOCAVEIS = [...STATUS_INTOCAVEIS, "CANCELADO"];

/** Normaliza para comparação: string, trim, UPPERCASE (a Torre já devolve maiúsculo). */
export function normalizeAspxStatus(value) {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * Decide se o `novoStatus` (vindo do ASPX) deve sobrescrever o `statusAtual`
 * (o que está hoje na coluna STATUS da planilha / `cargas.sheet_status`).
 * Puro — replica exatamente o Bloco 1 + a regra de status vazio do DC-316.
 *
 * @param {string} statusAtual  status atual (planilha)
 * @param {string} novoStatus   status novo (ASPX / aba ASP)
 * @returns {boolean} true se deve gravar `novoStatus`
 */
export function shouldUpdateAspxStatus(statusAtual, novoStatus) {
  const cur = normalizeAspxStatus(statusAtual);
  const nw = normalizeAspxStatus(novoStatus);

  // Sem status novo → nada a fazer.
  if (!nw) return false;

  // Status VAZIO: só aceita AGUARDANDO CARREGAMENTO ou CARREGADO.
  if (!cur) return STATUS_VAZIO_ACEITA.includes(nw);

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
 * O OVERRIDE do operador (`cargas.alloc_status`) pode CEDER e voltar a refletir a
 * planilha? Usado pelo sync ASPX para soltar overrides que ficaram para trás — o
 * modal do Monitor já gravou o status EXIBIDO como override sem o operador ter
 * escolhido nada (race do prefill), e sem isso o valor congelado sobrevive para
 * sempre: nada automático limpa `alloc_status`.
 *
 * Reusa `shouldUpdateAspxStatus` para herdar as MESMAS proteções do DC-316 — a
 * pergunta "o override pode ser substituído por X?" é a mesma que "X pode
 * sobrescrever o status atual?". Assim `CTE EM EMISSÃO`/`CTE ENVIADO` postos à
 * mão continuam valendo (o ASPX não conhece esse vocabulário) e a descarga não
 * regride. `CANCELADO` ganha proteção extra (ver STATUS_OVERRIDE_INTOCAVEIS).
 *
 * IMPORTANTE: só decide sobre o OVERRIDE. A decisão sobre `sheet_status` continua
 * ancorada no próprio `sheet_status` — ancorá-la no efetivo (`alloc ?? sheet`)
 * faria um override velho derrubar a proteção do CTE na coluna L da planilha.
 *
 * @param {string|null} allocStatus       override atual (null = sem override)
 * @param {string} novoStatusPlanilha     status da planilha JÁ reconciliado nesta rodada
 * @returns {boolean} true se o override deve ser limpo (→ NULL)
 */
export function shouldReleaseAllocStatusOverride(allocStatus, novoStatusPlanilha) {
  const cur = normalizeAspxStatus(allocStatus);
  const nw = normalizeAspxStatus(novoStatusPlanilha);

  // Sem override, ou override VAZIO ("" = "Disponível", ação deliberada de
  // reabrir): não há o que soltar. `null` e `""` têm significados diferentes no
  // Monitor e nenhum dos dois é um status congelado.
  if (!cur) return false;

  // Já alinhado com a planilha → o override é inócuo, não mexe.
  if (cur === nw) return false;

  if (STATUS_OVERRIDE_INTOCAVEIS.includes(cur)) return false;

  return shouldUpdateAspxStatus(cur, nw);
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
  STATUS_OVERRIDE_INTOCAVEIS,
  STATUS_VAZIO_ACEITA,
  STATUS_GATE_DADOS,
  STATUS_GATE_DATAS,
  ASP_COL,
};
