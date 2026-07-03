# run_refresh_brk.ps1 — executa a renovacao do cookie do BRK (le do Chrome logado).
# Chamado pela Tarefa Agendada (instalar_tarefa_cookie_brk.ps1) e pode ser rodado
# manualmente pra testar. Espelha o run_refresh.ps1 do SPX.
#
# Python: usa $env:BRK_PYTHON se definido; senao a .venv do brasilrisk-robo; senao 'python'.

$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RoboRoot  = Split-Path -Parent $ScriptDir
$LogDir    = Join-Path $RoboRoot "logs"
$Refresh   = Join-Path $RoboRoot "refresh_cookies_brk.py"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "cookie_refresh_brk.log"

$PythonExe = $env:BRK_PYTHON
if (-not $PythonExe) {
    $venv = Join-Path $RoboRoot ".venv\Scripts\python.exe"
    if (Test-Path $venv) { $PythonExe = $venv }
}
if (-not $PythonExe) {
    $c = Get-Command python -ErrorAction SilentlyContinue
    if ($c) { $PythonExe = $c.Source }
}
if (-not $PythonExe) {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [ERRO] python nao encontrado (defina BRK_PYTHON)" |
        Out-File -FilePath $LogFile -Append -Encoding utf8
    exit 3
}

# Garante a dependencia browser_cookie3 (instala 1x se faltar).
& $PythonExe -c "import browser_cookie3" 2>$null
if ($LASTEXITCODE -ne 0) {
    & $PythonExe -m pip install --disable-pip-version-check browser_cookie3 *>> $LogFile
}

Set-Location $RoboRoot
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] refresh BRK start ($PythonExe)" |
    Out-File -FilePath $LogFile -Append -Encoding utf8

& $PythonExe $Refresh *>> $LogFile
$code = $LASTEXITCODE

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] refresh BRK exit=$code" |
    Out-File -FilePath $LogFile -Append -Encoding utf8
exit $code
