# Runbook: ASPX Sync Container Recovery

> Operacional. **Status:** ativo (iter #10 cargas-casadas, 2026-05-25).
> Dono: `@antoniocesar-dev`. Severidade base: P2 (motoristas novos invisíveis
> na candidatura); escala para P1 se a janela de stale-cache passar de 48h.

## Sintomas

- Motoristas reclamam no WhatsApp: _"está sempre pedindo documento do veículo"_
  ou _"diz que meu CPF não está cadastrado"_, mesmo recém-aprovados no portal
  Angellira.
- Operator panel mostra menos motoristas cadastrados do que o esperado.
- Logs do backend acumulam o evento estruturado:
  ```json
  {"level":"warn","name":"driver-validation.aspx.stale_cache","ageSeconds": 432000, ...}
  ```
- Health endpoint `GET /api/admin/aspx-sync-health` retorna:
  ```json
  { "ok": true, "isStale": true, "severity": "critical", "hoursSinceSync": 120 }
  ```

## Diagnóstico (em 3 passos)

### 1) Consulta o health endpoint

```bash
# Autentica como operator e bate no admin endpoint.
curl -s \
  -H "Authorization: Bearer ${OPERATOR_TOKEN}" \
  "https://cargas.grupolamonica.com/api/admin/aspx-sync-health" | jq
```

Esperado em regime saudável:

```json
{
  "ok": true,
  "totalDrivers": 412,
  "lastSyncAt": "2026-05-25T13:45:00Z",
  "secondsSinceSync": 480,
  "hoursSinceSync": 0,
  "isStale": false,
  "severity": "ok"
}
```

Mapeamento de `severity`:

| severity   | secondsSinceSync       | Ação                                   |
| ---------- | ---------------------- | -------------------------------------- |
| `ok`       | ≤ 21600 (6h)           | Nada a fazer.                          |
| `warning`  | 21600–86400 (6–24h)    | Investigar logs do container.          |
| `critical` | > 86400 (24h) ou vazio | **Recovery imediato** (esta runbook).  |

### 2) Confirma direto no Postgres

```sql
-- Idade do registro mais recente
SELECT
  MAX(synced_at) AS last_sync,
  NOW() - MAX(synced_at) AS age,
  COUNT(*) AS total_drivers
FROM public.aspx_drivers;
```

Se `age > '06:00:00'` confirma stale. Se `total_drivers = 0` a tabela nunca
foi populada — provavelmente cookies nunca renovados.

### 3) Avalia TTL dos cookies ASPx

```sql
SELECT
  cookies_updated_at,
  cookies_expires_at,
  cookies_expires_at - NOW() AS remaining
FROM public.aspx_credentials
WHERE id = 1;
```

Se `remaining < interval '0'` → cookies vencidos. Causa raiz é login expirado;
container está rodando mas faz requests com 401/403. Pula para "Causas comuns
→ 1) Cookies expirados".

## Recovery (VPS — SSH como root, host `76.13.169.177`)

> Pré-requisito: você tem acesso SSH ao VPS produção. O `aspx-sync` container
> roda no diretório `/opt/apps/lamonica` ao lado do backend/frontend.

```bash
# 1) Acessa o host de produção
ssh root@76.13.169.177
cd /opt/apps/lamonica

# 2) Verifica status do container
DOMAIN="cargas.grupolamonica.com" docker compose \
  -f docker-compose.yml \
  -f docker-compose.domain.yml \
  -f docker-compose.vps.yml \
  ps aspx-sync

# 3) Últimos 100 logs (procurar Playwright timeout, 401/403 do Angellira)
DOMAIN="cargas.grupolamonica.com" docker compose \
  -f docker-compose.yml \
  -f docker-compose.domain.yml \
  -f docker-compose.vps.yml \
  logs aspx-sync --tail 100

# 4) Restart simples (resolve >70% dos casos: OOM, network blip)
DOMAIN="cargas.grupolamonica.com" docker compose \
  -f docker-compose.yml \
  -f docker-compose.domain.yml \
  -f docker-compose.vps.yml \
  restart aspx-sync

# 5) Acompanha o primeiro ciclo (até ~60s)
DOMAIN="cargas.grupolamonica.com" docker compose \
  -f docker-compose.yml \
  -f docker-compose.domain.yml \
  -f docker-compose.vps.yml \
  logs aspx-sync -f
# Espera ver "sync ok | rows=N" antes de seguir.

# 6) Valida no DB (de qualquer máquina com SUPABASE_DB_URL)
psql "$SUPABASE_DB_URL" \
  -c "SELECT MAX(synced_at), NOW() - MAX(synced_at) AS age, COUNT(*) FROM public.aspx_drivers;"
```

