# Runbook — Cadastro Bots (Angellira / SPX / Unificada)

> Epic **DC-111** — Sprint 1 entregou Angellira fim-a-fim. Sprint 2 entrega SPX.

Este runbook cobre setup, deploy, troubleshooting e smoke test E2E dos
sidecars Python que automatizam o cadastro de motorista, proprietário e
veículo nos sistemas externos.

---

## 1. Arquitetura resumida

```
Painel React (/motoristas)
        │ POST /api/operator/cadastros/:id/aprovar { jobs:['angellira'] }
        ▼
Backend Express (porta 3001)
        │ http://angelira-bot:8765/api/robo/*    (rede Docker interna)
        ▼
Sidecar angelira-bot (FastAPI, porta 8765)
        │ HTTPS Bearer JWT
        ▼
api.angellira.com.br/profile/{drivers,owners,vehicles}
```

3 sidecars em `bots/`:

| Sidecar | Porta | Função | Status |
|---------|-------|--------|--------|
| **angelira-bot** | 8765 | Cadastra motorista/proprietário/veículo no AngelLira | ✅ Sprint 1 |
| **unificada-bot** | 8001 | Gera Risk Assessment Document (PDF) via ReportLab | ✅ disponível (Sprint 2 integra) |
| **spx** | 8766 | Cadastra motorista no portal SPX/Shopee Express | 🚧 Sprint 2 |

---

## 2. Setup local (desenvolvedor)

### 2.1 Pré-requisitos
- Docker Desktop 24+
- Migration `20260528150000_add_external_registration_status.sql` aplicada no
  Supabase local: `psql ... -f backend/supabase/migrations/20260528...sql`
- Credenciais Angellira do operador (usuário do portal — pedir à Cynthia
  Rios, cynthia.rios@grupolamonica.com.br):
  - `ANGELIRA_API_USERNAME`
  - `ANGELIRA_API_PASSWORD`
  - `ANGELIRA_EMPRESA_ID` (default `876943`)

### 2.2 Configurar `backend.env` (na raiz, mesmo arquivo do backend)
Adicionar:
```ini
ANGELIRA_API_USERNAME=USUARIO.PORTAL
ANGELIRA_API_PASSWORD=senha-portal
ANGELIRA_EMPRESA_ID=876943
# Opcional — override do default
ANGELLIRA_BOT_URL=http://angelira-bot:8765
ANGELLIRA_BOT_TIMEOUT_MS=60000
```

### 2.3 Subir o stack
```bash
docker compose up -d --build angelira-bot unificada-bot backend
docker compose ps
```

Esperado:
- `angelira-bot` STATUS `Up (healthy)`
- `unificada-bot` STATUS `Up (healthy)`
- `backend` STATUS `Up (healthy)`

### 2.4 Smoke test
```bash
# Health do bot (de dentro da network — usa container do backend)
docker compose exec backend curl -fs http://angelira-bot:8765/api/status | jq

# Esperado:
# {
#   "ok": true,
#   "service": "angelira-robo (api-only)",
#   "robo_angelira": { "disponivel": true, "user": "USUARIO.PORTAL", ... }
# }
```

Se `disponivel: false`, verifique env vars em `backend.env`.

---

## 3. Deploy em produção (VPS)

### 3.1 Secrets do GitHub Actions
Adicionar (Repository Settings → Secrets and variables → Actions):
- `ANGELIRA_API_USERNAME`
- `ANGELIRA_API_PASSWORD`
- `ANGELIRA_EMPRESA_ID`

### 3.2 Provisionar no `backend.env` da VPS
SSH na VPS:
```bash
ssh deploy@76.13.169.177
cd /opt/apps/lamonica
sudo nano backend.env   # adicionar as 3 vars Angellira
```

### 3.3 Deploy automático
Push para `main` → workflow `deploy.yml` faz:
1. Build das 2 imagens (`ghcr.io/.../angelira-bot:SHA`, `unificada-bot:SHA`)
2. SSH na VPS → `docker compose pull && docker compose up -d`
3. Smoke test: `curl http://angelira-bot:8765/api/status`

### 3.4 Verificar pós-deploy
```bash
docker compose -f /opt/apps/lamonica/docker-compose.yml ps
docker logs cargas_lamonica-angelira-bot-1 --tail 30
```

---

## 4. Smoke test E2E manual (no preview ou prod-staging)

Pré-condições: stack rodando + login de operador + 1 cadastro pendente.

1. **Abrir** `/motoristas › Pendentes` no painel.
2. **Selecionar** um cadastro pendente com:
   - CPF do motorista preenchido
   - Cavalo com placa + `owner_doc` + `owner_doc_type`
   - `cavalo_owner` com `doc` + `razao_social/nome` + endereço
3. **Clicar "Aprovar"** → modal abre.
4. **Verificar checkbox** `[x] Cadastrar no Angellira` (default ligado).
5. **Confirmar** → toast aparece. O painel de revisão **NÃO** fecha; abaixo
   do botão aparece o bloco **"Cadastro externo"** com a linha Angellira.
