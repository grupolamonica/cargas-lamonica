// backfill_brk_supabase.js — preenche as colunas brk_* de driver_profiles no Supabase
// para motoristas EXISTENTES (o sync do backend é por evento/candidatura e não
// preenche retroativamente). Roda no SERVERBD, onde alcança o :5010 (localhost) e
// tem as credenciais Supabase do sistema de cadastro.
//
// Espelha a lógica do backend (backend/.../use-cases/brk-cache.js): status,
// conjunto_apto, MENOR data de validade entre os componentes, label, details.
//
// Seguro por padrão: DRY-RUN (só mostra o que gravaria). Grava só com --apply.
// Idempotente: pode rodar quantas vezes quiser. Sequencial + pausa entre motoristas
// (o BRK é provedor pago — não martelar). NÃO loga segredos.
//
// Env (do .env do sistema de cadastro):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_SECRET_KEY)
//   BRK_BASE_URL (default http://localhost:5010), BRK_API_KEY
//
// Uso:
//   node backfill_brk_supabase.js            # dry-run (preview)
//   node backfill_brk_supabase.js --apply    # grava no driver_profiles
//   node backfill_brk_supabase.js --apply --limit 5
'use strict';

const fs = require('fs');
const path = require('path');

// Carrega o .env do sistema hospedeiro (SUPABASE_*, BRK_API_KEY) SEM depender de
// dotenv/node_modules — parser mínimo. No SERVERBD o .env fica na pasta PAI do bot
// (Sistema_cadastro/.env). Vars já no ambiente têm prioridade (não sobrescreve).
function carregarEnv(p) {
  try {
    for (const linha of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const s = linha.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq < 0) continue;
      const k = s.slice(0, eq).trim();
      let v = s.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch { /* sem .env: segue com o process.env atual */ }
}
carregarEnv(path.join(__dirname, '..', '.env'));   // Sistema_cadastro/.env (SERVERBD)
carregarEnv(path.join(__dirname, '.env'));          // .env local do bot (se houver)

const APPLY = process.argv.includes('--apply');
const _limArg = process.argv.indexOf('--limit');
const LIMIT = _limArg >= 0 ? Number(process.argv[_limArg + 1]) || 0 : 0;
const PAUSA_MS = Number(process.env.BRK_BACKFILL_PAUSE_MS || 800);

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const BRK_BASE_URL = (process.env.BRK_BASE_URL || 'http://localhost:5010').replace(/\/+$/, '');
const BRK_API_KEY = process.env.BRK_API_KEY || '';

const soDigitos = (s) => String(s || '').replace(/\D+/g, '');
const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

function sbHeaders() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' };
}

// Espelha extractEarliestBrkValidUntil do brk-cache.js: menor data DD/MM/AAAA
// achada nos labels dos componentes -> ISO (YYYY-MM-DD). null se nenhuma.
function menorValidadeISO(componentes) {
  if (!componentes || typeof componentes !== 'object') return null;
  const isos = [];
  for (const comp of Object.values(componentes)) {
    const label = comp && typeof comp.label === 'string' ? comp.label : '';
    const m = label.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) {
      const iso = `${m[3]}-${m[2]}-${m[1]}`;
      const d = new Date(`${iso}T00:00:00Z`);
      if (!Number.isNaN(d.getTime())) isos.push(iso);
    }
  }
  if (!isos.length) return null;
  isos.sort();
  return isos[0];
}

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders(), signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Supabase GET ${path} -> HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function sbPatchDriver(userId, fields) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/driver_profiles?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(fields),
    signal: AbortSignal.timeout(20000),
  });
  if (!(r.status === 200 || r.status === 204)) {
    throw new Error(`Supabase PATCH driver_profiles -> HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}

async function consultarBrk(cpf, placas) {
  const qs = new URLSearchParams();
  qs.set('cpf', cpf);
  placas.filter(Boolean).forEach((p) => qs.append('placa', p));
  const r = await fetch(`${BRK_BASE_URL}/api/brk/consultar?${qs}`, {
    headers: { 'X-API-Key': BRK_API_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(60000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) {
    throw new Error(`BRK consultar -> HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

(async () => {
  const faltando = [];
  if (!SUPABASE_URL) faltando.push('SUPABASE_URL');
  if (!SUPABASE_KEY) faltando.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!BRK_API_KEY) faltando.push('BRK_API_KEY');
  if (faltando.length) {
    console.error(`[erro] env faltando: ${faltando.join(', ')}`);
    process.exitCode = 2;
    return;
  }
  console.log(`[modo] ${APPLY ? 'APPLY (grava)' : 'DRY-RUN (preview; use --apply pra gravar)'} | BRK=${BRK_BASE_URL}`);

  // 1) perfis (poucos): mapa cpf-normalizado -> user_id
  const perfis = await sbGet('driver_profiles?select=user_id,document_number');
  const perfilPorCpf = new Map();
  for (const p of perfis) {
    const c = soDigitos(p.document_number);
    if (c && !perfilPorCpf.has(c)) perfilPorCpf.set(c, p.user_id);
  }

  // 2) leads com placa -> candidato por motorista (dedup por cpf)
  const leads = await sbGet('load_public_leads?select=cpf,horse_plate,trailer_plate,trailer_plate_2');
  const candidatos = new Map(); // cpf -> {cpf, userId, placas}
  for (const l of leads) {
    const cpf = soDigitos(l.cpf);
    const horse = (l.horse_plate || '').trim();
    if (!cpf || !horse) continue;
    const userId = perfilPorCpf.get(cpf);
    if (!userId) continue; // sem perfil correspondente -> nada a gravar
    if (candidatos.has(cpf)) continue;
    const placas = [l.horse_plate, l.trailer_plate, l.trailer_plate_2].map((x) => (x || '').trim()).filter(Boolean);
    candidatos.set(cpf, { cpf, userId, placas });
  }

  let lista = [...candidatos.values()];
  if (LIMIT > 0) lista = lista.slice(0, LIMIT);
  console.log(`[info] ${lista.length} motorista(s) com perfil + placas para consultar\n`);

  let ok = 0, gravados = 0, falhas = 0;
  for (const c of lista) {
    const cpfMasc = `***${c.cpf.slice(-4)}`;
    try {
      const res = await consultarBrk(c.cpf, c.placas);
      const validUntil = menorValidadeISO(res.componentes);
      const fields = {
        brk_status: res.status || null,
        brk_conjunto_apto: typeof res.conjunto_apto === 'boolean' ? res.conjunto_apto : null,
        brk_valid_until: validUntil,
        brk_status_text: res.label || null,
        brk_details: res.componentes || null,
        brk_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      ok += 1;
      console.log(`  ${cpfMasc} placas=[${c.placas.join(',')}] -> ${fields.brk_status} | apto=${fields.brk_conjunto_apto} | vence=${validUntil || '-'} | "${fields.brk_status_text}"`);
      if (APPLY) {
        await sbPatchDriver(c.userId, fields);
        gravados += 1;
      }
    } catch (e) {
      falhas += 1;
      console.error(`  ${cpfMasc} FALHA: ${e.message}`);
    }
    await dorme(PAUSA_MS);
  }

  console.log(`\n[fim] consultados=${ok} gravados=${gravados} falhas=${falhas} ${APPLY ? '' : '(dry-run: nada gravado)'}`);
  process.exitCode = falhas > 0 ? 1 : 0;
})();
