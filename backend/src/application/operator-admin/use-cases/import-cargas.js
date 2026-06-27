import { withPgClient, withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import {
  buildHeaderIndex,
  normalizeClientName,
  parseImportRow,
  splitCsvRows,
} from "../../../domain/operator-admin/import-programacao.js";
import { ValidationError } from "../../../domain/load-claims/errors.js";

// Teto de segurança: importações maiores devem ser quebradas em arquivos.
const MAX_IMPORT_ROWS = 500;

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

// Marca cada linha válida como duplicada se o COD. CARGA (= id determinístico)
// já existe no banco OU já apareceu antes no próprio arquivo.
async function markDuplicates(client, rows) {
  const validRows = rows.filter((row) => row.ok);
  const ids = [...new Set(validRows.map((row) => row.payload.id))];

  const existing = new Set();
  if (ids.length > 0) {
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(", ");
    const { rows: found } = await client.query(
      `SELECT id FROM public.cargas WHERE id IN (${placeholders})`,
      ids,
    );
    found.forEach((row) => existing.add(row.id));
  }

  const seenInFile = new Set();
  for (const row of rows) {
    if (!row.ok) continue;
    const id = row.payload.id;
    row.duplicate = existing.has(id) || seenInFile.has(id);
    seenInFile.add(id);
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

function buildSummary(rows) {
  const valid = rows.filter((row) => row.ok);
  const duplicated = valid.filter((row) => row.duplicate).length;
  const invalid = rows.length - valid.length;
  return {
    total: rows.length,
    valid: valid.length,
    invalid,
    duplicated,
    importable: valid.length - duplicated,
  };
}

// Remove o payload (uso interno) antes de devolver ao cliente.
function toClientRow({ line, ok, errors, preview, duplicate }) {
  return { line, ok, errors, preview, duplicate: Boolean(duplicate) };
}

/**
 * Importa programação de cargas a partir de um CSV. Em `dryRun`, apenas valida e
 * devolve o preview por linha (marcando duplicatas por COD. CARGA); caso
 * contrário, insere as linhas válidas e ainda não existentes numa transação
 * única (inválidas e duplicadas são puladas e reportadas).
 *
 * COD. CARGA = LH → id determinístico (mesmo do sync da planilha): reimportar o
 * mesmo COD. CARGA não duplica a carga.
 */
export async function importOperatorCargas({ operatorId, csv, dryRun = false, requestIp, correlationId }) {
  if (typeof csv !== "string" || csv.trim() === "") {
    throw new ValidationError("CSV vazio ou ausente.");
  }

  if (dryRun) {
    const { headerError, rows } = await withPgClient(async (client) => {
      const clientesByName = await loadClientesByName(client);
      const parsed = parseAndValidate(csv, clientesByName);
      if (!parsed.headerError) await markDuplicates(client, parsed.rows);
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
        summary: { ...buildSummary(rows), imported: 0 },
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

    await markDuplicates(client, rows);

    const toInsert = rows.filter((row) => row.ok && !row.duplicate);
    for (const row of toInsert) {
      await insertCargo(client, row.payload, operatorId);
    }

    const summary = { ...buildSummary(rows), imported: toInsert.length };

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
        imported: summary.imported,
        duplicated: summary.duplicated,
        invalid: summary.invalid,
      },
    });

    return {
      statusCode: 201,
      payload: { ok: true, dryRun: false, summary, rows: rows.map(toClientRow), meta: { correlationId } },
    };
  });
}
