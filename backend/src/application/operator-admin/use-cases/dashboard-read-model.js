import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { lastDriverVisibleWriteAt } from "./driver-loads-freshness.js";
import { parseOperatorDashboardQuery } from "../../../domain/operator-admin/schemas.js";
import { buildPaginationMeta, parseNullableNumber } from "../../../domain/operator-admin/route-utils.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";
import {
  isMissingOptionalCargoReadModelColumnsError,
  buildDriverLoadFilters,
  queryDriverLoadCandidateRows,
  fetchRouteCatalogMetricsByLoadId,
  buildRouteLabelMap,
  buildDriverLoadPublicationState,
  mapDriverLoadReadModelItem,
  normalizeOptionalText,
  isMissingAspxMissingColumnError,
  isMissingAgendaAConfirmarColumnError,
  isMissingDriverVisibilityColumnError,
  isMissingPacoteColumnsError,
  isMissingBonusRequirementsColumnError,
  isMissingEixosColumnError,
} from "./_shared.js";

export async function fetchOperatorDashboardReadModel({ query, correlationId }) {
  const { page, pageSize, offset, maxPageSize, search, status, driverVisibility, clienteId, onlyOpenToDrivers } = parseOperatorDashboardQuery(query);

  // Tela de Links: "aberta para o motorista" == o que o portal lista. "Agora" no
  // fuso de Sao Paulo (container roda em UTC; data/horario sao BRT) p/ o corte de
  // expiracao — mesmo criterio dos facets do driver read model.
  const { dateIso: todayIso, timeIso: nowTimeIso } = onlyOpenToDrivers
    ? getSaoPauloWallClock()
    : { dateIso: null, timeIso: null };

  const buildDashboardFilterContext = ({ supportsOptionalColumns }) => {
    const values = [];
    const clauses = [];
    let index = 1;

    if (search) {
      values.push(`%${search}%`);
      clauses.push(`(
        cargas.id::text ILIKE $${index} OR cargas.origem ILIKE $${index} OR
        cargas.destino ILIKE $${index} OR cargas.perfil ILIKE $${index} OR
        cargas.status ILIKE $${index} OR COALESCE(clientes.nome, '') ILIKE $${index} OR
        COALESCE(clientes.descricao, '') ILIKE $${index}
      )`);
      index += 1;
    }

    if (onlyOpenToDrivers) {
      // Espelha o portal do motorista: OPEN + nao-template + visibilidade publica
      // + nao alocada (planilha) + nao expirada. Ignora status/driverVisibility.
      clauses.push("cargas.status = 'OPEN'");
      clauses.push("COALESCE(cargas.is_template, false) = false");
      if (supportsOptionalColumns) {
        clauses.push("COALESCE(cargas.driver_visibility, 'PUBLIC') = 'PUBLIC'");
      }
      clauses.push("COALESCE(cargas.alloc_motorista, cargas.sheet_motorista, '') = ''");
      values.push(todayIso);
      const todayGtIndex = index;
      index += 1;
      values.push(todayIso);
      const todayEqIndex = index;
      index += 1;
      values.push(nowTimeIso);
      const nowTimeIndex = index;
      index += 1;
      // DC-271: cargas lançadas/manuais expiram no carregamento como as da
      // planilha (removida a exceção "visível o dia todo"), igual ao portal.
      // Exceção "A confirmar" (agenda indefinida = placeholder hoje/00:00 + flag):
      // fica fora do corte, igual ao buildDriverLoadFilters — senão esta tela
      // divergiria do que o motorista realmente vê. Coluna ausente (banco legado)
      // → cai no fallback sem a exceção junto com as demais colunas opcionais.
      const excecaoAConfirmar = supportsOptionalColumns
        ? " OR COALESCE(cargas.agenda_a_confirmar, false) = true"
        : "";
      clauses.push(
        `(cargas.data IS NULL OR cargas.data > $${todayGtIndex} OR (cargas.data = $${todayEqIndex} AND (cargas.horario IS NULL OR cargas.horario >= $${nowTimeIndex}))${excecaoAConfirmar})`,
      );
    } else {
      if (status && status !== "todos") {
        if (status === "templates") {
          clauses.push("COALESCE(cargas.is_template, false) = true");
        } else {
          values.push(status);
          clauses.push(`cargas.status = $${index}`);
          index += 1;
        }
      }

      if (driverVisibility && driverVisibility !== "todos") {
        if (supportsOptionalColumns) {
          values.push(driverVisibility);
          clauses.push(`COALESCE(cargas.driver_visibility, 'PUBLIC') = $${index}`);
          index += 1;
        } else if (driverVisibility === "PREMIUM") {
          clauses.push("1 = 0");
        }
      }
    }

    if (clienteId) {
      values.push(clienteId);
      clauses.push(`cargas.cliente_id = $${index}::uuid`);
      index += 1;
    }

    return { values, whereSql: clauses.length ? clauses.join(" AND ") : "true", limitIndex: index, offsetIndex: index + 1 };
  };

  return withPgClient(async (client) => {
    let filterContext = buildDashboardFilterContext({ supportsOptionalColumns: true });
    let itemRows;

    const fullSelectSql = (whereSql) => `
      SELECT
        cargas.id, cargas.data, cargas.horario, cargas.origem, cargas.destino,
        cargas.distancia_km, cargas.duracao_horas, cargas.perfil, cargas.valor, cargas.bonus,
        COALESCE(cargas.driver_visibility, 'PUBLIC') AS driver_visibility,
        cargas.status, cargas.is_template, cargas.sheet_lh,
        cargas.sheet_data_carregamento, cargas.sheet_data_descarga,
        clientes.id AS cliente_id, clientes.nome AS cliente_nome, clientes.descricao AS cliente_descricao,
        clientes.forma_pagamento AS cliente_forma_pagamento, clientes.prazo_pagamento AS cliente_prazo_pagamento,
        clientes.observacoes AS cliente_observacoes, clientes.exige_antt AS cliente_exige_antt,
        clientes.exige_carga_monitorada AS cliente_exige_carga_monitorada,
        clientes.exige_rastreamento AS cliente_exige_rastreamento, clientes.exige_seguro AS cliente_exige_seguro,
        clientes.reputacao_boa_comunicacao AS cliente_reputacao_boa_comunicacao,
        clientes.reputacao_bom_pagador AS cliente_reputacao_bom_pagador,
        clientes.reputacao_carga_organizada AS cliente_reputacao_carga_organizada,
        clientes.reputacao_liberacao_rapida AS cliente_reputacao_liberacao_rapida,
        clientes.reputacao_pagamento_rapido AS cliente_reputacao_pagamento_rapido
      FROM public.cargas
      LEFT JOIN public.clientes ON clientes.id = cargas.cliente_id
      WHERE ${whereSql}
      ORDER BY cargas.created_at DESC, cargas.id DESC
      LIMIT $${filterContext.limitIndex} OFFSET $${filterContext.offsetIndex}
    `;

    const fallbackSelectSql = (whereSql) => `
      SELECT
        cargas.id, cargas.data, cargas.horario, cargas.origem, cargas.destino,
        NULL::numeric AS distancia_km, NULL::numeric AS duracao_horas,
        cargas.perfil, cargas.valor, cargas.bonus,
        'PUBLIC'::text AS driver_visibility,
        cargas.status, cargas.is_template, cargas.sheet_lh,
        NULL::text AS sheet_data_carregamento, NULL::text AS sheet_data_descarga,
        clientes.id AS cliente_id, clientes.nome AS cliente_nome, clientes.descricao AS cliente_descricao,
        clientes.forma_pagamento AS cliente_forma_pagamento, clientes.prazo_pagamento AS cliente_prazo_pagamento,
        clientes.observacoes AS cliente_observacoes, clientes.exige_antt AS cliente_exige_antt,
        clientes.exige_carga_monitorada AS cliente_exige_carga_monitorada,
        clientes.exige_rastreamento AS cliente_exige_rastreamento, clientes.exige_seguro AS cliente_exige_seguro,
        clientes.reputacao_boa_comunicacao AS cliente_reputacao_boa_comunicacao,
        clientes.reputacao_bom_pagador AS cliente_reputacao_bom_pagador,
        clientes.reputacao_carga_organizada AS cliente_reputacao_carga_organizada,
        clientes.reputacao_liberacao_rapida AS cliente_reputacao_liberacao_rapida,
        clientes.reputacao_pagamento_rapido AS cliente_reputacao_pagamento_rapido
      FROM public.cargas
      LEFT JOIN public.clientes ON clientes.id = cargas.cliente_id
      WHERE ${whereSql}
      ORDER BY cargas.created_at DESC, cargas.id DESC
      LIMIT $${filterContext.limitIndex} OFFSET $${filterContext.offsetIndex}
    `;

    try {
      const result = await client.query(fullSelectSql(filterContext.whereSql), [...filterContext.values, pageSize, offset]);
      itemRows = result.rows;
    } catch (error) {
      if (!isMissingOptionalCargoReadModelColumnsError(error)) throw error;
      filterContext = buildDashboardFilterContext({ supportsOptionalColumns: false });
      const fallbackResult = await client.query(fallbackSelectSql(filterContext.whereSql), [...filterContext.values, pageSize, offset]);
      itemRows = fallbackResult.rows;
    }

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS total_count FROM public.cargas LEFT JOIN public.clientes ON clientes.id = cargas.cliente_id WHERE ${filterContext.whereSql}`,
      filterContext.values,
    );
    // active_count: cargas OPEN nao-template AINDA disponiveis na planilha.
    // O cross-check com sheet_motorista alinha o tile do dashboard com a
    // listagem "Ativas" (read-models.js), evitando contar cargas que a
    // planilha ja alocou mas o sync ainda nao flippou para BOOKED. Filtro
    // de sheet_status removido (era over-broad).
    const { rows: summaryRows } = await client.query(`
      SELECT
        COALESCE(SUM(CASE
          WHEN status = 'OPEN'
            AND NOT COALESCE(is_template, false)
            AND COALESCE(alloc_motorista, sheet_motorista, '') = ''
          THEN 1 ELSE 0 END), 0)::int AS active_count,
        COALESCE(SUM(CASE WHEN status = 'DRAFT' THEN 1 ELSE 0 END), 0)::int AS draft_count,
        COALESCE(SUM(CASE WHEN COALESCE(is_template, false) THEN 1 ELSE 0 END), 0)::int AS template_count
      FROM public.cargas
    `);

    return {
      statusCode: 200,
      payload: {
        items: itemRows.map((row) => ({
          id: row.id, data: row.data, horario: row.horario, origem: row.origem, destino: row.destino,
          distancia_km: parseNullableNumber(row.distancia_km), duracao_horas: parseNullableNumber(row.duracao_horas),
          perfil: row.perfil, valor: parseNullableNumber(row.valor), bonus: parseNullableNumber(row.bonus),
          driver_visibility: row.driver_visibility, status: row.status, is_template: row.is_template,
          sheet_lh: row.sheet_lh ?? null, sheet_data_carregamento: row.sheet_data_carregamento,
          sheet_data_descarga: row.sheet_data_descarga,
          cliente: row.cliente_id ? {
            id: row.cliente_id, nome: row.cliente_nome, descricao: row.cliente_descricao,
            forma_pagamento: row.cliente_forma_pagamento, prazo_pagamento: row.cliente_prazo_pagamento,
            observacoes: row.cliente_observacoes, exige_antt: row.cliente_exige_antt,
            exige_carga_monitorada: row.cliente_exige_carga_monitorada,
            exige_rastreamento: row.cliente_exige_rastreamento, exige_seguro: row.cliente_exige_seguro,
            reputacao_boa_comunicacao: row.cliente_reputacao_boa_comunicacao,
            reputacao_bom_pagador: row.cliente_reputacao_bom_pagador,
            reputacao_carga_organizada: row.cliente_reputacao_carga_organizada,
            reputacao_liberacao_rapida: row.cliente_reputacao_liberacao_rapida,
            reputacao_pagamento_rapido: row.cliente_reputacao_pagamento_rapido,
          } : null,
        })),
        summary: {
          activeCount: summaryRows[0]?.active_count || 0,
          draftCount: summaryRows[0]?.draft_count || 0,
          templateCount: summaryRows[0]?.template_count || 0,
        },
        meta: buildPaginationMeta(page, pageSize, countRows[0]?.total_count || 0, maxPageSize, correlationId),
      },
    };
  });
}

// ── Cache + single-flight do read model de cargas do MOTORISTA ───────────────
// A lista de cargas do portal é PÚBLICA e idêntica para todos os motoristas
// (sem filtro por usuário). Centenas de motoristas no polling da view padrão
// executavam a MESMA query pesada (todas as cargas OPEN + JOINs, paginada em
// memória) — maior consumidor de egress do pooler. O cache colapsa N polls
// concorrentes (mesmos filtros) em 1 query por janela de TTL; o single-flight
// garante que uma rajada concorrente compartilhe a query em andamento.
// Chave = combinação de filtros (a view padrão sem busca é a mais comum →
// hit rate altíssimo). TTL default 8s em produção; 0 em teste (VITEST) p/ não
// vazar estado entre casos. Staleness de 8s é aceitável numa lista de cargas.
let _driverLoadsInFlight = new Map();
let _driverLoadsCache = new Map();

function getDriverLoadsCacheTtlMs() {
  // Override EXPLÍCITO vence sempre — inclusive em teste. Antes o desligamento em
  // VITEST vinha primeiro, então o caminho com cache (e a invalidação por escrita logo
  // abaixo) era intestável: nenhum caso conseguia ligar o cache para exercitá-lo.
  const raw = Number.parseInt(process.env.DRIVER_LOADS_CACHE_TTL_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  // Sem override, segue desligado em teste (não vaza estado entre casos).
  if (process.env.VITEST || process.env.NODE_ENV === "test") return 0;
  return 8_000; // default produção
}

function driverLoadsCacheKey(query = {}) {
  // Normaliza só os campos que mudam o resultado. Ordena p/ estabilidade.
  // DC-270: filtros multiselect chegam como array (param repetido) OU string;
  // serializa ordenado p/ a chave ser estável independente da ordem de seleção.
  const q = query || {};
  const arrKey = (v) =>
    (Array.isArray(v) ? v : v == null || v === "" ? [] : [v])
      .map((x) => String(x).trim().toLowerCase())
      .sort()
      .join("|");
  return JSON.stringify({
    page: String(q.page ?? ""),
    pageSize: String(q.pageSize ?? ""),
    search: String(q.search ?? "").trim().toLowerCase(),
    status: String(q.status ?? "").trim().toLowerCase(),
    driverVisibility: String(q.driverVisibility ?? "").trim().toLowerCase(),
    clienteId: arrKey(q.clienteId),
    origem: arrKey(q.origem),
    destino: arrKey(q.destino),
    perfil: arrKey(q.perfil),
    dateFrom: String(q.dateFrom ?? "").trim(),
    dateTo: String(q.dateTo ?? "").trim(),
  });
}

export async function fetchDriverLoadsReadModel({ query, correlationId }) {
  const ttl = getDriverLoadsCacheTtlMs();
  if (ttl <= 0) {
    return fetchDriverLoadsReadModelUncached({ query, correlationId });
  }
  const key = driverLoadsCacheKey(query);
  const now = Date.now();

  const cached = _driverLoadsCache.get(key);
  // Além do TTL, a entrada precisa ser POSTERIOR à última escrita que muda o que o
  // motorista vê. Sem isso, o operador liberava a carga, o digest mudava, o portal
  // refazia a busca e recebia esta MESMA entrada pré-escrita — e como o digest não muda
  // de novo, nada disparava outro refetch. Ver driver-loads-freshness.js.
  if (cached && now - cached.at < ttl && cached.at > lastDriverVisibleWriteAt()) {
    return { statusCode: 200, payload: { ...cached.payload, meta: { ...cached.payload.meta, correlationId, cached: true } } };
  }

  const inFlight = _driverLoadsInFlight.get(key);
  if (inFlight) {
    const shared = await inFlight;
    return { statusCode: 200, payload: { ...shared, meta: { ...shared.meta, correlationId, cached: true } } };
  }

  const promise = (async () => {
    const result = await fetchDriverLoadsReadModelUncached({ query, correlationId });
    // Só cacheia 200 (erros/fallbacks de schema não devem grudar).
    if (result?.statusCode === 200 && result.payload) {
      _driverLoadsCache.set(key, { at: Date.now(), payload: result.payload });
      // Evita crescimento ilimitado de chaves (filtros variados).
      if (_driverLoadsCache.size > 200) {
        const oldest = [..._driverLoadsCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
        if (oldest) _driverLoadsCache.delete(oldest);
      }
    }
    return result.payload;
  })();
  _driverLoadsInFlight.set(key, promise);

  try {
    const payload = await promise;
    return { statusCode: 200, payload };
  } finally {
    _driverLoadsInFlight.delete(key);
  }
}

async function fetchDriverLoadsReadModelUncached({ query, correlationId }) {
  return withPgClient(async (client) => {
    // Phase 10: includePacoteVisibilityFilter ativa a clausula composta
    //  (avulsa PUBLIC) OR (pacote em status visivel) — necessario para nao filtrar
    // cargas PREMIUM dentro de pacote publicado.
    //
    // Fallback strategy:
    //  - DB nova (com cargas_casadas + viagem_id):           pacote-aware (JOIN + DISTINCT ON)
    //  - DB legada (sem cargas_casadas/viagem_id):            cai p/ comportamento pre-Phase 10
    //  - DB legada SEM driver_visibility:                     cai mais um nivel (legado-2)
    // Cada fallback regera o whereSql sem as clausulas que dependem das colunas ausentes,
    // garantindo que cc.status / cargas.viagem_id nunca apareca no SQL fallback.
    const buildFilters = (overrides = {}) =>
      buildDriverLoadFilters(query, {
        includeDriverVisibilityFilter: true,
        includePacoteVisibilityFilter: true,
        ...overrides,
      });

    let filterContext = buildFilters();
    let parsedQuery = filterContext.parsedQuery;
    let whereSql = filterContext.whereSql;
    let values = filterContext.values;
    let itemRows;
    let usePacoteJoin = true;

    const runQuery = async () =>
      queryDriverLoadCandidateRows(client, {
        whereSql,
        values,
        withPacoteJoin: usePacoteJoin,
      });

    try {
      itemRows = await runQuery();
    } catch (error) {
      if (isMissingPacoteColumnsError(error)) {
        // DB pre-Phase 10: desliga JOIN e remove filtro de pacote do WHERE.
        usePacoteJoin = false;
        filterContext = buildFilters({ includePacoteVisibilityFilter: false });
        parsedQuery = filterContext.parsedQuery;
        whereSql = filterContext.whereSql;
        values = filterContext.values;
        try {
          itemRows = await runQuery();
        } catch (retryError) {
          if (!isMissingDriverVisibilityColumnError(retryError)) throw retryError;
          filterContext = buildFilters({
            includeDriverVisibilityFilter: false,
            includePacoteVisibilityFilter: false,
          });
          parsedQuery = filterContext.parsedQuery;
          whereSql = filterContext.whereSql;
          values = filterContext.values;
          itemRows = await runQuery();
        }
      } else if (isMissingDriverVisibilityColumnError(error)) {
        filterContext = buildFilters({ includeDriverVisibilityFilter: false });
        parsedQuery = filterContext.parsedQuery;
        whereSql = filterContext.whereSql;
        values = filterContext.values;
        itemRows = await runQuery();
      } else if (isMissingAspxMissingColumnError(error)) {
        // Banco sem a coluna aspx_missing_since: serve o portal SEM essa guarda em
        // vez de devolver erro ao motorista (a carga fora do ASPX volta a aparecer,
        // que é o comportamento anterior à feature — degradação, não outage).
        filterContext = buildFilters({ includeAspxMissingFilter: false });
        parsedQuery = filterContext.parsedQuery;
        whereSql = filterContext.whereSql;
        values = filterContext.values;
        itemRows = await runQuery();
      } else if (isMissingAgendaAConfirmarColumnError(error)) {
        // Banco sem a coluna agenda_a_confirmar: aplica o corte de expiração a todas
        // as cargas (comportamento anterior à flag) em vez de derrubar o portal.
        filterContext = buildFilters({ includeAgendaAConfirmarException: false });
        parsedQuery = filterContext.parsedQuery;
        whereSql = filterContext.whereSql;
        values = filterContext.values;
        itemRows = await runQuery();
      } else {
        throw error;
      }
    }

    const routeCatalogMetricsByLoadId = await fetchRouteCatalogMetricsByLoadId(client, itemRows);
    const routeLabelByLoadId = buildRouteLabelMap(itemRows);
    const publishableRows = itemRows
      // Rota desativada no catálogo (ativa=false) NÃO é ofertada ao motorista:
      // "desativar a rota" passa a tirar a carga do ar. Carga sem rota casada
      // (metrics null) ou com rota ativa é mantida.
      .filter((row) => routeCatalogMetricsByLoadId.get(row.id)?.ativa !== false)
      .map((row) => buildDriverLoadPublicationState(row, routeCatalogMetricsByLoadId.get(row.id), routeLabelByLoadId.get(row.id)))
      .filter((entry) => entry.isReady)
      .map((entry) => entry.row);

    // Filtro de localização em memória. Casa o termo contra o RÓTULO da rota
    // resolvida (nome canônico — agrupa variações da mesma cidade) OU contra a
    // origem/destino CRUA da carga. Sem o "OU crua", cargas que casaram uma rota
    // do catálogo passam a filtrar só pelo nome canônico (ex.: "SJ Rio Preto-03"
    // vira "SAO JOSE DO RIO PRETO"), e filtrar pelo nome cru que aparece na carga
    // (ex.: planilha Nestlé "FEIRA DE SANTANA - BA") não achava. Casar os dois é
    // robusto: acha tanto pelo nome do facet (rótulo) quanto pelo nome cru.
    // DC-270: origem/destino viraram multiselect (arrays). A carga passa se casar
    // QUALQUER origem selecionada (e idem destino). Array vazio = sem filtro.
    const { origem: origemFilter, destino: destinoFilter } = parsedQuery;
    const matchesCity = (query, labelPart, rawValue) => {
      const q = query.trim().toUpperCase();
      const inLabel = (labelPart ?? "").trim().toUpperCase().includes(q);
      const inRaw = String(rawValue ?? "").trim().toUpperCase().includes(q);
      return inLabel || inRaw;
    };
    const matchesAnyCity = (queries, labelPart, rawValue) =>
      queries.length === 0 || queries.some((q) => matchesCity(q, labelPart, rawValue));
    // DC-265/DC-270: filtro por cliente em memória (evita cast uuid[] no pg-mem).
    const clienteIds = parsedQuery.clienteIds ?? [];
    const filteredRows = publishableRows.filter((row) => {
      const [labelOrigin, labelDestino] = (row.routeLabel ?? "").split(" X ");
      if (!matchesAnyCity(origemFilter, labelOrigin, row.origem)) return false;
      if (!matchesAnyCity(destinoFilter, labelDestino, row.destino)) return false;
      if (clienteIds.length && !clienteIds.includes(row.clienteId)) return false;
      return true;
    });

    const paginatedRows = filteredRows.slice(parsedQuery.offset, parsedQuery.offset + parsedQuery.pageSize);

    const stateSet = new Set();
    const profileSet = new Set();

    filteredRows.forEach((row) => {
      const originMatch = String(row.origem || "").trim().match(/([A-Za-z]{2})\s*$/);
      const destinationMatch = String(row.destino || "").trim().match(/([A-Za-z]{2})\s*$/);
      if (originMatch?.[1]) stateSet.add(originMatch[1].toUpperCase());
      if (destinationMatch?.[1]) stateSet.add(destinationMatch[1].toUpperCase());
      if (row.perfil) profileSet.add(row.perfil);
    });

    return {
      statusCode: 200,
      payload: {
        items: paginatedRows.map(mapDriverLoadReadModelItem),
        summary: {
          totalCount: filteredRows.length,
          uniqueStateCount: stateSet.size,
          uniqueProfileCount: profileSet.size,
        },
        meta: buildPaginationMeta(
          parsedQuery.page, parsedQuery.pageSize, filteredRows.length, parsedQuery.maxPageSize, correlationId,
        ),
      },
    };
  });
}

// ── Cache + single-flight das FACETS do portal do motorista ──────────────────
// As facets (opções de origem/destino/perfil/cliente dos filtros) são GLOBAIS:
// o endpoint `GET /api/driver/loads/facets` é anônimo e não recebe nenhum
// parâmetro (nem query, nem usuário) — o resultado é idêntico para todos os
// motoristas. Mesmo assim, cada abertura do portal disparava a varredura
// COMPLETA das cargas OPEN (+ JOIN de clientes, sem LIMIT) só para destilar 4
// listas de strings, e o cache do React Query é por aba → N motoristas = N
// varreduras. Diferente do irmão `fetchDriverLoadsReadModel`, aqui não havia
// cache nenhum.
// Chave única (sem filtros) → hit rate praticamente 100%. TTL default 60s em
// produção; 0 em teste (VITEST) p/ não vazar estado entre casos. O WHERE só
// depende do relógio na granularidade de minuto (cargas expiradas), então 60s
// de staleness é equivalente ao que o front já tolera (staleTime de 5 min).
let _driverLoadFacetsInFlight = null;
let _driverLoadFacetsCache = { at: 0, payload: null };

function getDriverLoadFacetsCacheTtlMs() {
  const raw = Number.parseInt(process.env.DRIVER_LOAD_FACETS_CACHE_TTL_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 0) return raw; // override explícito vence (habilita teste)
  if (process.env.VITEST || process.env.NODE_ENV === "test") return 0; // default OFF em teste
  return 60_000; // default produção
}

// Hook de teste: zera o estado de módulo (o cache fica desligado sob VITEST,
// mas testes que forcem TTL > 0 via env precisam limpar entre casos).
export function __resetDriverLoadFacetsCache() {
  _driverLoadFacetsInFlight = null;
  _driverLoadFacetsCache = { at: 0, payload: null };
}

export async function fetchDriverLoadFacets({ correlationId }) {
  const ttl = getDriverLoadFacetsCacheTtlMs();
  if (ttl <= 0) {
    return fetchDriverLoadFacetsUncached({ correlationId });
  }

  const now = Date.now();
  if (_driverLoadFacetsCache.payload && now - _driverLoadFacetsCache.at < ttl) {
    return {
      statusCode: 200,
      payload: { ..._driverLoadFacetsCache.payload, meta: { correlationId, cached: true } },
    };
  }

  if (_driverLoadFacetsInFlight) {
    const shared = await _driverLoadFacetsInFlight;
    return { statusCode: 200, payload: { ...shared, meta: { correlationId, cached: true } } };
  }

  const promise = (async () => {
    const result = await fetchDriverLoadFacetsUncached({ correlationId });
    // Só cacheia 200 (erros/fallback de schema não devem grudar).
    if (result?.statusCode === 200 && result.payload) {
      _driverLoadFacetsCache = { at: Date.now(), payload: result.payload };
    }
    return result.payload;
  })();
  _driverLoadFacetsInFlight = promise;

  try {
    const payload = await promise;
    return { statusCode: 200, payload };
  } finally {
    _driverLoadFacetsInFlight = null;
  }
}

async function fetchDriverLoadFacetsUncached({ correlationId }) {
  return withPgClient(async (client) => {
    // Defense-in-depth: tambem cruza com a planilha (sheet_motorista) para que
    // cargas ja alocadas no Google Sheets nao vazem nas facets do driver mesmo
    // que o sync demore para refletir status='BOOKED' no DB. Filtro de
    // sheet_status removido (era over-broad — bloqueava statuses de pipeline
    // aberto como 'AGUARDANDO CARREGAMENTO').
    const sheetUnallocatedSql = "COALESCE(alloc_motorista, sheet_motorista, '') = ''";
    // Iter #8: filtra cargas expiradas (data + horario passados) tambem nos
    // facets — para que filtros e contadores nao mostrem cargas que nem
    // aparecem no listing. Parameterizado pq pg-mem nao suporta CURRENT_DATE.
    // "Agora" no fuso de Sao Paulo (container roda em UTC; data/horario sao BRT).
    const { dateIso: todayIso, timeIso: nowTimeIso } = getSaoPauloWallClock();
    // DC-271: cargas lançadas/manuais expiram no carregamento como as da planilha
    // (removida a exceção "visível o dia todo"), igual ao buildDriverLoadFilters.
    // Exceção "A confirmar": agenda indefinida (placeholder hoje/00:00 + flag) não
    // entra no corte — mesma regra do buildDriverLoadFilters, senão o facet conta
    // menos cargas do que a lista mostra.
    const notExpiredSql = (comExcecaoAConfirmar = true) =>
      "(data IS NULL OR data > $1 OR (data = $2 AND (horario IS NULL OR horario >= $3))" +
      (comExcecaoAConfirmar ? " OR COALESCE(agenda_a_confirmar, false) = true" : "") +
      ")";

    // Carga com a viagem fora do ASPX sai da lista (buildDriverLoadFilters) — tem
    // que sair do CONTADOR também, senão facet e lista divergem e o motorista vê
    // "3 cargas em Salvador" e abre uma lista com 2.
    const naoForaDoAspxSql = "aspx_missing_since IS NULL";
    const buildFacetWhereSql = (
      includeDriverVisibilityFilter,
      { comGuardaAspx = true, comExcecaoAConfirmar = true } = {},
    ) => {
      const guardaAspx = comGuardaAspx ? ` AND ${naoForaDoAspxSql}` : "";
      const naoExpirada = notExpiredSql(comExcecaoAConfirmar);
      return includeDriverVisibilityFilter
        ? `status = 'OPEN' AND COALESCE(is_template, false) = false AND COALESCE(driver_visibility, 'PUBLIC') = 'PUBLIC' AND ${sheetUnallocatedSql} AND ${naoExpirada}${guardaAspx}`
        : `status = 'OPEN' AND COALESCE(is_template, false) = false AND ${sheetUnallocatedSql} AND ${naoExpirada}${guardaAspx}`;
    };
    const facetParams = [todayIso, todayIso, nowTimeIso];

    const queryFacetRows = async (includeDriverVisibilityFilter) => {
      let whereSql = buildFacetWhereSql(includeDriverVisibilityFilter);
      let rows;
      try {
        rows = await queryDriverLoadCandidateRows(client, { whereSql, values: facetParams });
      } catch (facetError) {
        if (isMissingAgendaAConfirmarColumnError(facetError)) {
          // Sem a coluna da flag: conta com o corte de expiração em todas as cargas.
          whereSql = buildFacetWhereSql(includeDriverVisibilityFilter, { comExcecaoAConfirmar: false });
          rows = await queryDriverLoadCandidateRows(client, { whereSql, values: facetParams });
        } else {
          if (!isMissingAspxMissingColumnError(facetError)) throw facetError;
          // Mesma degradação da listagem: sem a coluna, conta sem a guarda.
          whereSql = buildFacetWhereSql(includeDriverVisibilityFilter, { comGuardaAspx: false });
          rows = await queryDriverLoadCandidateRows(client, { whereSql, values: facetParams });
        }
      }
      const routeCatalogMetricsByLoadId = await fetchRouteCatalogMetricsByLoadId(client, rows);
      const routeLabelByLoadId = buildRouteLabelMap(rows);
      return rows
        // Consistente com a lista: rota desativada não conta pros facetes.
        .filter((row) => routeCatalogMetricsByLoadId.get(row.id)?.ativa !== false)
        .map((row) => buildDriverLoadPublicationState(row, routeCatalogMetricsByLoadId.get(row.id), routeLabelByLoadId.get(row.id)))
        .filter((entry) => entry.isReady)
        .map((entry) => entry.row);
    };

    let publishableRows;
    try {
      publishableRows = await queryFacetRows(true);
    } catch (error) {
      if (!isMissingDriverVisibilityColumnError(error)) throw error;
      publishableRows = await queryFacetRows(false);
    }

    const origemSet = new Set();
    const destinoSet = new Set();
    const perfilSet = new Set();
    // DC-270: facet de CLIENTE (id → nome) = clientes que têm carga aberta agora,
    // consistente com origem/destino/perfil (derivados só das cargas visíveis).
    const clienteMap = new Map();

    publishableRows.forEach((row) => {
      if (row.routeLabel) {
        const [origem, destino] = row.routeLabel.split(" X ");
        if (origem?.trim()) origemSet.add(origem.trim());
        if (destino?.trim()) destinoSet.add(destino.trim());
      }
      if (normalizeOptionalText(row.perfil)) perfilSet.add(row.perfil);
      if (row.clienteId && normalizeOptionalText(row.clienteNome)) {
        clienteMap.set(row.clienteId, row.clienteNome.trim());
      }
    });

    return {
      statusCode: 200,
      payload: {
        origemOptions: Array.from(origemSet).sort((a, b) => a.localeCompare(b, "pt-BR")),
        destinoOptions: Array.from(destinoSet).sort((a, b) => a.localeCompare(b, "pt-BR")),
        perfilOptions: Array.from(perfilSet).sort((a, b) => a.localeCompare(b, "pt-BR")),
        clienteOptions: Array.from(clienteMap.entries())
          .map(([id, nome]) => ({ id, nome }))
          .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")),
        meta: { correlationId },
      },
    };
  });
}

// ── Detalhe de UMA carga para o portal do motorista ──────────────────────────
// A tela /motorista/cargas/:id (DriverCargoDetails) lia o banco DIRETO do
// navegador com a chave anônima: SELECT enriquecido em `cargas` (+ JOIN grande
// de `clientes`), consulta ao catálogo `route_metrics_cache`, fallback de
// distância em `cargas` e resolução de `clientes` — até 4 idas navegador→pooler
// POR ABERTURA, × centenas de motoristas (o link da carga é o que circula no
// WhatsApp, então esta tela é aberta muito mais que a lista). Além do egress,
// expunha `cargas`/`clientes`/`route_metrics_cache` ao cliente anônimo.
//
// Este use case centraliza tudo em UMA resposta cacheada:
//   - a query do detalhe (carga + cliente) roda no backend (papel `postgres`);
//   - as métricas de rota reusam `fetchRouteCatalogMetricsByLoadId` — a MESMA
//     resolução (variantes de chave + tarifa por perfil/eixos) que a lista do
//     portal usa, em vez de uma segunda implementação no navegador;
//   - os dois fallbacks da tela (distância histórica da rota e cliente que não
//     resolveu no JOIN) continuam existindo, disparando nas mesmas condições,
//     só que server-side.
//
// Gate de visibilidade: `status IN ('OPEN','RESERVED','BOOKED')` — exatamente a
// policy RLS anônima de `public.cargas` ("Public can view driver visible
// cargas"). Ou seja, o endpoint NÃO amplia o que o motorista já podia ler; só
// deixa de fazê-lo pelo navegador. Carga fora desses status → 404, mesmo
// resultado que o `maybeSingle()` sem linha produzia antes ("Carga não
// encontrada" → ErrorState).
//
// O que este use case deliberadamente NÃO faz: aplicar os filtros extra da
// LISTA (não-expirada, não alocada, driver_visibility, rota ativa). A tela de
// detalhe nunca os aplicou — o link do WhatsApp abre a carga mesmo depois de
// reservada — e ligá-los aqui mudaria o que o motorista vê. A prontidão de
// publicação continua sendo decidida no frontend (`resolveCargoPublicationReadiness`),
// que também monta o texto do aviso "Carga em preparação".
const DRIVER_CARGO_DETAIL_VISIBLE_STATUSES = ["OPEN", "RESERVED", "BOOKED"];
const DRIVER_CARGO_DETAIL_VISIBLE_STATUSES_SQL = DRIVER_CARGO_DETAIL_VISIBLE_STATUSES.map(
  (status) => `'${status}'`,
).join(", ");

// Schema legado sem os badges customizados do cliente (jsonb) — degrada para
// NULL, como o read model de clientes já faz.
function isMissingClienteCustomBadgesColumnError(error) {
  const combinedMessage = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return (
    combinedMessage.includes("custom_reputacoes") || combinedMessage.includes("custom_exigencias")
  );
}

// Os guards de coluna ausente (_shared.js) classificam por substring da
// mensagem. O pg-mem ANEXA o SQL que falhou à mensagem, então qualquer coluna
// citada no SELECT casaria com qualquer guard e o fallback desligaria o grupo
// errado. Reduzir ao primeiro parágrafo mantém só a mensagem real do postgres
// ("column X does not exist"), que é o que os guards querem inspecionar.
function toColumnErrorProbe(error) {
  return {
    message: String(error?.message || "").split("\n", 1)[0],
    detail: error?.detail,
  };
}

// `cargas.data` é DATE: o driver do pg devolve Date, e o PostgREST devolvia
// "YYYY-MM-DD" ao navegador. Normalizamos para o mesmo texto para que
// buildLoadingDateTime/buildOperationalDateLabel rendam o rótulo idêntico.
// Usa componentes UTC (contêiner roda em UTC) — nunca o fuso local do processo.
function toDateOnlyText(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  return text === "" ? null : text.slice(0, 10);
}

// `cargas.horario` é TIME (o pg devolve "HH:MM:SS"); só protege o caso de o
// driver entregar Date. Sem to_char: pg-mem não implementa em TIME.
function toTimeText(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(11, 19);
  }
  const text = String(value).trim();
  return text === "" ? null : text;
}

function buildDriverCargoDetailSql({
  withBonusRequirements = true,
  withEixos = true,
  withPacoteColumns = true,
  withClienteCustomBadges = true,
} = {}) {
  return `
    SELECT
      cargas.id,
      cargas.data,
      cargas.horario,
      cargas.origem,
      cargas.destino,
      cargas.distancia_km,
      cargas.duracao_horas,
      cargas.perfil,
      ${withEixos ? "cargas.eixos" : "NULL::smallint AS eixos"},
      cargas.valor,
      cargas.bonus,
      ${withBonusRequirements ? "cargas.bonus_exigencias" : "NULL::text AS bonus_exigencias"},
      cargas.status,
      cargas.cliente_id,
      cargas.sheet_data_carregamento,
      cargas.sheet_data_descarga,
      ${withPacoteColumns ? "cargas.viagem_id" : "NULL::uuid AS viagem_id"},
      ${withPacoteColumns ? "cargas.ordem_viagem" : "NULL::integer AS ordem_viagem"},
      clientes.id AS cliente_row_id,
      clientes.nome AS cliente_nome,
      clientes.descricao AS cliente_descricao,
      clientes.forma_pagamento AS cliente_forma_pagamento,
      clientes.prazo_pagamento AS cliente_prazo_pagamento,
      clientes.observacoes AS cliente_observacoes,
      clientes.exige_antt AS cliente_exige_antt,
      clientes.exige_carga_monitorada AS cliente_exige_carga_monitorada,
      clientes.exige_rastreamento AS cliente_exige_rastreamento,
      clientes.exige_seguro AS cliente_exige_seguro,
      clientes.reputacao_boa_comunicacao AS cliente_reputacao_boa_comunicacao,
      clientes.reputacao_bom_pagador AS cliente_reputacao_bom_pagador,
      clientes.reputacao_carga_organizada AS cliente_reputacao_carga_organizada,
      clientes.reputacao_liberacao_rapida AS cliente_reputacao_liberacao_rapida,
      clientes.reputacao_pagamento_rapido AS cliente_reputacao_pagamento_rapido,
      ${withClienteCustomBadges ? "clientes.custom_reputacoes" : "NULL::jsonb AS custom_reputacoes"},
      ${withClienteCustomBadges ? "clientes.custom_exigencias" : "NULL::jsonb AS custom_exigencias"}
    FROM public.cargas
    LEFT JOIN public.clientes ON clientes.id = cargas.cliente_id
    WHERE cargas.id = $1::uuid
      AND cargas.status IN (${DRIVER_CARGO_DETAIL_VISIBLE_STATUSES_SQL})
  `;
}

// Roda o SELECT do detalhe desligando, uma a uma, as colunas opcionais que a DB
// não tiver (mesma estratégia dos irmãos deste arquivo). Espelha o fallback que
// existia no frontend (LEGACY_CARGO_DETAILS_SELECT, que abria mão de
// bonus_exigencias/eixos/viagem_id/ordem_viagem juntos).
async function queryDriverCargoDetailRow(client, cargoId) {
  const support = {
    withBonusRequirements: true,
    withEixos: true,
    withPacoteColumns: true,
    withClienteCustomBadges: true,
  };

  // No pior caso desliga os 4 grupos (4 retries) — o loop tem teto.
  for (let attempt = 0; attempt <= 4; attempt += 1) {
    try {
      const { rows } = await client.query(buildDriverCargoDetailSql(support), [cargoId]);
      return rows[0] ?? null;
    } catch (error) {
      const probe = toColumnErrorProbe(error);
      if (support.withPacoteColumns && isMissingPacoteColumnsError(probe)) {
        support.withPacoteColumns = false;
      } else if (support.withBonusRequirements && isMissingBonusRequirementsColumnError(probe)) {
        support.withBonusRequirements = false;
      } else if (
        support.withClienteCustomBadges &&
        isMissingClienteCustomBadgesColumnError(probe)
      ) {
        support.withClienteCustomBadges = false;
      } else if (support.withEixos && isMissingEixosColumnError(probe)) {
        support.withEixos = false;
      } else {
        throw error;
      }
    }
  }

  return null;
}

function mapDriverCargoDetailCliente(row) {
  if (!row.cliente_row_id && !row.cliente_nome) {
    return null;
  }

  return {
    id: row.cliente_row_id,
    nome: row.cliente_nome,
    descricao: row.cliente_descricao ?? null,
    forma_pagamento: row.cliente_forma_pagamento ?? null,
    prazo_pagamento: row.cliente_prazo_pagamento ?? null,
    observacoes: row.cliente_observacoes ?? null,
    exige_antt: row.cliente_exige_antt ?? false,
    exige_carga_monitorada: row.cliente_exige_carga_monitorada ?? false,
    exige_rastreamento: row.cliente_exige_rastreamento ?? false,
    exige_seguro: row.cliente_exige_seguro ?? false,
    reputacao_boa_comunicacao: row.cliente_reputacao_boa_comunicacao ?? false,
    reputacao_bom_pagador: row.cliente_reputacao_bom_pagador ?? false,
    reputacao_carga_organizada: row.cliente_reputacao_carga_organizada ?? false,
    reputacao_liberacao_rapida: row.cliente_reputacao_liberacao_rapida ?? false,
    reputacao_pagamento_rapido: row.cliente_reputacao_pagamento_rapido ?? false,
    custom_reputacoes: row.custom_reputacoes ?? null,
    custom_exigencias: row.custom_exigencias ?? null,
  };
}

// Fallback 1 (era `resolveDriverCargoDistanceKm` no navegador): carga sem
// distancia_km e sem distância no catálogo → herda a última distância conhecida
// do mesmo trecho. Mantém o filtro de status da policy anônima para não passar a
// enxergar distância de carga que o navegador não podia ler.
async function resolveDriverCargoHistoryDistanceKm(client, { origem, destino }) {
  const { rows } = await client.query(
    `
      SELECT distancia_km
        FROM public.cargas
       WHERE origem = $1
         AND destino = $2
         AND distancia_km IS NOT NULL
         AND status IN (${DRIVER_CARGO_DETAIL_VISIBLE_STATUSES_SQL})
       ORDER BY created_at DESC
       LIMIT 1
    `,
    [origem, destino],
  );

  return parseNullableNumber(rows[0]?.distancia_km);
}

// Fallback 2 (era `fetchDriverClientsByIds` + `mergeDriverClientsIntoRows` no
// navegador): cliente_id preenchido mas o JOIN não trouxe cliente. Resolve o
// mesmo subconjunto de campos (id, nome, descricao) que o fallback do frontend
// mesclava — os demais campos seguem ausentes, como antes.
async function resolveDriverCargoClienteBrief(client, clienteId) {
  const { rows } = await client.query(
    "SELECT id, nome, descricao FROM public.clientes WHERE id = $1::uuid",
    [clienteId],
  );
  const row = rows[0];
  return row ? { id: row.id, nome: row.nome, descricao: row.descricao ?? null } : null;
}

// TTL + single-flight. O detalhe é PÚBLICO e idêntico para todos os motoristas
// (nenhum campo depende de identidade — o endpoint é anônimo e não recebe
// usuário), então a chave é só o cargoId. Rajadas de aberturas do mesmo link
// (o caso real: link disparado em massa no WhatsApp) colapsam em 1 execução.
// TTL default 8s em produção (igual à lista); 0 em teste, com override
// explícito por env vencendo o guard do VITEST.
let _driverCargoDetailInFlight = new Map();
let _driverCargoDetailCache = new Map();

function getDriverCargoDetailCacheTtlMs() {
  const raw = Number.parseInt(process.env.DRIVER_CARGO_DETAIL_CACHE_TTL_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 0) return raw; // override explícito vence (habilita teste)
  if (process.env.VITEST || process.env.NODE_ENV === "test") return 0; // default OFF em teste
  return 8_000; // default produção
}

// Hook de teste: zera o estado de módulo (o cache fica desligado sob VITEST,
// mas testes que forcem TTL > 0 via env precisam limpar entre casos).
export function __resetDriverCargoDetailCache() {
  _driverCargoDetailInFlight = new Map();
  _driverCargoDetailCache = new Map();
}

export async function fetchDriverCargoDetail({ cargoId, correlationId }) {
  const ttl = getDriverCargoDetailCacheTtlMs();
  if (ttl <= 0) {
    return fetchDriverCargoDetailUncached({ cargoId, correlationId });
  }

  const key = String(cargoId);
  const now = Date.now();

  const cached = _driverCargoDetailCache.get(key);
  if (cached && now - cached.at < ttl) {
    return {
      statusCode: 200,
      payload: { ...cached.payload, meta: { correlationId, cached: true } },
    };
  }

  const inFlight = _driverCargoDetailInFlight.get(key);
  if (inFlight) {
    const shared = await inFlight;
    if (shared.statusCode !== 200) {
      return { statusCode: shared.statusCode, payload: { ...shared.payload, meta: { correlationId } } };
    }
    return { statusCode: 200, payload: { ...shared.payload, meta: { correlationId, cached: true } } };
  }

  const promise = (async () => {
    const result = await fetchDriverCargoDetailUncached({ cargoId, correlationId });
    // Só cacheia 200 (404 e falhas de schema não devem grudar).
    if (result?.statusCode === 200 && result.payload) {
      _driverCargoDetailCache.set(key, { at: Date.now(), payload: result.payload });
      // Evita crescimento ilimitado de chaves (uma por carga aberta).
      if (_driverCargoDetailCache.size > 500) {
        const oldest = [..._driverCargoDetailCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
        if (oldest) _driverCargoDetailCache.delete(oldest);
      }
    }
    return result;
  })();
  _driverCargoDetailInFlight.set(key, promise);

  try {
    return await promise;
  } finally {
    _driverCargoDetailInFlight.delete(key);
  }
}

async function fetchDriverCargoDetailUncached({ cargoId, correlationId }) {
  return withPgClient(async (client) => {
    const row = await queryDriverCargoDetailRow(client, cargoId);

    if (!row) {
      // Mesma resposta para "não existe" e "não visível ao motorista" — não
      // revela a existência de carga fora dos status públicos.
      return {
        statusCode: 404,
        payload: {
          error: "NotFound",
          code: "CARGO_NOT_FOUND",
          message: "Carga não encontrada.",
          meta: { correlationId },
        },
      };
    }

    let cliente = mapDriverCargoDetailCliente(row);
    if (row.cliente_id && !cliente) {
      cliente = await resolveDriverCargoClienteBrief(client, row.cliente_id);
    }

    const cargo = {
      id: row.id,
      data: toDateOnlyText(row.data),
      horario: toTimeText(row.horario),
      origem: row.origem,
      destino: row.destino,
      // NUMERIC volta como string no driver do pg; o frontend faz
      // `typeof x === "number"`, então converter aqui é obrigatório.
      distancia_km: parseNullableNumber(row.distancia_km),
      duracao_horas: parseNullableNumber(row.duracao_horas),
      perfil: row.perfil,
      eixos: parseNullableNumber(row.eixos),
      valor: parseNullableNumber(row.valor),
      bonus: parseNullableNumber(row.bonus),
      bonus_exigencias: row.bonus_exigencias ?? null,
      status: row.status,
      cliente_id: row.cliente_id ?? null,
      sheet_data_carregamento: row.sheet_data_carregamento ?? null,
      sheet_data_descarga: row.sheet_data_descarga ?? null,
      viagem_id: row.viagem_id ?? null,
      ordem_viagem: row.ordem_viagem ?? null,
      cliente,
    };

    const routeMetrics =
      (await fetchRouteCatalogMetricsByLoadId(client, [
        { id: row.id, origem: row.origem, destino: row.destino, perfil: row.perfil, eixos: row.eixos },
      ])).get(row.id) ?? null;

    // Mesmos campos que o navegador lia de route_metrics_cache. `ativa` fica
    // fora de propósito: a lista usa esse flag para não ofertar a carga, mas o
    // detalhe nunca o aplicou e ligá-lo aqui esconderia carga que hoje abre.
    const routeFallback = routeMetrics
      ? {
          distancia_km: routeMetrics.distancia_km ?? null,
          duracao_horas: routeMetrics.duracao_horas ?? null,
          tempo_estimado_horas: routeMetrics.tempo_estimado_horas ?? null,
          perfil_padrao: routeMetrics.perfil_padrao ?? null,
          eixos: routeMetrics.eixos ?? null,
          valor_padrao: routeMetrics.valor_padrao ?? null,
          bonus_padrao: routeMetrics.bonus_padrao ?? null,
        }
      : null;

    const routeDistanceKm = parseNullableNumber(routeFallback?.distancia_km);
    const needsHistoryDistance = cargo.distancia_km === null && routeDistanceKm === null;
    const historyDistanciaKm = needsHistoryDistance
      ? await resolveDriverCargoHistoryDistanceKm(client, { origem: row.origem, destino: row.destino })
      : null;

    return {
      statusCode: 200,
      payload: {
        cargo,
        routeFallback,
        // Distância herdada do histórico do trecho — o frontend só a usa quando
        // a carga e o catálogo não têm distância própria (mesma ordem de antes).
        historyDistanciaKm,
        meta: { correlationId },
      },
    };
  });
}
