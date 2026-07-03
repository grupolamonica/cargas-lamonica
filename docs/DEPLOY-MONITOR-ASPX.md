# Runbook de deploy — Monitor + ASPX + Eixos + Torre

Branch pronta: **`release/monitor-aspx-eixos`** (main + `feature/share-rota-e-ranking-torre`,
9 conflitos resolvidos). Verificado: **679 testes backend + typecheck + `build:dev` OK**.

> Escopo: este deploy sobe **tudo** que estava na feature — Monitor drag-fila, alocação
> **ASPX**, **eixos** (rotas/cargas), **Torre** (dossiê/ranking) + o que a main acumulou
> (RLS hardening, BRK/SPX vigency, docs migrados, keep-alive do sidecar). Não é só o ASPX.
> São 120 arquivos / +18k linhas. Se quiser fatiar, avisar antes.

## Ordem obrigatória

**Migrations → Env → Deploy.** O código novo lê colunas que **não existem em prod**;
subir o código antes das migrations = **500 em massa** (Monitor/dashboard/enrichment).

---

## 1. Pré-flight

- [ ] Backup do banco de prod (snapshot Supabase `lbpzkdec` ou `pg_dump`).
- [ ] Confirmar janela de baixo tráfego (o deploy recria containers; ~1–2 min de downtime).
- [ ] `git` local: `main == origin/main` (verificado: `4b3f004`).

## 2. Migrations em PROD (`lbpzkdec`) — ANTES do código

Prod tem só `driver_vinculos` (aplicada ad-hoc sob `20260618171424`). **Faltam 7 objetos.**
Todas as migrations abaixo são **idempotentes / no-op-safe** — seguras para rodar mesmo
que parte já exista. Aplicar **nesta ordem**:

| # | Migration | O que adiciona |
|---|-----------|----------------|
| 1 | `20260618120000_add_alloc_fields_to_cargas.sql` | `cargas.alloc_*` (overlay do operador) |
| 2 | `20260618120001_create_driver_vinculos.sql` | (já existe em prod → no-op idempotente) |
| 3 | `20260619150000_add_alloc_pinned_to_cargas.sql` | `cargas.alloc_pinned` |
| 4 | `20260619160000_add_monitor_reservas.sql` | tabela `monitor_reservas` |
| 5 | `20260625120001_add_lh_manual_to_cargas.sql` | `cargas.lh_manual` |
| 6 | `20260625170000_add_cargo_id_to_sheet_monitor_enriched.sql` | `sheet_monitor_enriched.cargo_id` |
| 7 | `20260629180000_fix_route_name_mojibake.sql` | correção de dados (mojibake em rotas) |
| 8 | `20260630120000_add_eixos_to_routes_and_cargas.sql` | `routes.eixos` + `cargas.eixos` |

> As migrations da main (`enable_rls_backend_only_tables`, `secfix_definer_views`) **já
> estão em prod** (sob `20260625140344`/`20260625141708`) — **não reaplicar**.

Aplicação (na VPS, usando a `SUPABASE_DB_URL` do próprio backend de prod):

```bash
ssh antonio-magalhaes@76.13.169.177
cd /opt/apps/lamonica
# A imagem de backend nova (do deploy) traz os .sql; ou copie os 8 arquivos p/ a VPS.
# Aplicar cada um dentro de transação (idempotentes):
for f in 20260618120000_add_alloc_fields_to_cargas \
         20260618120001_create_driver_vinculos \
         20260619150000_add_alloc_pinned_to_cargas \
         20260619160000_add_monitor_reservas \
         20260625120001_add_lh_manual_to_cargas \
         20260625170000_add_cargo_id_to_sheet_monitor_enriched \
         20260629180000_fix_route_name_mojibake \
         20260630120000_add_eixos_to_routes_and_cargas; do
  echo ">>> $f"
  docker exec -i lamonica-backend-1 sh -c \
    'psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1' < "backend/supabase/migrations/$f.sql"
done
```

Verificação pós-migration (deve dar tudo `t`):
```sql
SELECT
  to_regclass('public.monitor_reservas') IS NOT NULL AS monitor_reservas,
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='cargas' AND column_name='alloc_motorista') AS alloc_motorista,
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='cargas' AND column_name='alloc_pinned') AS alloc_pinned,
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='cargas' AND column_name='lh_manual') AS lh_manual,
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='cargas' AND column_name='eixos') AS cargas_eixos,
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='routes' AND column_name='eixos') AS routes_eixos,
  EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='sheet_monitor_enriched' AND column_name='cargo_id') AS cargo_id;
```

