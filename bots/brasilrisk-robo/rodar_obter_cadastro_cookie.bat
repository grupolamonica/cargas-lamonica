@echo off
chcp 65001 >nul
cd /d "%~dp0backend"
echo ============================================================
echo   Obter cadastro reusando a SESSAO DO NAVEGADOR (sem senha)
echo ============================================================
echo.
if not exist cookie.txt (
  echo  FALTA o arquivo:  brasilrisk-robo\backend\cookie.txt
  echo  Cole nele o header "Cookie" copiado do DevTools ^(veja o README^).
  echo  ^(opcional^) crie tambem useragent.txt com o seu User-Agent.
  echo.
  pause
  exit /b 1
)
set /p CPF=CPF do motorista (somente numeros):
python -m examples.obter_cadastro_cookie
echo.
echo ============================================================
echo  Copie a saida acima e cole no chat (pode mascarar PII).
echo ============================================================
pause
