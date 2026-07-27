# DC-316 — Sync de status operacional ASPX → sistema/planilha (no backend)

Replicação, **no backend**, do script Apps Script `atualizarStatusEDados` (DC-316,
aba `ASP` → aba `SHOPEE`). Em vez de rodar dentro da planilha, o backend mantém o
status operacional das cargas sincronizado com o ASPX e corrige a coluna STATUS da
planilha por write-back.

## Peças

| Peça | Arquivo |
|------|---------|
| Regras puras (decisão de sobrescrever) | `backend/src/domain/operator-admin/aspx-status-rules.js` |
| Orquestração (busca Torre, casa por LH, grava) | `backend/src/application/operator-admin/use-cases/reconcile-aspx-status.js` |
| Job periódico (opt-in) | `backend/src/main.js` (bloco 4f, `ASPX_STATUS_RECONCILE_ENABLED`) |
| Write-back da coluna STATUS | `sheet-writeback.js` + `doPost` (col L) — ver [monitor-sheet-writeback.md](./monitor-sheet-writeback.md) |

## Fluxo

1. **Fonte** = a aba `ASP`: Torre `GET /api/spx/asp` (DC-136). `parseAspTripRow`
   extrai por viagem: status, motorista (tira `[id]`), cavalo+carreta (quebra a placa),
   ETAs de origem/destino. Indexado por **"LH Trip Number"**.
2. **Match** por `LH Trip Number == cargas.sheet_lh` (== `trip_number`). Só cargas
   Shopee têm `sheet_lh`; viagens do ASPX já vêm com motorista atribuído no portal.
3. **STATUS — regras (DC-316)** `shouldUpdateAspxStatus(statusAtual, novoStatus)` sobre
   o status atual da planilha (`cargas.sheet_status`):
   - Intocáveis: `NO SHOW`, `CTE EM EMISSÃO` — nunca sobrescritos.
   - Exceções: `CANCELADO`, `DEVOLVIDO` — sempre atualizam.
   - Descarga (`AGUARDANDO DESCARGA`/`DESCARREGANDO`/`DESCARREGADO`) — só a partir de
     `CTE ENVIADO`, `AGUARDANDO DESCARGA` ou `DESCARREGANDO`.
   - Anti-regressão: demais status não sobrescrevem `CTE ENVIADO` nem descarga.
   - Status vazio: só aceita `AGUARDANDO CARREGAMENTO` ou `CARREGADO`.
   - Efeito líquido: **`CTE EM EMISSÃO`/`CTE ENVIADO` vêm da planilha; o resto do ASPX**.
4. **DADOS — gate (DC-316 Bloco 2)** `shouldUpdateAspxData(statusAtual).dados`:
   - motorista/cavalo/carreta: só em `AGUARDANDO CARREGAMENTO`/`CARREGADO`.
5. **Sistema**: grava os espelhos `cargas.sheet_status/sheet_motorista/sheet_cavalo/
   sheet_carreta`. **Não toca `alloc_*`** — o override manual do operador é preservado e
   continua vencendo na exibição do Monitor (`COALESCE(alloc_*, sheet_*)`).
6. **Planilha**: write-back — STATUS (col L, condicional) + motorista/cavalo/carreta
   (E/F/G, sempre o valor **efetivo** p/ não apagar a célula). Best-effort. **Casa com o
   Apps Script publicado (PR #322)**, que já grava esses campos no update — **sem reimplante**.

## Fora de escopo (consciente)

- **datas (carregamento/descarga)**: NÃO sincronizadas. `cargas.sheet_data_*` é rótulo
  denormalizado ISO (`YYYY-MM-DDTHH:MM`) e o ASPX devolve outro formato — sincronizá-lo
  quebraria a convenção. O Monitor já mostra as datas do ASPX ao vivo (`applySpxSchedule`).
- **origem/destino**: NÃO sincronizados — sobrescrevê-los arriscaria o casamento de rota
  do catálogo (`route_metrics_cache`).
- **Push ao portal Shopee**: o backend não chama `ShopeeOpsLib.updateTripStatus`.
- **Overlay antigo de status ao vivo (spx-bot)**: desligue com
  `SPX_MONITOR_LIVE_STATUS_ENABLED=false` para o Monitor exibir esta regra sem o
  vocabulário do spx-bot por cima do CTE.

> datas e origem/destino podem ser tratados à parte depois, com o cuidado de formato/rota.

## Rollout (ordem)

1. Garantir `GOOGLE_SHEET_WRITEBACK_URL` + `TORRE_SPX_ASP_API_KEY`/`TORRE_API_KEY` setados
   (já OK em prod). **Não precisa reimplantar o Apps Script** — o publicado (PR #322) já
   grava STATUS (col L) + motorista/cavalo/carreta no update.
2. Confirmar que o **congelamento Shopee (DC-308)** foi liberado.
3. (Recomendado) `SPX_MONITOR_LIVE_STATUS_ENABLED=false`.
4. Ligar `ASPX_STATUS_RECONCILE_ENABLED=true` (intervalo `ASPX_STATUS_RECONCILE_INTERVAL_MIN`,
   default 3min) e mergear/deployar o backend.

## Não é necessário

- **Migration**: as colunas `cargas.sheet_*` já existem.
- **Reimplante do Apps Script**: o publicado (PR #322) já cobre status + motorista/cavalo/carreta.
- **Mudança no read model**: o Monitor já lê `COALESCE(alloc_status, sheet_status)`.
