// backend/src/application/google-sheets/check-writeback-health.js
//
// Vigia o BURACO SILENCIOSO do write-back: o Apps Script responde
// `{ok:true, created:N}` e a linha NÃO nasce na planilha. Provado em prod em
// 03/08/2026 — teste pelo próprio código do backend devolveu `created:1` e o LH não
// apareceu em nenhuma das 12 abas; o caminho de UPDATE, no mesmo teste, gravou
// normalmente (`updated:1`). Ou seja: o script escreve na planilha certa, mas o
// trecho de CRIAÇÃO reporta sucesso sem gravar.
//
// Sem esta verificação o problema fica invisível: o backend registra sucesso, o
// operador só descobre quando a Shopee cobra a carga que não está na planilha —
// foram 4 dias e 37 cargas até alguém notar.
//
// COMO FUNCIONA (fecha o ciclo, não confia na resposta do script):
//   1. depois de pedir criação, guarda em app_settings os LHs pedidos + o instante;
//   2. no ciclo seguinte, com o snapshot da planilha JÁ RELIDO depois daquele
//      instante, confere quais LHs continuam sem linha;
//   3. se sobrou algum, avisa o operador no sino (kind sheet_writeback_broken) e
//      loga alto. Um aviso por janela (default 6h) — não vira spam.
//
// A verificação NÃO escreve na planilha e NÃO altera carga: só compara e avisa.

import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../infrastructure/security-log.js";
import { ensureAppSettingsTable } from "../operator-admin/use-cases/angellira/auto-approve-vigentes.js";

const SETTING_KEY = "sheet_writeback_pending_create";

// A tabela já existe em prod; a garantia é só para ambiente novo. Se o DDL falhar
// (harness de teste não aceita todos os construtores), segue em frente — a query
// seguinte é que decide.
async function garantirAppSettings(client) {
  try {
    await ensureAppSettingsTable(client);
  } catch {
    /* noop */
  }
}

/** Mesma normalização do write-back: só "nestle" é outra planilha; o resto é shopee. */
function normSourceKey(source) {
  return String(source ?? "").trim().toLowerCase() === "nestle" ? "nestle" : "shopee";
}

