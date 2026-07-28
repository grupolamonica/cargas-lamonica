// backend/src/application/operator-admin/use-cases/programacao-route-colors.js
//
// Cores da LINHA da Programação por rota (código de PARTIDA + CHEGADA + tipo de
// VEÍCULO). Fonte da verdade: tabela public.programacao_route_colors (compartilhada,
// editável pela tela). O front lê a lista e casa cada viagem por (origemCodigo,
// destinoCodigo, veiculo normalizado) → pinta a linha.
//
// Tolerante a tabela ausente (migration não rodou ainda): a leitura devolve [] em vez
// de 500, então a tela continua funcionando sem cor até a migration subir.

import { withPgClient, withPgTransaction } from "../../../infrastructure/pg/postgres.js";

function isMissingTable(err) {
  return Boolean(err) && (err.code === "42P01" || /relation .* does not exist/i.test(err.message || ""));
}

// Normaliza o tipo de veículo p/ casar tabela↔viagem sem ruído: MAIÚSCULAS, espaços
// colapsados e separador de hífen canônico (" - "), então "CARRETA-EXPRESSA" e
// "CARRETA  -  EXPRESSA" casam com o seed "CARRETA - EXPRESSA". Mesma regra no front
// (programacaoColors.ts) — as duas camadas TÊM que produzir a mesma string.
export function normalizeVehicle(v) {
  return String(v ?? "").toUpperCase().replace(/\s+/g, " ").replace(/\s*-\s*/g, " - ").trim();
}

// UUID v4-ish (o id da tabela). Valida antes de ir ao banco p/ um id malformado virar
// 400 (não um 22P02 → 500 cru no cast text→uuid).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Código de estação = só dígitos (o "[8808]" já vem sem colchetes do read model).
function normalizeCode(v) {
  return String(v ?? "").trim();
}

// Hex #rgb ou #rrggbb. Rejeita qualquer outra coisa (evita injeção de valor de estilo).
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export function isValidHexColor(v) {
  return HEX_RE.test(String(v ?? "").trim());
}

function mapRow(r) {
  return {
    id: r.id,
    partida: r.partida,
    chegada: r.chegada,
    veiculo: r.veiculo,
    cor: r.cor,
    updatedAt: r.updated_at ?? null,
  };
}

/** Lista todas as regras de cor. Tabela ausente → []. */
export async function listRouteColors({ deps = {} } = {}) {
  const run = deps.withPgClient || withPgClient;
  try {
    const rows = await run((client) =>
      client
        .query(
          `SELECT id, partida, chegada, veiculo, cor, updated_at
             FROM public.programacao_route_colors
            ORDER BY partida, chegada, veiculo`,
        )
        .then((r) => r.rows),
    );
    return rows.map(mapRow);
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/**
 * Cria ou atualiza a cor de uma rota (upsert por partida+chegada+veiculo). Valida os
 * campos e devolve a regra resultante. Lança Error com `.statusCode` em entrada inválida.
 */
export async function upsertRouteColor({ partida, chegada, veiculo, cor, operatorId = null, deps = {} } = {}) {
  const p = normalizeCode(partida);
  const c = normalizeCode(chegada);
  const v = normalizeVehicle(veiculo);
  const hex = String(cor ?? "").trim();
  if (!p || !c || !v) {
    const e = new Error("Informe partida, chegada e veículo.");
    e.statusCode = 400;
    throw e;
  }
  if (!isValidHexColor(hex)) {
    const e = new Error("Cor inválida — use um hex como #fde047.");
    e.statusCode = 400;
    throw e;
  }
  const run = deps.withPgTransaction || withPgTransaction;
  try {
    const row = await run(async (client) => {
      const res = await client.query(
        `INSERT INTO public.programacao_route_colors (partida, chegada, veiculo, cor, updated_by)
              VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (partida, chegada, veiculo)
         DO UPDATE SET cor = EXCLUDED.cor, updated_at = now(), updated_by = EXCLUDED.updated_by
          RETURNING id, partida, chegada, veiculo, cor, updated_at`,
        [p, c, v, hex, operatorId],
      );
      return res.rows[0];
    });
    return mapRow(row);
  } catch (err) {
    if (isMissingTable(err)) {
      const e = new Error("Cores da rota ainda não disponíveis (migration pendente).");
      e.statusCode = 503;
      throw e;
    }
    throw err;
  }
}

/** Remove uma regra por id. Devolve { deleted: boolean }. */
export async function deleteRouteColor({ id, deps = {} } = {}) {
  const rid = String(id ?? "").trim();
  if (!rid || !UUID_RE.test(rid)) {
    const e = new Error("id inválido.");
    e.statusCode = 400;
    throw e;
  }
  const run = deps.withPgClient || withPgClient;
  try {
    const deleted = await run(async (client) => {
      const res = await client.query(
        `DELETE FROM public.programacao_route_colors WHERE id = $1`,
        [rid],
      );
      return res.rowCount > 0;
    });
    return { deleted };
  } catch (err) {
    if (isMissingTable(err)) return { deleted: false };
    throw err;
  }
}
