import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { parseOperatorDashboardQuery } from "../../../domain/operator-admin/schemas.js";
import { buildPaginationMeta, parseNullableNumber } from "../../../domain/operator-admin/route-utils.js";
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
} from "./_shared.js";

export async function fetchOperatorDashboardReadModel({ query, correlationId }) {
  const { page, pageSize, offset, maxPageSize, search, status, driverVisibility, clienteId } = parseOperatorDashboardQuery(query);

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
    const { rows: summaryRows } = await client.query(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'OPEN' AND NOT COALESCE(is_template, false) THEN 1 ELSE 0 END), 0)::int AS active_count,
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

export async function fetchDriverLoadsReadModel({ query, correlationId }) {
  return withPgClient(async (client) => {
    let filterContext = buildDriverLoadFilters(query);
    let parsedQuery = filterContext.parsedQuery;
    let whereSql = filterContext.whereSql;
    let values = filterContext.values;
    let itemRows;

    try {
      itemRows = await queryDriverLoadCandidateRows(client, { whereSql, values });
    } catch (error) {
      if (isMissingDriverVisibilityColumnError(error)) {
        filterContext = buildDriverLoadFilters(query, { includeDriverVisibilityFilter: false });
        parsedQuery = filterContext.parsedQuery;
        whereSql = filterContext.whereSql;
        values = filterContext.values;
        itemRows = await queryDriverLoadCandidateRows(client, { whereSql, values });
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

    // In-memory location filter (SQL ILIKE removed per D-02 — filter on resolved route labels)
    const { origem: origemFilter, destino: destinoFilter } = parsedQuery;
    const filteredRows = publishableRows.filter((row) => {
      if (origemFilter) {
        const [routeOrigin] = (row.routeLabel ?? "").split(" X ");
        if (!routeOrigin?.trim().toUpperCase().includes(origemFilter.trim().toUpperCase())) return false;
      }
      if (destinoFilter) {
        const parts = (row.routeLabel ?? "").split(" X ");
        const routeDestino = parts[1];
        if (!routeDestino?.trim().toUpperCase().includes(destinoFilter.trim().toUpperCase())) return false;
      }
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
    const buildFacetWhereSql = (includeDriverVisibilityFilter) =>
      includeDriverVisibilityFilter
        ? "status = 'OPEN' AND COALESCE(is_template, false) = false AND COALESCE(driver_visibility, 'PUBLIC') = 'PUBLIC'"
        : "status = 'OPEN' AND COALESCE(is_template, false) = false";

    const queryFacetRows = async (includeDriverVisibilityFilter) => {
      const whereSql = buildFacetWhereSql(includeDriverVisibilityFilter);
      const rows = await queryDriverLoadCandidateRows(client, { whereSql, values: [] });
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
