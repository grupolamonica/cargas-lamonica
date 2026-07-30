import { logStructuredEvent } from "../../infrastructure/security-log.js";
import { getPostgresPool } from "../../infrastructure/pg/postgres.js";
import { selectAllPaginated } from "../../infrastructure/supabase/paginate.js";
import { bustSheetMonitorEnrichedCache } from "./sheet-monitor-enriched-cache.js";
import { listSystemCargasForMonitor } from "./use-cases/list-system-cargas-monitor.js";

const STALE_HOURS = 6;
const BATCH_SIZE = 60;
const CONCURRENCY = 8;
// Timeout por consulta ao Angellira. A API deles às vezes fica LENTA (~12-13s por
// resposta em prod). 8s era curto demais → consulta boa mas lenta era abortada e
// virava "indisponível". Fica abaixo do timeout do cliente (ANGELLIRA_TIMEOUT_MS,
// 30s). Configurável por env p/ ajustar sem deploy.
const CALL_TIMEOUT_MS = Math.max(1_000, Number(process.env.ANGELLIRA_ENRICH_TIMEOUT_MS) || 25_000);

function normalizePlate(p) {
  return (p || "").replace(/[\s\-.]/g, "").toUpperCase();
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

async function runConcurrent(tasks, concurrency) {
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      await tasks[i]().catch(() => {});
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

// Normaliza nome: sem acento (NFD), minúsculo, espaço único. Casa "José" com
// "Jose" — recupera divergências de acentuação entre planilha e ASPX.
export function normNameForMatch(s) {
  return (s ?? "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Conectivos de nome (não distinguem pessoas) — ignorados no match nome↔nome.
const NAME_CONNECTORS = new Set(["de", "da", "do", "das", "dos", "e", "di", "du", "del", "la"]);

// Tokens "significativos" de um nome já normalizado: descarta conectivos e tokens
// de 1 letra (iniciais abreviadas). "wesley de araujo soares" → [wesley,araujo,soares].
function significantNameTokens(norm) {
  return norm.split(" ").filter((t) => t.length > 1 && !NAME_CONNECTORS.has(t));
}

/**
 * Diz se dois nomes de motorista são a MESMA pessoa, tolerante às divergências
 * reais entre a planilha/sistema e o ASPX: acento (normaliza), caixa, espaços,
 * conectivos inseridos/omitidos ("WESLEY ARAUJO SOARES" ⇄ "WESLEY DE ARAUJO
 * SOARES") e nome do meio a mais/a menos ("JOAO SILVA" ⇄ "JOAO PEDRO SILVA").
 *
 * Conservador p/ NÃO gerar falso-positivo (que esconderia motorista trocado):
 *  - MULTISET de tokens significativos IGUAL (ordem/conectivo à parte) — usa
 *    multiset, não set, p/ token repetido não mascarar diferença; OU
 *  - um nome é SUBCONJUNTO do outro (>= minSubsetTokens) COM o MESMO primeiro e
 *    último token e o multiset do curto cabendo no do longo.
 *
 * minSubsetTokens (default 2): no DIRETÓRIO (matchAspxDriver, milhares de nomes)
 * use 3 p/ não casar nome genérico de 2 tokens ("MARCELO DA SILVA") com outra
 * pessoa. Na comparação da MESMA carga (selo ASPX) o default 2 basta (só há 1
 * candidato — o motorista daquela viagem).
 */
export function driverNamesMatch(a, b, { minSubsetTokens = 2 } = {}) {
  const na = normNameForMatch(a);
  const nb = normNameForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = significantNameTokens(na);
  const tb = significantNameTokens(nb);
  if (ta.length === 0 || tb.length === 0) return false;

  // Mesmo MULTISET de tokens significativos (só ordem/conectivo mudou) → mesma
  // pessoa. Multiset (arrays ordenados), NÃO set: token repetido não pode mascarar
  // diferença — ex.: "LEANDRO SANTOS SANTOS" ≠ "LEANDRO FARIA SANTOS".
  if (ta.length === tb.length && [...ta].sort().join("") === [...tb].sort().join("")) {
    return true;
  }

  // Subconjunto (nome do meio a mais/menos): exige >=3 tokens no nome MAIS CURTO,
  // 1º e último iguais, e o multiset do curto cabendo no do longo. O piso de 3
  // evita casar nome GENÉRICO de 2 tokens ("MARCELO DA SILVA", "JOSE DOS SANTOS",
  // "ALEX PEREIRA") com um nome completo de outra pessoa. Nome de 2 tokens sem
  // igualdade exata → "não consultado" (o operador informa o CPF).
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length >= minSubsetTokens && short[0] === long[0] && short[short.length - 1] === long[long.length - 1]) {
    const longCounts = new Map();
    for (const t of long) longCounts.set(t, (longCounts.get(t) || 0) + 1);
    let fits = true;
    const shortCounts = new Map();
    for (const t of short) shortCounts.set(t, (shortCounts.get(t) || 0) + 1);
    for (const [t, c] of shortCounts) {
      if ((longCounts.get(t) || 0) < c) { fits = false; break; }
    }
    if (fits) return true;
  }
  return false;
}

// Pré-normaliza a lista do ASPX uma vez (evita normalizar 1600 nomes por motorista).
export function indexAspxList(aspxList) {
  return (aspxList || []).map((d) => ({ cpf: d.cpf, display_name: d.display_name, norm: normNameForMatch(d.display_name) }));
}

const NON_DRIVER = new Set(["noshow", "no show", "agregado", "sem motorista"]);

/**
 * Resolve nome→registro (ASPX / motoristas_historico) para descobrir o CPF do
 * motorista. CONSERVADOR: só casa quando é a MESMA PESSOA (via driverNamesMatch —
 * exato, mesmo conjunto de tokens, ou subconjunto com 1º+último iguais). Tolera
 * acento e MOJIBAKE (`?` = acento corrompido → coringa de 1 char, ancorado no nome
 * inteiro).
 *
 * NÃO casa mais por PREFIXO/primeiro-nome: "MAGNO GABRIEL DOS SANTOS" NÃO casa
 * "MAGNO WELLINGTON CHAVES LIMA" (pessoas diferentes que só dividem o 1º nome).
 * Antes, o fallback `startsWith(primeiroNome)` resolvia o CPF ERRADO → consultava
 * o Angellira do motorista errado. Melhor "não consultado" do que dado de outra
 * pessoa: sem match confiável, devolve null (o selo fica cinza, não vermelho/errado).
 */
export function matchAspxDriver(name, aspxIndexed) {
  const nl = normNameForMatch(name);
  if (!nl || NON_DRIVER.has(nl)) return null;
  const list = aspxIndexed && aspxIndexed[0] && "norm" in aspxIndexed[0] ? aspxIndexed : indexAspxList(aspxIndexed);

  // Mesma pessoa (conservador). Cobre acento/caixa/espaço/conectivo/nome-do-meio.
  // ESTRITO (minSubsetTokens:3): é busca num diretório de milhares → nome genérico
  // de 2 tokens não pode casar outra pessoa.
  const m = list.find((d) => driverNamesMatch(nl, d.norm, { minSubsetTokens: 3 }));
  if (m) return m;

  // Mojibake ('?' = acento corrompido): coringa de 1 char, ANCORADO (^...$) — casa
  // "flor?ncio"→"florencio" sem virar substring solta nem casar outra estrutura.
  if (nl.includes("?")) {
    const pattern = nl.split("").map((c) => (c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
    try {
      const rx = new RegExp(`^${pattern}$`);
      const mj = list.find((d) => rx.test(d.norm));
      if (mj) return mj;
    } catch {
      /* regex inválida — ignora */
    }
  }

  return null;
}

/**
 * Monta o registro de upsert de UMA linha (puro/testável). `row` = {lh, cargoId?,
 * motoristas, cavalo, carreta}. Para cargas do sistema, lh = 'cargo:<id>' e
 * cargoId preenchido → casa por cargo_id no frontend. Sempre devolve um registro
 * (mesmo sem motorista/placa) — a AUSÊNCIA de registro é o que vira "não consultado".
 */
export function buildEnrichedUpsertRow(row, ctx) {
  const { driverByName, vehiclesByPlate, angelliraVehicles } = ctx;
  const driverName = (row.motoristas || "").trim() || null;
  // Resolução unificada do motorista: motoristas_historico (CPF-verified) com
  // fallback no aspx_drivers. aspxFound = está no ASPX; cpf p/ Angellira.
  const driver = driverName ? (driverByName[driverName] ?? null) : null;
  const dr = driver?.angellira ?? null;

  const cavaloPl = normalizePlate(row.cavalo) || null;
  const carretaPl = normalizePlate(row.carreta) || null;

  function buildVehicle(plate) {
    if (!plate) return {};
    const db = vehiclesByPlate[plate];
    if (db) {
      return {
        source: "db",
        type: db.vehicle_type ?? null,
        found: db.angellira_status === "FOUND",
        status: db.angellira_status ?? null,
        validUntil: db.angellira_valid_until ?? null,
        statusText: db.angellira_status_text ?? null,
        display: db.angellira_display_name ?? null,
        details: db,
      };
    }
    const ang = angelliraVehicles[plate];
    if (!ang) return { source: "not_found", found: false };
    return {
      source: ang._source === "angellira" ? "angellira" : "not_found",
      type: ang.vehicleDetails?.type ?? null,
      found: ang.found ?? false,
      status: ang.status ?? null,
      validUntil: ang.validUntil ?? null,
      statusText: ang.statusText ?? null,
      display: ang.displayName ?? null,
      details: ang.vehicleDetails ?? null,
    };
  }

  const cavalo = buildVehicle(cavaloPl);
  const carreta = buildVehicle(carretaPl);

  return {
    lh: row.lh,
    cargo_id: row.cargoId ?? null,
    driver_name: driverName,
    // aspx_cpf/display só quando o motorista ESTÁ no ASPX (aspxFound) — o selo
    // "ASPX cadastrado" do frontend liga por aspx_cpf. O CPF p/ Angellira é
    // resolvido à parte (não depende de estar no ASPX).
    aspx_cpf: driver?.aspxFound ? (driver.cpf ?? null) : null,
    aspx_display_name: driver?.aspxFound ? (driver.aspxDisplayName ?? null) : null,
    angellira_driver_found: dr?.found ?? null,
    angellira_driver_status: dr?.status ?? null,
    angellira_driver_valid_until: dr?.validUntil ?? null,
    angellira_driver_status_text: dr?.statusText ?? null,
    angellira_driver_details: dr?.details ?? null,

    cavalo_plate: cavaloPl,
    cavalo_source: cavalo.source ?? null,
    cavalo_type: cavalo.type ?? null,
    cavalo_angellira_found: cavalo.found ?? null,
    cavalo_angellira_status: cavalo.status ?? null,
    cavalo_angellira_valid_until: cavalo.validUntil ?? null,
    cavalo_angellira_status_text: cavalo.statusText ?? null,
    cavalo_angellira_display: cavalo.display ?? null,
    cavalo_details: cavalo.details ?? null,

    carreta_plate: carretaPl,
    carreta_source: carreta.source ?? null,
    carreta_type: carreta.type ?? null,
    carreta_angellira_found: carreta.found ?? null,
    carreta_angellira_status: carreta.status ?? null,
    carreta_angellira_valid_until: carreta.validUntil ?? null,
    carreta_angellira_status_text: carreta.statusText ?? null,
    carreta_angellira_display: carreta.display ?? null,
    carreta_details: carreta.details ?? null,

    enriched_at: new Date().toISOString(),
  };
}

const isUnavail = (s) => !s || s === "UNAVAILABLE";
const isReal = (s) => Boolean(s) && s !== "UNAVAILABLE";

// Identidade resolvida do motorista (CPF) numa linha enriquecida — usada p/ não
// preservar dado de OUTRA pessoa que tinha o mesmo nome na planilha (match frouxo).
const driverIdentityCpf = (r) =>
  (r?.aspx_cpf || (r?.angellira_driver_details && r.angellira_driver_details.cpf) || null);

/**
 * Funde a nova linha enriquecida com a ANTERIOR preservando dado bom: se a nova
 * consulta veio UNAVAILABLE/vazia (falha transitória) mas já havia status real,
 * mantém o anterior. Só preserva quando é o MESMO motorista/placa (senão troca
 * de motorista carregaria dado errado). enriched_at sempre avança (marca consulta).
 */
export function mergePreservingGood(next, prev) {
  if (!prev) return next;
  const m = { ...next };

  // Motorista — só preserva o dado bom anterior numa falha TRANSITÓRIA real: o
  // motorista foi resolvido mas a API do Angellira caiu (status UNAVAILABLE). Se a
  // nova passada NÃO resolveu o motorista (status null — ex.: o matcher estrito
  // rejeitou corretamente um match errado, ou o motorista saiu da base), NÃO
  // preserva: o dado anterior pode ser de OUTRA pessoa (match frouxo antigo) e deve
  // SAIR. Assim o enriquecimento/"Consultar item" auto-limpa os matches errados.
  // Só para o MESMO motorista (senão troca de motorista carregaria dado errado).
  const nextIdCpf = driverIdentityCpf(next);
  const prevIdCpf = driverIdentityCpf(prev);
  if (
    next.driver_name &&
    next.driver_name === prev.driver_name &&
    next.angellira_driver_status === "UNAVAILABLE" &&
    isReal(prev.angellira_driver_status) &&
    nextIdCpf &&
    prevIdCpf &&
    nextIdCpf === prevIdCpf
  ) {
    if (!next.aspx_cpf && prev.aspx_cpf) {
      m.aspx_cpf = prev.aspx_cpf;
      m.aspx_display_name = prev.aspx_display_name ?? m.aspx_display_name;
    }
    m.angellira_driver_found = prev.angellira_driver_found;
    m.angellira_driver_status = prev.angellira_driver_status;
    m.angellira_driver_valid_until = prev.angellira_driver_valid_until;
    m.angellira_driver_status_text = prev.angellira_driver_status_text;
    m.angellira_driver_details = prev.angellira_driver_details ?? m.angellira_driver_details;
  }

  // Cavalo — só se for a mesma placa
  if (next.cavalo_plate && next.cavalo_plate === prev.cavalo_plate && isUnavail(next.cavalo_angellira_status) && isReal(prev.cavalo_angellira_status)) {
    m.cavalo_source = prev.cavalo_source;
    m.cavalo_type = prev.cavalo_type ?? m.cavalo_type;
    m.cavalo_angellira_found = prev.cavalo_angellira_found;
    m.cavalo_angellira_status = prev.cavalo_angellira_status;
    m.cavalo_angellira_valid_until = prev.cavalo_angellira_valid_until;
    m.cavalo_angellira_status_text = prev.cavalo_angellira_status_text;
    m.cavalo_angellira_display = prev.cavalo_angellira_display ?? m.cavalo_angellira_display;
    m.cavalo_details = prev.cavalo_details ?? m.cavalo_details;
  }

  // Carreta — só se for a mesma placa
  if (next.carreta_plate && next.carreta_plate === prev.carreta_plate && isUnavail(next.carreta_angellira_status) && isReal(prev.carreta_angellira_status)) {
    m.carreta_source = prev.carreta_source;
    m.carreta_type = prev.carreta_type ?? m.carreta_type;
    m.carreta_angellira_found = prev.carreta_angellira_found;
    m.carreta_angellira_status = prev.carreta_angellira_status;
    m.carreta_angellira_valid_until = prev.carreta_angellira_valid_until;
    m.carreta_angellira_status_text = prev.carreta_angellira_status_text;
    m.carreta_angellira_display = prev.carreta_angellira_display ?? m.carreta_angellira_display;
    m.carreta_details = prev.carreta_details ?? m.carreta_details;
  }

  return m;
}

/**
 * Monta as linhas de upsert p/ motoristas_historico a partir dos motoristas que
 * foram consultados AO VIVO agora (fallback ASPX) e voltaram FOUND. Persistir
 * transforma a consulta volátil num registro durável: na próxima passada o
 * motorista é resolvido pela TABELA (data fresca), SEM re-consultar a API — o que
 * elimina a oscilação FOUND↔UNAVAILABLE quando a API do Angellira falha
 * intermitentemente (timeout/circuit breaker). Puro/testável: recebe o estado já
 * resolvido e devolve as linhas (dedup por CPF; só FOUND com availability OK).
 */
export function buildDriverHistoricoUpsertRows(driverByName, cpfsToFetch, angelliraDrivers) {
  const fetched = new Set((cpfsToFetch || []).map((c) => String(c || "").replace(/\D/g, "")).filter(Boolean));
  const byCpf = new Map();
  for (const name of Object.keys(driverByName || {})) {
    const d = driverByName[name];
    const norm = String(d?.cpf || "").replace(/\D/g, "");
    if (!norm || !fetched.has(norm) || byCpf.has(norm)) continue;
    const a = angelliraDrivers?.[norm];
    if (!a || a.availability !== "OK" || a.found !== true) continue;
    byCpf.set(norm, {
      cpf: norm,
      nome: (a.driverDetails?.name || d.aspxDisplayName || name || "").trim(),
      angelliraQueryId: a.queryId ?? null,
      angelliraSentDate: a.lastSeenAt ?? null,
      angelliraLimitDate: a.validUntil ?? null,
      aspxFound: d.aspxFound === true,
      aspxDisplayName: d.aspxDisplayName ?? null,
    });
  }
  return [...byCpf.values()];
}

// Upsert (best-effort) das linhas do builder no motoristas_historico. Só toca
// colunas Angellira/ASPX (COALESCE preserva o resto da ficha).
async function upsertDriverHistoricoRows(pool, rows) {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO public.motoristas_historico
         (cpf, nome, angellira_query_id, angellira_sent_date, angellira_limit_date,
          aspx_found, aspx_display_name, aspx_matched_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $6 THEN now() ELSE NULL END, now())
       ON CONFLICT (cpf) DO UPDATE SET
         nome                 = COALESCE(NULLIF(EXCLUDED.nome, ''), motoristas_historico.nome),
         angellira_query_id   = EXCLUDED.angellira_query_id,
         angellira_sent_date  = EXCLUDED.angellira_sent_date,
         angellira_limit_date = EXCLUDED.angellira_limit_date,
         aspx_found           = motoristas_historico.aspx_found OR EXCLUDED.aspx_found,
         aspx_display_name    = COALESCE(EXCLUDED.aspx_display_name, motoristas_historico.aspx_display_name),
         updated_at           = now()`,
      [r.cpf, r.nome, r.angelliraQueryId, r.angelliraSentDate, r.angelliraLimitDate, r.aspxFound, r.aspxDisplayName],
    );
  }
}

// Persiste (best-effort) os FOUND buscados agora. NÃO lança — persistir é um bônus.
async function persistFetchedDriversToHistorico(driverByName, cpfsToFetch, angelliraDrivers, correlationId) {
  try {
    const rows = buildDriverHistoricoUpsertRows(driverByName, cpfsToFetch, angelliraDrivers);
    if (rows.length === 0) return;
    await upsertDriverHistoricoRows(getPostgresPool(), rows);
    logStructuredEvent("info", "sheet-monitor-enrich.persist-drivers", { correlationId, count: rows.length });
  } catch (err) {
    logStructuredEvent("warn", "sheet-monitor-enrich.persist-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Plano de escrita do "Consultar item" (forceLive), a partir das consultas ao vivo:
 *  - upserts: motoristas FOUND (data/id frescos) → mesmas linhas do builder normal;
 *  - clears:  CPFs que voltaram NOT_FOUND (availability OK, found=false) → zera a
 *             vigência (autoritativo, mesma convenção do cache de leads).
 * UNAVAILABLE (API fora naquele instante) fica de fora dos dois — não rebaixa dado
 * bom. Puro/testável (dedup por CPF; um CPF nunca aparece em upserts E clears).
 */
export function planForceLiveDriverWrites(driverByName, cpfsToFetch, angelliraDrivers) {
  const upserts = buildDriverHistoricoUpsertRows(driverByName, cpfsToFetch, angelliraDrivers);
  const upsertCpfs = new Set(upserts.map((u) => u.cpf));
  const fetched = new Set((cpfsToFetch || []).map((c) => String(c || "").replace(/\D/g, "")).filter(Boolean));
  const clears = new Set();
  for (const name of Object.keys(driverByName || {})) {
    const norm = String(driverByName[name]?.cpf || "").replace(/\D/g, "");
    if (!norm || !fetched.has(norm) || upsertCpfs.has(norm)) continue;
    const a = angelliraDrivers?.[norm];
    if (a && a.availability === "OK" && a.found === false) clears.add(norm);
  }
  return { upserts, clears: [...clears] };
}

// "Consultar item": grava motorista (FOUND/NOT_FOUND) e VEÍCULOS ao vivo. Espelha em
// driver_profiles (motorista REGISTRADO) e no cache `vehicles`. Best-effort — não lança.
async function persistForceLiveResults(driverByName, cpfsToFetch, angelliraDrivers, angelliraVehicles, correlationId) {
  try {
    const { upserts, clears } = planForceLiveDriverWrites(driverByName, cpfsToFetch, angelliraDrivers);
    const pool = getPostgresPool();
    await upsertDriverHistoricoRows(pool, upserts);
    for (const cpf of clears) {
      await pool.query(
        `UPDATE public.motoristas_historico
            SET angellira_query_id = NULL, angellira_limit_date = NULL, updated_at = now()
          WHERE cpf = $1`,
        [cpf],
      );
    }

    try {
      const { syncDriverAngelliraValidation, syncVehicleAngelliraLookup } = await import("./use-cases/angellira-cache.js");
      for (const r of upserts) {
        const res = angelliraDrivers?.[r.cpf];
        if (res && res.availability === "OK") {
          await syncDriverAngelliraValidation({ documentNumber: r.cpf, angelliraResult: res, correlationId });
        }
      }
      for (const plate of Object.keys(angelliraVehicles || {})) {
        const res = angelliraVehicles[plate];
        if (res && res.availability === "OK") {
          await syncVehicleAngelliraLookup({ plate, vehicleType: res.vehicleDetails?.type ?? null, angelliraResult: res, correlationId });
        }
      }
    } catch {
      /* espelho em driver_profiles/vehicles é bônus — motoristas_historico já gravou */
    }

    logStructuredEvent("info", "sheet-monitor-enrich.force-live-persist", {
      correlationId,
      drivers: upserts.length,
      cleared: clears.length,
    });
  } catch (err) {
    logStructuredEvent("warn", "sheet-monitor-enrich.force-live-persist-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Núcleo: resolve ASPX/Angellira (com cache) p/ um conjunto de linhas e faz
 * upsert em sheet_monitor_enriched (onConflict lh). Linhas da planilha e do
 * sistema usam o mesmo pipeline.
 *
 * forceLive=true ("Consultar item"): ignora TODO cache (motoristas_historico,
 * driver_profiles, vehicles) e RECONSULTA o Angellira AO VIVO para o motorista e
 * as placas da linha, persistindo o resultado (motoristas_historico/driver_profiles/
 * vehicles). É o "atualizar agora" sob demanda do operador. Default false — o fluxo
 * periódico e os hooks pós-alocação continuam usando cache (leves).
 */
async function enrichRows(supabaseClient, batch, correlationId, { forceLive = false } = {}) {
  if (!Array.isArray(batch) || batch.length === 0) return 0;

  // BANCO DE MOTORISTA (motoristas_historico) — fonte PRIMÁRIA: tem CPF, ASPX já
  // verificado por CPF (aspx_found) e Angellira já consultada (limit_date). Pagina
  // (>1000). Indexado por nome (acento/mojibake-tolerante).
  const mhRows = [];
  try {
    let from = 0;
    for (;;) {
      const { data } = await supabaseClient
        .from("motoristas_historico")
        .select("cpf, nome, aspx_found, aspx_display_name, angellira_query_id, angellira_limit_date")
        .not("nome", "is", null)
        .range(from, from + 999);
      const b = data || [];
      mhRows.push(...b);
      if (b.length < 1000) break;
      from += 1000;
    }
  } catch {
    /* banco de motorista indisponível — cai no fallback aspx_drivers */
  }
  const mhByCpf = Object.fromEntries(mhRows.map((r) => [r.cpf, r]));
  const mhIndex = indexAspxList(mhRows.map((r) => ({ cpf: r.cpf, display_name: r.nome })));

  // ASPX drivers (diretório) — FALLBACK p/ quem não está no banco de motorista.
  // Pagina: o diretório passa de 1000 linhas (cap do PostgREST) — sem paginar, o
  // fallback enxergaria só os 1000 mais recentes e perderia matches de ASPX.
  const aspxRows = await selectAllPaginated(
    (from, to) =>
      supabaseClient.from("aspx_drivers").select("cpf, display_name").order("last_seen_at", { ascending: false }).range(from, to),
    { label: "aspx_drivers", correlationId, partialOnError: true },
  );
  const aspxList = indexAspxList(aspxRows || []);

  // Plates from vehicles cache
  const uniquePlates = [
    ...new Set(batch.flatMap((r) => [normalizePlate(r.cavalo), normalizePlate(r.carreta)]).filter(Boolean)),
  ];
  // forceLive: ignora o cache de veículos → todas as placas vão p/ consulta ao vivo.
  const { data: dbVehicles } = (!forceLive && uniquePlates.length > 0)
    ? await supabaseClient
        .from("vehicles")
        .select("plate, vehicle_type, plate_role, angellira_status, angellira_valid_until, angellira_status_text, angellira_display_name, angellira_details")
        .in("plate", uniquePlates)
    : { data: [] };
  const vehiclesByPlate = Object.fromEntries((dbVehicles || []).map((v) => [v.plate, v]));

  // Resolve cada motorista: BANCO (motoristas_historico) primeiro — traz CPF +
  // ASPX (aspx_found) + Angellira (limit_date) já prontos, SEM chamar API. Quem
  // não está no banco cai no aspx_drivers (presença + CPF → Angellira via API).
  const driverByName = {};
  const aspxFallbackCpfs = [];
  for (const row of batch) {
    const name = (row.motoristas || "").trim();
    if (!name || driverByName[name]) continue;
    const mh = matchAspxDriver(name, mhIndex);
    if (mh) {
      const r = mhByCpf[mh.cpf];
      if (forceLive && r?.cpf) {
        // "Consultar item": ignora o valor salvo e RECONSULTA ao vivo. Resolve só
        // CPF/ASPX pela tabela; a Angellira vem do fetch (e é persistida depois).
        driverByName[name] = {
          cpf: r.cpf,
          aspxFound: r?.aspx_found === true,
          aspxDisplayName: r?.aspx_display_name ?? null,
          angellira: null,
        };
        aspxFallbackCpfs.push(r.cpf);
        continue;
      }
      driverByName[name] = {
        cpf: r?.cpf ?? null,
        aspxFound: r?.aspx_found === true,
        aspxDisplayName: r?.aspx_display_name ?? null,
        angellira: {
          found: r?.angellira_query_id != null,
          status: r?.angellira_query_id != null ? "FOUND" : null,
          validUntil: r?.angellira_limit_date ?? null,
          statusText: null,
          // Carrega nome + CPF confirmados no Angellira (não só o do ASPX): assim o
          // CPF fica sempre disponível p/ re-consultar/exibir, mesmo quando o
          // motorista NÃO está no ASPX (aspx_cpf fica null nesse caso).
          details:
            r?.angellira_query_id != null
              ? { name: r?.nome ?? null, cpf: r?.cpf ?? null, source: "motoristas_historico" }
              : null,
        },
      };
      continue;
    }
    const aspx = matchAspxDriver(name, aspxList);
    if (aspx) {
      // FALLBACK: quem não está no banco de motorista cai no aspx_drivers. O match
      // agora é ESTRITO (driverNamesMatch) → resolve a pessoa CERTA do ASPX (ou
      // ninguém), então é seguro alimentar a consulta Angellira ao vivo pelo CPF do
      // ASPX. Quem não casar em lugar nenhum → "não consultado" → consulta manual
      // por CPF no modal (que persiste na base p/ virar automático).
      driverByName[name] = { cpf: aspx.cpf, aspxFound: true, aspxDisplayName: aspx.display_name, angellira: null };
      if (aspx.cpf) aspxFallbackCpfs.push(aspx.cpf);
    }
  }

  const uniqueCpfs = [...new Set(aspxFallbackCpfs)];

  // Driver cache (driver_profiles) — pula Angellira p/ CPF já validado.
  // forceLive: ignora o cache → todos os CPFs vão p/ consulta ao vivo.
  const driverCacheByNormalizedCpf = {};
  if (uniqueCpfs.length > 0 && !forceLive) {
    try {
      const pool = getPostgresPool();
      const { rows: cachedDriverRows } = await pool.query(
        `SELECT REPLACE(REPLACE(document_number, '.', ''), '-', '') AS cpf_norm,
                angellira_status, angellira_valid_until, angellira_status_text
         FROM public.driver_profiles
         WHERE angellira_checked_at IS NOT NULL
           AND REPLACE(REPLACE(document_number, '.', ''), '-', '') = ANY($1)`,
        [uniqueCpfs],
      );
      for (const r of cachedDriverRows) {
        driverCacheByNormalizedCpf[r.cpf_norm] = {
          found: r.angellira_status === "FOUND",
          status: r.angellira_status ?? null,
          validUntil: r.angellira_valid_until ?? null,
          statusText: r.angellira_status_text ?? null,
        };
      }
    } catch {
      // cache miss — segue com chamadas Angellira
    }
  }

  const cpfsToFetch = uniqueCpfs.filter((c) => !driverCacheByNormalizedCpf[c]);
  const platesToFetch = uniquePlates.filter((p) => !vehiclesByPlate[p]);

  const { lookupAngelliraDriverByCpf, lookupAngelliraPlate } =
    await import("../../infrastructure/angellira/angellira-client.js");

  const angelliraDrivers = { ...driverCacheByNormalizedCpf };
  const angelliraVehicles = {};

  const tasks = [
    ...cpfsToFetch.map((cpf) => async () => {
      try {
        angelliraDrivers[cpf] = await withTimeout(lookupAngelliraDriverByCpf(cpf, { correlationId }), CALL_TIMEOUT_MS);
      } catch {
        angelliraDrivers[cpf] = { found: false, status: "UNAVAILABLE", statusText: null, validUntil: null };
        logStructuredEvent("warn", "sheet-monitor-enrich.driver-timeout", { correlationId, cpf });
      }
    }),
    ...platesToFetch.map((plate) => async () => {
      try {
        const res = await withTimeout(lookupAngelliraPlate(plate, { correlationId }), CALL_TIMEOUT_MS);
        angelliraVehicles[plate] = { ...res, _source: "angellira" };
      } catch {
        angelliraVehicles[plate] = { found: false, status: "UNAVAILABLE", _source: "not_found" };
        logStructuredEvent("warn", "sheet-monitor-enrich.plate-timeout", { correlationId, plate });
      }
    }),
  ];

  await runConcurrent(tasks, CONCURRENCY);

  // Preenche a Angellira dos motoristas resolvidos pelo FALLBACK aspx_drivers
  // (os do banco de motorista já vieram com Angellira da própria tabela).
  for (const name of Object.keys(driverByName)) {
    const d = driverByName[name];
    if (d.angellira === null && d.cpf) {
      const a = angelliraDrivers[d.cpf];
      d.angellira = a
        ? { found: a.found, status: a.status, validUntil: a.validUntil, statusText: a.statusText, details: a.driverDetails ?? null }
        : null;
    }
  }

  // Persiste os resultados da consulta ao vivo (best-effort, não bloqueia o selo):
  //  - normal: só motoristas FOUND buscados agora (fallback ASPX) → registro durável,
  //    a próxima passada resolve pela tabela e não re-consulta (mata a oscilação).
  //  - forceLive ("Consultar item"): grava motorista (FOUND=fresco, NOT_FOUND=zera) e
  //    também persiste os VEÍCULOS no cache `vehicles`.
  if (forceLive) {
    await persistForceLiveResults(driverByName, cpfsToFetch, angelliraDrivers, angelliraVehicles, correlationId);
  } else {
    await persistFetchedDriversToHistorico(driverByName, cpfsToFetch, angelliraDrivers, correlationId);
  }

  const ctx = { driverByName, vehiclesByPlate, angelliraVehicles };
  const upsertRows = batch.map((row) => buildEnrichedUpsertRow(row, ctx));

  // NÃO PERDER DADO BOM: se a nova consulta falhou (UNAVAILABLE) ou não achou
  // (Angellira/ASPX fora, timeout, tabela ASPX incompleta), preserva o dado
  // válido que já existia — só atualiza enriched_at. Evita o selo verde virar
  // vermelho/cinza por falha transitória.
  let existingByLh = {};
  try {
    const lhs = upsertRows.map((r) => r.lh);
    if (lhs.length > 0) {
      const { data: prevRows } = await supabaseClient
        .from("sheet_monitor_enriched")
        .select("*")
        .in("lh", lhs);
      for (const r of prevRows || []) existingByLh[r.lh] = r;
    }
  } catch {
    existingByLh = {};
  }
  const finalRows = upsertRows.map((r) => mergePreservingGood(r, existingByLh[r.lh]));

  const { error: upsertError } = await supabaseClient
    .from("sheet_monitor_enriched")
    .upsert(finalRows, { onConflict: "lh" });

  if (upsertError) {
    logStructuredEvent("error", "sheet-monitor-enrich.upsert-error", { correlationId, message: upsertError.message });
  } else {
    // Selos mudaram → invalida o cache p/ o próximo refetch trazer os novos.
    bustSheetMonitorEnrichedCache();
  }
  return batch.length;
}

// Cargas do sistema (sheet_lh nulo) projetadas no shape do pipeline de enrich.
async function loadSystemEnrichCandidates(supabaseClient) {
  try {
    const sys = await listSystemCargasForMonitor(supabaseClient);
    return sys
      .filter((c) => c.cargoId)
      .map((c) => ({
        lh: `cargo:${c.cargoId}`,
        cargoId: c.cargoId,
        motoristas: c.motoristas || "",
        cavalo: c.cavalo || "",
        carreta: c.carreta || "",
      }));
  } catch {
    return [];
  }
}

// Conjunto de `lh` já enriquecidos (opcionalmente com enriched_at >= sinceIso).
// PostgREST capa a resposta em 1000 linhas (.limit clampado em silêncio) — paginar
// com .range, senão o filtro de stale enxerga só 1000 e re-processa o resto à toa.
export async function fetchEnrichedLhSet(supabaseClient, { sinceIso = null, correlationId = null } = {}) {
  // best-effort: se uma página falhar (após 1 retry), loga e devolve o que leu —
  // sub-contar aqui só causa re-processamento (inofensivo: mergePreservingGood
  // protege contra downgrade), nunca corrompe dado.
  const rows = await selectAllPaginated(
    (from, to) => {
      let query = supabaseClient.from("sheet_monitor_enriched").select("lh, enriched_at");
      if (sinceIso) query = query.gte("enriched_at", sinceIso);
      return query.order("lh", { ascending: true }).range(from, to);
    },
    { label: "sheet_monitor_enriched.lh", correlationId, partialOnError: true },
  );
  const set = new Set();
  for (const r of rows) if (r.lh) set.add(r.lh);
  return set;
}

// Candidatos do Monitor: planilha (snapshot dedup por lh) ∪ cargas do sistema.
async function loadMonitorEnrichCandidates(supabaseClient, correlationId = null) {
  let rawRows = [];
  try {
    const { data: snapshot } = await supabaseClient
      .from("sheet_monitor_snapshot")
      .select("rows_json")
      .eq("id", 1)
      .single();
    rawRows = Array.isArray(snapshot?.rows_json) ? snapshot.rows_json : [];
  } catch (err) {
    // sem snapshot da planilha — segue só com as cargas do sistema, mas loga p/
    // distinguir "planilha quebrada" de "nada a fazer".
    logStructuredEvent("warn", "sheet-monitor-enrich.snapshot-read-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  let sheetRows = [...new Map(rawRows.filter((r) => r.lh).map((r) => [r.lh, r])).values()];

  // Overlay da ALOCAÇÃO efetiva (alloc_* ?? planilha): o operador pode ter
  // reatribuído/reordenado a fila (cargas.alloc_*). Enriquecemos o motorista/placa
  // EFETIVO — senão, após reordenar, o selo fica "não consultado" porque o
  // enriquecimento era do motorista antigo da planilha. "" (vazio explícito) vence.
  try {
    const allocRows = await selectAllPaginated(
      (from, to) =>
        supabaseClient
          .from("cargas")
          .select("sheet_lh, alloc_motorista, alloc_cavalo, alloc_carreta")
          .not("sheet_lh", "is", null)
          .not("alloc_updated_at", "is", null)
          .order("sheet_lh", { ascending: true })
          .range(from, to),
      { label: "cargas_alloc_enrich", correlationId, partialOnError: true },
    );
    if (allocRows.length > 0) {
      const allocByLh = Object.fromEntries(allocRows.map((r) => [r.sheet_lh, r]));
      sheetRows = sheetRows.map((r) => {
        const a = allocByLh[r.lh];
        if (!a) return r;
        return {
          ...r,
          motoristas: a.alloc_motorista ?? r.motoristas,
          cavalo: a.alloc_cavalo ?? r.cavalo,
          carreta: a.alloc_carreta ?? r.carreta,
        };
      });
    }
  } catch {
    /* overlay best-effort — sem alloc, enriquece a planilha pura */
  }

  const systemRows = await loadSystemEnrichCandidates(supabaseClient);
  return [...sheetRows, ...systemRows];
}

/**
 * Enriquece linhas ESPECÍFICAS da planilha por lh, com a alocação EFETIVA
 * (alloc_* ?? planilha). Fire-and-forget pós-alocação/reordenação: o selo passa a
 * refletir o motorista/placa que o operador acabou de pôr, em vez de ficar "não
 * consultado" (que era o motorista antigo da planilha / linha vazia). Não lança.
 */
export async function enrichSheetRowsByLh(supabaseClient, lhs, { correlationId = null, forceLive = false } = {}) {
  const wanted = [...new Set((lhs || []).map((s) => (s ?? "").toString().trim()).filter(Boolean))];
  if (wanted.length === 0) return;
  try {
    let rawRows = [];
    try {
      const { data: snapshot } = await supabaseClient
        .from("sheet_monitor_snapshot")
        .select("rows_json")
        .eq("id", 1)
        .single();
      rawRows = Array.isArray(snapshot?.rows_json) ? snapshot.rows_json : [];
    } catch {
      /* sem snapshot — segue só com a alocação */
    }
    const baseByLh = new Map(rawRows.filter((r) => r.lh).map((r) => [r.lh, r]));

    // Fonte da verdade do motorista/veículo = tabela `cargas` (efetivo =
    // alloc_* ?? sheet_*). O snapshot é só o fallback: cargas IMPORTADAS via CSV
    // têm sheet_lh mas NÃO entram no sheet_monitor_snapshot (que só reflete o sync
    // da planilha online), então consultá-las pelo snapshot enriquecia uma linha
    // VAZIA (selo continuava "Consulta pendente"). Ler de `cargas` cobre todas.
    const { data: allocRows } = await supabaseClient
      .from("cargas")
      .select("sheet_lh, alloc_motorista, alloc_cavalo, alloc_carreta, sheet_motorista, sheet_cavalo, sheet_carreta")
      .in("sheet_lh", wanted);
    const allocByLh = Object.fromEntries((allocRows || []).map((r) => [r.sheet_lh, r]));

    const rows = wanted.map((lh) => {
      const base = baseByLh.get(lh) || {};
      const a = allocByLh[lh];
      // "" (vazio explícito do operador) vence via ??: se o operador limpou o
      // motorista (alloc_motorista === ""), não caímos no sheet_motorista.
      return {
        lh,
        cargoId: null,
        motoristas: (a?.alloc_motorista ?? a?.sheet_motorista ?? base.motoristas ?? "") || "",
        cavalo: (a?.alloc_cavalo ?? a?.sheet_cavalo ?? base.cavalo ?? "") || "",
        carreta: (a?.alloc_carreta ?? a?.sheet_carreta ?? base.carreta ?? "") || "",
      };
    });
    await enrichRows(supabaseClient, rows, correlationId, { forceLive });
  } catch (err) {
    logStructuredEvent("warn", "sheet-monitor-enrich.by-lh-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// DC-230: enriquece UMA carga da planilha com o motorista/veículo EFETIVO
// FORNECIDO pelo cliente (exatamente o que o operador vê na tela). Independe do
// snapshot e da fonte da planilha (Shopee/Nestlé/importada): cargas fora do
// sheet_monitor_snapshot (ex.: Nestlé, cujo lh é namespaced) não eram achadas
// por enrichSheetRowsByLh e enriqueciam uma linha vazia. Aqui o selo é gravado
// com os valores passados, chaveado por `lh`. Não lança.
export async function enrichSheetRowByLhWithValues(
  supabaseClient,
  { lh, motorista = "", cavalo = "", carreta = "" },
  { correlationId = null, forceLive = false } = {},
) {
  const l = (lh ?? "").toString().trim();
  if (!l) return;
  try {
    await enrichRows(
      supabaseClient,
      [{
        lh: l,
        cargoId: null,
        motoristas: (motorista ?? "").toString().trim(),
        cavalo: (cavalo ?? "").toString().trim(),
        carreta: (carreta ?? "").toString().trim(),
      }],
      correlationId,
      { forceLive },
    );
  } catch (err) {
    logStructuredEvent("warn", "sheet-monitor-enrich.by-lh-values-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// Filtra os candidatos para os que realmente precisam (re)consultar:
//  - force + forceSessionStart: tudo que ainda NÃO foi processado nesta sessão
//    (dedup por enriched_at >= início — usado pelo loop incremental do endpoint)
//  - force sem sessão: tudo (re-consulta total — usado pelo backfill server-side)
//  - onlyMissing: só quem NÃO tem registro de enriquecimento (consulta-1-vez)
//  - default: pendentes + stale (> STALE_HOURS)
export async function filterRowsToProcess(supabaseClient, candidates, { force = false, forceSessionStart = null, onlyMissing = false, correlationId = null } = {}) {
  if (force && forceSessionStart) {
    const doneSet = await fetchEnrichedLhSet(supabaseClient, { sinceIso: forceSessionStart, correlationId });
    return candidates.filter((r) => !doneSet.has(r.lh));
  }
  if (force) return candidates;
  if (onlyMissing) {
    const existing = await fetchEnrichedLhSet(supabaseClient, { correlationId });
    return candidates.filter((r) => !existing.has(r.lh));
  }
  const staleTs = new Date(Date.now() - STALE_HOURS * 3_600_000).toISOString();
  const freshSet = await fetchEnrichedLhSet(supabaseClient, { sinceIso: staleTs, correlationId });
  return candidates.filter((r) => !freshSet.has(r.lh));
}

/**
 * Enriquece um lote de linhas do Monitor (planilha + cargas do sistema) com
 * Angellira + ASPX. Só re-processa o que está pendente/stale (> STALE_HOURS),
 * salvo force=true. Cargas do sistema entram pelo cargo_id (lh = 'cargo:<id>').
 */
export async function enrichSheetMonitorRows(supabaseClient, correlationId, { force = false, forceSessionStart = null } = {}) {
  const candidates = await loadMonitorEnrichCandidates(supabaseClient, correlationId);
  if (candidates.length === 0) return { enriched: 0, remaining: 0 };

  const rowsToProcess = await filterRowsToProcess(supabaseClient, candidates, { force, forceSessionStart, correlationId });

  const batch = rowsToProcess.slice(0, BATCH_SIZE);
  const remaining = rowsToProcess.length - batch.length;
  if (batch.length === 0) return { enriched: 0, remaining: 0 };

  await enrichRows(supabaseClient, batch, correlationId);
  return { enriched: batch.length, remaining };
}

/**
 * Enriquece TODAS as linhas pendentes do Monitor de uma vez, no BACKEND (loop
 * server-side em chunks de batchSize). Não depende do frontend ficar aberto —
 * usado pelo script de backfill (force) e pelo hook do refresh (onlyMissing).
 *  - force=true     → re-consulta tudo (refaz todos os selos)
 *  - onlyMissing    → só o que nunca foi consultado (barato; linhas novas)
 *  - default        → pendentes + stale (> STALE_HOURS)
 */
export async function enrichAllPendingMonitorRows(
  supabaseClient,
  correlationId,
  { force = false, onlyMissing = false, batchSize = 200, maxRows = 100_000, onProgress = null } = {},
) {
  const candidates = await loadMonitorEnrichCandidates(supabaseClient, correlationId);
  if (candidates.length === 0) return { enriched: 0, batches: 0, candidates: 0, pending: 0 };

  const allPending = await filterRowsToProcess(supabaseClient, candidates, { force, onlyMissing, correlationId });
  if (allPending.length > maxRows) {
    logStructuredEvent("warn", "sheet-monitor-enrich.max-rows-capped", {
      correlationId,
      candidates: candidates.length,
      pending: allPending.length,
      maxRows,
    });
  }
  const rowsToProcess = allPending.slice(0, maxRows);

  let enriched = 0;
  let batches = 0;
  for (let i = 0; i < rowsToProcess.length; i += batchSize) {
    const chunk = rowsToProcess.slice(i, i + batchSize);
    await enrichRows(supabaseClient, chunk, correlationId);
    enriched += chunk.length;
    batches += 1;
    if (onProgress) onProgress({ enriched, total: rowsToProcess.length, batches });
  }
  return { enriched, batches, candidates: candidates.length, pending: rowsToProcess.length };
}

/**
 * Enriquece UMA carga do sistema por id (fire-and-forget pós-insert/update).
 * Sempre faz upsert — mesmo sem motorista/placa grava a linha esqueleto, p/ o
 * selo nunca ficar "não consultado". Best-effort: NÃO lança.
 */
export async function enrichSystemCargoById(supabaseClient, cargoId, { correlationId = null, forceLive = false } = {}) {
  if (!cargoId) return;
  try {
    const { data } = await supabaseClient
      .from("cargas")
      .select("id, alloc_motorista, alloc_cavalo, alloc_carreta")
      .eq("id", cargoId)
      .maybeSingle();
    if (!data) return;
    const row = {
      lh: `cargo:${cargoId}`,
      cargoId,
      motoristas: (data.alloc_motorista || "").trim(),
      cavalo: data.alloc_cavalo || "",
      carreta: data.alloc_carreta || "",
    };
    await enrichRows(supabaseClient, [row], correlationId, { forceLive });
  } catch (err) {
    logStructuredEvent("warn", "sheet-monitor-enrich.system-cargo-failed", {
      correlationId,
      cargoId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// Campos do motorista a gravar na linha enriquecida a partir de uma consulta por
// CPF (puro/testável). `source: 'manual'` marca que o CPF foi informado pelo
// operador (não resolvido por nome).
export function buildDriverCpfFields(cpf, motorista, result) {
  const norm = String(cpf || "").replace(/\D/g, "");
  const angName = result?.driverDetails?.name || result?.displayName || null;
  return {
    driver_name: ((motorista || angName || "").toString().trim()) || null,
    angellira_driver_found: result?.found ?? false,
    angellira_driver_status: result?.status ?? null,
    angellira_driver_valid_until: result?.validUntil ?? null,
    angellira_driver_status_text: result?.statusText ?? null,
    angellira_driver_details: { name: angName, cpf: norm, source: "manual" },
  };
}

/**
 * Consulta MANUAL por CPF de UM item do Monitor. Usado quando o motorista NÃO está
 * na base do Angellira (motoristas_historico) e o auto não conseguiu resolver: o
 * operador informa o CPF e consultamos o Angellira AO VIVO por ele. Grava só as
 * colunas do motorista na linha (preserva veículos) e PERSISTE na base
 * (motoristas_historico + driver_profiles) p/ virar automático na próxima passada.
 * Não lança — devolve { ok, found, name, cpf, status, statusText, validUntil } ou
 * { ok:false, reason }.
 */
export async function enrichItemDriverByCpf(supabaseClient, { lh, cargoId, cpf, motorista = "" }, { correlationId = null } = {}) {
  const norm = String(cpf || "").replace(/\D/g, "");
  const key = cargoId ? `cargo:${cargoId}` : (lh ?? "").toString().trim();
  if (!key || norm.length !== 11) return { ok: false, reason: "INVALID_INPUT" };
  try {
    const { lookupAngelliraDriverByCpf } = await import("../../infrastructure/angellira/angellira-client.js");
    let result;
    try {
      result = await withTimeout(lookupAngelliraDriverByCpf(norm, { correlationId }), CALL_TIMEOUT_MS);
    } catch {
      result = { availability: "UNAVAILABLE", status: "UNAVAILABLE", found: false };
    }
    if (!result || result.availability !== "OK") {
      return { ok: false, reason: "ANGELLIRA_UNAVAILABLE" };
    }

    const driverFields = { ...buildDriverCpfFields(norm, motorista, result), enriched_at: new Date().toISOString() };

    // UPDATE só as colunas do motorista (preserva veículos/selos). Se a linha ainda
    // não existe (carga fora do snapshot), cria a mínima.
    const { data: updated } = await supabaseClient
      .from("sheet_monitor_enriched")
      .update(driverFields)
      .eq("lh", key)
      .select("lh");
    if (!updated || updated.length === 0) {
      await supabaseClient
        .from("sheet_monitor_enriched")
        .upsert([{ lh: key, cargo_id: cargoId ?? null, ...driverFields }], { onConflict: "lh" });
    }
    bustSheetMonitorEnrichedCache();

    // Persiste na base do Angellira p/ a próxima consulta ser AUTOMÁTICA (só FOUND).
    try {
      if (result.found === true) {
        const angName = result.driverDetails?.name || result.displayName || null;
        await upsertDriverHistoricoRows(getPostgresPool(), [{
          cpf: norm,
          nome: (angName || motorista || "").toString().trim(),
          angelliraQueryId: result.queryId ?? null,
          angelliraSentDate: result.lastSeenAt ?? null,
          angelliraLimitDate: result.validUntil ?? null,
          aspxFound: false,
          aspxDisplayName: null,
        }]);
      }
      const { syncDriverAngelliraValidation } = await import("./use-cases/angellira-cache.js");
      await syncDriverAngelliraValidation({ documentNumber: norm, angelliraResult: result, correlationId });
    } catch {
      /* persistência é bônus — a linha do item já foi gravada */
    }

    logStructuredEvent("info", "sheet-monitor-enrich.driver-by-cpf", {
      correlationId, lh: key, found: result.found === true, cpf: `***${norm.slice(-3)}`,
    });
    return {
      ok: true,
      found: result.found === true,
      name: result.driverDetails?.name || result.displayName || null,
      cpf: norm,
      status: result.status ?? null,
      statusText: result.statusText ?? null,
      validUntil: result.validUntil ?? null,
    };
  } catch (err) {
    logStructuredEvent("warn", "sheet-monitor-enrich.driver-by-cpf-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "ERROR" };
  }
}
