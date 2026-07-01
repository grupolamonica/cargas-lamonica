# run_refresh_brk_cdp.ps1 — renova o cookie do BRK via CDP (puppeteer.connect).
# Chamado pela Tarefa Agendada (instalar_tarefa_cookie_brk_cdp.ps1) ou manual.
# Requer: Chrome aberto pelo iniciar_chrome_brk.bat (porta 9222) e logado no BRK.

$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RoboRoot  = Split-Path -Parent $ScriptDir
$LogDir    = Join-Path $RoboRoot "logs"
$Script    = Join-Path $RoboRoot "refresh_cookies_brk_cdp.js"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "cookie_refresh_brk.log"

$NodeExe = $env:BRK_NODE
if (-not $NodeExe) {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { $NodeExe = $c.Source }
}
if (-not $NodeExe) {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [ERRO] node nao encontrado (defina BRK_NODE)" |
        Out-File -FilePath $LogFile -Append -Encoding utf8
    exit 3
}

Set-Location $RoboRoot
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] refresh BRK (CDP) start" |
    Out-File -FilePath $LogFile -Append -Encoding utf8

& $NodeExe $Script *>> $LogFile
$code = $LASTEXITCODE

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] refresh BRK (CDP) exit=$code" |
    Out-File -FilePath $LogFile -Append -Encoding utf8
exit $code
