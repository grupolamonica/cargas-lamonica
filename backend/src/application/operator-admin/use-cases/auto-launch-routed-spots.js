// backend/src/application/operator-admin/use-cases/auto-launch-routed-spots.js
//
// DC-201 / Epic DC-183 — "Spots automáticos no painel". Varre as viagens SPX da
// aba Planejado e LANÇA automaticamente (sem intervenção do operador) as que já
// têm TABELA DE PREÇO (rota) cadastrada no catálogo — assim elas aparecem sozinhas
// no portal do motorista. NÃO aceita no SPX: o aceite (acceptance_status 0→1)
// compromete a carga com a agência (SLA/financeiro) e continua sendo ação manual.
//
// Elegibilidade de um spot p/ auto-lançamento (duas famílias):
//   SPX/Shopee/Nestlé PLANEJADO:
//     - aba Planejado (viagem ainda ofertável)
//     - line-haul (LH "LT…") — só essas são viagens reais do SPX (Nestlé sempre true)
//   Nestlé ACEITA (Projeto Galileu):
//     - aba Aceito, fonte nestle-galileu, SEM motorista — a Nestlé aceita sozinha
//       (Galileu/robô); a carga aceita mas ainda sem caminhão é publicável no nosso
//       portal p/ achar motorista. (Nestlé aceita → lançar)
//   Em ambas:
//     - não atrasada (carregamento no futuro)
//     - ainda não lançada (jaLancada=false — dedup por lh_manual/sheet_lh)
//     - rota (origem→destino) casa uma linha de route_metrics_cache (tem valor)
//
// A carga é lançada via launch-cargo-from-trip (lh_manual, Cidade/UF limpo p/ casar
// a rota); com a rota cadastrada ela já nasce "ready" no portal (valor/métrica vêm
// ao vivo do catálogo). Idempotente: o launch deduplica por LH, então rodar em loop
// não duplica. Spots SEM rota são ignorados (o operador cadastra a rota e lança na
// tela, ou o próximo tick os pega depois que a rota existir).

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { fetchRouteCatalogMetricsByLoadId } from "./_shared.js";
import { getProgramacao } from "./get-programacao.js";
import { launchCargoFromTrip } from "./launch-cargo-from-trip.js";

const DEFAULT_MAX_PER_RUN = 50;

/**
 * @param {{ correlationId?: string, maxPerRun?: number, deps?: object }} args
 * @returns {Promise<{ ok: boolean, reason?: string, candidates: number, routed: number,
 *   launched: number, already: number, errors: number, deferred: number, results: object[] }>}
 */
export async function autoLaunchRoutedSpots({ correlationId, maxPerRun = DEFAULT_MAX_PER_RUN, deps = {} } = {}) {
  const getProg = deps.getProgramacao || getProgramacao;
  const launch = deps.launchCargoFromTrip || launchCargoFromTrip;
  const matchRoutes = deps.fetchRouteCatalogMetricsByLoadId || fetchRouteCatalogMetricsByLoadId;
  const run = deps.withPgClient || withPgClient;

  const empty = { ok: true, candidates: 0, routed: 0, launched: 0, already: 0, errors: 0, deferred: 0, results: [] };

  // Planejado (viagens ofertáveis) + Aceito (p/ pegar as Nestlé aceitas sem motorista).
  // A aba "aceito" também traz viagens SPX aceitas — que NUNCA viram candidato aqui
  // (só Nestlé aceita entra); é um custo pequeno (1 fetch a cada ciclo de ~5min) p/
  // alcançar as ofertas Nestlé aceitas, que só existem nessa aba. Se o SPX estiver
  // indisponível, o read model devolve 503 → no-op silencioso (mas se só o SPX cair e
  // a Nestlé responder, ainda processa).
  const prog = await getProg({ correlationId, tabs: ["planejado", "aceito"], deps });
  if (prog.statusCode !== 200) {
    return { ...empty, ok: false, reason: prog.payload?.error || "spx_unavailable" };
  }

  const rows = Array.isArray(prog.payload?.rows) ? prog.payload.rows : [];
  const candidates = rows.filter((r) => {
    // `r.data`: cargas SEM carregamento ("a confirmar") ficam manual-only — o operador
    // decide lançá-las; o auto-lançamento não publica agenda indefinida. Atrasadas e já
    // lançadas nunca entram.
    if (!r.data || r.expirada || r.jaLancada) return false;
    // SPX/Shopee/Nestlé planejado line-haul (comportamento original).
    if (r.tab === "planejado" && r.isLinehaul) return true;
    // Nestlé ACEITA aguardando caminhão. `podeLancar` (get-programacao) é a fonte única
    // da regra: oferta aceita (não desconhecida/nula), sem motorista e sem embarque
    // morto — nunca republica viagem cancelada/malformada.
    if (r.tab === "aceito" && r.source === "nestle-galileu" && r.podeLancar) return true;
    return false;
  });
  if (candidates.length === 0) return empty;

  // Quais candidatos têm rota cadastrada (casam route_metrics_cache pelo trecho).
  // Usa Cidade/UF limpo (não o rótulo "· TIPO", que não casa o catálogo).
  const routeRows = candidates.map((r) => ({
    id: r.lh,
    origem: r.origemCidadeUf || r.origem,
    destino: r.destinoCidadeUf || r.destino,
  }));
  const metricsByLh = await run((client) => matchRoutes(client, routeRows));
  const routed = candidates.filter((r) => metricsByLh.get(r.lh));
  if (routed.length === 0) return { ...empty, candidates: candidates.length };

  // Teto por ciclo (evita rajada); o excedente é pego no próximo tick. Nunca
  // truncamos em silêncio — o deferido é logado pelo chamador.
  const toLaunch = routed.slice(0, Math.max(1, maxPerRun));
  const deferred = Math.max(0, routed.length - toLaunch.length);

  const results = [];
  for (const r of toLaunch) {
    try {
      const res = await launch({
        lh: r.lh,
        origem: r.origemCidadeUf || r.origem,
        destino: r.destinoCidadeUf || r.destino,
        data: r.data,
        horario: r.horario ?? undefined,
        dataDescarga: r.dataDescarga ?? undefined,
        horarioDescarga: r.horarioDescarga ?? undefined,
        nome: r.nome || undefined,
        correlationId,
        deps,
      });
      results.push({ lh: r.lh, state: res.payload?.alreadyExists ? "already" : "launched", id: res.payload?.id ?? null });
    } catch (err) {
      results.push({ lh: r.lh, state: "error", reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    ok: true,
    candidates: candidates.length,
    routed: routed.length,
    launched: results.filter((r) => r.state === "launched").length,
    already: results.filter((r) => r.state === "already").length,
    errors: results.filter((r) => r.state === "error").length,
    deferred,
    results,
  };
}
