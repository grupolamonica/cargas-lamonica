import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { fetchRouteCatalogMetricsByLoadId } from "../operator-admin/use-cases/_shared.js";

const RECONCILE_BATCH_LIMIT = 200;
// Divergência de distância acima da qual as métricas gravadas são consideradas de
// OUTRA rota (não da rota atual da carga). 15% = folga p/ pequenas diferenças de
// catálogo entre perfis do mesmo trecho; os casos reais divergem >100% (ex.: 28km
// numa rota de 784km).
const STALE_DISTANCE_RATIO = 0.15;

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
      const { rows } = await client.query(
        `
          SELECT id, sheet_lh, lh_manual, origem, destino, perfil,
                 valor, bonus, distancia_km, duracao_horas
          FROM public.cargas
          WHERE status NOT IN ('CANCELLED', 'COMPLETED', 'FAILED')
            AND (sheet_lh IS NOT NULL OR lh_manual IS NOT NULL)
            AND COALESCE(TRIM(origem), '') <> ''
            AND COALESCE(TRIM(destino), '') <> ''
            AND distancia_km IS NOT NULL
        `,
      );
      if (rows.length === 0) return { scanned: 0, updated: 0 };

      // Casa a rota do catálogo por origem/destino (mesma função do sync/enrich).
      const catalog = await fetchRouteCatalogMetricsByLoadId(
        client,
        rows.map((r) => ({ id: r.id, origem: r.origem, destino: r.destino, perfil: r.perfil })),
      );

      let updated = 0;
      for (const r of rows) {
        const m = catalog.get(r.id);
        if (!m) continue; // sem rota no catálogo → nada p/ re-derivar

        const routeDist = toNum(m.distancia_km);
        const routeValor = toNum(m.valor_padrao);
        const persistedDist = toNum(r.distancia_km);
        // Precisa de distância da rota (referência) + valor da rota (o que gravar).
        if (routeDist === null || routeDist <= 0 || routeValor === null || persistedDist === null) continue;

        const stale = Math.abs(persistedDist - routeDist) / routeDist > STALE_DISTANCE_RATIO;
        if (!stale) continue;

        const newBonus = toNum(m.bonus_padrao);
        const newDuracao = toNum(m.duracao_horas);
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
          [r.id, routeValor, newBonus, routeDist, newDuracao],
        );
        emit("info", "re-derivado", {
          lh: r.sheet_lh || r.lh_manual,
          valorDe: toNum(r.valor),
          valorPara: routeValor,
          distDe: persistedDist,
          distPara: routeDist,
        });
        updated += 1;
        if (updated >= RECONCILE_BATCH_LIMIT) break;
      }
      return { scanned: rows.length, updated };
    });

    return { ok: true, ...result };
  } catch (error) {
    emit("warn", "erro", { message: error instanceof Error ? error.message : String(error) });
    return { ok: false, updated: 0 };
  }
}
