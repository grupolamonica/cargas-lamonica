# Cookie automático do BRK

## ✅ PRODUÇÃO (recomendado — validado 2026-07-01): login 1x + keep-alive HTTP

O navegador só entra no **login inicial**; a manutenção da sessão é **HTTP puro, sem
navegador** (soak: 8/8 pings vivos em ~35 min). Passos na máquina que roda o `:5010`
(SERVERBD):

1. **Login inicial (1x, headed — resolve o Cloudflare + grava o `cokiename`):**
   ```powershell
   cd "...\bots\brasilrisk-robo"
   npm install                          # 1x: instala puppeteer/dotenv locais
   node refresh_cookies_brk_pw.js login
   ```
   A janela fecha sozinha ao confirmar a sessão (grava `backend/cookie.txt` + `useragent.txt`).

2. **Keep-alive automático (tarefa agendada, HTTP, 24/7 sem navegador):**
   ```powershell
   .\scripts\instalar_keepalive_brk.ps1                 # a cada 10 min (S4U)
   .\scripts\instalar_keepalive_brk.ps1 -IntervalMinutes 8
   ```
   A tarefa **"BRK - Keep-Alive Cookie"** roda `keepalive_brk.js`: um GET autenticado em
   `/Motorista/Listar` reseta o timeout de ociosidade do ASP.NET. Exit 0 = viva · 5 = expirada.

> **Por que só isso basta:** a sessão do BRK **não rotaciona cookie** — o `cokiename`
> (ticket de auth, ~2400 chars) é estático. Basta "tocar" a sessão dentro da janela de
> ociosidade (~20 min); sem tráfego ela morre (era a causa do "cookie não funciona"). O
> `cf_clearance` sobrevive porque não re-desafiamos o Cloudflare por HTTP.

> ⚠️ Refaça o **login** (passo 1) quando a sessão morrer de vez (reboot longo sem
> keep-alive, logout no BRK, ou expiração do `cf_clearance`). O keep-alive sinaliza
> isso (exit 5 / log de "SESSÃO EXPIRADA").

> 🐛 Captura correta do cookie: o refresher exige `cokiename`/`ASPXAUTH`/`CodUsuario`
> (não o `FotoUsuarioLogado`, que aparece cedo demais) + confirmação funcional antes de
> exportar — senão exportava um cookie que não autentica por HTTP.

---

## Alternativa: refresh headed via perfil dedicado (mesma lógica do SPX)

Em vez de depender de um Chrome aberto **manualmente** (`:9222` + CDP, abaixo), este
modo lança um **navegador próprio com perfil PERSISTENTE DEDICADO** em
`%PROGRAMDATA%\brasilrisk-robo\pw_profile` — machine-wide, **sobrevive a restart do
SERVERBD e à troca de usuário Windows**. O perfil guarda o `cf_clearance` (Cloudflare)
+ a sessão ASP.NET, então o refresh headless mantém tudo vivo sem janela manual.
Espelha o `spx-robo/backend/spx_robo/cookie_sync.py`.

### Requisitos
- **Node + puppeteer** (já no projeto) e um **Chrome instalado** no Windows. O
  script usa o **Chrome do sistema** via `executablePath` (o Chromium do puppeteer
  não vem baixado). Override opcional: `BRK_CHROME_PATH`. (Alternativa: baixar o
  do puppeteer com `npx puppeteer browsers install chrome`.)
- **Login inicial presencial 1x** (resolve o Cloudflare).
- **Admin** só para registrar a Tarefa Agendada (igual ao SPX).
- (Opcional) `BRK_LOGIN_USER`/`BRK_LOGIN_PASSWORD` no `.env` p/ auto-cura headless.

### Setup (uma vez)
1. **Login (headed, resolve Cloudflare + loga):**
   ```powershell
   cd "...\brasilrisk-robo"
   node refresh_cookies_brk_pw.js login
   ```
   A janela fecha sozinha ao detectar a sessão. O perfil fica salvo.
2. **(Opcional) auto-cura headless:** ponha `BRK_LOGIN_USER` / `BRK_LOGIN_PASSWORD`
   no `.env` — se a sessão expirar e não houver captcha, o `refresh` re-loga sozinho.
