# Cargas Casadas — Checklist de Regressao (Phase 10)

**Objetivo:** Validar **zero regressao** em cargas avulsas (`cargas.viagem_id IS NULL`) e em todos os fluxos pre-existentes apos o deploy do feature Cargas Casadas (Phase 10 — requisito **CARGAS-CASADAS-08** LOCKED).

**Quando rodar:**

- Apos cada deploy de mudancas relacionadas ao Phase 10 (plans 10-01 a 10-08)
- Antes de promover de staging para producao
- Como gate manual de release (complementa a suite Playwright em `tests/e2e/cargas-casadas/`)

**Como rodar:**

1. Stack rodando (frontend + backend + Supabase staging) — **NUNCA** producao para os checks de DB direto.
2. Operador humano (Antonio) executa os checks UI/manual.
3. Para cada item: marcar `[x]` se passar, `[F]` se falhar (anotar evidencia/screenshot).
4. Se >1 item `[F]`: nao promover; abrir issue, corrigir, re-rodar.

---

## 1. Portal Driver — Cargas Avulsas (sem pacote)

> Premissa: motorista logado no portal `/motorista` ve uma mistura de cargas avulsas + viagens casadas.

- [ ] Listing `/motorista` renderiza cargas avulsas com layout original (1 coleta → 1 entrega; **sem** header "Viagem casada")
- [ ] `LoadCard` de carga avulsa exibe `cargas.valor` (valor unitario) — **nao** usa `cargas_casadas.valor_total`
- [ ] Tela de detalhes `/motorista/cargas/:id` de carga avulsa **NAO** renderiza `PacotePanel` (data-testid `pacote-panel` ausente)
- [ ] Botao "Candidatar-se" em carga avulsa cria `load_claims` row com `status` em [`WON_RESERVATION`, `WAITLISTED`] — usa o use-case original (sem reserva de pacote)
- [ ] Filtros de origem/destino/perfil no listing funcionam normalmente em listing misto (avulsa + pacote)
- [ ] Pagination/scroll infinito do listing nao quebra com pacotes ao lado de avulsas
- [ ] Reload do listing (`Ctrl+R`) preserva visibilidade correta de pacote vs avulsa (driver_visibility=PUBLIC vs PREMIUM)

## 2. Painel Operador — Cargas Avulsas

- [ ] `/cargas` (`ManageCargas`) lista cargas avulsas + cargas em pacotes (ambas visiveis ao operador)
- [ ] Modal de edicao `CargoModal` de carga avulsa preserva todos os campos (origem, destino, perfil, valor, bonus, status, driver_visibility)
- [ ] Toggle de status de carga avulsa para `CANCELLED` via UI **NAO** dispara cascade — `cargas_casadas` intocada
- [ ] Delete (`DELETE /api/operator/cargas/:cargoId`) de carga avulsa funciona
- [ ] Duplicar carga avulsa (`POST /api/operator/cargas/:cargoId/duplicate`) gera nova carga com `viagem_id IS NULL`
- [ ] Sheet sync (Google Sheets — Shopee) continua importando cargas como AVULSAS (`viagem_id IS NULL`)

## 3. Backend — Endpoints existentes (regressao API)

- [ ] `POST /api/loads/:loadId/claims` com `loadId` apontando para carga avulsa funciona (path original `createLoadClaim` sem reserva de pacote)
- [ ] `GET /api/public-loads/loads` retorna cargas avulsas com `pacote_meta: null` (response shape backward-compat)
- [ ] `PUT /api/operator/cargas/:id` (PATCH em `routes.js`) atualiza carga avulsa sem afetar nenhuma `cargas_casadas` row
- [ ] `DELETE /api/operator/cargas/:id` em carga avulsa retorna 204/200 sem efeito colateral em `cargas_casadas`
- [ ] `POST /api/operator/cargas/:cargoId/toggle-status` em carga avulsa funciona normalmente

## 4. Database — Constraints + RLS + Realtime

- [ ] `SELECT COUNT(*) FROM public.cargas WHERE viagem_id IS NULL` retorna a maioria dos registros (>=99%) — pacotes sao excecao, nao regra
- [ ] RLS de `public.cargas` continua filtrando `driver_visibility` corretamente para o role `driver` (PUBLIC vs PREMIUM)
- [ ] RLS de `public.cargas_casadas` permite leitura para drivers apenas via JOIN com cargas PREMIUM (validar via Supabase SQL editor com `set role authenticated`)
- [ ] Publication `supabase_realtime` contem `cargas`, `load_claims`, `load_claim_events` E `cargas_casadas` (verificar via `SELECT * FROM pg_publication_tables WHERE pubname='supabase_realtime'`)
- [ ] `cargas_casadas.version` incrementa em UPDATE de `valor_total` ou em add/remove de carga-membro (validar via trigger SQL)
- [ ] FK `cargas.viagem_id REFERENCES cargas_casadas(id)` permite NULL (avulsa) e ON DELETE SET NULL ou similar

## 5. Integracoes externas

- [ ] ANTT cascade endpoint (`POST /api/candidatura/antt-precheck`) responde normalmente para cargas avulsas E para pacotes
- [ ] Cadastro Motorista v2 (Phase 7) workflow nao afetado — sidecar Infosimples continua respondendo `/api/candidatura/pre-check`
- [ ] Evolution API (Phase 7) worker de notificacoes WhatsApp processa fila normalmente
- [ ] Geoapify rota cache (`route_metrics_cache`) continua sendo populado para cargas individuais
- [ ] Angellira CPF validation no fluxo de candidatura nao mudou

## 6. Performance

- [ ] `GET /api/public-loads/loads` p95 < 500ms apos deploy (medir via `/api/health` metrics OU Traefik dashboard)
- [ ] `DISTINCT ON` ou `LEFT JOIN cargas_casadas` na nova query do listing nao degrada listing avulso (medir via `EXPLAIN ANALYZE` SELECT do read-model)
- [ ] Realtime channel subscriptions em `cargas_casadas` nao geram > 100 mensagens/s em condicoes normais (medir via Supabase Realtime dashboard)
- [ ] `cargas(viagem_id)` index existe e e usado (validar via `EXPLAIN` em SELECT com filtro `viagem_id IS NULL`)

## 7. CI/CD + Deploy

- [ ] Workflow `e2e-cargas-casadas` (npm script `test:e2e:cargas-casadas`) configurado em CI nightly cron (`0 2 * * *`) — segue padrao Phase 8
- [ ] Smoke test (`scripts/smoke-test.sh`) continua passando apos deploy
- [ ] Rollback path (`.github/workflows/rollback.yml`) consegue voltar a versao anterior do backend sem perder dados de `cargas_casadas` (lembrar: migrations forward-only — rollback de schema requer migration nova)
- [ ] Variaveis de ambiente novas em prod documentadas (se houver — Phase 10 nao introduz nenhuma)

---

**Responsavel pela execucao:** operador humano (Antonio) — checks UI/manual + comandos SQL no Supabase staging.
**Backup automatizado:** specs Playwright em `tests/e2e/cargas-casadas/` cobrem 4 cenarios criticos (happy path, edit invalidation, cancel cascade, race condition).
**Failure protocol:** se >1 item `[F]`, rollback via GitHub Actions `rollback.yml` (Phase 5 entregou). Nao promover ate corrigir.

**Referencias:**

- Spec do feature: `.planning/phases/10-cargas-casadas/CONTEXT.md`
- Plans executados: `10-01-PLAN.md` (schema) → `10-07-PLAN.md` (operator UI)
- Suite automatizada: `tests/e2e/cargas-casadas/*.spec.ts`
