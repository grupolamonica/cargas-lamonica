// backend/src/application/operator-admin/use-cases/reconcile-launched-cargo-schedule.js
//
// Passada de AGENDA (carregamento/descarga) para a carga LANÇADA
// (`cargas.lh_manual`, `sheet_lh` NULL), mantendo-a em dia com a fonte da viagem:
// portal SPX (Shopee, LH "LT…") e Projeto Galileu (Nestlé).
//
// POR QUE existe: o overlay do Monitor conserta o que a TELA mostra, mas
// `cargas.data`/`horario` continuam sendo o valor gravado UMA vez no lançamento —
// e são eles que governam o PORTAL DO MOTORISTA, a expiração
// (`expire-past-cargas`) e a ordenação. Sem esta passada, o operador vê o horário
// certo no Monitor e o motorista vê o velho no portal.
//
// O `launchCargoFromTrip` já tem um self-heal de agenda no caminho "já existe",
// mas ele só roda quando alguém LANÇA de novo — e o auto-lançamento
// (`auto-launch-routed-spots`) descarta os candidatos com `jaLancada`, então uma
// carga lançada nunca era revisitada. Medido em produção 04/08/2026: 10 das 34
// cargas Nestlé lançadas com agenda divergente da fonte (uma com um dia inteiro de
// diferença: sistema 03/08 16:00, Galileu 04/08 16:00) e 3 presas no placeholder
// "a confirmar" mesmo com o Galileu já tendo data real.
//
// ESCOPO — o que fica FORA, de propósito:
//   - carga da PLANILHA (`sheet_lh`): a agenda dela é do sync/write-back, não daqui;
//   - gêmea APOSENTADA (`retired_reason`) e CANCELLED/DRAFT: não são operáveis;
//   - EXPIRED: reviver carga expirada é decisão de ciclo de vida (mexe no que o
//     motorista enxerga), não de saneamento de agenda. Uma vez que a agenda passe a
//     acompanhar a fonte, o caso "expirou porque o placeholder ficou no passado"
//     deixa de ser criado;
//   - agenda que a fonte não conhece (sem match no índice) — nunca apaga o que está lá.
//
// GATE: `LAUNCHED_SCHEDULE_SYNC` = "off" (default) | "dry" | "on".
//   - off: no-op;
//   - dry: mede e loga o que MUDARIA, sem gravar;
//   - on: grava data/horario + os rótulos denormalizados e audita cada mudança.
// Escrever aqui move a agenda que o MOTORISTA vê, então o default é conservador:
// liga-se em "dry" primeiro, confere-se o log, depois "on".

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import {
  fetchSpxScheduleIndexFromSidecar,
  fetchSpxScheduleIndex,
  mergeLiveIndexes,
} from "./spx-schedule-overlay.js";
import { fetchNestleMonitorIndex, nestleIndexLookup } from "./nestle-monitor-overlay.js";

const BATCH_LIMIT = 300;

/** "off" (default) | "dry" | "on" */
export function launchedScheduleSyncMode() {
  const raw = String(process.env.LAUNCHED_SCHEDULE_SYNC ?? "").trim().toLowerCase();
  return raw === "on" || raw === "dry" ? raw : "off";
}

/**
 * DATE do pg → 'YYYY-MM-DD' (data de PAREDE).
 *
 * ATENÇÃO ao tipo: esta passada lê por `node-postgres`, que devolve DATE como
 * objeto **Date** (UTC-midnight) — não como string. `String(date).slice(0, 10)`
 * daria "Sun Aug 09", que nunca é igual a "2026-08-09": a comparação dava sempre
 * diferente e a passada reescrevia TODA carga lançada a cada ciclo (medido em
 * produção: 102 de 131 "mudariam" com nada mudado). O mapper do Monitor
 * (`list-system-cargas-monitor`) pode fatiar a string porque é alimentado pelo
 * PostgREST, que serializa a data como texto — aqui não.
 *
 * Aceita os dois formatos: Date (usa a data UTC, que é a de parede num DATE) e
 * string ISO/'YYYY-MM-DD'.
 */
function toDateIso(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
}

/** TIME do pg → 'HH:MM'. O driver devolve TIME como string ('18:00:00'). */
function toTimeIso(v) {
  if (!v) return null;
  return String(v).slice(0, 5);
}

