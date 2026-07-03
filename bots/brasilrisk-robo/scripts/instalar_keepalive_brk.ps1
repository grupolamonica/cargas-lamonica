# instalar_keepalive_brk.ps1 - registra a Tarefa Agendada do keep-alive BRK
# (keepalive_brk.js) a cada N min, via schtasks.exe.
#
# ASCII-only de proposito: .ps1 UTF-8-sem-BOM lido como ANSI pelo Windows PowerShell
# 5.1 quebra em travessoes/acentos (o byte vira aspa "inteligente"). Sem nao-ASCII aqui.
#
# Por que schtasks.exe (e nao Register-ScheduledTask): no SERVERBD o
# Register-ScheduledTask (CIM/DCOM) exige elevacao e falha com "Access is denied" em
# shell nao-admin. O schtasks.exe classico registra a tarefa como o usuario logado SEM
# admin (validado em producao 2026-07-03).
#
# A tarefa roda na SESSAO LOGADA (sem /RU) - preciso porque o cookie.txt do BRK vive no
# drive MAPEADO H:, que so existe na sessao interativa. O SERVERBD mantem o usuario
# logado 24/7 pra rodar os bots, entao a tarefa fica sempre ativa.
#
# O keep-alive e HTTP puro: sem navegador, sem npm, nao escreve em disco.
# Pre-requisito: cookie valido - rode 1x  node refresh_cookies_brk_pw.js login
#
# Uso:
#   .\instalar_keepalive_brk.ps1                    # a cada 10 min
#   .\instalar_keepalive_brk.ps1 -IntervalMinutes 8
#   .\instalar_keepalive_brk.ps1 -Remover           # desinstala

param(
    [int]$IntervalMinutes = 10,
    [string]$TaskName = "BRK - Keep-Alive Cookie",
    [switch]$Remover
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RoboDir   = Split-Path -Parent $ScriptDir               # brasilrisk-robo/
$Launcher  = Join-Path $RoboDir "run_keepalive_brk.cmd"
$Script    = Join-Path $RoboDir "keepalive_brk.js"

if ($Remover) {
    schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
    Write-Host "Tarefa '$TaskName' removida (se existia)."
    return
}

if (-not (Test-Path $Script))   { throw "keepalive_brk.js nao encontrado em $RoboDir" }
if (-not (Test-Path $Launcher)) { throw "run_keepalive_brk.cmd nao encontrado em $RoboDir" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warning "node nao esta no PATH - o launcher usa 'node'. Garanta Node >= 18 no PATH do usuario logado."
}

Write-Host "Launcher : $Launcher"
Write-Host "Intervalo: a cada $IntervalMinutes min (HTTP, sem navegador; roda na sessao logada)"

# /SC MINUTE /MO N = repete a cada N min. /RL LIMITED = sem elevacao.
# Sem /RU => roda como o usuario logado (interativo), onde o H: existe. /F = idempotente.
schtasks.exe /Create /TN $TaskName /TR $Launcher /SC MINUTE /MO $IntervalMinutes /RL LIMITED /F
if ($LASTEXITCODE -ne 0) { throw "schtasks /Create falhou (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "OK: tarefa '$TaskName' registrada (schtasks, a cada $IntervalMinutes min, sessao logada)."
Write-Host "Testar agora:  schtasks /Run /TN `"$TaskName`""
Write-Host "Ver resultado: schtasks /Query /TN `"$TaskName`" /V /FO LIST   (LastTaskResult 0 = ok)"
Write-Host "Ou direto:     node `"$Script`"   (deve imprimir 'keep-alive OK')"
