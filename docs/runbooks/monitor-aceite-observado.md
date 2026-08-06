# Runbook: Monitor — aceite da viagem como FATO OBSERVADO

> Operacional. **Status:** ativo desde 2026-08-06. Severidade base: **P1** — o modo de
> falha desta feature é *esconder carga viva do operador*, não derrubar tela.
> PRs: **#463** (read model + migration) · **#465** (observador) · **#466** (backfill Nestlé)
> · **#464** (frontend). Corrige o incidente do **#457**.

O Monitor só esconde a carga **lançada da Shopee** quando há **evidência observada** de
não-aceite: `trip_acceptance_checked_at` preenchido **e mais novo que
`MONITOR_ACCEPTANCE_EVIDENCE_TTL_HOURS`** (24h) **e** `trip_accepted_at` nulo. Quem grava a
observação é o job `detect-aspx-missing-trips` (a cada 10 min), de carona no índice do ASPX.
Regra da casa, e é o que este runbook protege: **dado ausente, duvidoso ou VELHO nunca
esconde linha.**

---

## 1. Ordem de deploy

**Não existe step de migration no CI/CD.** Confirmado em `.github/workflows/` (`ci.yml`,
`deploy.yml`, `rollback.yml`): nenhum `psql`, `migrate` ou `supabase db push`. O deploy é
automático no merge para `main`. **A migration é manual e é responsabilidade de quem mergeia.**

Ordem canônica: **migration → verificar → deploy → confirmar que o filtro ligou.**
O desenho é seguro em qualquer ordem (seção 2), mas esta é a que não exige explicação.

### 1.1 Aplicar a migration

A imagem do backend **não tem `psql`** (`backend/Dockerfile` instala só `curl`) e **não
carrega `backend/supabase/`** (`COPY src ./src`). Aplica-se via `node` + `pg`, que a imagem
tem, usando a `SUPABASE_DB_URL` do próprio backend de prod — mesmo padrão de
`scripts/aspx-sync/_apply_migration.mjs`.

```bash
ssh antonio-magalhaes@76.13.169.177
cd /opt/apps/lamonica

# O .sql só existe no host DEPOIS do deploy (o deploy roda `git reset --hard origin/main`).
docker cp backend/supabase/migrations/20260806150000_add_trip_acceptance_checked_to_cargas.sql \
  lamonica-backend-1:/tmp/mig.sql

docker exec -i lamonica-backend-1 node <<'JS'
const pg = require("pg");
const sql = require("node:fs").readFileSync("/tmp/mig.sql", "utf8");
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
(async () => { await c.connect(); await c.query(sql); console.log("OK"); await c.end(); })()
  .catch((e) => { console.error("FALHA:", e.message); process.exit(1); });
JS
```

**Migrando ANTES do merge** (o `.sql` ainda não está na VPS), o corpo inteiro é um `ALTER`
aditivo — o `COMMENT` é documentação e pode entrar depois com o comando acima:

```bash
docker exec -i lamonica-backend-1 node <<'JS'
const pg = require("pg");
const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  await c.connect();
  await c.query("ALTER TABLE public.cargas ADD COLUMN IF NOT EXISTS trip_acceptance_checked_at timestamptz");
  console.log("OK"); await c.end();
})().catch((e) => { console.error("FALHA:", e.message); process.exit(1); });
JS
```

Aditiva, sem DEFAULT, sem NOT NULL, sem índice, sem backfill: `IF NOT EXISTS` a torna
idempotente e o lock é instantâneo. Não requer janela.

### 1.2 Verificar (as DUAS colunas — falta uma, o filtro fica desligado por inteiro)

```sql
SELECT
  EXISTS(SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='cargas'
            AND column_name='trip_accepted_at')            AS trip_accepted_at,
  EXISTS(SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='cargas'
            AND column_name='trip_acceptance_checked_at')  AS trip_acceptance_checked_at;
```

Tem de dar `t | t`. Com apenas uma delas o read model desliga o filtro inteiro (por desenho:
sem as duas não dá para distinguir "observamos que não está aceita" de "nunca olhamos").

### 1.3 Confirmar que o filtro ligou

Não há log quando a coluna opcional é desligada por 42703 — a confirmação é por **dado**:

```sql
SELECT count(*)                                                               AS lancadas_vivas,
       count(*) FILTER (WHERE trip_acceptance_checked_at IS NOT NULL)         AS observadas,
       count(*) FILTER (WHERE trip_accepted_at IS NOT NULL)                   AS aceitas,
       count(*) FILTER (WHERE trip_accepted_at IS NULL
                          AND trip_acceptance_checked_at > now() - interval '24 hours'
                          AND status = 'OPEN'
                          AND coalesce(nullif(trim(alloc_motorista), ''), NULL) IS NULL
                          AND coalesce(nullif(trim(coalesce(alloc_status, sheet_status)), ''), NULL) IS NULL)
                                                                              AS escondiveis
  FROM public.cargas
 WHERE lh_manual IS NOT NULL AND sheet_lh IS NULL AND is_template = false
   AND status NOT IN ('EXPIRED','DRAFT') AND alloc_merged_into_cargo_id IS NULL;
```

