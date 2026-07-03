// keepalive_brk.js — mantém a sessão do BRK (Brasil Risk) viva via HTTP PURO.
//
// A sessão ASP.NET do br2.brasilrisk.com.br morre por ociosidade (~20 min). Um GET
// autenticado periódico numa página protegida reseta o timeout de ociosidade do
// servidor — mantendo a sessão viva SEM navegador. Comprovado por soak: 8/8 pings
// em ~35 min (2026-07-01). Espelha o keep-alive do SPX, mas ainda mais simples:
// a sessão do BRK NÃO rotaciona cookie (o `cokiename` é estático, sem Set-Cookie),
// então só "tocamos" a sessão — não há cookie novo pra reescrever.
//
// Lê a sessão de backend/cookie.txt + backend/useragent.txt (gerados por
// `refresh_cookies_brk_pw.js login`). NÃO abre navegador: pra rodar como tarefa
// agendada 24/7 (mesmo sem usuário logado).
//
// Exit: 0 = sessão viva · 5 = sessão expirada (rode o `login`) ·
//       2 = cookie ausente · 3 = erro de rede/resposta inesperada.
'use strict';

const fs = require('fs');
const path = require('path');

const BRK = (process.env.BRK_BASE_URL || 'https://br2.brasilrisk.com.br').replace(/\/+$/, '');
const BACKEND = path.join(__dirname, 'backend');
const COOKIE_FILE = path.join(BACKEND, 'cookie.txt');
const UA_FILE = path.join(BACKEND, 'useragent.txt');
const CHECK_URL = `${BRK}/Motorista/Listar`;   // página protegida: 200 se logado, 302 -> /Account/Login se não
const TIMEOUT_MS = Number(process.env.BRK_KEEPALIVE_TIMEOUT_MS || 30000);
const _UA_PADRAO =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function readTrim(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } }
const ts = () => new Date().toISOString().slice(11, 19);

// Sai pelo exitCode e deixa o event loop drenar (fecha os sockets keep-alive do
// undici sem o assert do libuv que `process.exit()` abrupto causa no Windows).
// Fallback: se o socket segurar o loop, força a saída limpa após alguns segundos.
function finalizar(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5000).unref();
}

(async () => {
  const cookie = readTrim(COOKIE_FILE);
  const ua = readTrim(UA_FILE) || _UA_PADRAO;
  if (!cookie) {
    console.error(`[${ts()}] cookie.txt vazio/ausente — faça o login: node refresh_cookies_brk_pw.js login`);
    return finalizar(2);
  }
  try {
    const resp = await fetch(CHECK_URL, {
      method: 'GET',
      redirect: 'manual',
      headers: { Cookie: cookie, 'User-Agent': ua, Accept: 'text/html,*/*', Referer: `${BRK}/` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Libera a conexão sem baixar o corpo inteiro (não precisamos do HTML).
    try { await resp.body?.cancel(); } catch { /* noop */ }

    const loc = resp.headers.get('location') || '';
    const sessaoMorta =
      resp.status === 401 ||
      (resp.status >= 300 && resp.status < 400 && /\/account\/login|\/login/i.test(loc));
    if (sessaoMorta) {
      console.error(`[${ts()}] SESSÃO EXPIRADA (status=${resp.status}${loc ? ' -> ' + loc : ''}). ` +
                    `Refaça o login: node refresh_cookies_brk_pw.js login`);
      return finalizar(5);
    }
    if (resp.status >= 400) {
      console.error(`[${ts()}] resposta inesperada (status=${resp.status}) — sessão pode estar instável`);
      return finalizar(3);
    }
    console.log(`[${ts()}] keep-alive OK (status=${resp.status}) — sessão BRK renovada`);
    return finalizar(0);
  } catch (e) {
    console.error(`[${ts()}] erro de rede: ${e.message}`);
    return finalizar(3);
  }
})();
