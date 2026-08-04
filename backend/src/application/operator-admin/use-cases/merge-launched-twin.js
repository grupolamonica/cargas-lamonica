// Merge da ALOCAÇÃO da gêmea: os `alloc_*` da carga LANÇADA (lh_manual, sheet_lh
// NULL) passam para a carga da PLANILHA (sheet_lh), que é a canônica.
//
// POR QUE: uma mesma viagem SPX vive como DUAS cargas — a linha da planilha e a
// carga lançada pela Programação. A duplicidade é a causa raiz de uma família de
// defeitos já corrigidos um a um (write-back na chave errada, duplicação no Monitor,
// assign na linha vazia, status congelado, regressão do CTE na planilha). Enquanto as
// duas linhas existem, LEITURA e ESCRITA discordam sobre "qual é a carga do LH".
//
// POR QUE A CANÔNICA É A DA PLANILHA (e não a lançada "adotar" o `sheet_lh`):
// gravar `sheet_lh` numa carga lançada cria uma 2ª linha sob
// `idx_cargas_source_sheet_lh` (UNIQUE (COALESCE(sheet_source,''), sheet_lh)) e o
// upsert do sync (google-sheet-loads.js, `onConflict: "id"`) lança 23505 — o sync da
// FONTE INTEIRA morre a cada 5 min, e com ele a persistência do snapshot. Além disso a
// planilha já é o objeto que todo o resto casa (DC-316, openLhSet, write-back, sweep).
//
// GARANTIAS (todas verificadas contra o código dos consumidores):
//   * a perdedora NUNCA é apagada — as FKs de lead/evento são ON DELETE CASCADE e ela
//     é a pré-imagem do rollback;
//   * `lh_manual` da perdedora NUNCA é limpo — é o gate anti-duplo-lançamento da
//     Programação;
//   * os `alloc_*` da perdedora NUNCA são zerados — o marcador é que a tira do jogo;
//   * lead/candidatura NÃO são tocados nem re-apontados: a auditoria é append-only e o
//     histórico é costurado na LEITURA (união de resource_id), não reescrevendo o
//     passado. Gêmea com reserva/lead ativo é PULADA (a reserva do motorista vale mais
//     que a unificação);
//   * cancelamento não migra e, mais forte, o merge é BLOQUEADO quando o efetivo da
//     vencedora casa `%cancel%`: injetar motorista numa carga cancelada a torna alvo
//     instantâneo de `sweepCancelledCascades` (que não tem janela de data e roda no fim
//     do mesmo sync) — é o incidente que derrubou 39 motoristas da fila.
//
// GATE `TWIN_MERGE` = "off" (default) | "dry" | "on", no mesmo padrão de
// ASPX_STATUS_LAUNCHED. Em "dry" decide e devolve o plano, sem escrever nada.

import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";

/** Campos de alocação migráveis. `status` é tratado à parte (regra de cancelamento). */
const CAMPOS_MIGRAVEIS = [
  "alloc_motorista",
  "alloc_cavalo",
  "alloc_carreta",
  "alloc_tipo",
  "alloc_vinculo",
  "alloc_descricao",
  "alloc_tratativas",
  "alloc_checklist_cavalo",
  "alloc_checklist_carreta",
];

// Colunas lidas das duas pontas. `codigo_viagem` NÃO entra: é UNIQUE parcial e copiar
// colide; vai como `naoMigrado` no evento.
const COLUNAS = `id, sheet_lh, sheet_source, lh_manual, status,
  ${CAMPOS_MIGRAVEIS.join(", ")}, alloc_status,
  alloc_pinned, alloc_pinned_at, alloc_pinned_by, alloc_updated_at, alloc_updated_by,
  alloc_merged_into_cargo_id, sheet_motorista, sheet_status,
  reserved_public_lead_id, reserved_claim_id, reserved_driver_id, booked_driver_id,
  viagem_id, codigo_viagem, retired_reason`;

const trim = (v) => String(v ?? "").trim();
const ehCancelamento = (v) => /cancel|devolv|no[\s-]*show/i.test(trim(v));

/** "off" (default) | "dry" | "on" */
export function twinMergeMode() {
  const raw = String(process.env.TWIN_MERGE ?? "").trim().toLowerCase();
  return raw === "on" || raw === "dry" ? raw : "off";
}

/** Valor EFETIVO de alocação: `??` (COALESCE), igual ao Monitor — "" é decisão explícita. */
function efetivo(allocValue, sheetValue) {
  return trim(allocValue != null ? allocValue : sheetValue);
}

/**
 * Um campo do doador deve substituir o da vencedora?
 *
 * Regra (fecha os dois modos de falha que "vence o mais recente" produz):
 *   * só copia valor NÃO-VAZIO — um "" do doador nunca apaga valor da vencedora
 *     (era o defeito do #412: alloc_motorista "" mascarava o motorista da planilha);
 *   * só copia quando a vencedora não decidiu nada (NULL) OU quando o doador é
 *     ESTRITAMENTE mais novo — decisão nova da vencedora nunca é sobrescrita, o que
 *     também torna a passada idempotente.
 */