`escondiveis` é o teto do que sai da tela (o filtro ainda desconta lead vivo na fila e
Nestlé). Se `escondiveis > 0` e o Monitor não mudou de contagem, o filtro **não** ligou —
confira `MONITOR_HIDE_UNACCEPTED_LAUNCHED` no `backend.env`.

---

## 2. Os 4 estados — nenhum quebra

| # | Estado | O que o operador VÊ | Quebra? |
|---|--------|---------------------|---------|
| a | código velho + banco velho (prod hoje) | as ~92 lançadas visíveis — é o incidente do #457 já mitigado por env | Não |
| b | código NOVO + banco velho (real logo após o merge) | 42703 → fallback por nome desliga a opcional → filtro de aceite DESLIGADO por inteiro; ~92 lançadas visíveis; job devolve `skipped:"column_missing"` sem logar | Não |
| c | código novo + banco novo, **antes** do job rodar | todo `checked_at` NULL = aceite desconhecido → **nada** escondido | Não |
| d | código novo + banco novo, **depois** do job | esconde só com evidência fresca; disjuntor aborta acima de `max(5, 20% das conclusivas)` | Não |

A degradação sempre MOSTRA carga a mais, nunca a menos. Por isso a ordem migration↔deploy
é uma questão de higiene, não de risco.

---

## 3. ROLLBACK

> ### NÃO use `rollback.yml` para reverter esta feature.
>
> É a pior ação possível aqui, e é exatamente o que
> [`docs/DEPLOY-MONITOR-ASPX.md`](../DEPLOY-MONITOR-ASPX.md) §7 recomenda como padrão.
> Voltar o código para `d0d16a8` restaura o read model do **#457**, que não conhece
> `trip_acceptance_checked_at` — a regra vira `if (c.trip_accepted_at) return false;` e nada
> mais, ou seja, **NULL volta a significar "não aceita"**. Toda lançada com `accepted_at`
> nulo some de novo — inclusive as que o observador acabou de confirmar como aceitas, agora
> com aparência de dado legítimo. O banco não volta junto: as colunas ficam preenchidas e
> o código velho as ignora.

**O caminho de volta é o env.** Em `/opt/apps/lamonica/backend.env` (editar chave a chave —
**não** dar `cat` no arquivo, há secrets):

```
MONITOR_HIDE_UNACCEPTED_LAUNCHED=false
```

```bash
ssh antonio-magalhaes@76.13.169.177
cd /opt/apps/lamonica
DOMAIN="cargas.grupolamonica.com" docker compose \
  -f docker-compose.yml -f docker-compose.vps.yml -f docker-compose.domain.yml -f docker-compose.deploy.yml \
  up -d backend
```

Efeito imediato na próxima leitura do Monitor: **nenhuma** linha é escondida por aceite.

**Atenção — o que NÃO serve de kill-switch de emergência:**

| Chave | O que faz | Serve para apagar incêndio? |
|-------|-----------|------------------------------|
| `MONITOR_HIDE_UNACCEPTED_LAUNCHED=false` | desliga o filtro na LEITURA | **Sim** — efeito na próxima request |
| `SPX_ACCEPTANCE_OBSERVE_ENABLED=false` | para de GRAVAR observação | **Não** — as linhas já escondidas continuam escondidas até a evidência expirar pelo TTL (**até 24h**) |
| `MONITOR_ACCEPTANCE_EVIDENCE_TTL_HOURS=0` | valor ≤ 0 cai no default | **Não** — não desliga nada |

`backend.env` **sobrevive aos deploys** (é gitignored; o `git reset --hard origin/main` do
`deploy.yml` não o toca). Ou seja: a linha fica lá para sempre até alguém removê-la.
**Remover depois de resolver** e recriar o backend com o mesmo comando acima — senão a
feature fica desligada em silêncio e o próximo a investigar perde uma tarde.

---

## 4. Rollout recomendado

1. **Antes do merge**, com o filtro desligado por precaução: acrescentar
   `MONITOR_HIDE_UNACCEPTED_LAUNCHED=false` ao `backend.env`. Não precisa recriar nada — o
   deploy do merge já sobe o container com a chave.
2. **Mergear** (`main` → deploy automático). Estado (b) até a migration: filtro desligado
   por falta de coluna *e* por env, ~92 lançadas na tela.
