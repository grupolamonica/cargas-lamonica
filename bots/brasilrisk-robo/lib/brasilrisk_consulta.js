// bots/brasilrisk-robo/lib/brasilrisk_consulta.js
// Consulta READ-ONLY de aptidao no BRK / Brasil Risk (br2.brasilrisk.com.br).
// Node puro (fetch + cookie de sessao). A consulta do grid ja traz o status:
//   Motorista: GET /Motorista/ListaMotoristas  -> aaData[].UltimaPesquisa.PesquisaStatus
//   Veiculo:   GET /Veiculo/ListarVeiculos     -> aaData[].UltimaPesquisa.StatusPesquisa
//   CodPesquisaStatus === 2  => Apto.  (NAO usa o "Ver status" faturavel.)
//
// Sessao: reaproveita a cookie do proprio robo (gerada por `refresh_cookies_brk_pw.js login`):
//   env BRSYSTEM_COOKIE  (header Cookie) e BRSYSTEM_UA (User-Agent)  OU
//   arquivos  ./backend/cookie.txt  e  ./backend/useragent.txt
//
// IMPORTANTE (Cloudflare): o replay HTTP so passa enquanto o cf_clearance for
// valido. O cf_clearance nasce de um `login` HEADED (humano resolve o Turnstile,
// TTL ~dias); o keepalive_brk.js mantem a sessao ASP.NET viva sem navegador.
// 403 (Just a moment) => cf_clearance expirado: refaca `node refresh_cookies_brk_pw.js login`.
'use strict';

const fs = require('fs');
const path = require('path');

const BASE_URL = (process.env.BRK_BASE_URL || 'https://br2.brasilrisk.com.br').replace(/\/+$/, '');
const DEFAULT_TIMEOUT_MS = Number(process.env.BRK_TIMEOUT_MS || 20000);
const CACHE_TTL_MS = Number(process.env.BRK_CACHE_TTL_MS || 5 * 60 * 1000);
const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// A sessao vive em ./backend (mesmo diretorio que refresh_cookies_brk_pw.js escreve).
const _COOKIE_PATH = path.join(__dirname, '..', 'backend', 'cookie.txt');
const _UA_PATH = path.join(__dirname, '..', 'backend', 'useragent.txt');

const _cache = new Map(); // chave -> { ts, valor }
let _sessao = null;       // { cookie, ua, fonte }
let _sessaoMtime = -1;    // mtime do cookie.txt da ultima leitura

// ── sessao / cookie ──────────────────────────────────────────────────────────
function _lerArquivo(...candidatos) {
    for (const c of candidatos) {
        try {
            const txt = fs.readFileSync(c, 'utf8').trim();
            if (txt) return txt;
        } catch { /* tenta o proximo */ }
    }
    return '';
}

