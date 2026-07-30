# Monitoring — Painel de TV da Operação (Grafana da empresa)

Guia operacional completo do monitoramento do Lamonica Cargas exibido na TV.

## Arquitetura

```
NO VPS (76.13.169.177 — só coleta, leve):
  Prometheus (stack platform, já existia)
    ├── scrape traefik:8080/metrics          → tráfego, códigos HTTP, latência
    ├── scrape backend:3001/metrics          → pool pg, memória, uptime
    ├── scrape <ref>.supabase.co (plano Pro) → conexões, disco, CPU/RAM do banco
    └── scrape blackbox-exporter (este dir)  → probe do site (fora→dentro) + bots
  Traefik expõe: https://prometheus.grupolamonica.com  (TLS + basic auth)

NO SERVIDOR DA EMPRESA:
  Grafana (já existia)
    ├── datasource "lmc-prometheus" → https://prometheus.grupolamonica.com
    └── datasource "lmc-postgres"  → Supabase pooler :5432, role grafana_ro,
                                      views kpi.* (read-only, sem PII)
  Dashboard: grafana/dashboards/tv-operacao.json

TV = PC do escritório + HDMI → Chrome em modo kiosk no Grafana (LAN)
```

Arquivos deste diretório:

| Arquivo | Uso |
|---|---|
| `docker-compose.yml` | blackbox-exporter (+ node-exporter/cAdvisor no profile `host-metrics`) — sobe no VPS |
| `blackbox/blackbox.yml` | módulos de probe HTTP |
| `prometheus/scrape-jobs.example.yml` | jobs a copiar para o `prometheus.yml` da platform (placeholders → preencher no VPS) |
| `prometheus/traefik-labels.example.yml` | labels para expor o Prometheus via Traefik |
| `grafana/dashboards/tv-operacao.json` | dashboard da TV (importar no Grafana da empresa) |

## Pré-requisitos

1. **DNS**: registro A `prometheus.grupolamonica.com` → `76.13.169.177`.
2. **Acesso SSH** ao VPS.
3. **Admin no Grafana da empresa** (para datasources/import/usuário viewer).
4. Supabase **plano Pro** (endpoint de métricas) + acesso ao SQL editor.

## Passo 1 — VPS: coletores e scrape

```bash
# 1. Subir o blackbox-exporter (repo já sincronizado em /opt/apps/lamonica):
cd /opt/apps/lamonica
docker compose -f monitoring/docker-compose.yml up -d
# Se a platform NÃO tiver node-exporter/cAdvisor e quiser métricas de host:
# docker compose -f monitoring/docker-compose.yml --profile host-metrics up -d

# 2. Adicionar os jobs de monitoring/prometheus/scrape-jobs.example.yml ao
#    prometheus.yml da platform (localizar com):
docker inspect prometheus --format '{{range .Mounts}}{{if eq .Destination "/etc/prometheus/prometheus.yml"}}{{.Source}}{{end}}{{end}}'
#    Preencher <SUPABASE_PROJECT_REF> e <SUPABASE_SERVICE_ROLE_KEY>
#    (a key está no .env de produção do backend — nunca commitá-la).

# 3. Hot-reload e conferência:
docker kill --signal=SIGHUP prometheus
# Prometheus UI -> Status -> Targets: todos UP
```

> Os probes dos bots exigem os serviços na network `platform_monitoring` —
> incluído no `docker-compose.yml` do app (deploy normal do repo).

## Passo 2 — VPS: expor o Prometheus para o Grafana da empresa

```bash
# 1. Gerar hash htpasswd (a senha em claro vai para o datasource do Grafana):
docker run --rm httpd:2.4-alpine htpasswd -nbB grafana '<senha>' | sed -e 's/\$/\$\$/g'

# 2. Adicionar os labels de monitoring/prometheus/traefik-labels.example.yml
#    ao serviço prometheus em /opt/platform/docker-compose.yml e recriar:
docker compose -f /opt/platform/docker-compose.yml up -d prometheus

# 3. Testar de fora:
curl -s -o /dev/null -w '%{http_code}\n' https://prometheus.grupolamonica.com        # 401
curl -su grafana:'<senha>' https://prometheus.grupolamonica.com/-/healthy            # OK
```

## Passo 3 — Supabase: views de KPI + usuário read-only

1. A migration `backend/supabase/migrations/20260730120000_create_kpi_schema_grafana.sql`
   cria o schema `kpi`, as views e o role `grafana_ro` (NOLOGIN, sem senha).
2. **Passo manual** no SQL editor do Supabase (senha nunca vai pro repo):

```sql
ALTER ROLE grafana_ro LOGIN PASSWORD '<senha-forte-gerada>';
```

