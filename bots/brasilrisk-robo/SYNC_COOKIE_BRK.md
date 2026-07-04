# Sync do cookie BRK: card do painel → robô `:5010`

Fecha o loop de gestão do cookie do **BRK (Brasil Risk)** pelo painel, igual ao SPX:
o operador cola o cookie no **card** e o robô passa a usá-lo **sozinho**, sem abrir
navegador e sem reiniciar nada.

## O loop

```
┌─ painel (Motoristas → Brasil Risk → "Atualizar cookie")
│     POST /api/operator/brk/cookie
▼
brk_credentials  (Supabase, singleton id=1: cookies_json + user_agent + TTL)
│
│   sync_cookie_from_supabase_brk.js   (Tarefa Agendada no SERVERBD, a cada ~2 min)
▼
backend/cookie.txt + backend/useragent.txt   (o que o robô :5010 lê)
│
│   lib/brasilrisk_consulta.js recarrega o cookie.txt sozinho (watch de mtime)
▼
robô :5010  →  consulta de aptidão no br2.brasilrisk.com.br
```

Peças:
- **Backend/Frontend** (já em produção, PR #81 / DC-166): o card `BrkSyncCard` + os
  endpoints `GET/POST /api/operator/brk/*` + a tabela `brk_credentials`.
- **`sync_cookie_from_supabase_brk.js`** (este PR): a ponte Supabase → `cookie.txt`
  no SERVERBD.
- **`keepalive_brk.js`** (já instalado): mantém a sessão ASP.NET viva entre consultas.

## "Mais novo vence" (por que não há conflito)

O sync só **sobrescreve** o `cookie.txt` local se o cookie do card
(`cookies_updated_at`) for **mais novo** que o `cookie.txt`. Consequências:

- Colou um cookie novo no card → `updated_at` > mtime → **o card vence** (é o que você quer).
- Fez um `login` local depois → `cookie.txt` mais novo → **o local é mantido** (não é
  sobrescrito por um cookie antigo do card).
- Supabase sem cookie (`cookies_json` vazio) → **não toca em nada** (não apaga cookie bom).
- Nada mudou → **não reescreve** (evita zerar o cache do lib por churn de mtime).

> Se você fizer `login` local, o painel continuará mostrando o cookie antigo (o sync é
> só Supabase → arquivo). Para manter o card em dia, **cole também no painel**. (Um push
> automático do `login` → Supabase pode vir em PR futuro.)

## Instalar no SERVERBD

Pré-requisitos no `.env` do robô (os mesmos do `backfill_brk_supabase.js`):

```
SUPABASE_URL=https://lbpzkdecwraipbjbaajs.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role do projeto "Lamonica Cargas">
```

> ⚠ **Confirme o caminho do `cookie.txt`.** Este script escreve, por padrão, em
> `bots/brasilrisk-robo/backend/cookie.txt` (o que o `server.js`/`lib` deste robô leem).
> Se o `:5010` que o backend chama for **outro** robô (ex.: o do sistema de cadastro no
> `H:`), aponte no `.env`:
> ```
> BRK_COOKIE_FILE=H:\...\caminho\cookie.txt
> BRK_UA_FILE=H:\...\caminho\useragent.txt
> ```

Testar 1x (dry, seguro — não apaga nada):

```powershell
node sync_cookie_from_supabase_brk.js
# "sem cookie no Supabase" (exit 2) enquanto ninguem colou no card;
# "sincronizado" (exit 0) depois que colar.
```

Registrar a tarefa (a cada 2 min, sessão logada, sem admin — igual ao keep-alive):

```powershell
cd bots\brasilrisk-robo
.\scripts\instalar_sync_cookie_brk.ps1                 # a cada 2 min
.\scripts\instalar_sync_cookie_brk.ps1 -IntervalMinutes 1
.\scripts\instalar_sync_cookie_brk.ps1 -Remover        # desinstala
```

Ver resultado:

```powershell
schtasks /Query /TN "BRK - Sync Cookie do Painel" /V /FO LIST   # LastTaskResult 0 = ok
```

## Fluxo de uso (operador)

1. Logar no `br2.brasilrisk.com.br` num Chrome, resolvendo o Turnstile do Cloudflare.
2. Exportar os cookies do domínio (extensão **Cookie-Editor** → Export) — precisa incluir
   o **`cf_clearance`** e o **`cokiename`**.
3. No painel: **Motoristas → Brasil Risk → "Atualizar cookie"**, colar o export + o
   **User-Agent** do Chrome (o `cf_clearance` é amarrado ao UA).
4. Em ~2 min o sync escreve o `cookie.txt` e o robô volta a consultar. O card mostra o
   TTL do cookie e quantos motoristas têm BRK.

## Exit codes (`sync_cookie_from_supabase_brk.js`)

| code | significado |
|------|-------------|
| 0 | em sincronia / atualizado / local mais novo (mantido) |
| 2 | sem cookie no Supabase (nada a fazer) |
| 3 | erro de rede / resposta / escrita |
| 4 | env do Supabase ausente |
