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
   - motorista/cavalo/carreta e **origem/destino**: só em `AGUARDANDO CARREGAMENTO`/`CARREGADO`.
   - **datas** (carregamento/descarga): também em `AGUARDANDO CHEGAR NO CLIENTE`.
5. **Sistema**: grava os espelhos `cargas.sheet_status/sheet_motorista/sheet_cavalo/
   sheet_carreta`. **Não toca `alloc_*`** (override do operador vence na exibição) nem
   `cargas.sheet_data_*`/`cargas.origem/destino` (ver abaixo).
6. **Planilha** (write-back, best-effort): STATUS (col L) + motorista/cavalo/carreta (E/F/G,
   sempre o **efetivo** p/ não apagar a célula) + **datas (col C/D)** + **origem/destino
   (col I/J)**. Datas/origem/destino fazem *piggyback*: só vão quando algo (status/placas)
   já mudou na carga.

## Por que datas e origem/destino vão SÓ para a planilha

- **datas**: o sync **re-lê e normaliza** a data da planilha (`formatBrazilianDateTimeLabel`
  → `cargas.sheet_data_*`), então gravar direto brigaria com esse formato. O Monitor já
  mostra as datas do ASPX ao vivo (`applySpxSchedule`); a planilha recebe o valor cru do ASPX.
- **origem/destino**: o sync **não** copia Origem/Destino da planilha para `cargas.origem/
  destino` (o UPDATE de carga existente só mexe em colunas `sheet_*`), então o **casamento
  de rota do catálogo fica intacto**. A planilha (e o snapshot do Monitor) refletem o ASPX.

Fora de escopo mesmo: **push ao portal Shopee** (`ShopeeOpsLib` é da planilha). E o
**overlay antigo de status ao vivo (spx-bot)** — desligue com
`SPX_MONITOR_LIVE_STATUS_ENABLED=false` para o Monitor exibir esta regra sem o vocabulário
do spx-bot por cima do CTE.

## Rollout (ordem)

1. **Reimplantar o Apps Script** (`doPost`) gravando datas/origem/destino (C/D/I/J) também
   no **update** — "Nova versão" (ver [monitor-sheet-writeback.md](./monitor-sheet-writeback.md)).
   Status + motorista/cavalo/carreta já funcionavam sem isso; só datas/origem/destino exigem.
2. Garantir `GOOGLE_SHEET_WRITEBACK_URL` + `TORRE_SPX_ASP_API_KEY`/`TORRE_API_KEY` (já OK em prod).
3. Confirmar que o **congelamento Shopee (DC-308)** foi liberado.
4. (Recomendado) `SPX_MONITOR_LIVE_STATUS_ENABLED=false`.
5. Ligar `ASPX_STATUS_RECONCILE_ENABLED=true` (intervalo `..._INTERVAL_MIN`, default 3min)
   e mergear/deployar o backend.

> O backend pode subir ANTES do reimplante do Apps Script: o job manda as chaves de
> datas/origem/destino e o script antigo simplesmente as ignora no update (status +
> motorista/cavalo/carreta seguem funcionando). Datas/origem/destino passam a valer
> assim que o `doPost` novo for reimplantado.

## Não é necessário

- **Migration**: as colunas `cargas.sheet_*` já existem.
- **Mudança no read model**: o Monitor já lê `COALESCE(alloc_status, sheet_status)`.
