@echo off
chcp 65001 >nul
cd /d "%~dp0backend"
echo ============================================================
echo   Obter cadastro de motorista no BRSystem2 (via HTTP/API)
echo ============================================================
echo.
set /p BRSYSTEM_USER=Login do BRSystem:
set /p BRSYSTEM_PASS=Senha (vai aparecer na tela):
set /p CPF=CPF do motorista (somente numeros):
echo.
echo Instalando dependencia (requests), se preciso...
python -m pip install requests >nul 2>&1
echo Buscando...
echo.
python -m examples.obter_cadastro
echo.
echo ============================================================
echo  Copie a saida acima e cole no chat (pode mascarar PII).
echo ============================================================
pause