6. **Aguardar ~30-60s** — polling de 3s atualiza badges em tempo real:
   - `EM PROGRESSO` (amarelo, com spinner) durante chamadas
   - `OK` (verde) ao terminar com sucesso
7. **Conferir no portal Angellira** (https://profile.angellira.com.br) que:
   - O proprietário (PJ ou PF) aparece em "Proprietários"
   - O cavalo aparece em "Veículos" vinculado ao proprietário correto
   - O motorista aparece em "Motoristas"
8. **Conferir no Supabase**:
   ```sql
   SELECT angellira_registration_status, angellira_driver_id,
          angellira_owner_id, angellira_vehicle_ids
   FROM public.driver_profiles
   WHERE document_number = '<CPF>';

   SELECT step, status, external_id, error
   FROM public.external_registration_jobs
   WHERE cadastro_id = '<UUID>'
   ORDER BY created_at;
   ```
   Esperado: 4 rows com `status='OK'` (1 por etapa).

---

## 5. Troubleshooting

### 5.1 "503 Sidecar Angellira indisponível"
**Causa:** container offline ou credenciais ausentes.
```bash
docker compose ps angelira-bot
docker logs cargas_lamonica-angelira-bot-1 --tail 50
docker compose exec angelira-bot env | grep ANGELIRA
```
**Fix:** restartar com env correto:
```bash
docker compose up -d --force-recreate angelira-bot
```

### 5.2 "OWNER_NAO_CADASTRADO" no cavalo/carreta
**Causa:** o veículo já existe no Angellira mas o proprietário esperado não
está cadastrado.
**Fix:** o operador deve cadastrar manualmente o proprietário primeiro
(via painel Angellira), depois clicar **Re-tentar etapa** no bloco
"Cadastro externo" → "Prop. Cavalo" / "Prop. Carreta".

### 5.3 "OWNER_GENERICO_BLOQUEADO"
**Causa:** o veículo está vinculado a owner genérico (GRIFFI / `TRANSPORTADOR_N0`).
**Fix:** política estrita — operador deve corrigir o owner manualmente no
Angellira antes de re-tentar.

### 5.4 Owner divergente (caso Federal Transportes)
**Sintoma:** placa já cadastrada com PJ "FEDERAL TRANSPORTES" mas o cadastro
local diz que o motorista é PF dono.
**Fix:** botão **Verificar** chama `check_owner` que retorna `divergencia=true`.
Painel exibe motivo. Operador decide se cancela ou força (futuro: Sprint 2).

### 5.5 "BOT_CIRCUIT_OPEN"
**Causa:** 3 falhas consecutivas no bot → circuit breaker aberto por 60s.
**Fix:** aguardar 1 minuto e tentar de novo. Se persistir, ver logs do bot.

### 5.6 Rollback
Se o deploy quebrar:
```bash
gh workflow run rollback.yml -f sha=<SHA-anterior>
```
Ou manual via SSH:
```bash
ssh deploy@76.13.169.177
cd /opt/apps/lamonica
docker pull ghcr.io/<org>/angelira-bot:<SHA-anterior>
docker compose up -d angelira-bot
```

---

## 6. Logs e observabilidade

- **Bot logs:** `docker logs cargas_lamonica-angelira-bot-1 -f`
- **Backend logs:** `docker logs cargas_lamonica-backend-1 -f | grep angellira-bot`
- **Audit log (Supabase):**
  ```sql
  SELECT event_type, action, outcome, metadata, created_at
  FROM public.security_audit_events
  WHERE event_type LIKE 'operator.cadastro.angellira%'
  ORDER BY created_at DESC LIMIT 20;
  ```

---

## 7. Limitações conhecidas

- **Pipeline síncrono** (timeout 90s no client Node) — para cadastros muito
  pesados pode falhar por timeout. Sprint 2 considerará workers async.
- **Sem retry automático em jobs ERROR** — operador re-tenta manualmente
  pelo painel (botão "Re-tentar etapa").
- **CRLV/CNH não são enviados ainda** — bots aceitam `anexos: {cnh_frente_path, ...}`
  mas o pipeline Node não preenche. Sprint 2 integra com `anexo_storage`
  do sidecar `cadastro-ocr`.
- **Cookie SPX manual** — Sprint 2 reutiliza `aspx_credentials.cookies_json`
  já existente no Supabase (renovação via Playwright).

---

## 8. Referências

- **Epic:** [DC-111](https://gestaolamonica.atlassian.net/browse/DC-111)
- **Sub-tarefas Sprint 1:** DC-112 a DC-119
- **Detalhe técnico dos bots:** [`bots/RELATORIO_CADASTRO.md`](../bots/RELATORIO_CADASTRO.md)
- **Cliente Node:** [`backend/src/infrastructure/cadastro-bots/angellira-bot-client.js`](../backend/src/infrastructure/cadastro-bots/angellira-bot-client.js)
- **Use cases:** [`backend/src/application/operator-admin/use-cases/angellira/`](../backend/src/application/operator-admin/use-cases/angellira/)
- **UI:** [`frontend/src/components/operator/ExternalRegistrationPanel.tsx`](../frontend/src/components/operator/ExternalRegistrationPanel.tsx)
