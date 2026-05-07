@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Cadastro de Motorista - Lamonica

cd /d "%~dp0"

echo ============================================================
echo   Cadastro de Motorista - Backend Lamonica
echo ============================================================
echo.

REM ---- 1) Verifica Python ---------------------------------------------------
where python >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Python nao encontrado no PATH.
  echo        Instale Python 3.11+ e marque "Add to PATH".
  pause
  exit /b 1
)

REM ---- 2) Verifica .env (token Infosimples) --------------------------------
if not exist ".env" (
  if exist ".env.example" (
    echo [AVISO] .env nao encontrado. Copiando .env.example para .env
    copy /Y ".env.example" ".env" >nul
  ) else (
    echo [ERRO] .env nao encontrado e nao existe .env.example para copiar.
    pause
    exit /b 1
  )
)
findstr /C:"COLE_SEU_TOKEN_AQUI" ".env" >nul 2>&1
if not errorlevel 1 (
  echo [ERRO] Token Infosimples nao configurado em .env
  echo        Edite o arquivo .env e substitua "COLE_SEU_TOKEN_AQUI" pelo token real.
  pause
  exit /b 1
)

REM ---- 3) Libera a porta 8765 (encerra zumbis do uvicorn) ------------------
echo [1/4] Liberando porta 8765...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":8765 .*LISTENING"') do (
  echo       encerrando PID %%P
  taskkill /F /PID %%P >nul 2>&1
)

REM ---- 4) Instala dependencias base (silencioso se ja instaladas) ----------
echo [2/4] Instalando dependencias base...
python -m pip install --quiet --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
  echo [ERRO] Falha ao instalar dependencias base.
  pause
  exit /b 1
)

REM ---- 5) Verifica se OCR local esta configurado ---------------------------
set OCR_LOCAL_ATIVO=0
findstr /R /C:"^OCR_.*_PROVIDER=local" ".env" >nul 2>&1
if not errorlevel 1 set OCR_LOCAL_ATIVO=1

if "%OCR_LOCAL_ATIVO%"=="0" (
  echo [3/4] OCR local nao configurado. Pulando instalacao pesada.
  goto START_SERVER
)

echo [3/4] OCR local ativo. Verificando easyocr...
python -m pip show easyocr >nul 2>&1
if not errorlevel 1 (
  echo       easyocr ja instalado. OK.
  goto START_SERVER
)

echo       Instalando easyocr + torch. Download ~600MB, apenas 1a vez.
python -m pip install --disable-pip-version-check -r requirements-ocr.txt
if errorlevel 1 (
  echo [AVISO] Falha ao instalar easyocr. App sobe, mas rotas com
  echo         OCR_*_PROVIDER=local retornarao 503 ate instalar manualmente.
)

:START_SERVER
REM ---- 6) Sobe o servidor (SEM --reload p/ evitar zumbis no Windows) -------
echo [4/4] Iniciando servidor em http://localhost:8765
echo       (Pressione CTRL+C para encerrar)
echo.
cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 8765

echo.
echo Servidor encerrado.
pause
