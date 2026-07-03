@echo off
REM Launcher do keep-alive BRK — usado pela Tarefa Agendada (schtasks /TR aponta pra ca).
REM %~dp0 = pasta deste .cmd (brasilrisk-robo\), com barra final. keepalive_brk.js le
REM o backend\cookie.txt relativo a ele (__dirname), entao working-dir nao importa.
REM Requer `node` no PATH do usuario (Node >= 18). Roda 1 ping HTTP e sai.
node "%~dp0keepalive_brk.js"