## 3. Env vars em PROD (`/opt/apps/lamonica/backend.env`)

Nenhuma dessas existe hoje em prod. Adicionar (editar chave a chave — **não** dar cat no
arquivo inteiro, há secrets):

```
SPX_SIDECAR_URL=http://spx-bot:8766      # backend→sidecar na rede lamonica-net
SPX_ALLOC_STATION_ID=5015                # estação do operador Lamonica
SPX_ALLOC_AGENCY_ID=1297                 # agência Lamonica
SPX_ALLOC_WRITE_ENABLED=false            # kill-switch: começa DESLIGADO (dry-run)
```

- `SPX_ALLOC_WRITE_ENABLED=false`: o Monitor mostra a prévia e **monta** o pedido, mas
  **não envia** ao Shopee. Ligar (`true`) só depois de validar em prod (passo 6).
- **`GOOGLE_SHEET_WRITEBACK_URL`**: deixar **não setado** → o Monitor não escreve de volta
  na planilha real (comportamento seguro atual). Só setar se quiser o espelho na planilha.

## 4. Deploy

```bash
# PR release/monitor-aspx-eixos → main (squash, conforme CONTRIBUTING).
# push na main dispara ci.yml (gate) + deploy.yml:
#   - build+push frontend/backend no GHCR
#   - na VPS: build dos sidecars locais (spx-bot INCLUÍDO — deploy.yml:215) + up -d
#   - smoke test
```
O `deploy.yml` (linha 215) **já rebuilda o `spx-bot`** → as rotas novas `/spx/trips/*`
entram na imagem. (Era um gap na branch antiga; a main já corrigiu.)

## 5. Verificação pós-deploy

- [ ] Monitor (`/planilha`) carrega sem 500 (KPIs, linhas, selos).
- [ ] `docker exec lamonica-spx-bot-1 sh -c 'curl -s localhost:8766/openapi.json' | grep -o '/spx/trips/[a-z]*'` → lista `assignable`, `snapshot`, `alocar`.
- [ ] Modal "Atribuir no ASPX" abre a prévia (com `SPX_ALLOC_WRITE_ENABLED=false` roda em dry-run).
- [ ] `docker logs lamonica-backend-1` sem erros de coluna/migration.

## 6. Ligar o envio REAL do ASPX (passo deliberado, depois de validar)

```bash
# backend.env: SPX_ALLOC_WRITE_ENABLED=true  → recreate do backend
DOMAIN="cargas.grupolamonica.com" docker compose \
  -f docker-compose.yml -f docker-compose.vps.yml -f docker-compose.domain.yml -f docker-compose.deploy.yml \
  up -d backend
```
Aí o botão vira "Aplicar N no ASPX" + confirmação extra e o assign vai de verdade ao portal.

## 7. Rollback

- Código: `rollback.yml` (workflow_dispatch com o SHA anterior).
- Migrations: todas aditivas — um rollback de código convive com as colunas novas (ficam
  sem uso). Não dropar colunas com o código novo ainda em prod.

---

## Notas de resolução do merge (para review do PR)

- `google-sheet-loads.js`: adotado o mecanismo da **main** p/ EXPIRED→OPEN
  (`isSheetLoadActive` + `nowSp` + contador separado `revivedExpiredCount` + hardening
  RESERVED); preservados os extras da branch (filtro `sheet_synced_at`, `getSheetClientName`,
  sweep de cancelamento). Corrigido double-count do auto-merge.
- `google-sheet-loads.test.js`: suíte da main (consistente com `revivedExpiredCount`).
- `sheet-monitor-enrichment.js`: versão da branch (superset; paginação + `mergePreservingGood`).
- `handlers.js`/`routes.js`: união (rotas torre + unificada + docs-migrados).
- `Motoristas.tsx`: pills padronizados (Angellira/ASPX/BRK).
- **Débito técnico menor**: o mock de teste de `google-sheet-loads.test.js` não exporta
  `withPgTransaction`, então o bloco de sweep loga um warning benigno nos testes (é
  try/catch, não quebra). Ajustar o mock em follow-up.
