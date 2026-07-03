// bots/brasilrisk-robo/server.js
// Servidor REST do robô BRK (Brasil Risk). Expõe a consulta READ-ONLY de aptidão
// para o backend do cargas-lamonica consumir via HTTP (contrato em API_REST.md):
//
//   GET /api/brk/consultar?cpf=<11dig>&placa=<cavalo>&placa=<carreta>
//   Header: X-API-Key: <BRK_API_KEY>   (ou Authorization: Bearer <key> | ?api_key=)
//   -> { ok, conjunto_apto, status, color, label, componentes, consultado_em }
//
//   GET /health  -> { ok, session } (sem auth; usado pelo healthcheck do container)
//
// Sessão/cookie: lida por lib/brasilrisk_consulta.js de ./backend/cookie.txt
// (gerado por `node refresh_cookies_brk_pw.js login`; mantida viva por keepalive_brk.js).
// Node puro — sem navegador no caminho da consulta.
'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

// Carrega .env local se existir (opcional; em container as vars vêm do env_file).
try { require('dotenv').config(); } catch { /* dotenv opcional */ }

const brk = require('./lib/brasilrisk_consulta');

const HOST = process.env.BRK_SIDECAR_HOST || '0.0.0.0';
const PORT = Number(process.env.BRK_SIDECAR_PORT || process.env.PORT || 8767);
const API_KEY = (process.env.BRK_API_KEY || '').trim();

const ts = () => new Date().toISOString();

function _extractKey(req, url) {
    const h = req.headers['x-api-key'];
    if (h) return String(h).trim();
    const auth = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1].trim();
    return (url.searchParams.get('api_key') || '').trim();
}

// Comparação em tempo constante (evita timing attack na key).
function _keyOk(provided) {
    if (!API_KEY || !provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(API_KEY);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function _send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch { return _send(res, 400, { ok: false, error: 'URL inválida' }); }

    if (req.method !== 'GET') return _send(res, 405, { ok: false, error: 'Método não permitido' });

    // Health: sem auth, read-only, não consome o BRK (só checa se há cookie).
    if (url.pathname === '/health' || url.pathname === '/status') {
        return _send(res, 200, { ok: true, service: 'brk-bot', session: brk.disponivel(), ts: ts() });
    }

    if (url.pathname !== '/api/brk/consultar') {
        return _send(res, 404, { ok: false, error: 'Rota não encontrada' });
    }

    // Auth
    if (!API_KEY) {
        return _send(res, 503, { ok: false, error: 'BRK_API_KEY não configurada no robô' });
    }
    if (!_keyOk(_extractKey(req, url))) {
        return _send(res, 401, { ok: false, error: 'API key inválida' });
    }

    // Parâmetros
    const cpf = (url.searchParams.get('cpf') || '').trim();
    const placas = url.searchParams.getAll('placa').map((p) => p.trim()).filter(Boolean);
    if (!cpf && placas.length === 0) {
        return _send(res, 400, { ok: false, error: 'Informe cpf e/ou placa(s)' });
    }

    try {
        const painel = await brk.consultarPainel({ cpf, placas });
        // painel.status === 'erro' (sessão/cf_clearance caiu) volta 200: o cliente
        // (brk-client.js) trata como UNAVAILABLE e preserva o último valor bom.
        return _send(res, 200, { ok: painel.status !== 'erro', ...painel, consultado_em: ts() });
    } catch (e) {
        console.error(`[${ts()}] erro na consulta: ${e && e.message ? e.message : e}`);
        return _send(res, 500, { ok: false, status: 'erro', error: 'Falha na consulta ao BRK' });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`[${ts()}] brk-bot ouvindo em http://${HOST}:${PORT}` +
        ` (API_KEY ${API_KEY ? 'configurada' : 'AUSENTE'}, sessão ${brk.disponivel() ? 'presente' : 'ausente'})`);
});
