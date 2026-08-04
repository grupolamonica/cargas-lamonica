import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { writeAllocationsToSheet, isSheetWritebackEnabled, formatSheetDateLabel } from "./sheet-writeback.js";

const RECONCILE_BATCH_LIMIT = 100;

// Nome do motorista a partir do validation_summary_json do lead (Angellira
// displayName) — mesma fonte usada pelo write-back de reserva (reflectReservationOnSheet).
//
// EGRESS: a query NÃO trafega mais o `validation_summary_json` inteiro (JSON do
// Angellira/ASPX, dezenas de KB por lead) só para ler UM campo — ela já devolve
// `angelira_display_name` extraído no SQL, com o mesmo caminho usado no resto do
// repo (`->'driver'->'angelira'->>'displayName'`, cf. operator-admin/handlers.js).
// Esta função continua aceitando o JSON cru para os chamadores/testes legados.
function angelliraDisplayName(validationSummaryJson) {
  let summary = validationSummaryJson;
  if (typeof summary === "string") {
    try {
      summary = JSON.parse(summary);
    } catch {
      summary = null;
    }
  }
  const name = summary?.driver?.angelira?.displayName;
  return typeof name === "string" && name.trim() ? name.trim() : "";
}

/**
 * Resolve o nome Angellira de uma linha da query. Prefere a coluna já extraída
 * no SQL (`angelira_display_name`); só cai no JSON cru quando a coluna não veio
 * (linha montada à mão em teste). Quando a coluna VEIO mas é NULL/vazia, o
 * resultado é "" — o SQL é autoritativo, não há JSON para reprocessar.
 */
function resolveAngelliraDisplayName(row) {
  if ("angelira_display_name" in row) {
    const extracted = row.angelira_display_name;
    return typeof extracted === "string" && extracted.trim() ? extracted.trim() : "";
  }
  return angelliraDisplayName(row.validation_summary_json);
}

/**
 * Auto-cura do write-back para a planilha (reconciliador).
 *
 * Grava na planilha as cargas que estão TOMADAS no sistema — reservadas por lead
 * (status RESERVED) OU com motorista alocado pelo operador (alloc_motorista) —
 * mas cuja linha na planilha está EM BRANCO (coluna motorista vazia). Cobre duas
 * classes:
 *   1) Carga da PLANILHA (sheet_lh): a linha já existe no snapshot mas está em
 *      branco → preenche motorista/veículo (update-only).
 *   2) Carga do SISTEMA (lh_manual, sheet_lh NULL) com motorista alocado no Monitor
 *      mas SEM linha na planilha — a "linha-casca" só é criada no lançamento quando
 *      a viagem está ACEITA, então spots lançados-não-aceitos (auto-lançamento
 *      DC-201) e depois alocados nunca apareciam na planilha. Aqui a linha é
 *      CRIADA-ou-preenchida (createIfMissing) com rota + agenda + motorista.
 *   3) Carga do SISTEMA cuja linha JÁ existe na planilha com STATUS em branco,
 *      enquanto o sistema tem o status → preenche só a célula vazia. A linha-casca
 *      nascia sem status/tipo e, para carga lançada (lh_manual), nada preenchia
 *      depois: o sync do ASPX (DC-316) só opera em carga da planilha (sheet_lh).
 *      Era o motivo de 37 das 41 linhas criadas em 03/08/2026 ficarem com STATUS
 *      vazio (e todas com TIPO vazio).
 *
 * Segurança:
 * - **Só preenche vazios**: o candidato precisa estar em branco na planilha
 *   (snapshot). NUNCA sobrescreve um motorista já presente (respeita o dado da
 *   fonte/Shopee). Para a carga do sistema, `sheet_has_driver` exclui os LHs que já
 *   foram escritos (o re-sync os traz de volta ao snapshot com motorista) — assim a
 *   linha não é re-gravada a cada ciclo.
 * - Na CRIAÇÃO, manda status/tipo EFETIVOS (alloc_* ?? sheet_*) — a linha nasce
 *   rotulada com o que o sistema já sabe.
 * - Em linha EXISTENTE, `status` só vai quando a célula da planilha está VAZIA.
 *   NUNCA re-rotula o que o operador digitou — o status da planilha é dele (e, para
 *   carga da planilha, do DC-316).
 * - Cap de {@link RECONCILE_BATCH_LIMIT} por classe/ciclo.
 * - Best-effort: nunca lança. Roda ao fim de cada sync, com o snapshot já fresco.
 *
 * Cobre o gap histórico (cargas tomadas antes do write-back existir/estar ligado
 * ou cujo POST falhou na hora, sem retry).
 */