function deveCopiar(doador, vencedora, campo) {
  if (trim(doador[campo]) === "") return false;
  if (vencedora[campo] == null) return true;
  const d = doador.alloc_updated_at ? new Date(doador.alloc_updated_at).getTime() : 0;
  const w = vencedora.alloc_updated_at ? new Date(vencedora.alloc_updated_at).getTime() : 0;
  return d > w;
}

/** Motivo pelo qual a gêmea não pode ser mergeada agora (ou null). */
function motivoDeBloqueio(doador, vencedora, leadsAtivos) {
  // Cancelamento no DESTINO: injetar motorista aqui arma a cascata retroativa.
  if (ehCancelamento(efetivo(vencedora.alloc_status, vencedora.sheet_status))) return "cancel_no_destino";
  if (doador.reserved_public_lead_id) return "reserva_de_lead_na_perdedora";
  if (doador.reserved_claim_id) return "reserva_de_claim_na_perdedora";
  if (doador.reserved_driver_id) return "reserva_de_motorista_na_perdedora";
  if (doador.booked_driver_id) return "motorista_booked_na_perdedora";
  if (doador.viagem_id) return "perna_de_pacote_na_perdedora";
  if (leadsAtivos > 0) return "lead_ativo_na_perdedora";
  return null;
}

/**
 * Mergeia a alocação da gêmea lançada na carga canônica.
 *
 * Recebe o `client` da transação EM CURSO (não abre a própria): identidade e dado
 * mudam juntos, sob o mesmo `FOR UPDATE`. Idempotente: o marcador tira o LH do
 * universo e a regra de cópia não sobrescreve decisão mais nova da vencedora.
 *
 * @param {import("pg").PoolClient} client
 * @param {{ lh: string, winnerId: string, mode?: string, correlationId?: string|null,
 *           materialized?: boolean }} args
 * @returns {Promise<{ merged: boolean, mode: string, loserId: string|null,
 *   copiedFields: string[], skipped: string|null, naoMigrado: object }>}
 */
