# instalar_sync_cookie_brk.ps1 - registra a Tarefa Agendada do sync de cookie BRK
# (sync_cookie_from_supabase_brk.js) a cada N min, via schtasks.exe.
#
# ASCII-only de proposito: .ps1 UTF-8-sem-BOM lido como ANSI pelo Windows PowerShell
# 5.1 quebra em travessoes/acentos (o byte vira aspa "inteligente"). Sem nao-ASCII aqui.
#
# O que faz: puxa o cookie do BRK do Supabase (brk_credentials, gravado pelo card do
# painel) e escreve o cookie.txt que o robo :5010 le. Fecha o loop card -> robo.
#
# Por que schtasks.exe (e nao Register-ScheduledTask): no SERVERBD o
# Register-ScheduledTask (CIM/DCOM) exige elevacao e falha com "Access is denied" em
# shell nao-admin. O schtasks.exe classico registra a tarefa como o usuario logado SEM
# admin (validado em producao 2026-07-03 com o keep-alive).
#
# A tarefa roda na SESSAO LOGADA (sem /RU) - preciso porque o cookie.txt do BRK vive no
# drive MAPEADO H:, que so existe na sessao interativa. O SERVERBD mantem o usuario
# logado 24/7 pra rodar os bots, entao a tarefa fica sempre ativa.
#
# Pre-requisitos:
#   1) SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY no .env do robo (mesmo do backfill).
#   2) Se o :5010 for outro robo (ex.: sistema de cadastro), aponte BRK_COOKIE_FILE /
#      BRK_UA_FILE no .env pro cookie.txt que ESSE robo le.
#
# Uso:
#   .\instalar_sync_cookie_brk.ps1                    # a cada 2 min
#   .\instalar_sync_cookie_brk.ps1 -IntervalMinutes 1
#   .\instalar_sync_cookie_brk.ps1 -Remover           # desinstala

param(
    [int]$IntervalMinutes = 2,
    [string]$TaskName = "BRK - Sync Cookie do Painel",
    [switch]$Remover
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RoboDir   = Split-Path -Parent $ScriptDir               # brasilrisk-robo/
$Launcher  = Join-Path $RoboDir "run_sync_cookie_brk.cmd"
$Script    = Join-Path $RoboDir "sync_cookie_from_supabase_brk.js"

if ($Remover) {
    schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
    Write-Host "Tarefa '$TaskName' removida (se existia)."
    return
}

if (-not (Test-Path $Script))   { throw "sync_cookie_from_supabase_brk.js nao encontrado em $RoboDir" }
if (-not (Test-Path $Launcher)) { throw "run_sync_cookie_brk.cmd nao encontrado em $RoboDir" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warning "node nao esta no PATH - o launcher usa 'node'. Garanta Node >= 18 no PATH do usuario logado."
}

Write-Host "Launcher : $Launcher"
Write-Host "Intervalo: a cada $IntervalMinutes min (HTTP Supabase -> cookie.txt; roda na sessao logada)"

# /SC MINUTE /MO N = repete a cada N min. /RL LIMITED = sem elevacao.
# Sem /RU => roda como o usuario logado (interativo), onde o H: existe. /F = idempotente.
schtasks.exe /Create /TN $TaskName /TR $Launcher /SC MINUTE /MO $IntervalMinutes /RL LIMITED /F
if ($LASTEXITCODE -ne 0) { throw "schtasks /Create falhou (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "OK: tarefa '$TaskName' registrada (schtasks, a cada $IntervalMinutes min, sessao logada)."
Write-Host "Testar agora:  schtasks /Run /TN `"$TaskName`""
Write-Host "Ver resultado: schtasks /Query /TN `"$TaskName`" /V /FO LIST   (LastTaskResult 0 = ok)"
Write-Host "Ou direto:     node `"$Script`"   (deve imprimir 'sincronizado' ou 'ja em sincronia')"