3. Teste rápido (SQL editor): `SET ROLE grafana_ro; SELECT * FROM kpi.cadastros_status_atual; RESET ROLE;`
   — deve retornar; um `SELECT` em `public.pending_driver_registrations` com esse role deve falhar.

## Passo 4 — Grafana da empresa: datasources + dashboard

Criar os dois datasources **com estes UIDs exatos** (o dashboard referencia por UID):

| UID | Tipo | Configuração |
|---|---|---|
| `lmc-prometheus` | Prometheus | URL `https://prometheus.grupolamonica.com` · Basic auth `grafana` / senha do Passo 2 |
| `lmc-postgres` | PostgreSQL | Host `aws-0-<region>.pooler.supabase.com:5432` (session mode) · DB `postgres` · User `grafana_ro.<project-ref>` · TLS `require` · **Max open connections: 3** |

> O user do pooler leva o sufixo do projeto: `grafana_ro.<project-ref>`.
> Session mode (5432) não disputa os slots do transaction mode (6543) usados pelo backend.

Depois: **Dashboards → Import** → colar `grafana/dashboards/tv-operacao.json`.
Criar usuário **`tv`** com role **Viewer** (Administration → Users) para a TV.

Via API (alternativa automatizável com service account token Admin):

```bash
curl -X POST http://<grafana>/api/datasources -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d @datasource.json
curl -X POST http://<grafana>/api/dashboards/db -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d "{\"dashboard\": $(cat grafana/dashboards/tv-operacao.json), \"overwrite\": true}"
```

## Passo 5 — TV (PC do escritório + HDMI)

1. Logar no Chrome como o usuário `tv` (Viewer) uma vez.
2. Atalho na área de trabalho (ajustar caminho do Chrome e URL do Grafana):

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --incognito=off "http://<grafana-empresa>/d/tv-operacao?kiosk&refresh=30s"
```

3. Windows: Configurações → Energia → **suspensão de tela: Nunca** (na saída HDMI).
4. Opcional: colocar o atalho em `shell:startup` para abrir sozinho após reboot.

## Verificação de ponta a ponta

1. Prometheus → Status → Targets: `traefik`, `lamonica-backend`, `supabase`, `blackbox-site`, `blackbox-bots` **UP**.
2. `https://prometheus.grupolamonica.com` → 401 sem senha; `/-/healthy` OK com senha.
3. Grafana: os dois datasources com "Save & test" verde.
4. Dashboard sem "No data" (painéis do Supabase podem pedir ajuste de nome de métrica — comparar com `curl -su service_role:<key> https://<ref>.supabase.co/customer/v1/privileged/metrics | head -50`).
5. **Sanidade de negócio**: o nº de "Cadastros pendentes" deve bater com o painel do operador.

## Troubleshooting

| Sintoma | Causa provável / ação |
|---|---|
| Target `lamonica-backend` DOWN | Backend fora da network `platform_monitoring` (conferir `docker inspect`) ou porta errada. Testar: `docker run --rm --network platform_monitoring curlimages/curl -fs http://backend:3001/metrics` |
| Targets `blackbox-bots` DOWN | Bots ainda sem a network (deploy do compose novo não rodou) ou blackbox-exporter parado |
| Target `supabase` DOWN (401) | service_role key errada no `prometheus.yml` |
| Datasource Prometheus falha no Grafana | DNS não propagou, cert ainda emitindo, ou senha basic auth errada |
| Datasource Postgres falha | Senha do `grafana_ro` não definida (`ALTER ROLE ... LOGIN PASSWORD`), user sem sufixo `.<project-ref>`, ou TLS desligado |
| Painel de negócio vazio | Migration do schema `kpi` não aplicada em prod |
| Painéis Supabase "AJUSTAR QUERY" | Nome de métrica diverge — inventariar com o curl acima e ajustar a query do painel |
| TV travou/preta | Reabrir o atalho kiosk; conferir suspensão de tela e se o Grafana da empresa está no ar |

## Rotação de credenciais

| Credencial | Onde vive | Como rotacionar |
|---|---|---|
| Basic auth do Prometheus | Label htpasswd no compose da platform + datasource do Grafana | Gerar novo hash (Passo 2), recriar prometheus, atualizar datasource |
| Senha do `grafana_ro` | Supabase + datasource do Grafana | `ALTER ROLE grafana_ro PASSWORD '...'` + atualizar datasource |
| service_role key (se regenerada no Supabase) | `prometheus.yml` do VPS + `.env` do backend | Atualizar ambos + SIGHUP no prometheus |
| Token de service account (setup) | Grafana da empresa | Revogar após o setup — não é usado em runtime |
