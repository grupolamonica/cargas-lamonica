// sync_cookie_from_supabase_brk.js — traz o cookie do BRK do Supabase (brk_credentials)
// para o cookie.txt que o robô :5010 lê. É a ponte entre o CARD do painel
// (Motoristas -> Brasil Risk -> "Atualizar cookie") e o robô:
//
//   card  --POST /api/operator/brk/cookie-->  brk_credentials (Supabase)
//   este script (agendado no SERVERBD)      -> backend/cookie.txt + useragent.txt
//   lib/brasilrisk_consulta.js recarrega o cookie.txt sozinho (watch de mtime)
//
// Assim o robô passa a usar o cookie colado no painel SEM reiniciar. Espelha o
// modelo do SPX (cookie mora no Supabase, o robô puxa). HTTP puro + fs, sem deps
// além do dotenv (opcional) que o próprio robô já usa.
//
// "MAIS NOVO VENCE": só sobrescreve o cookie.txt local se o cookie do card
// (cookies_updated_at) for MAIS NOVO que o cookie.txt. Assim um `login` local
// recém-feito não é sobrescrito por um cookie antigo do card — e um cookie
// recém-colado no card (updated_at > mtime) sempre vence. Nunca apaga um cookie
// local bom quando o Supabase está vazio.
//
// Caminho do cookie: por padrão bots/brasilrisk-robo/backend/cookie.txt (o que o
// server.js/lib deste robô leem). Se no SERVERBD o :5010 for outro robô (ex.: o do
// sistema de cadastro), aponte com BRK_COOKIE_FILE / BRK_UA_FILE no .env.
//
// Env (do .env do robô / sistema de cadastro):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_SECRET_KEY)   [obrigatório]
//   BRK_COOKIE_FILE, BRK_UA_FILE                                        [opcional]
//   BRK_SYNC_TIMEOUT_MS (default 20000)                                 [opcional]
//
// Exit: 0 = em sincronia / atualizado / local mais novo (mantido) ·
//       2 = sem cookie no Supabase (nada a fazer) ·
//       3 = erro de rede/resposta/escrita · 4 = env do Supabase ausente.
'use strict';

const fs = require('fs');
const path = require('path');

// Carrega .env local e do diretório pai (idem server.js), sem sobrescrever env já setado.
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '.env') });
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
} catch { /* dotenv opcional */ }

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const TIMEOUT_MS = Number(process.env.BRK_SYNC_TIMEOUT_MS || 20000);

const BACKEND = path.join(__dirname, 'backend');
const COOKIE_FILE = process.env.BRK_COOKIE_FILE || path.join(BACKEND, 'cookie.txt');
const UA_FILE = process.env.BRK_UA_FILE || path.join(BACKEND, 'useragent.txt');

const ts = () => new Date().toISOString().slice(11, 19);

// Sai pelo exitCode e deixa o event loop drenar (fecha os sockets keep-alive do
// undici sem o assert do libuv que process.exit() abrupto causa no Windows).
function finalizar(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5000).unref();
}

function readTrim(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } }
function mtimeMs(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

function sbHeaders() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Accept: 'application/json' };
}

// { nome: valor } -> header Cookie "a=1; b=2"
function montarHeaderCookie(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return Object.entries(obj)
    .filter(([k, v]) => k && v != null && String(v) !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

(async () => {
  const faltando = [];
  if (!SUPABASE_URL) faltando.push('SUPABASE_URL');
  if (!SUPABASE_KEY) faltando.push('SUPABASE_SERVICE_ROLE_KEY');
  if (faltando.length) {
    console.error(`[${ts()}] env do Supabase ausente: ${faltando.join(', ')} — configure o .env do robô`);
    return finalizar(4);
  }

  let row;
  try {
    const url = `${SUPABASE_URL}/rest/v1/brk_credentials` +
      `?id=eq.1&select=cookies_json,user_agent,cookies_updated_at,cookies_expires_at`;
    const r = await fetch(url, { headers: sbHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) {
      console.error(`[${ts()}] Supabase GET brk_credentials -> HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      return finalizar(3);
    }
    const rows = await r.json();
    row = Array.isArray(rows) ? rows[0] : rows;
  } catch (e) {
    console.error(`[${ts()}] erro de rede no Supabase: ${e.message}`);
    return finalizar(3);
  }

  const cookiesJson = row && row.cookies_json;
  const header = montarHeaderCookie(cookiesJson);
  const count = cookiesJson && typeof cookiesJson === 'object' ? Object.keys(cookiesJson).length : 0;
  if (!header) {
    console.log(`[${ts()}] sem cookie no Supabase (brk_credentials.cookies_json vazio) — nada a sincronizar. ` +
      `Cole o cookie no card do painel (Motoristas -> Brasil Risk -> Atualizar cookie).`);
    return finalizar(2);
  }

  const ua = (row.user_agent || '').trim();
  const supaUpdatedMs = row.cookies_updated_at ? Date.parse(row.cookies_updated_at) : 0;
  const cookieAtual = readTrim(COOKIE_FILE);
  const uaAtual = readTrim(UA_FILE);

  // Já em sincronia? Não reescreve (evita churn de mtime que zera o cache do lib).
  if (cookieAtual === header && (!ua || uaAtual === ua)) {
    console.log(`[${ts()}] já em sincronia (${count} cookies). Nada a fazer.`);
    return finalizar(0);
  }

  // "Mais novo vence": se o cookie.txt local for MAIS NOVO que o do card, não
  // sobrescreve (ex.: `login` local recém-feito). Um card recém-colado tem
  // cookies_updated_at > mtime do cookie.txt, então sempre vence aqui.
  const localMs = mtimeMs(COOKIE_FILE);
  if (cookieAtual && localMs > supaUpdatedMs) {
    console.log(`[${ts()}] cookie.txt local é mais novo que o do card ` +
      `(local=${new Date(localMs).toISOString()} > card=${row.cookies_updated_at || '-'}) — ` +
      `mantendo o local. Se quer o do card, recole no painel.`);
    return finalizar(0);
  }

  try {
    fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
    fs.writeFileSync(COOKIE_FILE, header + '\n', 'utf8');
    if (ua) fs.writeFileSync(UA_FILE, ua + '\n', 'utf8');
    const temCf = Object.keys(cookiesJson).some((n) => /cf_clearance/i.test(n));
    const venc = row.cookies_expires_at ? ` (card marca expira ${row.cookies_expires_at})` : '';
    console.log(`[${ts()}] cookie do card sincronizado -> ${COOKIE_FILE} ` +
      `(${count} cookies, cf_clearance=${temCf ? 'sim' : 'NAO'}, UA=${ua ? 'atualizado' : 'mantido'})${venc}. ` +
      `O robô :5010 recarrega sozinho na próxima consulta.`);
    if (!temCf) {
      console.warn(`[${ts()}] AVISO: sem cf_clearance no cookie do card — a consulta pode tomar 403 no Cloudflare.`);
    }
    return finalizar(0);
  } catch (e) {
    console.error(`[${ts()}] falha ao escrever o cookie.txt (${COOKIE_FILE}): ${e.message}`);
    return finalizar(3);
  }
})();
