# Runbook — Ligar a retenção de dados pessoais (DC-283 / CRIT-4)

**Contexto:** a plataforma tinha dois mecanismos de retenção escritos em código e **nunca chamados** — não havia bootstrap no `main.js` nem `on: schedule` em `.github/workflows/`. Na prática, todo rascunho de candidatura (CNH, RG, endereço, dados bancários, foto de selfie) e todo lead público viviam indefinidamente. É o achado CRIT-4 da auditoria LGPD e viola o art.16 (limitação de armazenamento).

Este PR **liga o encanamento, mas não abre a torneira**. Ligar de fato é uma decisão consciente, e este runbook é o passo a passo.

---

## Por que não já vem ligado

Os dois são **expurgos de estreia**: como nunca rodaram, o primeiro ciclo enfrenta todo o acumulado histórico. E o que eles fazem não volta.

Medição em produção, 2026-08-07 (consulta somente-leitura, mesmo `WHERE` do job):

| Mecanismo | Elegíveis hoje | O que faz | Reversível? |
|---|---|---|---|
| Expurgo de rascunhos > 72h | **382** de 425 rascunhos v2 | `DELETE` da linha + remove CNH/selfie/CRLV do bucket `cadastro-drafts` | **Não** |
| Redação de PII de leads > 30d | **626** de 1633 leads | CPF/telefone/placas viram `redacted-<id>` | **Não** |

O guard do expurgo é rígido (`status='draft' AND versao_cadastro='v2'`) e protege corretamente os 441 registros não-rascunho (`aprovado`, `pendente`, `rejeitado`, `concluido`) e todos os cadastros v1.

---

## Parte 1 — Expurgo de rascunhos

Controlado por `CANDIDATURA_DRAFT_CLEANUP_MODE`, com três estados:

| Modo | Comportamento |
|---|---|
| `off` | Worker não sobe |
| `report` (**default**) | Conta os elegíveis e loga por ciclo. **Não apaga nada** |
| `on` | Apaga, respeitando `CANDIDATURA_DRAFT_CLEANUP_BATCH` (default 50) por ciclo |

### Passo a passo

1. **Deploy com o default (`report`).** Nada é apagado. A cada hora sai no log do container:

   ```
   [draft-cleanup] modo report — nada foi apagado {"elegiveis":382,"apagaria_por_ciclo":50,...}
   ```

2. **Confira o número.** Se `elegiveis` estiver muito acima do esperado, pare e investigue antes de continuar — pode indicar que o wizard está abandonando rascunhos que deveriam virar submissão.

3. **Ligue:** `CANDIDATURA_DRAFT_CLEANUP_MODE=on` no `backend.env` da VPS e recrie o container.

4. **Acompanhe o primeiro ciclo.** Com lote de 50 e intervalo de 1h, 382 rascunhos levam ~8 horas para drenar. O log passa a mostrar:

   ```
   [draft-cleanup] {"pg_deleted":50,"storage_deleted":137,"storage_errors":0}
   ```

   `storage_errors` diferente de zero é esperado em pequena quantidade (rascunho sem arquivo enviado); crescente e sistemático significa problema de credencial do Storage.

### Por que o lote existe

O código original apagava tudo num único `DELETE` e depois disparava **duas chamadas ao Supabase Storage por linha**. Com 382 elegíveis, isso é ~764 chamadas de API num único tick — candidato certo a timeout ou rate limit. O teto por ciclo transforma isso em drenagem gradual.

---

## Parte 2 — Redação de PII de leads

Opt-in direto, sem modo intermediário: o use-case já processa em lotes de 50 por ciclo, então ele mesmo é a drenagem gradual.

```
PUBLIC_LEAD_PII_REDACTION_ENABLED=true
PUBLIC_LEAD_PII_REDACTION_INTERVAL_MIN=60
PUBLIC_LEAD_PII_RETENTION_DAYS=30
```

Só toca leads em estado terminal (`APPROVED` com carga encerrada, ou `CANCELLED`) e mais velhos que a retenção. Cada lote emite evento `public-leads.pii.redacted` na trilha de auditoria.

Com 626 elegíveis, lotes de 50 e ciclo de 1h: ~13 horas para drenar.

---

## Como verificar o alcance sem ligar nada

Consulta somente-leitura, de dentro do container do backend:

```bash
docker exec -i lamonica-backend-1 node -e "
const { Client } = require('/app/node_modules/pg');
(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const d = await c.query(\"SELECT COUNT(*)::int AS n FROM public.pending_driver_registrations WHERE status='draft' AND versao_cadastro='v2' AND updated_at < now() - interval '72 hours'\");
  console.log('rascunhos elegiveis:', d.rows[0].n);
  await c.end();
})();
"
```

---

## Rollback

Ambos são só desligar a variável e recriar o container. **Mas o que já foi apagado ou redigido não volta** — não há undo. Por isso o modo `report` existe: ele é a única chance de olhar antes.

## Fora do escopo deste runbook

- Retenção da tabela de auditoria (achado MED-9 — comentário de índice cita 90d, sem job)
- Motor de eliminação abrangente cobrindo `motoristas_historico` e o resto do Storage (MED-14)
- Janela de retenção juridicamente definida por finalidade — os 72h/30d aqui são os que já estavam no código, não uma política aprovada
