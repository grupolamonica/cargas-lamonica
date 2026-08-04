import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { fetchRouteCatalogMetricsByLoadId } from "../operator-admin/use-cases/_shared.js";

const RECONCILE_BATCH_LIMIT = 200;
// Divergência de distância acima da qual as métricas gravadas são consideradas de
// OUTRA rota (não da rota atual da carga). 15% = folga p/ pequenas diferenças de
// catálogo entre perfis do mesmo trecho; os casos reais divergem >100% (ex.: 28km
// numa rota de 784km).
const STALE_DISTANCE_RATIO = 0.15;

// Universo de cargas candidatas — idêntico nas duas fases (agrupamento e coleta),
// para que a fase 2 não possa incluir carga que a fase 1 não teria examinado.
const CANDIDATE_CARGO_WHERE = `status NOT IN ('CANCELLED', 'COMPLETED', 'FAILED')
            AND (sheet_lh IS NOT NULL OR lh_manual IS NOT NULL)
            AND COALESCE(TRIM(origem), '') <> ''
            AND COALESCE(TRIM(destino), '') <> ''
            AND distancia_km IS NOT NULL
            -- Unificação da gêmea: a perdedora já mergeada fica FORA — sem isso ela
            -- continua consumindo o batch e recebendo \`valor\` recalculado numa
            -- linha morta, invisível ao Monitor/portal.
            AND alloc_merged_into_cargo_id IS NULL`;

const toNum = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Auto-cura de PREÇO/MÉTRICAS defasados na carga (reconciliador).
 *
 * Quando o destino de uma viagem muda DEPOIS de a carga já existir, o sync
 * atualiza origem/destino mas PRESERVA valor/bônus/distância/duração antigos
 * (DC-240 trata valor não-nulo como "edição do operador", só faz backfill quando
 * o campo está vazio). Resultado: a carga fica com o preço de OUTRA rota — ex.:
 * `Simões Filho → Jaboatão` (784km) exibindo R$600/28km da rota `Simões → Salvador`.
 * A mesma armadilha existe na carga lançada (lh_manual): o self-heal do lançamento
 * também preserva o valor não-nulo.
 *
 * Aqui detectamos a defasagem pelo sinal OBJETIVO "a distância GRAVADA diverge
 * >{@link STALE_DISTANCE_RATIO} da distância da rota ATUAL" — o operador nunca edita
 * distância (ela é sempre denormalizada do catálogo), então divergência de distância
 * = métricas de outra rota. Nesses casos re-derivamos valor/bônus/distância/duração
 * do catálogo. NÃO tocamos cargas cujo valor difere mas a distância BATE (edição de
 * preço legítima do operador OU atualização de tabela no catálogo) — só o valor
 * diferente NÃO é sinal de defasagem de rota.
 *
 * ── Custo de leitura (egress) ────────────────────────────────────────────────
 * O veredito de defasagem é função PURA da tupla (origem, destino, perfil,
 * distancia_km): `origem/destino/perfil` escolhem a tarifa no catálogo e
 * `distancia_km` é o valor comparado. Duas cargas com a mesma tupla têm SEMPRE o
 * mesmo veredito. Por isso a varredura roda em duas fases:
 *
 *   FASE 1 — `GROUP BY origem, destino, perfil, distancia_km`: devolve uma linha
 *            por tupla distinta (produção 2026-08-03: 36 linhas cobrindo 1.389
 *            cargas candidatas) em vez de uma linha por carga.
 *   FASE 2 — só quando alguma tupla está defasada: busca os ids daquela tupla
 *            (projeção mínima: id + LH p/ log + valor p/ log), limitada ao saldo
 *            do batch. Em regime estacionário (nenhuma defasagem) a fase 2 nem
 *            acontece.
 *
 * A detecção é BIT-A-BIT a mesma de antes: mesmo matcher
 * ({@link fetchRouteCatalogMetricsByLoadId}, alimentado com a mesma tripla
 * origem/destino/perfil e sem `eixos`, como antes), mesmo limiar, mesma escrita.
 * Nada de watermark por `updated_at`: a defasagem também nasce do lado do CATÁLOGO
 * (operador corrige a distância de uma rota, e a carga não é tocada — o cascade do
 * `updateRoute` só alcança OPEN/DRAFT e no máximo 500 linhas), e nesse caso o
 * `cargas.updated_at` NÃO muda. Um filtro incremental por `updated_at` perderia
 * exatamente esse caso.
 *
 * Segurança:
 * - Cobre carga da PLANILHA (sheet_lh) e do SISTEMA (lh_manual). Não toca perfil,
 *   status, motorista nem cargas sem rota no catálogo.
 * - Cap de {@link RECONCILE_BATCH_LIMIT} por ciclo. Best-effort: nunca lança.
 * - Roda ao fim de cada sync (mesmo lugar da auto-cura do write-back). Idempotente:
 *   após corrigir, a distância passa a bater com a rota → não re-grava no ciclo seguinte.
 *
 * @param {{ log?: (level:string,event:string,data:object)=>void }} [opts]
 */
