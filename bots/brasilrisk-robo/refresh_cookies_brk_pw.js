// refresh_cookies_brk_pw.js — renova o cookie do BRK com PERFIL DEDICADO PRÓPRIO.
//
// Espelha a lógica do SPX (spx-robo/backend/spx_robo/cookie_sync.py): em vez de
// "conectar num Chrome aberto manualmente" (refresh_cookies_brk_cdp.js + :9222),
// este script LANÇA seu próprio Chromium (puppeteer) com um perfil PERSISTENTE
// DEDICADO em %PROGRAMDATA% — machine-wide, sobrevive a restart do SERVERBD e à
// troca de usuário Windows. O perfil guarda o cf_clearance (Cloudflare) + a sessão
// ASP.NET, então o `refresh` headless mantém a sessão viva sem navegador manual.
//
// Modos:
//   node refresh_cookies_brk_pw.js login     # 1x, headed: operador resolve Cloudflare + loga
//   node refresh_cookies_brk_pw.js refresh   # headless: revisita o portal, auto-login p/ credenciais, exporta
//
// Grava (MESMO contrato do _cdp.js):  backend/cookie.txt (header Cookie) + backend/useragent.txt
//
// Env:
//   BRK_BASE_URL=https://br2.brasilrisk.com.br
//   BRK_PW_PROFILE_DIR=...                 # override do perfil (default %PROGRAMDATA%\brasilrisk-robo\pw_profile)
//   BRK_LOGIN_USER / BRK_LOGIN_PASSWORD    # habilita auto-login headless (self-heal); sem isso, expirou -> rode 'login'
//   BRK_REFRESH_HEADED=1                    # força o refresh headed (debug / Cloudflare desafiando headless)
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
// Carrega .env pro auto-login (BRK_LOGIN_USER/PASSWORD): primeiro o do sistema
// hospedeiro (pasta PAI — ex.: Sistema_cadastro/.env no SERVERBD), depois o do
// proprio bot (se existir, sobrepoe). Opcional (try/catch): sem .env o refresh
// funciona igual, so perde a auto-cura headless quando a sessao cai.
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
  dotenv.config({ path: path.join(__dirname, '.env'), override: true });
} catch {}

const BRK_URL = (process.env.BRK_BASE_URL || 'https://br2.brasilrisk.com.br').replace(/\/+$/, '');
const LISTAR_URL = `${BRK_URL}/Motorista/Listar`;
const BACKEND = path.join(__dirname, 'backend');
const COOKIE_FILE = path.join(BACKEND, 'cookie.txt');
const UA_FILE = path.join(BACKEND, 'useragent.txt');

function _profileDir() {
  if (process.env.BRK_PW_PROFILE_DIR) return process.env.BRK_PW_PROFILE_DIR;
  const base = process.env.PROGRAMDATA || process.env.LOCALAPPDATA || require('os').homedir();
  return path.join(base, 'brasilrisk-robo', 'pw_profile');
}

// Usa o Chrome REAL do sistema (melhor contra Cloudflare que o Chromium do puppeteer,
// e dispensa baixar navegador). Override por BRK_CHROME_PATH. Se nao achar, deixa o
// puppeteer usar o proprio (exige `npx puppeteer browsers install chrome`).
function _chromePath() {
  if (process.env.BRK_CHROME_PATH) return process.env.BRK_CHROME_PATH;
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch {} }
  return undefined;
}

function _escreve(arquivo, conteudo) {
  fs.mkdirSync(BACKEND, { recursive: true });
  const tmp = arquivo + '.tmp';
  fs.writeFileSync(tmp, conteudo, 'utf8');
  fs.renameSync(tmp, arquivo);
}

// Lê TODOS os cookies (descriptografados, inclui HttpOnly + cf_clearance) via CDP.
async function _lerCookiesBrk(page) {
  const cdp = await page.target().createCDPSession();
  const { cookies } = await cdp.send('Network.getAllCookies');
  return cookies.filter((c) => /brasilrisk/i.test(c.domain || ''));
}