/**
 * Instante canônico ('YYYY-MM-DDTHH:MM') a partir de QUALQUER das formas que as
 * colunas de rótulo aceitam. `sheet_data_descarga` guarda tanto 'YYYY-MM-DD HH:MM'
 * (espaço, como o sistema grava) quanto 'YYYY-MM-DDTHH:MM' e o legado BR
 * 'DD/MM/YYYY HH:MM' — `parseDescarga` em list-system-cargas-monitor.js lê as três.
 *
 * Comparar essas colunas como STRING é errado: a mesma agenda escrita com espaço em
 * vez de "T" parecia diferente e a passada reescrevia a carga em TODO ciclo, para
 * sempre (medido em prod: 2 cargas com data/hora/rótulo perfeitamente consistentes
 * eram marcadas como "mudariam" só por causa do separador). Rótulo sem instante
 * ("A confirmar") → null, que é justamente "precisa ser substituído".
 */
function canonicalLabel(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})[ ](\d{2}):(\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}`;
  return null;
}

/**
 * A agenda da carga precisa mudar? Puro/testável.
 *
 * Só compara o que a fonte AFIRMA: sem carga no índice, não há decisão a tomar
 * (devolve null) — apagar/zerar agenda a partir de um índice incompleto seria pior
 * que o valor velho. A descarga é opcional e independente: uma viagem pode ter
 * carregamento novo sem ETA de destino.
 *
 * RÓTULO NULL É PRESERVADO. `sheet_data_carregamento` nulo é estado deliberado — a
 * carga criada pelo Monitor não tem o campo e o front cai no fallback data+horário
 * (é a regra de `domain/cargo-schedule.js#syncedCarregamentoLabel`). Preencher aqui
 * mudaria de qual campo as telas leem, sem ninguém ter pedido.
 *
 * @param {{ data: any, horario: any, sheet_data_carregamento: string|null, sheet_data_descarga: string|null, agenda_a_confirmar: boolean|null }} cargo
 * @param {{ carga: {dateIso,timeIso,at}|null, descarga: {at}|null }} fonte
 * @returns {{ dataIso: string, timeIso: string, carregamentoLabel: string|null, descargaLabel: string|null,
 *             de: string, para: string, motivo: string }|null} null = nada a fazer
 */
export function diffLaunchedSchedule(cargo, fonte) {
  if (!fonte?.carga?.dateIso || !fonte.carga.timeIso) return null;
  const dataIso = fonte.carga.dateIso;
  const timeIso = fonte.carga.timeIso;
  const alvoCarreg = fonte.carga.at; // 'YYYY-MM-DDTHH:MM'
  const alvoDescarga = fonte.descarga?.at ?? null;

  const dataAtual = toDateIso(cargo.data);
  const horaAtual = toTimeIso(cargo.horario);
  const labelAtual = cargo.sheet_data_carregamento ?? null;

  const mudaAgenda = dataAtual !== dataIso || horaAtual !== timeIso;
  // O rótulo denormalizado tem de acompanhar as colunas canônicas mesmo quando elas
  // já estão certas: era exatamente por eles divergirem que a carga aparecia com um
  // horário no Monitor e outro no portal. Nulo fica nulo (ver doc acima).
  const mudaLabel = labelAtual != null && canonicalLabel(labelAtual) !== alvoCarreg;
  const mudaDescarga = alvoDescarga != null && canonicalLabel(cargo.sheet_data_descarga) !== alvoDescarga;
  // Placeholder ainda marcado como indefinido, mas a fonte já tem data real.
  const mudaFlag = cargo.agenda_a_confirmar === true;

  if (!mudaAgenda && !mudaLabel && !mudaDescarga && !mudaFlag) return null;
  const motivo = [
    mudaAgenda && "agenda",
    mudaLabel && "rótulo",
    mudaDescarga && "descarga",
    mudaFlag && "flag a-confirmar",
  ].filter(Boolean).join("+");
  return {
    dataIso,
    timeIso,
    // Nulo preservado; só grava rótulo em quem já tem um.
    carregamentoLabel: labelAtual == null ? null : alvoCarreg,
    // Só grava descarga quando de fato mudou — senão preserva o formato já gravado.
    descargaLabel: mudaDescarga ? alvoDescarga : null,
    de: `${dataAtual ?? "?"} ${horaAtual ?? "?"}${cargo.agenda_a_confirmar === true ? " (a confirmar)" : ""}`,
    para: `${dataIso} ${timeIso}`,
    motivo,
  };
}

/**
 * @param {{ correlationId?: string|null, deps?: object }} [opts]
 * @returns {Promise<{ ok: boolean, mode: string, checked: number, updated: number, skipped?: string }>}
 */
