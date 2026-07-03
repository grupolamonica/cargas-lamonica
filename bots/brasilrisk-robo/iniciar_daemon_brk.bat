@echo off
REM Daemon do cookie BRK: mantem UM Chrome dedicado aberto e logado, faz keep-alive
REM e regrava o backend\cookie.txt periodicamente. Enquanto roda, o painel/API do
REM BRK ficam sempre com cookie fresco, sem relogar (o que o Cloudflare barra).
REM
REM Deixe rodando. Para iniciar junto com o Windows: crie um atalho deste .bat em
REM   shell:startup  (Win+R -> shell:startup).
REM Login: o daemon tenta auto-login (credenciais no .env). Se o Cloudflare pedir
REM captcha, faca login na janela que abriu — o daemon recupera sozinho.

cd /d "%~dp0"
node refresh_cookies_brk_pw.js daemon
echo.
echo [daemon encerrou] veja a mensagem acima.
pause