export async function mergeLaunchedTwinAlloc(client, { lh, winnerId, mode = twinMergeMode(), correlationId = null, materialized = false } = {}) {
  const vazio = { merged: false, mode, loserId: null, copiedFields: [], skipped: null, naoMigrado: {} };
  const lhTrim = trim(lh);
  if (mode === "off" || !lhTrim || !winnerId) return { ...vazio, skipped: mode === "off" ? "disabled" : "sem_lh_ou_vencedora" };

  // Doador: carga LANÇADA do LH. Prefere a VIVA; a lápide também é doadora legítima
  // (guarda a única cópia da decisão do operador em muitos pares), mas nunca é alvo.
  const { rows: doadores } = await client.query(
    `SELECT ${COLUNAS}
       FROM public.cargas
      WHERE lh_manual = $1 AND sheet_lh IS NULL AND id <> $2
        AND alloc_merged_into_cargo_id IS NULL
      ORDER BY (retired_reason IS NULL) DESC, (alloc_updated_at IS NOT NULL) DESC,
               alloc_updated_at DESC NULLS LAST, created_at ASC, id ASC
      LIMIT 1
      FOR UPDATE`,
    [lhTrim, winnerId],
  );
  const doador = doadores[0];
  if (!doador) return { ...vazio, skipped: "sem_gemea" };

  const { rows: vencedoras } = await client.query(
    `SELECT ${COLUNAS} FROM public.cargas WHERE id = $1 FOR UPDATE`,
    [winnerId],
  );
  const vencedora = vencedoras[0];
  if (!vencedora) return { ...vazio, loserId: doador.id, skipped: "vencedora_inexistente" };

  const { rows: leads } = await client.query(
    `SELECT count(*)::int AS n FROM public.load_public_leads
      WHERE load_id = $1 AND status IN ('PRE_REGISTERED', 'QUEUED', 'APPROVED')`,
    [doador.id],
  );
  const bloqueio = motivoDeBloqueio(doador, vencedora, leads[0]?.n ?? 0);
  if (bloqueio) return { ...vazio, loserId: doador.id, skipped: bloqueio };

  // Campos a copiar + o que fica de fora e por quê.
  const copiedFields = CAMPOS_MIGRAVEIS.filter((c) => deveCopiar(doador, vencedora, c));
  const naoMigrado = {};
  if (ehCancelamento(doador.alloc_status)) naoMigrado.status = trim(doador.alloc_status);
  else if (deveCopiar(doador, vencedora, "alloc_status")) copiedFields.push("alloc_status");
  if (trim(doador.codigo_viagem)) naoMigrado.codigoViagem = trim(doador.codigo_viagem);
  // "Fixo" só migra se a vencedora não estiver fixa (não desfixa decisão de lá).
  const migraPinned = doador.alloc_pinned === true && vencedora.alloc_pinned !== true;

  if (copiedFields.length === 0 && !migraPinned) {
    // Nada a migrar, mas a gêmea foi RECONHECIDA: marca para sair do universo (só no
    // modo "on"), senão o par seria reavaliado para sempre.
    if (mode === "on") await marcarPerdedora(client, doador.id, winnerId);
    return { ...vazio, loserId: doador.id, skipped: "nada_a_migrar", naoMigrado };
  }

  if (mode !== "on") {
    return { merged: false, mode, loserId: doador.id, copiedFields, skipped: null, naoMigrado };
  }

  const sets = copiedFields.map((c, i) => `${c} = $${i + 2}`);
  const vals = [winnerId, ...copiedFields.map((c) => doador[c])];
  if (migraPinned) {
    sets.push(`alloc_pinned = true`, `alloc_pinned_at = $${vals.length + 1}`, `alloc_pinned_by = $${vals.length + 2}`);
    vals.push(doador.alloc_pinned_at, doador.alloc_pinned_by);
  }
  // `alloc_updated_at` avança para o mais novo dos dois (é o carimbo da decisão que
  // passou a valer) e `alloc_updated_by` preserva a autoria do doador.
  // O máximo é calculado em JS: `GREATEST(..., to_timestamp(0))` não roda no harness
  // pg-mem (função nativa ausente) e os dois valores já estão em memória aqui.
  const maisNovo = [doador.alloc_updated_at, vencedora.alloc_updated_at]
    .filter(Boolean)
    .map((v) => new Date(v))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  sets.push(
    `alloc_updated_at = COALESCE($${vals.length + 1}::timestamptz, alloc_updated_at)`,
    `alloc_updated_by = COALESCE($${vals.length + 2}, alloc_updated_by)`,
    `updated_at = now()`,
  );
  vals.push(maisNovo ? maisNovo.toISOString() : null, doador.alloc_updated_by);

  await client.query(`UPDATE public.cargas SET ${sets.join(", ")} WHERE id = $1`, vals);
  await marcarPerdedora(client, doador.id, winnerId);

  // Auditoria APPEND-ONLY, no id da VENCEDORA (é onde o operador vai olhar). Nenhum
  // resource_id antigo é reescrito — o histórico da perdedora é costurado na leitura.
  await insertSecurityAuditEvent(client, {
    eventType: "system.cargo.twin_alloc_merged",
    actorRole: "system",
    resourceType: "cargo",
    resourceId: winnerId,
    action: "update",
    outcome: "success",
    correlationId,
    metadata: {
      lh: lhTrim,
      source: vencedora.sheet_source ?? null,
      // NÃO carregamos os ids das cargas aqui: `sanitizeLogPayload` trata qualquer
      // string de 32+ chars como segredo inline e grava "[REDACTED]" — um UUID em
      // metadata é sempre perdido (security-log.js, INLINE_SECRET_PATTERN). O elo
      // fica onde é confiável: `resource_id` (coluna, não sanitizada) aponta a
      // VENCEDORA, e `cargas.alloc_merged_into_cargo_id` aponta dela para a perdedora
      // — é por essa coluna que o rollback e o histórico costurado navegam.
      copiedFields,
      naoMigrado,
      materialized,
      // Pré-imagem das duas pontas (rollback e leitura forense).
      beforeWinner: snapshotAlloc(vencedora),
      beforeLoser: snapshotAlloc(doador),
    },
  });

  return { merged: true, mode, loserId: doador.id, copiedFields, skipped: null, naoMigrado };
}

/** Marca a perdedora. NÃO zera alloc_*, NÃO limpa lh_manual, NÃO apaga a linha. */
async function marcarPerdedora(client, loserId, winnerId) {
  await client.query(
    `UPDATE public.cargas
        SET alloc_merged_into_cargo_id = $2, alloc_merged_at = now(), updated_at = now()
      WHERE id = $1 AND alloc_merged_into_cargo_id IS NULL`,
    [loserId, winnerId],
  );
}

/** Pré-imagem dos alloc_* (placas incluídas: já vazam no metadata dos outros eventos). */
function snapshotAlloc(row) {
  const out = { status: row.alloc_status ?? null, pinned: row.alloc_pinned === true, updatedAt: row.alloc_updated_at ?? null };
  for (const c of CAMPOS_MIGRAVEIS) out[c.replace(/^alloc_/, "")] = row[c] ?? null;
  return out;
}

export const __TEST__ = { CAMPOS_MIGRAVEIS, deveCopiar, motivoDeBloqueio, ehCancelamento };