export async function reconcileStaleRouteMetrics({ log } = {}) {
  const emit = (level, event, data) =>
    log ? log(level, event, data) : console.info(`[reconcile-route-metrics] ${event}`, data ?? "");

  try {
    const result = await withPgClient(async (client) => {
      // FASE 1 — uma linha por tupla que decide o veredito (não por carga).
      const { rows: groups } = await client.query(
        `
          SELECT origem, destino, perfil, distancia_km, COUNT(*) AS cargas
          FROM public.cargas
          WHERE ${CANDIDATE_CARGO_WHERE}
          GROUP BY origem, destino, perfil, distancia_km
        `,
      );
      if (groups.length === 0) return { scanned: 0, groups: 0, updated: 0 };

      // `scanned` continua sendo o nº de cargas candidatas examinadas — só que
      // agora vem do COUNT(*) do agrupamento, sem trafegar uma linha por carga.
      const scanned = groups.reduce((acc, g) => acc + (Number(g.cargas) || 0), 0);

      // Casa a rota do catálogo por origem/destino (mesma função do sync/enrich).
      // Ids sintéticos: o matcher devolve Map(id → métricas) e só usa
      // origem/destino/perfil da linha — igual ao comportamento anterior.
      const catalog = await fetchRouteCatalogMetricsByLoadId(
        client,
        groups.map((g, index) => ({
          id: `g${index}`,
          origem: g.origem,
          destino: g.destino,
          perfil: g.perfil,
        })),
      );

      const staleGroups = [];
      groups.forEach((g, index) => {
        const m = catalog.get(`g${index}`);
        if (!m) return; // sem rota no catálogo → nada p/ re-derivar

        const routeDist = toNum(m.distancia_km);
        const routeValor = toNum(m.valor_padrao);
        const persistedDist = toNum(g.distancia_km);
        // Precisa de distância da rota (referência) + valor da rota (o que gravar).
        if (routeDist === null || routeDist <= 0 || routeValor === null || persistedDist === null) return;

        const stale = Math.abs(persistedDist - routeDist) / routeDist > STALE_DISTANCE_RATIO;
        if (!stale) return;

        staleGroups.push({
          group: g,
          persistedDist,
          routeValor,
          routeDist,
          routeBonus: toNum(m.bonus_padrao),
          routeDuracao: toNum(m.duracao_horas),
        });
      });

      // Regime estacionário: nenhuma tupla defasada → nenhuma linha de carga lida.
      if (staleGroups.length === 0) return { scanned, groups: groups.length, updated: 0 };

      let updated = 0;
      const alreadyUpdated = new Set();
      for (const stale of staleGroups) {
        const remaining = RECONCILE_BATCH_LIMIT - updated;
        if (remaining <= 0) break;

        // FASE 2 — só as cargas da tupla defasada, projeção mínima (id + LH/valor
        // p/ o log) e limitada ao saldo do batch: nunca lê linha que não vai gravar.
        // perfil NULL e perfil '' caem no mesmo grupo do COALESCE — e no matcher
        // ambos normalizam para "" (mesma tarifa, mesmo veredito); o Set de ids
        // evita gravar duas vezes se as duas variantes existirem.
        const { rows: cargas } = await client.query(
          `
            SELECT id, sheet_lh, lh_manual, valor
            FROM public.cargas
            WHERE ${CANDIDATE_CARGO_WHERE}
              AND origem = $1
              AND destino = $2
              AND COALESCE(perfil, '') = $3
              AND distancia_km = $4
            ORDER BY id
            LIMIT $5
          `,
          [
            stale.group.origem,
            stale.group.destino,
            stale.group.perfil ?? "",
            stale.group.distancia_km,
            remaining,
          ],
        );

        for (const r of cargas) {
          if (alreadyUpdated.has(r.id)) continue;
          alreadyUpdated.add(r.id);
          const newBonus = stale.routeBonus;
          const newDuracao = stale.routeDuracao;
          // Re-deriva SÓ métricas/preço do catálogo. duracao usa COALESCE p/ não apagar
          // uma duração existente quando o catálogo não a tem.
          await client.query(
            `
              UPDATE public.cargas
                 SET valor = $2,
                     bonus = $3,
                     distancia_km = $4,
                     duracao_horas = COALESCE($5, duracao_horas),
                     updated_at = now()
               WHERE id = $1
            `,
            [r.id, stale.routeValor, newBonus, stale.routeDist, newDuracao],
          );
          emit("info", "re-derivado", {
            lh: r.sheet_lh || r.lh_manual,
            valorDe: toNum(r.valor),
            valorPara: stale.routeValor,
            distDe: stale.persistedDist,
            distPara: stale.routeDist,
          });
          updated += 1;
          if (updated >= RECONCILE_BATCH_LIMIT) break;
        }
        if (updated >= RECONCILE_BATCH_LIMIT) break;
      }
      return { scanned, groups: groups.length, updated };
    });

    return { ok: true, ...result };
  } catch (error) {
    emit("warn", "erro", { message: error instanceof Error ? error.message : String(error) });
    return { ok: false, updated: 0 };
  }
}
