import { withPgClient } from "../../../infrastructure/pg/postgres.js";
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
  isMissingDriverVisibilityColumnError,
  isMissingPacoteColumnsError,
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
      clauses.push(
        `(cargas.data IS NULL OR cargas.data > $${todayGtIndex} OR (cargas.data = $${todayEqIndex} AND (cargas.horario IS NULL OR cargas.horario >= $${nowTimeIndex})))`,
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
  if (process.env.VITEST || process.env.NODE_ENV === "test") return 0;
  const raw = Number.parseInt(process.env.DRIVER_LOADS_CACHE_TTL_MS ?? "", 10);
  if (Number.isFinite(raw) && raw >= 0) return raw; // respeita override (incl. 0)
  return 8_000; // default produção
}

function driverLoadsCacheKey(query = {}) {
  // Normaliza só os campos que mudam o resultado. Ordena p/ estabilidade.
  const q = query || {};
  return JSON.stringify({
    page: String(q.page ?? ""),
    pageSize: String(q.pageSize ?? ""),
    search: String(q.search ?? "").trim().toLowerCase(),
    status: String(q.status ?? "").trim().toLowerCase(),
    driverVisibility: String(q.driverVisibility ?? "").trim().toLowerCase(),
    clienteId: String(q.clienteId ?? "").trim(),
    origem: String(q.origem ?? "").trim().toLowerCase(),
    destino: String(q.destino ?? "").trim().toLowerCase(),
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
  if (cached && now - cached.at < ttl) {
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
      } else {
        throw error;
      }
    }

    const routeCatalogMetricsByLoadId = await fetchRouteCatalogMetricsByLoadId(client, itemRows);
    const routeLabelByLoadId = buildRouteLabelMap(itemRows);
    const publishableRows = itemRows
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
    const { origem: origemFilter, destino: destinoFilter } = parsedQuery;
    const matchesCity = (query, labelPart, rawValue) => {
      const q = query.trim().toUpperCase();
      const inLabel = (labelPart ?? "").trim().toUpperCase().includes(q);
      const inRaw = String(rawValue ?? "").trim().toUpperCase().includes(q);
      return inLabel || inRaw;
    };
    const filteredRows = publishableRows.filter((row) => {
      const [labelOrigin, labelDestino] = (row.routeLabel ?? "").split(" X ");
      if (origemFilter && !matchesCity(origemFilter, labelOrigin, row.origem)) return false;
      if (destinoFilter && !matchesCity(destinoFilter, labelDestino, row.destino)) return false;
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

export async function fetchDriverLoadFacets({ correlationId }) {
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
    const notExpiredSql =
      "(data IS NULL OR data > $1 OR (data = $2 AND (horario IS NULL OR horario >= $3)))";

    const buildFacetWhereSql = (includeDriverVisibilityFilter) =>
      includeDriverVisibilityFilter
        ? `status = 'OPEN' AND COALESCE(is_template, false) = false AND COALESCE(driver_visibility, 'PUBLIC') = 'PUBLIC' AND ${sheetUnallocatedSql} AND ${notExpiredSql}`
        : `status = 'OPEN' AND COALESCE(is_template, false) = false AND ${sheetUnallocatedSql} AND ${notExpiredSql}`;
    const facetParams = [todayIso, todayIso, nowTimeIso];

    const queryFacetRows = async (includeDriverVisibilityFilter) => {
      const whereSql = buildFacetWhereSql(includeDriverVisibilityFilter);
      const rows = await queryDriverLoadCandidateRows(client, { whereSql, values: facetParams });
      const routeCatalogMetricsByLoadId = await fetchRouteCatalogMetricsByLoadId(client, rows);
      const routeLabelByLoadId = buildRouteLabelMap(rows);
      return rows
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

    publishableRows.forEach((row) => {
      if (row.routeLabel) {
        const [origem, destino] = row.routeLabel.split(" X ");
        if (origem?.trim()) origemSet.add(origem.trim());
        if (destino?.trim()) destinoSet.add(destino.trim());
      }
      if (normalizeOptionalText(row.perfil)) perfilSet.add(row.perfil);
    });

    return {
      statusCode: 200,
      payload: {
        origemOptions: Array.from(origemSet).sort((a, b) => a.localeCompare(b, "pt-BR")),
        destinoOptions: Array.from(destinoSet).sort((a, b) => a.localeCompare(b, "pt-BR")),
        perfilOptions: Array.from(perfilSet).sort((a, b) => a.localeCompare(b, "pt-BR")),
        meta: { correlationId },
      },
    };
  });
}
