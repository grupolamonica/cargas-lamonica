# instalar_tarefa_cookie_brk_pw.ps1 — registra a Tarefa Agendada que renova os
# cookies do BRK (Brasil Risk) periodicamente, usando o perfil dedicado próprio
# (refresh_cookies_brk_pw.js refresh). Espelha o instalador do SPX.
#
# Idempotente: se a tarefa já existe, remove e recria.
# Roda como o usuário atual, quando ele estiver logado (sem guardar senha) —
# necessário porque o puppeteer precisa de uma sessão de desktop no Windows.
#
# Uso:
#   .\instalar_tarefa_cookie_brk_pw.ps1                  # intervalo padrão 30 min
#   .\instalar_tarefa_cookie_brk_pw.ps1 -IntervalMinutes 60
#   .\instalar_tarefa_cookie_brk_pw.ps1 -NodeExe "C:\Program Files\nodejs\node.exe"
#   .\instalar_tarefa_cookie_brk_pw.ps1 -Remover         # desinstala a tarefa

param(
    [int]$IntervalMinutes = 30,
    [string]$NodeExe = "",
    [string]$TaskName = "BRK - Renovar Cookie",
    [switch]$Remover
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RoboDir   = Split-Path -Parent $ScriptDir               # brasilrisk-robo/
$RunScript = Join-Path $RoboDir "refresh_cookies_brk_pw.js"

if ($Remover) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Tarefa '$TaskName' removida (se existia)."
    return
}

if (-not (Test-Path $RunScript)) { throw "refresh_cookies_brk_pw.js não encontrado em $RoboDir" }

if (-not $NodeExe) {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { $NodeExe = $c.Source } else { throw "node não encontrado no PATH; passe -NodeExe" }
}
if (-not (Test-Path $NodeExe)) { throw "NodeExe inválido: $NodeExe" }

Write-Host "Node     : $NodeExe"
Write-Host "Script   : $RunScript"
Write-Host "Intervalo: a cada $IntervalMinutes min"

# Roda o node direto, com working dir = pasta do robô (pra achar backend/ e node_modules do pai).
$Action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$RunScript`" refresh" -WorkingDirectory $RoboDir

$TriggerLogon = New-ScheduledTaskTrigger -AtLogOn
$TriggerLogon.Delay = "PT1M"
$TriggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

$Principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger @($TriggerLogon, $TriggerRepeat) `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Renova os cookies do BRK (perfil dedicado puppeteer: refresh_cookies_brk_pw.js refresh) a cada $IntervalMinutes min." | Out-Null

Write-Host ""
Write-Host "OK: tarefa '$TaskName' registrada."
Write-Host "ANTES do 1o refresh, faca o login UMA vez (headed, resolve Cloudflare):"
Write-Host "    cd `"$RoboDir`""
Write-Host "    & `"$NodeExe`" refresh_cookies_brk_pw.js login"
Write-Host ""
Write-Host "Testar agora:  Start-ScheduledTask -TaskName `"$TaskName`""