3. **Agende o refresh** (PowerShell em `brasilrisk-robo\scripts`):
   ```powershell
   .\instalar_tarefa_cookie_brk_pw.ps1                 # a cada 30 min
   .\instalar_tarefa_cookie_brk_pw.ps1 -IntervalMinutes 20
   ```
   Tarefa **"BRK - Renovar Cookie"** (sem senha; roda como você quando logado).

### Rodar manual / testar
```powershell
node refresh_cookies_brk_pw.js refresh          # headless
node refresh_cookies_brk_pw.js refresh  # com BRK_REFRESH_HEADED=1 p/ ver a janela (debug Cloudflare)
```
Exit 0 = ok · 5 = sessão expirada (rode `node refresh_cookies_brk_pw.js login`) · 2/3 = erro.

> ⚠️ **Cloudflare**: se o Cloudflare desafiar o headless (Turnstile/captcha), o refresh
> falha com exit 5 → rode o `login` (headed) de novo, ou use `BRK_REFRESH_HEADED=1`.
> O perfil persistente reduz muito a frequência disso, mas não elimina 100%.

> Saída idêntica à do modo CDP: `backend/cookie.txt` + `backend/useragent.txt`; o painel
> (`lib/brasilrisk_consulta.js`) recarrega sozinho.

---

## Alternativa antiga: CDP (Chrome manual na porta 9222)

O Chrome 149 desta máquina usa **App-Bound Encryption**, então NÃO dá pra ler o
cookie do disco (`browser_cookie3` falha) e o BRK tem **Cloudflare** (login
headless bloqueado). A solução que funciona: **ler o cookie do próprio Chrome
logado via CDP (DevTools Protocol)** — o Chrome entrega os cookies já
descriptografados, incluindo `cf_clearance` e a sessão.

## Setup (uma vez)
1. **Abra o Chrome dedicado do BRK:**
   `brasilrisk-robo\iniciar_chrome_brk.bat`
   (abre um Chrome num perfil separado `.chrome-brk`, com porta de depuração 9222)
2. **Faça login no BRK** nessa janela (resolve o Cloudflare junto). **Deixe a janela aberta.**
3. **Agende o refresh automático** (PowerShell em `brasilrisk-robo\scripts`):
   ```powershell
   .\instalar_tarefa_cookie_brk_cdp.ps1            # a cada 30 min (padrão)
   .\instalar_tarefa_cookie_brk_cdp.ps1 -IntervalMinutes 20
   ```
   Tarefa criada: **"BRK - Renovar Cookie (CDP)"** (sem senha, roda como você).

Pronto. A cada ciclo o script:
- conecta no Chrome (porta 9222), navega no BRK (**keep-alive** — mantém a sessão viva),
- lê os cookies descriptografados e grava `backend/cookie.txt` + `backend/useragent.txt`,
- o painel (`lib/brasilrisk_consulta.js`) **recarrega sozinho** → badge BRK atualiza.

## Rodar manual (testar)
```powershell
node brasilrisk-robo\refresh_cookies_brk_cdp.js
# ou
brasilrisk-robo\scripts\run_refresh_brk_cdp.ps1
```
Exit 0 = ok · 2 = Chrome não está na porta 9222 (rode o iniciar_chrome_brk.bat) ·
4/5 = sem login (logue na janela do BRK).

## Dica importante
- Deixe o **Chrome dedicado sempre aberto** (o `iniciar_chrome_brk.bat` usa
  `--restore-last-session`; pode pôr um atalho dele na Inicialização do Windows).
- Quando o badge mostrar **"sessão expirada"**, é só **logar de novo** na janela do BRK.
- `cf_clearance` é atrelado ao User-Agent — por isso salvamos o UA real do Chrome
  junto; não precisa ajustar nada.

## Fallback (máquina SEM App-Bound Encryption, ou manual)
- `atualizar_cookies_brk.bat` + `refresh_cookies_brk.py` (lê via `browser_cookie3`).
- Ou colar o header `Cookie` (DevTools → Network → Copy → Copy request headers, ou
  extensão Cookie-Editor) direto em `backend/cookie.txt`.

> Ver também `scripts/instalar_tarefa_cookie_brk_cdp.ps1 -Remover` pra desinstalar a tarefa.
