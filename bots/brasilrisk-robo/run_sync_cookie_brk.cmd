@echo off
REM Launcher do sync de cookie BRK (Supabase -> cookie.txt) — usado pela Tarefa Agendada.
REM %~dp0 = pasta deste .cmd (brasilrisk-robo\), com barra final. O script resolve o
REM cookie.txt relativo a ele (__dirname) e le SUPABASE_URL/KEY do .env do robo.
REM Requer `node` no PATH do usuario (Node >= 18). Roda 1 sync HTTP e sai.
node "%~dp0sync_cookie_from_supabase_brk.js"
