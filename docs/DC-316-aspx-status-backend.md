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
4. **DADOS — gates (DC-316 Bloco 2)** `shouldUpdateAspxData(statusAtual)`:
   - motorista/cavalo/carreta: só em `AGUARDANDO CARREGAMENTO`/`CARREGADO`.
   - datas (carregamento/descarga): também em `AGUARDANDO CHEGAR NO CLIENTE`.
5. **Sistema**: grava os espelhos `cargas.sheet_status/sheet_motorista/sheet_cavalo/
   sheet_carreta/sheet_data_carregamento/sheet_data_descarga`. **Não toca `alloc_*`** —
   o override manual do operador é preservado e continua vencendo na exibição do Monitor
   (`COALESCE(alloc_*, sheet_*)`).
6. **Planilha**: write-back — STATUS (col L), motorista/cavalo/carreta (E/F/G, sempre o
   valor **efetivo** p/ não apagar a célula) e datas (col C/D, condicionais). Best-effort.

## Fora de escopo (consciente)

- **origem/destino**: NÃO são sincronizados — sobrescrevê-los arriscaria o casamento de
  rota do catálogo (`route_metrics_cache`). Ficam como estão. Tratar à parte se necessário.
- **Push ao portal Shopee**: o backend não chama `ShopeeOpsLib.updateTripStatus` (é
  capacidade da planilha). Só corrige **sistema + planilha**.
- **Overlay antigo de status ao vivo (spx-bot)**: para o Monitor mostrar exatamente esta
  regra (e não o vocabulário do spx-bot por cima), desligue-o com
  `SPX_MONITOR_LIVE_STATUS_ENABLED=false`.

## Rollout (ordem obrigatória)

1. Reimplantar o `doPost` do write-back gravando a coluna STATUS (col L) — **Nova versão**
   no Apps Script (ver [monitor-sheet-writeback.md](./monitor-sheet-writeback.md)).
2. Garantir `GOOGLE_SHEET_WRITEBACK_URL` + `TORRE_SPX_ASP_API_KEY`/`TORRE_API_KEY` setados.
3. Confirmar que o **congelamento Shopee (DC-308)** foi liberado.
4. (Recomendado) `SPX_MONITOR_LIVE_STATUS_ENABLED=false` — desliga o overlay antigo de
   status ao vivo (spx-bot) para o Monitor exibir exatamente esta regra, sem vocabulário
   concorrente por cima do CTE.
5. Ligar `ASPX_STATUS_RECONCILE_ENABLED=true` (intervalo `ASPX_STATUS_RECONCILE_INTERVAL_MIN`,
   default 3min) e reimplantar o backend.

> Enquanto os passos 1–3 não estiverem prontos, deixe o job **desligado** (default): sem
> o `doPost` gravar a col L, o status iria para `sheet_status` mas o próximo sync da planilha
> (a cada 5min) o reverteria (a planilha é a fonte de verdade do sync) — evite esse flap
> ligando só depois do reimplante.

## Não é necessário

- **Migration**: `cargas.sheet_status`/`alloc_status`/`alloc_source` já existem.
- **Mudança no read model**: o Monitor já lê `COALESCE(alloc_status, sheet_status)`.