Após o ciclo passar, re-bate `/api/admin/aspx-sync-health` e confirme
`severity: "ok"`. Comunique no canal `#ops-cargas`.

> **Lembrete prod:** nunca rode `cat .env` no host — secrets adjacentes vazam.
> Use `grep <KEY>= .env` para inspecionar variáveis pontuais.

## Causas comuns

### 1) Cookies Playwright expirados (`aspx_credentials.cookies_expires_at < NOW()`)

Sintoma: logs do container batem `401 Unauthorized` em loop. `restart` não
resolve — o login precisa ser refeito **manualmente** na máquina do operador
(IP do VPS é bloqueado pelo portal):

```bash
# Na máquina do operador (Windows local), com Node 20+:
cd lan-a-cargas-main/scripts/aspx-sync
python asp.py --refresh-credentials
# Script faz login Playwright, grava cookies em public.aspx_credentials.
```

Depois, restart do container no VPS com o passo (4) acima.

### 2) OOM kill do container

Sintoma: `docker compose ps` mostra status `Exited (137)` ou
`OOMKilled`. Solução temporária: `restart`. Solução definitiva: aumentar
`mem_limit` em `docker-compose.yml` (ex.: `512m` → `768m`).

### 3) Network outage / portal Angellira instável

Sintoma: logs com `ECONNRESET`, `ETIMEDOUT`, `Error: socket hang up` em
sequência. Aguardar 10–15min e tentar de novo. Se persistir após 30min,
escalar para o suporte Angellira.

### 4) Migration recente quebrou schema de `aspx_drivers`

Sintoma: logs com `relation "aspx_drivers" does not exist` ou
`column ... does not exist`. Confirmar últimas migrations em
`supabase/migrations/`, reverter se necessário. Usar `pre-deploy-check.sh`
antes de migrations futuras (norma do projeto).

## Monitoramento contínuo

### Banner no operator dashboard (frontend)

`ManageCargas.tsx` (ou Overview) pode chamar `/api/admin/aspx-sync-health`
no mount e mostrar banner persistente quando `severity !== "ok"`:

- `warning` (6–24h) → banner amarelo `"Sync ASPx atrasado: motoristas novos podem nao aparecer ainda."`
- `critical` (> 24h) → banner vermelho `"Sync ASPx parado ha X horas. Acionar runbook."`

### Alarme Prometheus (futuro)

```yaml
# alert rule (sugestão)
- alert: AspxSyncStale
  expr: aspx_drivers_seconds_since_sync > 21600
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "ASPx sync atrasado ({{ $value }}s)"
    runbook: "https://github.com/.../docs/runbooks/aspx-sync-recovery.md"
```

A métrica `aspx_drivers_seconds_since_sync` precisa ser exposta pelo
backend em `/metrics` (Phase de observability futura — não bloqueia
adoção desta runbook).

### Log estruturado já em produção

Backend emite `driver-validation.aspx.stale_cache` toda vez que um lookup
encontra `max(synced_at) > 6h`. Filtre por:

```
level=warn AND name=driver-validation.aspx.stale_cache
```

## Prevenção

1. **Health check** automatizado: cron-style chamada ao endpoint a cada 15min
   por um monitor externo (UptimeRobot, Better Uptime). Notifica quando
   `severity` muda para `warning` ou `critical`.
2. **Renovação proativa de cookies**: agendar reload manual no operador uma
   vez por semana (segunda-feira de manhã), em vez de esperar expirar.
3. **Reinicialização disciplinada**: `docker compose restart aspx-sync` no
   1º dia útil de cada mês, durante manutenção planejada — corta cauda longa
   de leaks de memória.

## Histórico de incidentes

| Data       | Janela parada | Causa raiz                         | Mitigação aplicada                |
| ---------- | ------------- | ---------------------------------- | --------------------------------- |
| 2026-05-20 a 2026-05-25 | 5 dias | Container parou, motivo não identificado em logs | `restart` + health endpoint criado (iter #10) |

## Referências

- Backend: `backend/src/application/aspx/aspx-admin.js`
  (`getAspxSyncHealth`).
- Backend: `backend/src/infrastructure/aspx/aspx-directory.js`
  (warning log `driver-validation.aspx.stale_cache`).
- Frontend: `frontend/src/components/driver/cadastro-v2/TelaZeroPendencies.tsx`
  (mensagens diferenciadas — assumem que sync ok = cadastro ok).
- Norma operacional VPS: `~/.claude/.../prod_compose_invocation.md`.
- Norma de release: `.planning/PRE-PRODUCTION-CHECKLIST.md`.