// Marcadores de sessao AUTENTICADA. ATENCAO:
//  - ASP.NET_SessionId NAO serve — existe ate pra visitante anonimo.
//  - FotoUsuarioLogado tambem NAO serve como gatilho: e' setado ANTES do cookie
//    de auth real, entao capturar nele exportava um conjunto que NAO autentica
//    via HTTP (302 -> /Account/Login). Era o bug do "cookie automatico".
// A credencial REAL do BRSystem e' `cokiename` (ticket de forms-auth, ~2400 chars);
// ASPXAUTH/CodUsuario cobrem variacoes do app. So consideramos logado com um destes.
const _AUTH_COOKIE_RE = /ASPXAUTH|cokiename|CodUsuario/i;

function _isAuthed(cookies, url) {
  if (/\/Account\/Login/i.test(url || '')) return false;
  return cookies.some((c) => _AUTH_COOKIE_RE.test(c.name));
}

async function _exportar(browser, page) {
  const ua = await browser.userAgent();
  const cookies = await _lerCookiesBrk(page);
  if (!cookies.length) return { n: 0, temCf: false, temSessao: false };
  const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  _escreve(COOKIE_FILE, header);
  if (ua) _escreve(UA_FILE, ua);
  return {
    n: cookies.length,
    temCf: cookies.some((c) => /cf_clearance/i.test(c.name)),
    temSessao: cookies.some((c) => _AUTH_COOKIE_RE.test(c.name)),
  };
}

// Auto-login best-effort (form ASP.NET clássico). Retorna true se autenticou.
async function _autoLogin(page) {
  const user = process.env.BRK_LOGIN_USER;
  const pass = process.env.BRK_LOGIN_PASSWORD;
  if (!user || !pass) return false;
  try {
    // Headed: o Turnstile "managed" passa sozinho em alguns segundos e o form de
    // login aparece. Espera o campo de senha surgir (ate 40s) — cobre o interstício.
    await page.waitForSelector('#Password, input[type=password]', { timeout: 40000, visible: true });
    const userSel = (await page.$('#UserName')) ? '#UserName' : 'input[name="UserName"]';
    const passSel = (await page.$('#Password')) ? '#Password' : 'input[type=password]';
    const btnSel = (await page.$('#autenticar')) ? '#autenticar' : 'button[type=submit], input[type=submit]';
    await page.click(userSel, { clickCount: 3 }).catch(() => {});
    await page.type(userSel, user, { delay: 25 });
    await page.type(passSel, pass, { delay: 25 });
    await Promise.allSettled([
      page.click(btnSel),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    ]);
    console.log(`[ok] auto-login submetido (${user})`);
    return true;
  } catch (e) {
    console.warn('[aviso] auto-login nao preencheu o form:', e.message);
    return false;
  }
}

// Espera o Cloudflare liberar (interstício "Just a moment") + sessão aparecer.
async function _aguardarPortal(page, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const cookies = await _lerCookiesBrk(page).catch(() => []);
    if (_isAuthed(cookies, page.url())) return true;
    await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}

