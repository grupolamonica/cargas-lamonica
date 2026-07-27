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

const STATUS_DESCARGA = ["AGUARDANDO DESCARGA", "DESCARREGANDO", "DESCARREGADO"];
const STATUS_PERMITEM_DESCARGA = ["CTE ENVIADO", "AGUARDANDO DESCARGA", "DESCARREGANDO"];
const STATUS_EXCECAO = ["CANCELADO", "DEVOLVIDO"];
const STATUS_INTOCAVEIS = ["NO SHOW", "CTE EM EMISSÃO"];
const STATUS_VAZIO_ACEITA = ["AGUARDANDO CARREGAMENTO", "CARREGADO"];

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
  STATUS_VAZIO_ACEITA,
  STATUS_GATE_DADOS,
  STATUS_GATE_DATAS,
  ASP_COL,
};