function realertHours() {
  const n = Number(process.env.SHEET_WRITEBACK_ALERT_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

/**
 * Registra os LHs cuja CRIAÇÃO acabou de ser pedida ao Apps Script, para o ciclo
 * seguinte conferir se chegaram. Best-effort: nunca lança (não pode derrubar o sync).
 */
export async function recordCreateAttempt(lhs, { sources = [], deps = {} } = {}) {
  const run = deps.withPgClient || withPgClient;
  const lista = [...new Set((lhs || []).map((v) => String(v ?? "").trim()).filter(Boolean))];
  if (lista.length === 0) return { ok: true, recorded: 0 };
  // Fontes envolvidas (cargas.sheet_source; nulo = shopee, padrão histórico). A
  // conferência só conclui quando o snapshot DE CADA fonte foi relido — as fontes
  // sincronizam em momentos diferentes (medido em prod: 5min de defasagem entre
  // shopee e nestle), então olhar "o snapshot mais novo" daria aviso falso quando
  // a leitura de uma fonte falha e a da outra não.
  const fontes = [...new Set((sources.length > 0 ? sources : [null]).map(normSourceKey))];
  try {
    await run(async (client) => {
      await garantirAppSettings(client);
      // UPDATE-então-INSERT em vez de ON CONFLICT com expressão: mesma semântica e
      // portável para o harness de teste.
      const payload = JSON.stringify({ at: new Date().toISOString(), lhs: lista, fontes });
      const { rowCount } = await client.query(
        `UPDATE public.app_settings SET value = $2::jsonb, updated_at = now(),
                updated_by = 'sheet-writeback-health' WHERE key = $1`,
        [SETTING_KEY, payload],
      );
      if (rowCount === 0) {
        await client.query(
          `INSERT INTO public.app_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)`,
          [SETTING_KEY, payload, "sheet-writeback-health"],
        );
      }
    });
    return { ok: true, recorded: lista.length };
  } catch (err) {
    logStructuredEvent("warn", "sheet-writeback-health.record-failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, recorded: 0 };
  }
}

/**
 * Confere a tentativa anterior contra o snapshot RELIDO e avisa se as linhas não
 * chegaram. Roda ao fim do sync, depois de o snapshot ser atualizado.
 *
 * @returns {Promise<{ ok: boolean, skipped?: string, pedidas: number, faltando: number,
 *   avisou: boolean }>}
 */
export async function checkWritebackHealth({ correlationId = null, deps = {} } = {}) {
  const run = deps.withPgClient || withPgClient;
  if (process.env.SHEET_WRITEBACK_HEALTH_ENABLED === "false") {
    return { ok: true, skipped: "disabled", pedidas: 0, faltando: 0, avisou: false };
  }

  try {
    return await run(async (client) => {
      await garantirAppSettings(client);
      const { rows: cfg } = await client.query(
        `SELECT value FROM public.app_settings WHERE key = $1`,
        [SETTING_KEY],
      );
      const valor = cfg[0]?.value ?? null;
      const guardado = typeof valor === "string" ? JSON.parse(valor) : valor || {};
      const at = guardado.at ?? null;
      const lhs = Array.isArray(guardado.lhs) ? guardado.lhs.map((v) => String(v)) : [];
      // Tentativa gravada antes deste campo existir → shopee (era a única fonte com
      // write-back ligado).
      const fontes = Array.isArray(guardado.fontes) && guardado.fontes.length > 0
        ? [...new Set(guardado.fontes.map(normSourceKey))]
        : ["shopee"];
      if (!at || lhs.length === 0) {
        return { ok: true, skipped: "sem-tentativa-registrada", pedidas: 0, faltando: 0, avisou: false };
      }

      // O snapshot DE CADA fonte envolvida precisa ter sido RELIDO depois da
      // tentativa, senão a conferência é inconclusiva (foi assim que uma checagem
      // manual errou por 25 segundos). Uma fonte sem snapshot ou com leitura
      // atrasada segura a conclusão — nunca vira aviso.
      const { rows: snapRows } = await client.query(
        `SELECT source, synced_at, rows_json FROM public.sheet_monitor_snapshot`,
      );
      const daFonte = new Map(snapRows.map((r) => [normSourceKey(r.source), r]));
      const desatualizadas = fontes.filter((f) => {
        const s = daFonte.get(f);
        return !s?.synced_at || new Date(s.synced_at).getTime() <= new Date(at).getTime();
      });
      if (desatualizadas.length > 0) {
        return {
          ok: true,
          skipped: "snapshot-anterior-a-tentativa",
          fontesDesatualizadas: desatualizadas,
          pedidas: lhs.length,
          faltando: 0,
          avisou: false,
        };
      }

      // Quais dos LHs pedidos continuam SEM linha na planilha? Só os snapshots das
      // fontes envolvidas contam. A comparação é em JS (o snapshot é um jsonb único
      // por fonte) — evita SQL exótico e fica legível.
      const chegaram = new Set();
      for (const f of fontes) {
        const bruto = daFonte.get(f)?.rows_json;
        const lista = typeof bruto === "string" ? JSON.parse(bruto) : bruto;
        for (const linha of Array.isArray(lista) ? lista : []) {
          const lh = String(linha?.lh ?? "").trim();
          if (lh) chegaram.add(lh);
        }
      }
      const faltando = lhs.filter((lh) => !chegaram.has(lh));

      // Tentativa conferida — limpa para não reavaliar a mesma leva.
      await client.query("DELETE FROM public.app_settings WHERE key = $1", [SETTING_KEY]);

      if (faltando.length === 0) {
        logStructuredEvent("info", "sheet-writeback-health.ok", {
          correlationId,
          pedidas: lhs.length,
        });
        return { ok: true, pedidas: lhs.length, faltando: 0, avisou: false };
      }

      logStructuredEvent("error", "sheet-writeback-health.linhas-nao-criadas", {
        correlationId,
        fontes,
        pedidas: lhs.length,
        faltando: faltando.length,
        exemplos: faltando.slice(0, 5),
      });

      // Um aviso por janela — o problema é persistente (dura dias), não vale
      // repetir a cada 5 minutos.
      const cutoff = new Date(Date.now() - realertHours() * 3600_000).toISOString();
      const { rows: recente } = await client.query(
        `SELECT 1 FROM public.operator_notifications
          WHERE kind = 'sheet_writeback_broken' AND created_at > $1 LIMIT 1`,
        [cutoff],
      );
      if (recente.length > 0) {
        return { ok: true, pedidas: lhs.length, faltando: faltando.length, avisou: false };
      }

      await client.query(
        `INSERT INTO public.operator_notifications (kind, title, body, metadata)
         VALUES ('sheet_writeback_broken', $1, $2, $3::jsonb)`,
        [
          `Planilha não recebeu ${faltando.length} carga(s) que o sistema enviou`,
          "O sistema pediu a criação das linhas e o script da planilha confirmou, mas elas não apareceram. As cargas estão certas no sistema — a planilha está sem elas.",
          JSON.stringify({
            fontes,
            pedidas: lhs.length,
            faltando: faltando.length,
            lhs: faltando.slice(0, 50),
            correlation_id: correlationId || null,
          }),
        ],
      );
      return { ok: true, pedidas: lhs.length, faltando: faltando.length, avisou: true };
    });
  } catch (err) {
    logStructuredEvent("warn", "sheet-writeback-health.check-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, pedidas: 0, faltando: 0, avisou: false };
  }
}
