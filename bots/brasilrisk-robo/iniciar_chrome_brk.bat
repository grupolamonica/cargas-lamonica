@echo off
REM Abre um Chrome DEDICADO do BRK com porta de depuracao (CDP), num perfil
REM separado (.chrome-brk) pra nao conflitar com o seu Chrome normal.
REM Faca LOGIN no BRK nesta janela (1x - resolve tambem o Cloudflare) e DEIXE
REM ELA ABERTA. O refresh agendado le o cookie daqui automaticamente.

set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo [erro] chrome.exe nao encontrado. Ajuste o caminho neste .bat.
  pause
  exit /b 1
)

set "UD=%~dp0.chrome-brk"

start "" "%CHROME%" --remote-debugging-port=9222 --user-data-dir="%UD%" --no-first-run --no-default-browser-check --restore-last-session "https://br2.brasilrisk.com.br/Account/Login"

echo Chrome do BRK aberto (porta 9222).
echo Faca login no BRK nessa janela e deixe-a aberta.