export async function reconcileTakenCargosToSheet({ log } = {}) {
  if (!isSheetWritebackEnabled()) return { ok: true, skipped: true, reconciled: 0 };

  const warn = (event, data) =>
    log ? log("warn", event, data) : console.warn(`[reconcile-sheet] ${event}`, data);

  let rows = [];
  try {
    rows = await withPgClient(async (client) => {
      const result = await client.query(
        `
          -- Uma ÚNICA expansão do snapshot alimenta os três conjuntos (antes eram
          -- dois jsonb_array_elements sobre a mesma tabela = dois scans do JSON).
          WITH sheet_rows AS (
            SELECT (e->>'lh') AS lh,
                   COALESCE(TRIM(e->>'motoristas'), '') AS motorista,
                   COALESCE(TRIM(e->>'status'), '') AS status
            FROM public.sheet_monitor_snapshot s, jsonb_array_elements(s.rows_json) e
            WHERE COALESCE(TRIM(e->>'lh'), '') <> ''
          ),
          blank_sheet AS (
            SELECT DISTINCT lh FROM sheet_rows WHERE motorista = ''
          ),
          sheet_has_driver AS (
            SELECT DISTINCT lh FROM sheet_rows WHERE motorista <> ''
          ),
          -- LHs cujo STATUS está em branco na planilha. Uma linha por LH: com linha
          -- gêmea, só conta como vazio quando TODAS estão vazias — assim nunca
          -- escrevemos por cima de um valor que já existe em alguma delas.
          sheet_blank_status AS (
            SELECT lh FROM sheet_rows GROUP BY lh HAVING bool_and(status = '')
          )
          (
            -- (1) Carga da PLANILHA (sheet_lh) tomada, com a linha em branco → preenche.
            SELECT c.sheet_lh AS lh, c.sheet_source, false AS create_row,
                   c.alloc_motorista, c.alloc_cavalo, c.alloc_carreta,
                   NULL::text AS origem, NULL::text AS destino,
                   NULL::text AS carreg, NULL::text AS descarga,
                   l.horse_plate, l.trailer_plate,
                   -- Só o campo usado, não o JSON inteiro (egress).
                   l.validation_summary_json->'driver'->'angelira'->>'displayName'
                     AS angelira_display_name,
                   NULL::text AS status_efetivo, NULL::text AS tipo_efetivo
            FROM public.cargas c
            JOIN blank_sheet b ON b.lh = c.sheet_lh
            LEFT JOIN public.load_public_leads l ON l.id = c.reserved_public_lead_id
            WHERE c.sheet_lh IS NOT NULL AND c.sheet_lh <> ''
              AND (c.status = 'RESERVED' OR COALESCE(TRIM(c.alloc_motorista), '') <> '')
            LIMIT ${RECONCILE_BATCH_LIMIT}
          )
          UNION ALL
          (
            -- (2) Carga do SISTEMA (lh_manual, sem sheet_lh) com motorista alocado mas
            -- SEM linha na planilha (viagem não-aceita no lançamento) → cria-ou-preenche.
            -- sheet_has_driver exclui as já escritas (voltam ao snapshot com motorista).
            SELECT c.lh_manual AS lh, c.sheet_source, true AS create_row,
                   c.alloc_motorista, c.alloc_cavalo, c.alloc_carreta,
                   c.origem, c.destino,
                   c.sheet_data_carregamento AS carreg, c.sheet_data_descarga AS descarga,
                   NULL::text AS horse_plate, NULL::text AS trailer_plate,
                   NULL::text AS angelira_display_name,
                   COALESCE(NULLIF(TRIM(c.alloc_status), ''), NULLIF(TRIM(c.sheet_status), '')) AS status_efetivo,
                   COALESCE(NULLIF(TRIM(c.alloc_tipo), ''), NULLIF(TRIM(c.sheet_tipo), '')) AS tipo_efetivo
            FROM public.cargas c
            LEFT JOIN sheet_has_driver d ON d.lh = c.lh_manual
            WHERE c.sheet_lh IS NULL
              AND COALESCE(TRIM(c.lh_manual), '') <> ''
              AND COALESCE(TRIM(c.alloc_motorista), '') <> ''
              AND d.lh IS NULL
              -- Unificação da gêmea (TWIN_MERGE): esta linha já entregou seus alloc_*
              -- para a canônica. Sem este filtro, ela continuaria criando/preenchendo
              -- célula na planilha com o valor da PRÉ-imagem (nunca zerado de propósito),
              -- e o merge deixaria de ser estável — o valor descartado voltaria a
              -- reaparecer a cada ciclo.
              AND c.alloc_merged_into_cargo_id IS NULL
              -- Só linehaul SPX (LT…) → planilha Shopee. Carga lançada não persiste
              -- sheet_source (fica NULL → roteia p/ shopee); o gate LT evita criar um
              -- LH de outra fonte (ex.: Nestlé) na planilha errada. Rever quando o
              -- write-back Nestlé for ligado (aí resolver a fonte de verdade).
              AND upper(TRIM(c.lh_manual)) LIKE 'LT%'
            LIMIT ${RECONCILE_BATCH_LIMIT}
          )
          UNION ALL
          (
            -- (3) Carga do SISTEMA cuja linha JÁ existe na planilha com STATUS em
            -- branco, enquanto o sistema tem o status → preenche a célula vazia.
            -- Converge: gravada a célula, o LH sai deste ramo no ciclo seguinte.
            SELECT c.lh_manual AS lh, c.sheet_source, false AS create_row,
                   c.alloc_motorista, c.alloc_cavalo, c.alloc_carreta,
                   NULL::text AS origem, NULL::text AS destino,
                   NULL::text AS carreg, NULL::text AS descarga,
                   NULL::text AS horse_plate, NULL::text AS trailer_plate,
                   NULL::text AS angelira_display_name,
                   COALESCE(NULLIF(TRIM(c.alloc_status), ''), NULLIF(TRIM(c.sheet_status), '')) AS status_efetivo,
                   NULL::text AS tipo_efetivo
            FROM public.cargas c
            JOIN sheet_blank_status v ON v.lh = c.lh_manual
            WHERE c.sheet_lh IS NULL
              AND COALESCE(TRIM(c.lh_manual), '') <> ''
              AND COALESCE(TRIM(c.alloc_motorista), '') <> ''
              AND upper(TRIM(c.lh_manual)) LIKE 'LT%'
              AND COALESCE(NULLIF(TRIM(c.alloc_status), ''), NULLIF(TRIM(c.sheet_status), '')) IS NOT NULL
              -- Mesmo motivo do ramo (2): linha já mergeada fica fora.
              AND c.alloc_merged_into_cargo_id IS NULL
            LIMIT ${RECONCILE_BATCH_LIMIT}
          )
        `,
      );
      return result.rows;
    });
  } catch (err) {
    warn("query-failed", { message: err instanceof Error ? err.message : String(err) });
    return { ok: false, reconciled: 0 };
  }

  // Um LH pode vir de mais de um ramo (ex.: linha em branco na planilha E status
  // vazio) — o mapa junta os campos num único update por LH.
  const porLh = new Map();
  for (const row of rows) {
    const allocMotorista = (row.alloc_motorista ?? "").toString().trim();
    const motorista = allocMotorista || resolveAngelliraDisplayName(row);
    const cavalo = (row.alloc_cavalo ?? row.horse_plate ?? "").toString().trim();
    const carreta = (row.alloc_carreta ?? row.trailer_plate ?? "").toString().trim();
    // Nada resolvido para gravar → pula (não faz POST inútil).
    if (!motorista && !cavalo && !carreta) continue;
    const update = { lh: String(row.lh).trim(), source: row.sheet_source ?? null, motorista, cavalo, carreta };
    const statusEfetivo = (row.status_efetivo ?? "").toString().trim();
    const tipoEfetivo = (row.tipo_efetivo ?? "").toString().trim();
    // Carga do sistema sem linha na planilha → cria-ou-preenche (createIfMissing)
    // com rota + agenda; as datas viram o formato da planilha (DD/MM/YYYY HH:MM).
    if (row.create_row) {
      update.createIfMissing = true;
      update.origem = (row.origem ?? "").toString();
      update.destino = (row.destino ?? "").toString();
      update.dataCarregamento = formatSheetDateLabel(row.carreg);
      update.dataDescarga = formatSheetDateLabel(row.descarga);
      // A linha nasce ROTULADA com o que o sistema já sabe. Sem isso ela nascia com
      // STATUS e TIPO vazios e, para carga lançada (lh_manual), nada preenchia depois
      // — o sync do ASPX (DC-316) só opera em carga da planilha (sheet_lh).
      if (statusEfetivo) update.status = statusEfetivo;
      if (tipoEfetivo) update.tipo = tipoEfetivo;
    } else if (statusEfetivo) {
      // Linha existente: a query só devolve status quando a célula da planilha está
      // VAZIA — preenche o vazio, nunca re-rotula o que o operador digitou.
      update.status = statusEfetivo;
    }
    const anterior = porLh.get(update.lh);
    porLh.set(update.lh, anterior ? { ...anterior, ...update } : update);
  }

  const updates = [...porLh.values()];
  if (updates.length === 0) return { ok: true, reconciled: 0 };

  const res = await writeAllocationsToSheet(updates, { log }).catch((err) => ({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  }));

  // Registra os LHs cuja CRIAÇÃO foi pedida, para o próximo ciclo conferir se a
  // linha realmente nasceu (o Apps Script responde created:N mesmo quando não
  // grava — ver check-writeback-health.js). Best-effort: não afeta o resultado.
  // Só entram fontes com write-back LIGADO: sem URL o Apps Script nunca é chamado
  // (a linha some por configuração, não por falha) e o aviso seria falso todo dia.
  const criacoes = updates.filter((u) => u.createIfMissing && isSheetWritebackEnabled(u.source));
  if (res?.ok && criacoes.length > 0) {
    const { recordCreateAttempt } = await import("./check-writeback-health.js");
    await recordCreateAttempt(
      criacoes.map((u) => u.lh),
      { sources: criacoes.map((u) => u.source) },
    );
  }

  if (!res?.ok) {
    warn("writeback-failed", { attempted: updates.length, res });
    return { ok: false, attempted: updates.length, reconciled: 0 };
  }
  return { ok: true, reconciled: updates.length };
}
