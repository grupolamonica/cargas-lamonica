// refresh_cookies_brk_cdp.js — renova o cookie do BRK via CDP (DevTools Protocol).
//
// A prova de App-Bound Encryption: conecta num Chrome JA ABERTO com
// --remote-debugging-port (use o iniciar_chrome_brk.bat) e le os cookies JA
// DESCRIPTOGRAFADOS (inclui HttpOnly e o cf_clearance do Cloudflare). Tambem
// captura o User-Agent real do navegador (pra casar com o cf_clearance).
//
// Grava:  backend/cookie.txt  (header Cookie)  e  backend/useragent.txt
// O painel (lib/brasilrisk_consulta.js) recarrega sozinho quando o arquivo muda.
//
// Uso (manual ou via Tarefa Agendada):  node refresh_cookies_brk_cdp.js
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');   // resolve do node_modules do projeto pai

const PORT = process.env.BRK_CDP_PORT || '9222';
const BROWSER_URL = `http://127.0.0.1:${PORT}`;
const BRK_URL = process.env.BRK_BASE_URL || 'https://br2.brasilrisk.com.br';
const BACKEND = path.join(__dirname, 'backend');
const COOKIE_FILE = path.join(BACKEND, 'cookie.txt');
const UA_FILE = path.join(BACKEND, 'useragent.txt');

function _escreve(arquivo, conteudo) {
    fs.mkdirSync(BACKEND, { recursive: true });
    const tmp = arquivo + '.tmp';
    fs.writeFileSync(tmp, conteudo, 'utf8');
    fs.renameSync(tmp, arquivo);
}

(async () => {
    let browser;
    try {
        browser = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
    } catch (e) {
        console.error(`[erro] nao consegui conectar no Chrome em ${BROWSER_URL}.`);
        console.error('       Abra o Chrome do BRK com:  brasilrisk-robo\\iniciar_chrome_brk.bat');
        console.error('       (ele inicia o Chrome com --remote-debugging-port=' + PORT + ')');
        process.exit(2);
    }

    try {
        const ua = await browser.userAgent();

        // Keep-alive: navega no BRK pra manter cf_clearance/sessao vivos.
        const pages = await browser.pages();
        let page = pages.find(p => /brasilrisk/i.test(p.url())) || pages[0] || await browser.newPage();
        let urlFinal = '';
        try {
            await page.goto(`${BRK_URL}/Motorista/Listar`, { waitUntil: 'domcontentloaded', timeout: 25000 });
            urlFinal = page.url();
        } catch { urlFinal = page.url(); }

        // Le TODOS os cookies (descriptografados) e filtra o dominio do BRK.
        const client = await page.target().createCDPSession();
        const { cookies } = await client.send('Network.getAllCookies');
        const brk = cookies.filter(c => /brasilrisk\.com\.br$/i.test(c.domain) || /brasilrisk/i.test(c.domain));

        if (!brk.length) {
            console.error('[erro] nenhum cookie de brasilrisk no Chrome conectado.');
            console.error('       Faca LOGIN no BRK na janela aberta pelo iniciar_chrome_brk.bat e rode de novo.');
            await browser.disconnect();
            process.exit(4);
        }

        const header = brk.map(c => `${c.name}=${c.value}`).join('; ');
        _escreve(COOKIE_FILE, header);
        if (ua) _escreve(UA_FILE, ua);

        const temCf = brk.some(c => /cf_clearance/i.test(c.name));
        const temSessao = brk.some(c => /ASPXAUTH|ASP\.NET_SessionId/i.test(c.name));
        const naLogin = /\/Account\/Login/i.test(urlFinal);

        console.log(`[ok] ${brk.length} cookies do BRK salvos em ${COOKIE_FILE}`);
        console.log(`[ok] User-Agent salvo (${(ua || '').slice(0, 40)}...)`);
        console.log(`[info] cf_clearance: ${temCf ? 'sim' : 'NAO'} | sessao(ASPXAUTH/SessionId): ${temSessao ? 'sim' : 'NAO'}`);
        if (naLogin || !temSessao) {
            console.warn('[aviso] a sessao parece EXPIRADA (caiu na tela de login). '
                + 'Faca login de novo na janela do iniciar_chrome_brk.bat.');
        }
        await browser.disconnect();   // NAO fecha o Chrome do usuario
        process.exit(naLogin || !temSessao ? 5 : 0);
    } catch (e) {
        console.error('[erro] falha lendo cookies via CDP:', e.message);
        try { await browser.disconnect(); } catch {}
        process.exit(3);
    }
})();
