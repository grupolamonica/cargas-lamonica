// backend/src/application/operator-admin/use-cases/notify-new-queue-drivers.js
//
// DC-299 — Alerta de novo motorista na FILA. Detecta motoristas que ENTRARAM na fila há
// pouco (lead QUEUED com queued_at recente) e insere uma notificação `new_queue_driver`
// em operator_notifications. O sino do operador (polling 30s, toda tela) pega a
// notificação e — no cliente — dispara bip + 1 aviso de voz + notificação do navegador +
// toast, e leva à Fila (/leads?carga=...). NÃO aprova/aloca nada.
//
// Mesmo padrão do DC-279/DC-288 (notify-new-spots): dedup por lead_id (24h); janela
// LOOKBACK curta p/ não alertar o BACKLOG inteiro da fila no 1º ciclo (só quem acabou de
// entrar). Kill-switch e cadência no main.js.
//
// EGRESS: este scanner roda 24/7 (a cada ~3min), então usa uma query LEVE — só os leads
// QUEUED recém-entrados (poucas linhas), SEM os JOINs pesados do read model da tela da Fila
// (cargas_casadas/clientes/pacotes/grupo). Reaproveita apenas a cadeia de nome do motorista
// (validation_summary_json → aspx_drivers → pending_driver_registrations).

import { withPgClient } from "../../../infrastructure/pg/postgres.js";

const DEDUP_WINDOW_HOURS = 24;
// Só alerta quem entrou na fila nos últimos N min — evita alertar toda a fila existente
// no primeiro ciclo após deploy (só motorista "novo" de verdade).
const LOOKBACK_MIN = 20;
const MAX_PER_RUN = 20;

// Mesma cadeia de fallback do read model (resolveLeadDriverName): Angellira → ASPx →
// cadastro pendente. `null` → o chamador cai no telefone.
function resolveDriverName(row) {
  let summary = row.validation_summary_json;
  if (typeof summary === "string") {
    try {
      summary = JSON.parse(summary);
    } catch {
      summary = null;
    }
  }
  const angelira = summary?.driver?.angelira?.displayName;
  if (typeof angelira === "string" && angelira.trim()) return angelira.trim();
  if (typeof row.aspx_display_name === "string" && row.aspx_display_name.trim()) return row.aspx_display_name.trim();
  if (typeof row.pdr_display_name === "string" && row.pdr_display_name.trim()) return row.pdr_display_name.trim();
  return null;
}

/**
 * @returns {Promise<{ ok: boolean, reason?: string, candidates: number, notified: number, skipped: number }>}
 */
export async function notifyNewQueueDrivers({ correlationId, deps = {} } = {}) {
  const run = deps.withPgClient || withPgClient;
  const lookbackMin = deps.lookbackMin ?? LOOKBACK_MIN;
  const empty = { ok: true, candidates: 0, notified: 0, skipped: 0 };

  try {
    return await run(async (client) => {
      // 1) Leads que ENTRARAM na fila há < LOOKBACK (query leve — filtro por queued_at no SQL).
      const { rows: candidates } = await client.query(
        `SELECT leads.id, leads.load_id, leads.phone,
                cargas.origem AS load_origem, cargas.destino AS load_destino,
                leads.validation_summary_json,
                ad.display_name AS aspx_display_name,
                pdr.nome_motorista AS pdr_display_name
           FROM public.load_public_leads AS leads
           INNER JOIN public.cargas ON cargas.id = leads.load_id
           LEFT JOIN public.aspx_drivers AS ad ON ad.cpf = leads.cpf
           LEFT JOIN (
             SELECT DISTINCT ON (dados->'motorista'->>'cpf')
                    dados->'motorista'->>'cpf' AS cpf,
                    dados->'motorista'->>'nome' AS nome_motorista
               FROM public.pending_driver_registrations
              WHERE status IN ('pendente','em_revisao','em_analise','submitted','draft')
              ORDER BY dados->'motorista'->>'cpf', created_at DESC
           ) AS pdr ON pdr.cpf = leads.cpf
          WHERE leads.status = 'QUEUED'
            AND leads.queued_at IS NOT NULL
            AND leads.queued_at > now() - make_interval(mins => $1)
          ORDER BY leads.queued_at ASC
          LIMIT 100`,
        [lookbackMin],
      );
      if (candidates.length === 0) return { ...empty };

      // 2) Dedup: não renotifica um lead já notificado nas últimas 24h.
      const ids = candidates.map((c) => String(c.id));
      const { rows: dupRows } = await client.query(
        `SELECT DISTINCT metadata->>'lead_id' AS id
           FROM public.operator_notifications
          WHERE kind = 'new_queue_driver'
            AND created_at > now() - make_interval(hours => $1)
            AND metadata->>'lead_id' = ANY($2::text[])`,
        [DEDUP_WINDOW_HOURS, ids],
      );
      const already = new Set(dupRows.map((x) => x.id));

      const fresh = candidates.filter((c) => !already.has(String(c.id))).slice(0, MAX_PER_RUN);
      const skipped = candidates.length - fresh.length;
      if (fresh.length === 0) return { ...empty, candidates: candidates.length, skipped };

      // 3) Insere as notificações.
      for (const c of fresh) {
        const nome = String(resolveDriverName(c) || c.phone || "Motorista").trim();
        const origem = c.load_origem || "";
        const destino = c.load_destino || "";
        const rota = [origem, destino].filter(Boolean).join(" → ");
        await client.query(
          `INSERT INTO public.operator_notifications (kind, title, body, metadata)
           VALUES ('new_queue_driver', $1, $2, $3::jsonb)`,
          [
            `Novo motorista na fila: ${nome}`,
            rota ? `${rota} · veja na Fila` : "Veja na Fila",
            JSON.stringify({
              lead_id: String(c.id),
              carga_id: c.load_id ?? null,
              driver: nome,
              origem: origem || null,
              destino: destino || null,
              correlation_id: correlationId || null,
            }),
          ],
        );
      }
      return { ok: true, candidates: candidates.length, notified: fresh.length, skipped };
    });
  } catch (err) {
    // Tabela/coluna ausente (migration atrasada) ou fila indisponível (schema drift):
    // no-op silencioso — o chamador (main.js) só loga, não derruba o processo.
    return { ...empty, ok: false, reason: err?.code === "42P01" ? "table_missing" : err?.message || "queue_unavailable" };
  }
}