3. **Aplicar a migration** (§1.1) e verificar (§1.2).
4. **Deixar o job observar 1–2 ciclos** (10 min cada) e ler o log agregado:
   ```bash
   docker logs --since 30m lamonica-backend-1 2>&1 | grep 'detect-aspx-missing-trips.acceptance'
   ```
   Formato: `[security-event] detect-aspx-missing-trips.acceptance-observed { conclusivas, aceitas, gravadas, novasAceitas, novasOcultacoes }`.
5. **Conferir 3–4 LHs no portal SPX à mão** contra o banco (§5) — o sinal
   `acceptance_status = 0` na aba Planejado significar "não aceita" **nunca foi medido em
   produção**. Este passo é o que valida a premissa da feature.
6. Só então **remover** `MONITOR_HIDE_UNACCEPTED_LAUNCHED=false` do `backend.env` e recriar
   o backend (comando da §3). Reler a §1.3.

### O disjuntor VAI abrir no primeiro ciclo — e isso é o desenho

Teto = `max(SPX_ACCEPTANCE_MAX_HIDE_ABS, floor(conclusivas × SPX_ACCEPTANCE_MAX_HIDE_RATIO))`,
defaults `5` e `0.2`. Com as **48 lançadas "LT…" vivas** e **0 aceites gravados** medidos em
06/08/2026, o teto fica em **`max(5, 9) = 9`**: **a partir de 10 viagens voltando "não
aceita" no mesmo ciclo o disjuntor abre**, nada é gravado, e a feature fica **inerte** até
alguém subir `SPX_ACCEPTANCE_MAX_HIDE_ABS`.

Sinais de que abriu — não é bug:

- sino do operador: *"N cargas lançadas apareceriam como NÃO aceitas — nada foi alterado"*
  (kind `spx_acceptance_mass_hide`, um aviso por janela de `ASPX_MISSING_REALERT_HOURS`);
- log `detect-aspx-missing-trips.acceptance-mass-hide-aborted { conclusivas, aceitas, ocultacoes, teto }`.

**Ação:** conferir os LHs no portal. Se as ausências forem reais, subir
`SPX_ACCEPTANCE_MAX_HIDE_ABS` (ex.: `50`) no `backend.env` e recriar o backend. Se não
forem, o disjuntor acabou de evitar a repetição do #457 — investigar a aba Planejado antes
de mexer no teto.

---

## 5. "Sumiu uma carga do Monitor" — diagnóstico

Três lugares, nesta ordem.

**1) O banco diz por quê.** Trocar o LH:

```sql
SELECT id, lh_manual, status, alloc_motorista, alloc_status, sheet_status,
       trip_accepted_at, trip_acceptance_checked_at,
       trip_acceptance_checked_at > now() - interval '24 hours' AS evidencia_fresca
  FROM public.cargas
 WHERE lh_manual = 'LT-XXXXXXXX' AND sheet_lh IS NULL;
```

Leitura do resultado:

| Resultado | Veredito |
|-----------|----------|
| `trip_accepted_at` preenchido | **não** é o filtro de aceite — a linha fica sempre |
| `trip_acceptance_checked_at` NULL | **não** é o filtro — nunca checado = desconhecido = visível |
| `evidencia_fresca = f` | **não** é o filtro — evidência velha = desconhecido = visível |
| `checked_at` fresco + `accepted_at` NULL + `status='OPEN'` + sem motorista/status operacional | **é o filtro** — comportamento esperado; se estiver errado, aceite no portal SPX (o job re-observa em ≤10 min) ou §3 |
| `aspx_missing_since` preenchido | é o **outro** filtro: viagem saiu do ASPX (selo "Fora do ASPX" em `/cargas`) |

**2) O log do job diz se a observação está viva.**

```bash
docker logs --since 2h lamonica-backend-1 2>&1 | grep 'detect-aspx-missing-trips'
```

- `acceptance-observed` → gravando normalmente (em regime, só a regravação de 60 min escreve;
  pico aqui = mudança real no portal).
- `acceptance-mass-hide-aborted` → disjuntor aberto, nada gravado (§4).
- `acceptance-failed` → erro real na carona; o resto do job segue.
- **silêncio total** → ou a coluna não existe (`skipped:"column_missing"`, silencioso por
  desenho), ou `SPX_ACCEPTANCE_OBSERVE_ENABLED=false`, ou `ASPX_MISSING_DETECT_ENABLED=false`.
  Checar §1.2 e o `backend.env`.

**3) O sino do operador.** `operator_notifications`, kinds `spx_acceptance_mass_hide`
(disjuntor) e o de viagem fora do ASPX. Nenhuma ocultação por aceite gera aviso individual —
por desenho: 90 sinos não ajudam ninguém.

> Nada aqui apaga carga. A lançada escondida continua em **`/cargas`**, íntegra. Se ela sumiu
> de `/cargas` também, o problema **não** é esta feature.