function _mtime(p) {
    try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

// Reusa o cookie do robo. Se o cookie.txt mudar (refresh automatico agendado),
// recarrega sozinho — o servidor nao precisa reiniciar.
function _carregarSessao(force = false) {
    if (process.env.BRSYSTEM_COOKIE) {
        if (!_sessao || _sessao.fonte !== 'env' || force) {
            _sessao = { cookie: process.env.BRSYSTEM_COOKIE, ua: process.env.BRSYSTEM_UA || DEFAULT_UA, fonte: 'env' };
        }
        return _sessao;
    }
    const mt = _mtime(_COOKIE_PATH);
    if (!force && _sessao && _sessao.fonte === 'file' && mt === _sessaoMtime) return _sessao;
    const cookie = _lerArquivo(_COOKIE_PATH, path.join(__dirname, '..', 'cookie.txt'));
    const ua = process.env.BRSYSTEM_UA || _lerArquivo(_UA_PATH) || DEFAULT_UA;
    _sessaoMtime = mt;
    _sessao = cookie ? { cookie, ua, fonte: 'file' } : null;
    return _sessao;
}

function recarregarSessao() {
    clearCache();
    return _carregarSessao(true);
}

function disponivel() {
    return !!_carregarSessao(true);
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
// Filtros nomeados que os grids esperam na query (mesmo vazios). A grade de
// MOTORISTA da 302 -> /Home/Error se eles faltarem; a de veiculo tolera, mas
// mandamos por simetria/robustez.
const _FILTROS_MOT = {
    dataInicial: '', dataFinal: '', codMotorista: '', nome: '', empSolicitante: '',
    codPerfil: '', codFuncao: '', cnh: '', codigoUF: '', codStatus: '',
    controleCliente: '', somenteMotoristaDaOperacao: 'false', idConjunto: '',
};
const _FILTROS_VEIC = {
    dataInicial: '', dataFinal: '', codVeiculo: '', modelo: '', marca: '', codUF: '',
    ProprietarioNome: '', EmpresaSolicitante: '', codEquiRastreamento: '',
    statusEquipRastreamento: '', codStatus: '', nrTerminal: '', controleCliente: '', idConjunto: '',
};

async function _getJson(rota, params, opts = {}) {
    const sess = _carregarSessao();
    if (!sess) {
        const e = new Error('Cookie BRK nao configurado');
        e.code = 'SEM_COOKIE';
        throw e;
    }
    const qs = new URLSearchParams({
        ...params,
        sEcho: '1', iColumns: '10', iDisplayStart: '0', iDisplayLength: '5',
        iSortCol_0: '0', sSortDir_0: 'asc', iSortingCols: '1', _: String(Date.now()),
    }).toString();

    const resp = await fetch(`${BASE_URL}${rota}?${qs}`, {
        method: 'GET',
        redirect: 'manual',
        headers: {
            'Cookie': sess.cookie,
            'User-Agent': sess.ua,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Referer': opts.referer || `${BASE_URL}/`,
        },
        signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS),
    });

    if (resp.status === 401) {
        const e = new Error('401 — sessao invalida'); e.code = 'SESSAO_EXPIRADA'; throw e;
    }
    if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location') || '';
        if (/\/account\/login|\/login/i.test(loc)) {
            const e = new Error(`Sessao expirada (-> ${loc})`); e.code = 'SESSAO_EXPIRADA'; throw e;
        }
        // 302 -> /Home/Error etc.: erro do servidor (ex.: params faltando), NAO cookie ruim
        const e = new Error(`Redirect inesperado ${resp.status} -> ${loc}`); e.code = 'REDIRECT'; throw e;
    }
    const ct = resp.headers.get('content-type') || '';
    const txt = await resp.text();
    if (!ct.toLowerCase().includes('json')) {
        // 403 Cloudflare (Just a moment) OU pagina de login => sessao/cf_clearance caiu.
        if (resp.status === 403 || /just a moment|challenge-platform|cf-|\/Account\/Login|name=["']?(login|usuario|senha)/i.test(txt.slice(0, 2000))) {
            const e = new Error(resp.status === 403
                ? 'Cloudflare 403 (cf_clearance expirado) — refaca o login headed'
                : 'Sessao expirada (pagina de login)');
            e.code = 'SESSAO_EXPIRADA';
            throw e;
        }
        const e = new Error(`Resposta nao-JSON (${resp.status}, ${ct})`);
        e.code = 'RESP_INVALIDA';
        throw e;
    }
    return JSON.parse(txt);
}

// ── parsers (espelham brk_client/motorista.py e veiculo.py) ──────────────────
const _isApto = (sp) =>
    !!sp && (sp.CodPesquisaStatus === 2 || String(sp.NomeStatus || '').trim().toUpperCase() === 'APTO');

function _parseMotorista(row) {
    const up = row.UltimaPesquisa || {};
    const sp = up.PesquisaStatus || {};
    return {
        found: true,
        apto: _isApto(sp),
        status: String(sp.NomeStatus || '') || null,
        validade: row.DhValidadeExibir || up.DhValidadeExibir || null,
        data_solicitacao: row.DhSolicitacaoExibir || null,
        nome: (row.Nome || '').trim() || null,
        cpf: row.CPF || null,
        cod_motorista: row.CodMotoristaPessoa || null,
        sipa: row.SIPA || null,
        onisys: row.ONISYS || null,
        cnh_validade: row.CNHValidadeExibir || null,
        cnh_vencida: row.CNHVencida || false,
    };
}

function _parseVeiculo(row) {
    const up = row.UltimaPesquisa || {};
    const sp = up.StatusPesquisa || {};            // ⚠ veiculo usa StatusPesquisa
    const rastr = row.VeiculoRastreador || {};
    const eq = row.StatusEquipamento || {};
    return {
        found: true,
        apto: _isApto(sp),
        status: String(sp.NomeStatus || '') || null,
        validade: row.DhValidadeExibir || up.DhValidadeExibir || null,
        data_solicitacao: row.DhSolicitacaoExibir || null,
        placa: (row.Placa || '').trim() || null,
        marca: (row.Marca || '').trim() || null,
        modelo: (row.Modelo || '').trim() || null,
        ano: row.AnoFabricacao || null,
        proprietario: (row.ProprietarioNome || '').trim() || null,
        rastreador: (rastr.EmpresaEquipamento || {}).NomeEmpresaEquipamento || null,
        status_equipamento: eq.NomeEquipamentoStatus || null,
    };
}

// ── cache ────────────────────────────────────────────────────────────────────
function _cacheGet(k) {
    const e = _cache.get(k);
    if (!e) return null;
    if (Date.now() - e.ts > CACHE_TTL_MS) { _cache.delete(k); return null; }
    return e.valor;
}
function _cacheSet(k, v) {
    _cache.set(k, { ts: Date.now(), valor: v });
    if (_cache.size > 200) _cache.delete(_cache.keys().next().value);
}
function clearCache() { _cache.clear(); }

// ── consultas unitarias ──────────────────────────────────────────────────────
async function consultarMotorista(cpf, opts = {}) {
    const c = String(cpf || '').replace(/\D+/g, '');
    if (!c) return { found: false, vazio: true };
    const ck = `m:${c}`;
    const hit = _cacheGet(ck);
    if (hit) return { ...hit, _cache: true };
    const raw = await _getJson('/Motorista/ListaMotoristas', { cpf: c, ..._FILTROS_MOT },
        { timeoutMs: opts.timeoutMs, referer: `${BASE_URL}/Motorista/Listar` });
    const rows = raw.aaData || [];
    const out = rows.length ? _parseMotorista(rows[0]) : { found: false };
    _cacheSet(ck, out);
    return out;
}

async function consultarVeiculo(placa, opts = {}) {
    const p = String(placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!p) return { found: false, vazio: true };
    const ck = `v:${p}`;
    const hit = _cacheGet(ck);
    if (hit) return { ...hit, _cache: true };
    const raw = await _getJson('/Veiculo/ListarVeiculos', { placa: p, ..._FILTROS_VEIC },
        { timeoutMs: opts.timeoutMs, referer: `${BASE_URL}/Veiculo/Listar` });
    const rows = raw.aaData || [];
    const out = rows.length ? _parseVeiculo(rows[0]) : { found: false, placa: p };
    _cacheSet(ck, out);
    return out;
}

// ── agregado pronto pro painel (badge {status,label,color,componentes}) ───────
const _ddmm = (v) => (v || '').split('/').slice(0, 3).join('/'); // ja vem dd/mm/aaaa

// Mapeia o NomeStatus textual do BRK p/ a semantica de cor do painel.
function _statusDoNome(nome) {
    const up = String(nome || '').toUpperCase();
    if (up.includes('APTO') || up.includes('APTA')) return { status: 'vigente', color: 'emerald' };
    if (up.includes('VENC')) return { status: 'expirado', color: 'amber' };          // VENCIDO
    if (up.includes('PENDENT') || up.includes('ANALISE') || up.includes('ANÁLISE') || up.includes('AGUARD'))
        return { status: 'pendente', color: 'amber' };
    return { status: 'nao_conforme', color: 'rose' };  // INAPTO/REPROVADO/BLOQUEADO/...
}

function _compBadge(parsed, rotuloVazio) {
    if (!parsed || parsed.vazio) return { status: 'nao_aplicavel', label: rotuloVazio || '—', color: 'slate' };
    if (!parsed.found) return { status: 'nao_cadastrado', label: 'Não cadastrado', color: 'slate' };
    if (parsed.apto) return { status: 'vigente', label: `Apto${parsed.validade ? ' · vence ' + _ddmm(parsed.validade) : ''}`, color: 'emerald', limit: parsed.validade };
    const m = _statusDoNome(parsed.status);
    const lbl = (parsed.status || 'Não apto') + (parsed.validade ? ' · ' + _ddmm(parsed.validade) : '');
    return { status: m.status, label: lbl, color: m.color, limit: parsed.validade };
}

async function consultarPainel({ cpf, placas } = {}, opts = {}) {
    if (!disponivel()) {
        return {
            status: 'erro', color: 'slate',
            label: 'cookie não configurado',
            detalhe: 'Defina BRSYSTEM_COOKIE (ou crie ./backend/cookie.txt via `node refresh_cookies_brk_pw.js login`).',
        };
    }
    const lista = (Array.isArray(placas) ? placas : []).filter(Boolean);
    const tarefas = [];
    if (cpf) tarefas.push(['motorista', () => consultarMotorista(cpf, opts)]);
    lista.forEach((pl, i) => tarefas.push([i === 0 ? 'cavalo' : (i === 1 ? 'carreta' : `veiculo${i}`), () => consultarVeiculo(pl, opts)]));

    // Sequencial de proposito: o BRK costuma travar/timeout com varias chamadas
    // simultaneas na mesma sessao. Com o cache de 5 min isso so pesa na 1a vez.
    const settled = [];
    for (const [, fn] of tarefas) {
        try { settled.push({ status: 'fulfilled', value: await fn() }); }
        catch (e) { settled.push({ status: 'rejected', reason: e }); }
    }

    const componentes = {};
    let expirou = false, algumErro = false;
    settled.forEach((s, i) => {
        const key = tarefas[i][0];
        if (s.status === 'fulfilled') {
            componentes[key] = _compBadge(s.value, key === 'motorista' ? 'Sem CPF' : 'Sem placa');
            if (s.value && s.value.found === false && s.value.vazio) componentes[key] = { status: 'nao_aplicavel', label: '—', color: 'slate' };
        } else {
            algumErro = true;
            if (s.reason && s.reason.code === 'SESSAO_EXPIRADA') expirou = true;
            componentes[key] = { status: 'erro', label: 'erro', color: 'slate', detalhe: s.reason?.message };
        }
    });

    if (expirou) {
        return { status: 'erro', color: 'slate', label: 'sessão expirada — refaça o login (cf_clearance)', componentes };
    }

    const rel = Object.entries(componentes).filter(([, c]) => c.status !== 'nao_aplicavel');
    if (!rel.length) {
        return { status: 'aguardando_dados', color: 'slate', label: 'Aguardando OCR', componentes };
    }
    const problemas = rel.filter(([, c]) => c.status !== 'vigente');
    if (!problemas.length) {
        const datas = rel.map(([, c]) => c.limit).filter(Boolean).sort((a, b) =>
            a.split('/').reverse().join('').localeCompare(b.split('/').reverse().join('')));
        return { status: 'vigente', color: 'emerald', label: `Apto${datas[0] ? ' · vence ' + datas[0] : ''}`, conjunto_apto: true, componentes };
    }
    // Lista cada componente com problema (ex.: "motorista: vencido · carreta: não cadastrado").
    const rotulo = { nao_conforme: 'inapto', expirado: 'vencido', nao_cadastrado: 'não cadastrado', pendente: 'pendente', erro: 'erro' };
    const label = problemas.map(([k, c]) => `${k}: ${rotulo[c.status] || c.status}`).join(' · ');
    let status, color;
    if (problemas.some(([, c]) => c.status === 'nao_conforme')) { status = 'nao_conforme'; color = 'rose'; }
    else if (problemas.some(([, c]) => c.status === 'expirado' || c.status === 'pendente')) { status = 'expirado'; color = 'amber'; }
    else if (problemas.some(([, c]) => c.status === 'nao_cadastrado')) { status = 'nao_cadastrado'; color = 'slate'; }
    else { status = 'parcial'; color = 'amber'; }
    return { status, color, label, conjunto_apto: false, componentes };
}

module.exports = {
    disponivel,
    recarregarSessao,
    consultarMotorista,
    consultarVeiculo,
    consultarPainel,
    clearCache,
};
