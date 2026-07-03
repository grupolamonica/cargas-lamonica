import { withPgClient, withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import {
  buildHeaderIndex,
  normalizeClientName,
  parseImportRow,
  splitCsvRows,
} from "../../../domain/operator-admin/import-programacao.js";
import { ValidationError } from "../../../domain/load-claims/errors.js";
import { fetchRouteCatalogMetricsByLoadId } from "./_shared.js";

// Teto de segurança: importações maiores devem ser quebradas em arquivos.
const MAX_IMPORT_ROWS = 500;

// Cargas com motorista em processo / viagem concluída NÃO são sobrescritas por
// re-importação (evita atropelar uma reserva ou um histórico). As demais
// (rascunho/aberta/expirada/cancelada/falha) são atualizadas pelo COD. CARGA.
const PROTECTED_STATUSES = new Set(["RESERVED", "BOOKED", "COMPLETED"]);

// Mapa nome-normalizado → cliente, para resolver a coluna CLIENTE do CSV.
async function loadClientesByName(client) {
  const { rows } = await client.query("SELECT id, nome FROM public.clientes");
  const map = new Map();
  for (const row of rows) {
    map.set(normalizeClientName(row.nome), { id: row.id, nome: row.nome });
  }
  return map;
}

/**
 * Separa o CSV, mapeia o cabeçalho e valida cada linha. Não escreve nada — usado
 * tanto pelo dry-run (preview) quanto como etapa de validação do import real.
 *
 * @returns {{headerError?: string, rows: Array}}
 */
function parseAndValidate(csv, clientesByName) {
  const matrix = splitCsvRows(csv);

  if (matrix.length === 0) {
    return { headerError: "Arquivo CSV vazio.", rows: [] };
  }

  const [headerRow, ...dataRows] = matrix;
  const { indexByColumn, missingRequired } = buildHeaderIndex(headerRow);

  if (missingRequired.length > 0) {
    return {
      headerError: `Cabeçalho inválido. Colunas obrigatórias ausentes: ${missingRequired.join(", ")}.`,
      rows: [],
    };
  }

  if (dataRows.length > MAX_IMPORT_ROWS) {
    return {
      headerError: `Arquivo excede o limite de ${MAX_IMPORT_ROWS} linhas (recebidas ${dataRows.length}). Divida em partes.`,
      rows: [],
    };
  }

  const rows = dataRows.map((cells, offset) => {
    const result = parseImportRow(cells, indexByColumn, { clientesByName });
    return {
      line: offset + 2, // +1 do cabeçalho, +1 para base 1 (linha do arquivo)
      ok: result.ok,
      errors: result.errors,
      preview: result.preview,
      payload: result.payload,
    };
  });

  return { rows };
}

// Define a ação de cada linha válida por COD. CARGA (= id determinístico):
//   insert  → COD. CARGA novo
//   update  → já existe e pode ser sobrescrita (refresh / revive)
//   skip    → já existe com motorista/viagem (protegida) ou repetida no arquivo
async function classifyRows(client, rows) {
  const validRows = rows.filter((row) => row.ok);
  const ids = [...new Set(validRows.map((row) => row.payload.id))];

  const statusById = new Map();
  if (ids.length > 0) {
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(", ");
    const { rows: found } = await client.query(
      `SELECT id, status FROM public.cargas WHERE id IN (${placeholders})`,
      ids,
    );
    found.forEach((row) => statusById.set(row.id, row.status));
  }

  const seenInFile = new Set();
  for (const row of rows) {
    if (!row.ok) {
      row.action = "invalid";
      continue;
    }
    const id = row.payload.id;
    if (seenInFile.has(id)) {
      row.action = "skip";
      row.reason = "COD. CARGA repetido no arquivo";
      continue;
    }
    seenInFile.add(id);

    const existingStatus = statusById.get(id);
    if (!existingStatus) {
      row.action = "insert";
    } else if (PROTECTED_STATUSES.has(existingStatus)) {
      row.action = "skip";
      row.reason = `já existe com motorista/viagem (${existingStatus})`;
    } else {
      row.action = "update";
    }
  }
}

// Marca, por linha válida, se a rota (origem→destino) tem cadastro no catálogo
// (route_metrics_cache). Apenas informativo no preview — não bloqueia o import.
async function markRouteRegistration(client, rows) {
  const validRows = rows.filter((row) => row.ok);
  if (validRows.length === 0) return;

  const loadRows = validRows.map((row) => ({
    id: row.payload.id,
    origem: row.payload.origem,
    destino: row.payload.destino,
  }));
  const metricsById = await fetchRouteCatalogMetricsByLoadId(client, loadRows);

  for (const row of validRows) {
    row.preview.route_registered = metricsById.get(row.payload.id) != null;
  }
}

async function insertCargo(client, payload, operatorId) {
  await client.query(
    `
      INSERT INTO public.cargas (
        id, data, horario, origem, destino, perfil, status, is_template,
        created_by, driver_visibility, sheet_lh, sheet_tipo,
        sheet_data_carregamento, sheet_data_descarga, cliente_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `,
    [
      payload.id,
      payload.data,
      payload.horario,
      payload.origem,
      payload.destino,
      payload.perfil,
      payload.status,
      payload.is_template,
      operatorId,
      payload.driver_visibility,
      payload.sheet_lh,
      payload.sheet_tipo,
      payload.sheet_data_carregamento,
      payload.sheet_data_descarga,
      payload.cliente_id,
    ],
  );
}

// Atualiza a carga existente (mesmo COD. CARGA) com os valores do CSV. Preserva
// id, sheet_lh, created_by e created_at.
async function updateCargo(client, payload) {
  await client.query(
    `
      UPDATE public.cargas
      SET data = $2, horario = $3, origem = $4, destino = $5, perfil = $6,
          status = $7, driver_visibility = $8, sheet_tipo = $9,
          sheet_data_carregamento = $10, sheet_data_descarga = $11,
          cliente_id = $12, updated_at = now()
      WHERE id = $1
    `,
    [
      payload.id,
      payload.data,
      payload.horario,
      payload.origem,
      payload.destino,
      payload.perfil,
      payload.status,
      payload.driver_visibility,
      payload.sheet_tipo,
      payload.sheet_data_carregamento,
      payload.sheet_data_descarga,
      payload.cliente_id,
    ],
  );
}

function buildSummary(rows) {
  const counts = { total: rows.length, invalid: 0, skipped: 0, inserted: 0, updated: 0 };
  for (const row of rows) {
    if (!row.ok) counts.invalid += 1;
    else if (row.action === "skip") counts.skipped += 1;
    else if (row.action === "insert") counts.inserted += 1;
    else if (row.action === "update") counts.updated += 1;
  }
  counts.importable = counts.inserted + counts.updated;
  return counts;
}

// Remove o payload (uso interno) antes de devolver ao cliente.
function toClientRow({ line, ok, errors, preview, action, reason }) {
  return { line, ok, errors, preview, action: action ?? (ok ? "insert" : "invalid"), reason: reason ?? null };
}

/**
 * Importa programação de cargas a partir de um CSV. Em `dryRun`, apenas valida e
 * classifica cada linha (nova / atualiza / pulada / erro); caso contrário,
 * insere as novas e atualiza as existentes (mesmo COD. CARGA) numa transação
 * única. Cargas com motorista/viagem (RESERVED/BOOKED/COMPLETED) são preservadas.
 *
 * COD. CARGA = LH → id determinístico (mesmo do sync da planilha): reimportar o
 * mesmo COD. CARGA atualiza a carga (não duplica).
 */
export async function importOperatorCargas({ operatorId, csv, dryRun = false, requestIp, correlationId }) {
  if (typeof csv !== "string" || csv.trim() === "") {
    throw new ValidationError("CSV vazio ou ausente.");
  }

  if (dryRun) {
    const { headerError, rows } = await withPgClient(async (client) => {
      const clientesByName = await loadClientesByName(client);
      const parsed = parseAndValidate(csv, clientesByName);
      if (!parsed.headerError) {
        await classifyRows(client, parsed.rows);
        await markRouteRegistration(client, parsed.rows);
      }
      return parsed;
    });

    if (headerError) {
      return {
        statusCode: 200,
        payload: { ok: false, dryRun: true, headerError, summary: buildSummary([]), rows: [], meta: { correlationId } },
      };
    }

    return {
      statusCode: 200,
      payload: {
        ok: true,
        dryRun: true,
        summary: buildSummary(rows),
        rows: rows.map(toClientRow),
        meta: { correlationId },
      },
    };
  }

  return withPgTransaction(async (client) => {
    const clientesByName = await loadClientesByName(client);
    const { headerError, rows } = parseAndValidate(csv, clientesByName);

    if (headerError) {
      return {
        statusCode: 400,
        payload: { ok: false, dryRun: false, headerError, summary: buildSummary([]), rows: [], meta: { correlationId } },
      };
    }

    await classifyRows(client, rows);
    await markRouteRegistration(client, rows);

    for (const row of rows) {
      if (row.action === "insert") await insertCargo(client, row.payload, operatorId);
      else if (row.action === "update") await updateCargo(client, row.payload);
    }

    const summary = buildSummary(rows);

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.imported",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cargo",
      resourceId: null,
      action: "import",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        total: summary.total,
        inserted: summary.inserted,
        updated: summary.updated,
        skipped: summary.skipped,
        invalid: summary.invalid,
      },
    });

    return {
      statusCode: 201,
      payload: { ok: true, dryRun: false, summary, rows: rows.map(toClientRow), meta: { correlationId } },
    };
  });
}
