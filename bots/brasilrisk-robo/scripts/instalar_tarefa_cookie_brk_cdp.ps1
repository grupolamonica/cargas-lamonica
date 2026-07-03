# instalar_tarefa_cookie_brk_cdp.ps1 — agenda a renovacao do cookie do BRK via CDP.
# Le do Chrome dedicado aberto pelo iniciar_chrome_brk.bat (a prova de App-Bound
# Encryption). Sem senha. Idempotente.
#
# Uso:
#   .\instalar_tarefa_cookie_brk_cdp.ps1                 # intervalo padrao 30 min
#   .\instalar_tarefa_cookie_brk_cdp.ps1 -IntervalMinutes 20
#   .\instalar_tarefa_cookie_brk_cdp.ps1 -Remover

param(
    [int]$IntervalMinutes = 30,
    [string]$NodeExe = "",
    [string]$TaskName = "BRK - Renovar Cookie (CDP)",
    [switch]$Remover
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunScript = Join-Path $ScriptDir "run_refresh_brk_cdp.ps1"

if ($Remover) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Tarefa '$TaskName' removida (se existia)."
    return
}

if (-not (Test-Path $RunScript)) { throw "run_refresh_brk_cdp.ps1 nao encontrado em $ScriptDir" }

if (-not $NodeExe) {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { $NodeExe = $c.Source } else { throw "node nao encontrado no PATH; passe -NodeExe" }
}
if (-not (Test-Path $NodeExe)) { throw "NodeExe invalido: $NodeExe" }

Write-Host "Node   : $NodeExe"
Write-Host "Script : $RunScript"
Write-Host "Intervalo: a cada $IntervalMinutes min"

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunScript`""

$TriggerLogon = New-ScheduledTaskTrigger -AtLogOn
$TriggerLogon.Delay = "PT1M"
$TriggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

$Principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 3)

[Environment]::SetEnvironmentVariable("BRK_NODE", $NodeExe, "User")

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger @($TriggerLogon, $TriggerRepeat) `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Renova o cookie do BRK via CDP (le do Chrome dedicado, a prova de ABE) a cada $IntervalMinutes min." | Out-Null

Write-Host ""
Write-Host "OK: tarefa '$TaskName' registrada."
Write-Host "Pre-requisito: deixar o Chrome do BRK aberto (iniciar_chrome_brk.bat) e logado."
Write-Host "Testar agora:  Start-ScheduledTask -TaskName `"$TaskName`""
Write-Host "Ver log:       Get-Content `"$((Split-Path -Parent $ScriptDir))\logs\cookie_refresh_brk.log`" -Tail 20"
