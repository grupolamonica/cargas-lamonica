# instalar_tarefa_cookie_brk.ps1 — registra a Tarefa Agendada que renova o cookie
# do BRK de tempos em tempos (mesma logica do SPX, sem guardar senha).
#
# Idempotente: se a tarefa ja existe, remove e recria.
# Roda como o usuario atual, so quando ele estiver logado (le os cookies do Chrome dele).
#
# Uso:
#   .\instalar_tarefa_cookie_brk.ps1                 # intervalo padrao 60 min
#   .\instalar_tarefa_cookie_brk.ps1 -IntervalMinutes 45
#   .\instalar_tarefa_cookie_brk.ps1 -PythonExe "C:\caminho\python.exe"
#   .\instalar_tarefa_cookie_brk.ps1 -Remover        # desinstala a tarefa

param(
    [int]$IntervalMinutes = 60,
    [string]$PythonExe = "",
    [string]$TaskName = "BRK - Renovar Cookie",
    [switch]$Remover
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunScript = Join-Path $ScriptDir "run_refresh_brk.ps1"

if ($Remover) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Tarefa '$TaskName' removida (se existia)."
    return
}

if (-not (Test-Path $RunScript)) { throw "run_refresh_brk.ps1 nao encontrado em $ScriptDir" }

if (-not $PythonExe) {
    $venv = Join-Path (Split-Path -Parent $ScriptDir) ".venv\Scripts\python.exe"
    if (Test-Path $venv) { $PythonExe = $venv }
    else {
        $c = Get-Command python -ErrorAction SilentlyContinue
        if ($c) { $PythonExe = $c.Source } else { throw "python nao encontrado no PATH; passe -PythonExe" }
    }
}
if (-not (Test-Path $PythonExe)) { throw "PythonExe invalido: $PythonExe" }

Write-Host "Python : $PythonExe"
Write-Host "Script : $RunScript"
Write-Host "Intervalo: a cada $IntervalMinutes min"

$Action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunScript`""

# Dispara 1 min apos o logon e repete pra sempre no intervalo escolhido.
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

# Grava o python escolhido pro usuario (a tarefa roda como ele).
[Environment]::SetEnvironmentVariable("BRK_PYTHON", $PythonExe, "User")

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger @($TriggerLogon, $TriggerRepeat) `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Renova o cookie do BRK lendo do Chrome logado a cada $IntervalMinutes min." | Out-Null

Write-Host ""
Write-Host "OK: tarefa '$TaskName' registrada."
Write-Host "Pre-requisito: estar LOGADO no BRK no Chrome desta maquina."
Write-Host "Testar agora:  Start-ScheduledTask -TaskName `"$TaskName`""
Write-Host "Ver log:       Get-Content `"$((Split-Path -Parent $ScriptDir))\logs\cookie_refresh_brk.log`" -Tail 20"
