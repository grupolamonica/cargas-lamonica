# instalar_keepalive_brk.ps1 — registra a Tarefa Agendada que mantém a sessão do
# BRK viva via HTTP PURO (keepalive_brk.js), a cada N min. SEM navegador.
#
# Diferente do refresh com Puppeteer, o keep-alive HTTP não precisa de desktop,
# então roda como S4U (24/7, mesmo com ninguém logado) — ideal pro SERVERBD.
#
# Pré-requisito: fazer o login UMA vez (headed, resolve Cloudflare + grava o
# cookie.txt com o cokiename):   node refresh_cookies_brk_pw.js login
# Depois, esta tarefa só "toca" a sessão a cada N min pra ela não expirar.
#
# Idempotente: se a tarefa já existe, remove e recria.
#
# Uso:
#   .\instalar_keepalive_brk.ps1                    # intervalo padrão 10 min
#   .\instalar_keepalive_brk.ps1 -IntervalMinutes 8
#   .\instalar_keepalive_brk.ps1 -NodeExe "C:\Program Files\nodejs\node.exe"
#   .\instalar_keepalive_brk.ps1 -Remover           # desinstala a tarefa

param(
    [int]$IntervalMinutes = 10,
    [string]$NodeExe = "",
    [string]$TaskName = "BRK - Keep-Alive Cookie",
    [switch]$Remover
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RoboDir   = Split-Path -Parent $ScriptDir               # brasilrisk-robo/
$RunScript = Join-Path $RoboDir "keepalive_brk.js"

if ($Remover) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Tarefa '$TaskName' removida (se existia)."
    return
}

if (-not (Test-Path $RunScript)) { throw "keepalive_brk.js não encontrado em $RoboDir" }

if (-not $NodeExe) {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { $NodeExe = $c.Source } else { throw "node não encontrado no PATH; passe -NodeExe" }
}
if (-not (Test-Path $NodeExe)) { throw "NodeExe inválido: $NodeExe" }

Write-Host "Node     : $NodeExe"
Write-Host "Script   : $RunScript"
Write-Host "Intervalo: a cada $IntervalMinutes min (HTTP, sem navegador)"

# Roda o node direto, working dir = pasta do robô (pra achar backend/cookie.txt).
$Action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$RunScript`"" -WorkingDirectory $RoboDir

# Dispara no boot (sobrevive a restart do SERVERBD) + repete a cada N min, sempre.
$TriggerBoot = New-ScheduledTaskTrigger -AtStartup
$TriggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

# S4U: roda mesmo sem usuário logado, sem guardar senha (não precisa de desktop).
$Principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited

$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
    -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 2)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger @($TriggerBoot, $TriggerRepeat) `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Mantém a sessão do BRK viva via HTTP (keepalive_brk.js) a cada $IntervalMinutes min, sem navegador. Login inicial: refresh_cookies_brk_pw.js login." | Out-Null

Write-Host ""
Write-Host "OK: tarefa '$TaskName' registrada (S4U, a cada $IntervalMinutes min)."
Write-Host "1) ANTES de tudo, faça o login UMA vez (headed, resolve o Cloudflare):"
Write-Host "     cd `"$RoboDir`""
Write-Host "     & `"$NodeExe`" refresh_cookies_brk_pw.js login"
Write-Host "2) Testar o keep-alive agora:  Start-ScheduledTask -TaskName `"$TaskName`""
Write-Host "   (veja o resultado no Histórico da tarefa ou rodando  node keepalive_brk.js)"
