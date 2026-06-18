import "../../infrastructure/config/load-env.js";
import { createSupabaseAdminClient } from "../../infrastructure/supabase/admin-client.js";
import { parseCsv, fetchGoogleSheetCsv } from "./google-sheet-loads.js";

const VINCULOS_TABLE = "driver_vinculos";
const DEFAULT_VINCULO_TAB = process.env.GOOGLE_SHEET_VINCULO_TAB?.trim() || "Vinculo";
const UPSERT_BATCH_SIZE = 200;

/**
 * Chave de junção entre o nome do motorista resolvido pela fila e o nome da aba
 * "Vinculo" da planilha. A aba não tem CPF, então casamos por NOME — e nomes
 * variam em acento/caixa/espaços entre as fontes (Angellira, ASPx, cadastro).
 *
 * Normalização: remove acentos (NFD), lowercase, colapsa qualquer espaço em
 * branco (inclui tab/nbsp) em um único espaço e faz trim. DEVE ser idêntica na
 * escrita (sync) e na leitura (read model), senão a junção falha silenciosamente.
 */
export function normalizeDriverNameKey(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeHeaderName(value) {
  return normalizeDriverNameKey(value);
}

/**
 * Localiza a linha de cabeçalho que contém as colunas "motoristas" e "vinculo"
 * e retorna os índices das colunas. Retorna null quando a aba não tem o formato
 * esperado (defensivo: gviz pode devolver outra aba se o nome mudar).
 */
function findVinculoHeader(rows) {
  for (let index = 0; index < rows.length; index += 1) {
    const normalized = rows[index].map((cell) => normalizeHeaderName(cell));
    const motoristaIdx = normalized.findIndex((h) => h === "motoristas" || h === "motorista");
    const vinculoIdx = normalized.findIndex((h) => h === "vinculo" || h === "vinculos");

    if (motoristaIdx !== -1 && vinculoIdx !== -1) {
      return { headerRowIndex: index, motoristaIdx, vinculoIdx };
    }
  }

  return null;
}

/**
 * Parseia o CSV da aba "Vinculo" em registros { nome_original, nome_normalizado,
 * vinculo }. Deduplica por nome normalizado (última ocorrência vence) e descarta
 * linhas-ruído (nome vazio, vínculo vazio, ou nome igual ao próprio vínculo —
 * ex.: célula "FROTA" sozinha que alimenta o dropdown da planilha).
 */
export function parseDriverVinculos(csvText) {
  const rows = parseCsv(csvText);
  const header = findVinculoHeader(rows);

  if (!header) {
    return [];
  }

  const { headerRowIndex, motoristaIdx, vinculoIdx } = header;
  const byKey = new Map();

  for (let index = headerRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const nomeOriginal = (row[motoristaIdx] ?? "").trim();
    const vinculo = (row[vinculoIdx] ?? "").replace(/\s+/g, " ").trim().toUpperCase();

    if (!nomeOriginal || !vinculo) {
      continue;
    }

    const nomeNormalizado = normalizeDriverNameKey(nomeOriginal);

    // Linha-ruído: nome igual ao vínculo (célula de dropdown "FROTA"/"PME"...).
    if (!nomeNormalizado || nomeNormalizado === normalizeDriverNameKey(vinculo)) {
      continue;
    }

    byKey.set(nomeNormalizado, {
      nome_normalizado: nomeNormalizado,
      nome_original: nomeOriginal,
      vinculo,
    });
  }

  return Array.from(byKey.values());
}

export function getVinculoSheetCsvUrl() {
  const sheetId = process.env.GOOGLE_SHEET_ID?.trim() || "";

  if (!sheetId) {
    return null;
  }

  // gviz por NOME da aba (estável): export?gid= exigiria descobrir o gid, e a
  // aba "Vinculo" (dados) coexiste com uma aba "Vínculo" (dashboard) — o nome
  // exato evita a colisão. gviz devolve text/csv sem autenticação para a
  // planilha link-pública (mesma premissa do sync de cargas).
  const tab = encodeURIComponent(DEFAULT_VINCULO_TAB);
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${tab}`;
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/**
 * Sincroniza a aba "Vinculo" para public.driver_vinculos: upsert dos registros
 * atuais + remoção dos que sumiram da planilha. No-op gracioso quando
 * GOOGLE_SHEET_ID não está configurado ou a aba não tem o formato esperado.
 */
export async function syncDriverVinculos({
  fetchImpl = globalThis.fetch,
  csvUrl = getVinculoSheetCsvUrl(),
  supabaseClient = createSupabaseAdminClient(),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required.");
  }

  if (!csvUrl) {
    console.warn("[driver-vinculos] GOOGLE_SHEET_ID nao configurado. Sync de vinculos ignorado.");
    return { skipped: true, reason: "GOOGLE_SHEET_ID_NOT_CONFIGURED", upserted: 0, deleted: 0 };
  }

  const csvText = await fetchGoogleSheetCsv(fetchImpl, csvUrl);
  const records = parseDriverVinculos(csvText);

  if (records.length === 0) {
    console.warn("[driver-vinculos] nenhuma linha valida na aba Vinculo. Sync abortado (no-op).");
    return { skipped: true, reason: "EMPTY_OR_INVALID_SHEET", upserted: 0, deleted: 0 };
  }

  const syncedAt = new Date().toISOString();

  for (const batch of chunk(records, UPSERT_BATCH_SIZE)) {
    const { error } = await supabaseClient
      .from(VINCULOS_TABLE)
      .upsert(
        batch.map((r) => ({ ...r, synced_at: syncedAt, updated_at: syncedAt })),
        { onConflict: "nome_normalizado" },
      );

    if (error) {
      throw error;
    }
  }

  // Remove vínculos que sumiram da planilha (motorista trocou de vínculo cuja
  // chave de nome mudou, ou foi removido da aba).
  const currentKeys = records.map((r) => r.nome_normalizado);
  const { error: deleteError, count: deleted } = await supabaseClient
    .from(VINCULOS_TABLE)
    .delete({ count: "exact" })
    .not("nome_normalizado", "in", `(${currentKeys.map((k) => `"${k.replace(/"/g, '""')}"`).join(",")})`);

  if (deleteError) {
    throw deleteError;
  }

  console.info(`[driver-vinculos] sync concluido: ${records.length} upserted, ${deleted ?? 0} removidos`);

  return { skipped: false, upserted: records.length, deleted: deleted ?? 0, csvUrl };
}

/**
 * Carrega o mapa nome_normalizado -> vinculo para o read model da fila.
 * Recebe um pg client (mesma transação do read model). NÃO captura erros: o
 * chamador deve envolver em runWithTransactionSavepoint para que um eventual
 * 42P01 (tabela ainda não migrada) faça ROLLBACK do savepoint sem poluir a
 * transação principal — degradando para um Map vazio sem badge de vínculo.
 */
export async function loadDriverVinculoMap(client) {
  const { rows } = await client.query(
    `SELECT nome_normalizado, vinculo FROM public.driver_vinculos`,
  );
  const map = new Map();
  for (const row of rows) {
    if (row.nome_normalizado) {
      map.set(row.nome_normalizado, row.vinculo);
    }
  }
  return map;
}