export async function reconcileLaunchedCargoSchedule({ correlationId = null, deps = {} } = {}) {
  const mode = launchedScheduleSyncMode();
  if (mode === "off") return { ok: true, skipped: "disabled", mode, checked: 0, updated: 0 };

  const run = deps.withPgClient || withPgClient;
  const getSidecar = deps.fetchSpxScheduleIndexFromSidecar || fetchSpxScheduleIndexFromSidecar;
  const getTorre = deps.fetchSpxScheduleIndex || fetchSpxScheduleIndex;
  const getNestle = deps.fetchNestleMonitorIndex || fetchNestleMonitorIndex;

  // Índices AO VIVO — os MESMOS que o Monitor usa (memoizados, então esta passada
  // costuma pegar o cache quente e não custa rede). Best-effort em cada ponta.
  const [sidecar, torre, nestle] = await Promise.all([
    Promise.resolve()
      .then(() => getSidecar({ correlationId }))
      .catch(() => null),
    Promise.resolve()
      .then(() => getTorre({ correlationId }))
      .catch(() => null),
    Promise.resolve()
      .then(() => getNestle({ correlationId }))
      .catch(() => null),
  ]);
  const spxIndex = mergeLiveIndexes(sidecar, torre);
  if (!spxIndex && !nestle) {
    return { ok: true, skipped: "no-index", mode, checked: 0, updated: 0 };
  }

  let resultado;
  try {
    resultado = await run(async (client) => {
      const { rows } = await client.query(
        `SELECT id, TRIM(lh_manual) AS lh, data, horario,
                sheet_data_carregamento, sheet_data_descarga, agenda_a_confirmar
           FROM public.cargas
          WHERE sheet_lh IS NULL
            AND NULLIF(TRIM(lh_manual), '') IS NOT NULL
            AND retired_reason IS NULL
            AND COALESCE(UPPER(status), '') NOT IN ('CANCELLED', 'DRAFT', 'EXPIRED')
          ORDER BY data DESC NULLS LAST, lh_manual ASC
          LIMIT ${BATCH_LIMIT}`,
      );

      const auditar = [];
      const exemplos = [];
      let updated = 0;

      for (const cargo of rows) {
        const lh = String(cargo.lh ?? "").trim();
        if (!lh) continue;
        // Shopee casa direto por trip_number; Nestlé pode ter LH multi-grupo
        // ("B101474063, B101473490") → lookup tolerante.
        const fonte = spxIndex?.get(lh) || nestleIndexLookup(nestle, lh);
        if (!fonte) continue;

        const diff = diffLaunchedSchedule(cargo, fonte);
        if (!diff) continue;

        updated++;
        if (exemplos.length < 8) exemplos.push(`${lh}: ${diff.de} → ${diff.para} [${diff.motivo}]`);

        if (mode === "on") {
          await client.query(
            `UPDATE public.cargas
                SET data = $2::date, horario = $3::time,
                    sheet_data_carregamento = COALESCE($4, sheet_data_carregamento),
                    sheet_data_descarga = COALESCE($5, sheet_data_descarga),
                    agenda_a_confirmar = false,
                    version = version + 1,
                    updated_at = now()
              WHERE id = $1`,
            [cargo.id, diff.dataIso, diff.timeIso, diff.carregamentoLabel, diff.descargaLabel],
          );
          auditar.push({ cargoId: cargo.id, lh, de: diff.de, para: diff.para, motivo: diff.motivo });
        }
      }

      // Mexer na agenda muda o que o motorista vê — vai para a auditoria (o
      // histórico da carga no painel sai do audit).
      for (const ev of auditar) {
        await insertSecurityAuditEvent(client, {
          eventType: "system.cargo.schedule_synced",
          actorRole: "system",
          resourceType: "cargo",
          resourceId: ev.cargoId,
          action: "update",
          outcome: "success",
          correlationId,
          metadata: {
            lh: ev.lh,
            motivo: "launched_schedule_sync",
            changes: [{ field: "carregamento", label: "Carregamento", before: ev.de, after: ev.para }],
            campos: ev.motivo,
          },
        }).catch(() => {});
      }

      return { checked: rows.length, truncado: rows.length >= BATCH_LIMIT, updated, exemplos };
    });
  } catch (err) {
    logStructuredEvent("warn", "launched-schedule-sync.query-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, mode, checked: 0, updated: 0 };
  }

  if (resultado.updated > 0 || resultado.truncado) {
    logStructuredEvent(mode === "dry" ? "warn" : "info", `launched-schedule-sync.${mode === "dry" ? "dry-run" : "aplicado"}`, {
      correlationId,
      checked: resultado.checked,
      mudariam: resultado.updated,
      truncado: resultado.truncado,
      exemplos: resultado.exemplos,
    });
  }

  return { ok: true, mode, checked: resultado.checked, updated: resultado.updated, truncado: resultado.truncado, exemplos: resultado.exemplos };
}