// Verificacao FUNCIONAL de login (mais confiavel que adivinhar nomes de cookie):
// acessa uma pagina protegida e confere que NAO caiu no /Account/Login.
async function _estaLogado(page) {
  try { await page.goto(LISTAR_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  return !/\/Account\/Login/i.test(page.url());
}

(async () => {
  const mode = (process.argv[2] || 'refresh').toLowerCase();
  const userDataDir = _profileDir();
  fs.mkdirSync(userDataDir, { recursive: true });

  // BRK: o Cloudflare Turnstile bloqueia headless (testado: cai em "Um momento…").
  // Num Chrome REAL (headed) o managed challenge passa sozinho, entao rodamos headed
  // por padrao. Override raro (rede sem Cloudflare): BRK_REFRESH_HEADLESS=1.
  const headed = process.env.BRK_REFRESH_HEADLESS !== '1';
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: headed ? false : true,
      userDataDir,
      executablePath: _chromePath(),   // usa o Chrome do sistema (undefined = bundled do puppeteer)
      defaultViewport: null,
      // O Cloudflare Turnstile entra em loop ("verifique que é humano" reiniciando
      // sem parar) quando detecta automação. Remove os dois "tells" principais:
      // o switch --enable-automation e a feature AutomationControlled (que expõe
      // navigator.webdriver=true). Sem isso o checkbox nunca conclui.
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
      ],
    });
  } catch (e) {
    console.error('[erro] não consegui lançar o Chromium do puppeteer:', e.message);
    process.exit(2);
  }

  try {
    const page = (await browser.pages())[0] || (await browser.newPage());

    if (mode === 'login') {
      console.log('>> Abrindo navegador (perfil dedicado). Se aparecer Cloudflare/captcha ou login, resolva na janela.');
      console.log('>> A janela fecha sozinha ao detectar a sessão autenticada (ou após o timeout).');
      try { await page.goto(BRK_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch {}
      const ok = await _aguardarPortal(page, 10 * 60 * 1000); // 10 min p/ logar
      if (!ok) { console.error('[erro] timeout — nenhuma sessão autenticada detectada.'); await browser.close(); process.exit(5); }
      // Confirmacao FUNCIONAL antes de exportar: navega numa pagina protegida e
      // confere que NAO caiu no /Account/Login. Garante que o cookie exportado
      // (incl. cokiename) realmente autentica por HTTP — evita exportar sessao
      // meia-boca capturada durante o interstício do login.
      if (!(await _estaLogado(page))) {
        console.error('[erro] cookie capturado nao autentica (/Motorista/Listar redirecionou p/ login). Refaca o login.');
        await browser.close();
        process.exit(5);
      }
      const r = await _exportar(browser, page);
      console.log(`[ok] login capturado: ${r.n} cookies (cf_clearance:${r.temCf?'sim':'NAO'} sessão:${r.temSessao?'sim':'NAO'}) salvos em ${COOKIE_FILE}`);
      await browser.close();
      process.exit(r.temSessao ? 0 : 5);
    }

    if (mode === 'daemon') {
      // MODELO CONFIAVEL PRO BRK: mantem o navegador ABERTO e logado. O keep-alive
      // segura a sessao + cf_clearance vivos, entao NAO precisa relogar (o que o
      // Cloudflare barra). So o login inicial / pos-reboot e manual (ou auto-login
      // best-effort, que o daemon recupera sozinho no proximo ciclo).
      const intervalMs = Number(process.env.BRK_DAEMON_INTERVAL_MS || 10 * 60 * 1000);
      const ts = () => new Date().toISOString().slice(11, 19);
      console.log(`>> Daemon BRK iniciado (headed, perfil dedicado). Keep-alive + export a cada ${Math.round(intervalMs / 60000)} min.`);
      console.log('>> Se a sessao cair e o auto-login falhar (Cloudflare), faca login NA JANELA — recupero no proximo ciclo.');
      for (;;) {
        let ok = false;
        try {
          let logado = await _estaLogado(page);
          if (!logado) {
            console.warn(`[${ts()}] sessao nao autenticada — tentando auto-login`);
            if (await _autoLogin(page)) logado = await _estaLogado(page);
          }
          if (logado) {
            const r = await _exportar(browser, page);
            console.log(`[${ts()}] ok — ${r.n} cookies exportados (cf:${r.temCf ? 's' : 'n'} sessao:${r.temSessao ? 's' : 'n'})`);
            ok = true;
          } else {
            console.error(`[${ts()}] sessao caida — FACA LOGIN na janela aberta (recheco em 20s)`);
          }
        } catch (e) {
          console.error(`[${ts()}] erro no ciclo: ${e.message}`);
        }
        // Ok -> proximo keep-alive no intervalo normal. Caido -> recheca em 20s
        // pra pegar rapido um login manual feito na janela.
        await new Promise((r) => setTimeout(r, ok ? intervalMs : 20000));
      }
    }

    // mode === 'refresh'
    let logado = await _estaLogado(page);
    if (!logado) {
      // Sessão caiu -> auto-login (headed passa o Turnstile; precisa de credenciais no .env).
      const tentou = await _autoLogin(page);
      if (tentou) logado = await _estaLogado(page);
    }

    if (!logado) {
      console.error(`[erro] sessão BRK expirada (url=${page.url()}). Rode:  node refresh_cookies_brk_pw.js login`);
      await browser.close();
      process.exit(5);
    }

    const r = await _exportar(browser, page);
    console.log(`[ok] refresh: ${r.n} cookies salvos (cf_clearance:${r.temCf?'sim':'NAO'} sessão:${r.temSessao?'sim':'NAO'}) em ${COOKIE_FILE}`);
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('[erro] falha no refresh:', e.message);
    try { await browser.close(); } catch {}
    process.exit(3);
  }
})();
