// backend/src/application/operator-admin/use-cases/notify-new-spots.js
//
// DC-279 — Notificação de spot. Varre o feed da Programação (mesmo recorte de
// "spot disponível" do auto-lançamento) e, para cada spot novo cuja ROTA o
// operador marcou p/ alertar (programacao_settings.spot_alert_route_keys),
// insere uma notificação `new_spot` em operator_notifications. O sino do operador
// (polling 30s, presente em toda tela) pega a notificação e — no cliente — dispara
// som + notificação do navegador. NÃO aceita/lança nada: o aceite segue manual na
// tela de Programação (a notificação leva o operador até lá).
//
// Dedup: não renotifica um LH já notificado nas últimas 24h (janela — um spot que
// some e reaparece depois disso volta a alertar, aceitável).

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { createRouteLookupKeys } from "../../../domain/operator-admin/route-utils.js";
import { getProgramacao } from "./get-programacao.js";
import { getSpotAlertRouteKeys } from "./programacao-settings.js";

const DEDUP_WINDOW_HOURS = 24;
const MAX_PER_RUN = 20;

// Recorte de "spot disponível": planejado line-haul ofertável, ou Nestlé aceita
// sem caminhão; nunca atrasado/sem data. NÃO filtra por `jaLancada`: o
// auto-lançamento (DC-201) publica o spot no portal mas NÃO aceita no SPX — o
// operador ainda precisa aceitar, então o alerta continua valendo. O dedup por LH
// (24h) evita renotificar. Sem isto, o auto-launch (5min) marcava jaLancada antes
// do notifier (3min) e ~40% dos alertas nunca disparavam (review DC-279 #3).
function isAvailableSpot(r) {
  if (!r.data || r.expirada) return false;
  if (r.tab === "planejado" && r.isLinehaul) return true;
  if (r.tab === "aceito" && r.source === "nestle-galileu" && r.podeLancar) return true;
  return false;
}

/**
 * @returns {Promise<{ ok: boolean, reason?: string, candidates: number, matched: number,
 *   notified: number, skipped: number }>}
 */
export async function notifyNewSpots({ correlationId, deps = {} } = {}) {
  const getProg = deps.getProgramacao || getProgramacao;
  const getKeys = deps.getSpotAlertRouteKeys || getSpotAlertRouteKeys;
  const run = deps.withPgClient || withPgClient;

  const empty = { ok: true, candidates: 0, matched: 0, notified: 0, skipped: 0, deferred: 0 };

  // Nenhuma rota marcada → feature inerte (não faz fetch do feed à toa).
  const alertKeys = await getKeys({ deps });
  if (!Array.isArray(alertKeys) || alertKeys.length === 0) {
    return { ...empty, reason: "no_routes_selected" };
  }
  const alertSet = new Set(alertKeys);

  const prog = await getProg({ correlationId, tabs: ["planejado", "aceito"], deps });
  if (prog.statusCode !== 200) {
    return { ...empty, ok: false, reason: prog.payload?.error || "spx_unavailable" };
  }
  const rows = Array.isArray(prog.payload?.rows) ? prog.payload.rows : [];

  // Spots disponíveis cujo trecho (Cidade/UF) casa uma rota selecionada. Usa a
  // MESMA normalização (createRouteLookupKeys) do catálogo/route_metrics_cache, e
  // as keys selecionadas vêm de origin_key|destination_key — casam por construção.
  const matchedRaw = [];
  for (const r of rows) {
    if (!isAvailableSpot(r)) continue;
    const keys = createRouteLookupKeys(r.origemCidadeUf || r.origem, r.destinoCidadeUf || r.destino);
    const routeKey = keys.find((k) => alertSet.has(k));
    if (routeKey && r.lh) matchedRaw.push({ row: r, routeKey });
  }
  // Dedup dentro da MESMA leva: o feed pode repetir o mesmo LH (ex.: linhas por
  // perna/perfil); sem isso inseriríamos notificações duplicadas (review DC-279 #5).
  const matched = Array.from(new Map(matchedRaw.map((m) => [m.row.lh, m])).values());
  if (matched.length === 0) return { ...empty };

  const lhs = matched.map((m) => m.row.lh);
  const alreadyLhs = await run((client) =>
    client
      .query(
        `SELECT DISTINCT metadata->>'lh' AS lh
           FROM public.operator_notifications
          WHERE kind = 'new_spot'
            AND created_at > now() - make_interval(hours => $1)
            AND metadata->>'lh' = ANY($2::text[])`,
        [DEDUP_WINDOW_HOURS, lhs],
      )
      .then((res) => new Set(res.rows.map((x) => x.lh)))
      .catch((err) => {
        if (err?.code === "42P01") return new Set(); // tabela ausente → sem dedup histórico
        throw err;
      }),
  );

  const notYet = matched.filter((m) => !alreadyLhs.has(m.row.lh));
  const skipped = matched.length - notYet.length; // já notificados nas últimas 24h
  const fresh = notYet.slice(0, MAX_PER_RUN);
  const deferred = notYet.length - fresh.length; // excedente do teto por ciclo (pego no próximo)
  if (fresh.length === 0) {
    return { ...empty, candidates: matched.length, matched: matched.length, skipped, deferred };
  }

  await run(async (client) => {
    for (const { row: r, routeKey } of fresh) {
      const origem = r.origemCidadeUf || r.origem;
      const destino = r.destinoCidadeUf || r.destino;
      const quando = [r.data, r.horario].filter(Boolean).join(" ");
      await client.query(
        `INSERT INTO public.operator_notifications (kind, title, body, metadata)
         VALUES ('new_spot', $1, $2, $3::jsonb)`,
        [
          `Nova carga spot: ${origem} → ${destino}`,
          quando ? `${quando} · aceite na Programação` : "Disponível na Programação",
          JSON.stringify({
            lh: r.lh,
            origem,
            destino,
            data: r.data ?? null,
            horario: r.horario ?? null,
            route_key: routeKey,
            source: r.source ?? "spx",
            correlation_id: correlationId || null,
          }),
        ],
      );
    }
  });

  return {
    ok: true,
    candidates: matched.length,
    matched: matched.length,
    notified: fresh.length,
    skipped,
    deferred,
  };
}
