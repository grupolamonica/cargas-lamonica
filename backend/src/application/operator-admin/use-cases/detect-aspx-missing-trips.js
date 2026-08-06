// backend/src/application/operator-admin/use-cases/detect-aspx-missing-trips.js
//
// Vigia as cargas LANÇADAS pela Programação (lh_manual = viagem "LT…" do SPX) e
// detecta quando a viagem SAIU do ASPX — a Shopee cancelou/removeu a viagem do portal
// depois de a carga já estar lançada no sistema. Sem isto, a carga ficava aberta e
// candidatável no portal do motorista, e "operável" no Monitor, sem lastro nenhum no
// ASPX (caso real: LT1Q8102CLEN1, lançada em 30/07 e sumida do portal no dia seguinte).
//
// Política (pedido do operador) — a carga NUNCA sai do sistema:
//   1. marca a carga (aspx_missing_since) → o Monitor deixa de listá-la (não é mais
//      viagem operável) e a tela de Cargas mostra o selo "Fora do ASPX";
//   2. avisa o operador pelo sino (operator_notifications, kind aspx_trip_missing) e
//      RE-AVISA a cada ASPX_MISSING_REALERT_HOURS enquanto a viagem não voltar;
//   3. se a viagem reaparecer no portal, limpa a marca (volta ao Monitor) e avisa
//      (kind aspx_trip_restored).
// Nada de UPDATE em status/visibilidade: quem decide cancelar/expirar é o operador.
//
// Escopo deliberado: só cargas do SISTEMA lançadas (sheet_lh NULL + lh_manual "LT…").
// Cargas da planilha (sheet_lh) têm a planilha como fonte da verdade e seguem pelo
// reconcile-aspx-status (DC-316); Nestlé/manual/importadas não têm viagem no SPX.
//
// Anti-falso-positivo (crítico — marcar carga boa é pior que atrasar o aviso):
//   - SÓ avalia carga com CARREGAMENTO AINDA POR VIR (agenda >= agora, relógio de São
//     Paulo). Essa é a base sólida: uma viagem que ainda não carregou não pode estar
//     concluída/arquivada, então PRECISA estar em Planejado(1) ou Aceito(2) — abas
//     completas. Carga de carregamento passado dependeria do Concluído (janela mtime
//     + paginação) para provar presença: base frágil (medido em prod: 51 "ausentes"
//     em 146, quase todas de dias anteriores) e operacionalmente irrelevante — a
//     carga já rodou, o Monitor a trata como histórico e o expire-past-cargas expira.
//     No recorte correto o mesmo levantamento deu 5 ausentes em 93 — reais;
//   - o índice inclui o Concluído (janela curta) só para não marcar uma viagem que
//     já apareceu como finalizada;
//   - se QUALQUER aba falhar (index.partial), o índice vier vazio ou o portal truncar
//     a resposta (index.truncated), o ciclo é abortado sem marcar nada;
//   - cargas CANCELLED/EXPIRED ficam fora (não estão no Monitor nem em /cargas por
//     padrão — avisar sobre elas é só ruído).
//
// CARONA (aceite observado) — este job é o ÚNICO lugar do sistema que já olha o SPX ao
// vivo a cada 10 min varrendo exatamente as cargas lançadas "LT…". Custo marginal de
// chamada ao portal: ZERO. Então ele também OBSERVA o aceite e o grava
// (trip_accepted_at / trip_acceptance_checked_at) — ver observeTripAcceptance. Sem essa
// carona, o único caminho que gravava aceite era o nosso botão "Aceitar": o aceite feito
// direto no portal SPX nunca chegava ao banco (0 cargas "LT…" marcadas até 06/08/2026) e
// o Monitor lia esse silêncio como "ninguém aceitou". A carona tem CONSULTA PRÓPRIA (o
// recorte do passo A congelaria a evidência da carga que já carregou) e DISJUNTOR
// próprio (acceptanceHideLimits): esconder muitas linhas de uma vez com base num sinal
// nunca medido em produção é o incidente do PR #457 — o freio existe para isso.
//
// PASSO B (rota retirada) — cobre a carga com carregamento JÁ PASSADO, que o passo A
// deliberadamente ignora. A evidência sólida aí não é a viagem, é a ROTA: portal sem
// nenhuma viagem do trecho + todas as cargas do trecho ausentes + volume mínimo +
// ausência sustentada (o 1º ciclo observa, o seguinte marca) + índice saudável + teto
// de rotas por ciclo. Marca com reason 'route_removed' e emite UM aviso por rota (não
// um por carga). Carga com motorista/reserva NUNCA é marcada — entra na contagem do
// aviso. Sai atrás de dry-run (ASPX_MISSING_ROUTE_DRYRUN, default LIGADO).

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { getSaoPauloWallClock } from "../../../domain/sao-paulo-time.js";
import { fetchTripIndex } from "../../../infrastructure/spx/spx-allocation-client.js";
import {
  classifyAspxPresence,
  classifyRouteRemoval,
  isSpxTripNumber,
  routeKeyFromLabels,
} from "../../../domain/operator-admin/aspx-trip-presence.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";

// Janela do índice SPX. Espelha o que a Programação/preview usam (45/30) — o Concluído
// usa uma janela própria (mtime) curta: ele serve só p/ reconhecer viagem recém
// finalizada, e janela curta reduz a chance de o portal truncar a resposta.
const DAYS_BACK = 45;
const DAYS_FORWARD = 30;
const CONCLUIDO_DAYS_BACK = 15;
// Horizonte à frente das cargas avaliadas, com margem p/ dentro da janela do índice
// (carga além do horizonte do portal não está no índice por definição).
const FORWARD_MARGIN_DAYS = 1;
// Teto de avisos por ciclo (o excedente entra no próximo — nunca truncamos calado).
const MAX_NOTIFY_PER_RUN = 20;

function realertHours() {
  const n = Number(process.env.ASPX_MISSING_REALERT_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

// DISJUNTOR de marcação em massa. Sumir 1-2 viagens é rotina (cancelamento); sumir
// "quase todas" é sintoma de índice degradado (sessão trocada, station_id/agência
// diferente, portal devolvendo recorte menor) — e marcar em massa esvaziaria o
// Monitor. Nesse caso NÃO marca nada: emite UM aviso agregado e espera o próximo
// ciclo. Limite = maior entre o absoluto e a fração do que foi verificado.
function massMarkLimits() {
  const abs = Number(process.env.ASPX_MISSING_MAX_MARK_ABS);
  const ratio = Number(process.env.ASPX_MISSING_MAX_MARK_RATIO);
  return {
    abs: Number.isFinite(abs) && abs > 0 ? abs : 5,
    ratio: Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0.3,
  };
}

// ─── Passo B: rota retirada do ASPX ────────────────────────────────────────────
// Parâmetros do passo B (todos com default conservador). DRY-RUN é o default no
// primeiro deploy: o passo só LOGA e avisa, sem marcar carga nenhuma, até o operador
// conferir o log contra o portal e ligar (ASPX_MISSING_ROUTE_DRYRUN=false).
function routeStepConfig() {
  const num = (env, def, { min = 0 } = {}) => {
    const n = Number(process.env[env]);
    return Number.isFinite(n) && n >= min ? n : def;
  };
  return {
    // desligado = passo B nem roda; dryRun = roda e loga/avisa, sem escrever marca
    enabled: process.env.ASPX_MISSING_ROUTE_ENABLED !== "false",
    dryRun: process.env.ASPX_MISSING_ROUTE_DRYRUN !== "false",
    pastDays: num("ASPX_MISSING_PAST_DAYS", 14, { min: 1 }),
    minLoads: num("ASPX_MISSING_ROUTE_MIN_LOADS", 3, { min: 1 }),
    minAbsentHours: num("ASPX_MISSING_ROUTE_MIN_ABSENT_HOURS", 6, { min: 0 }),
    // Piso de saúde do índice: portal com poucas viagens não é base p/ concluir nada.
    minIndexTrips: num("ASPX_MISSING_MIN_INDEX_TRIPS", 100, { min: 1 }),
    // Teto de rotas por ciclo: uma pane do portal não pode marcar o sistema inteiro.
    maxRoutesPerRun: num("ASPX_MISSING_MAX_ROUTES_PER_RUN", 2, { min: 1 }),
  };
}

// Kill-switch da carona do aceite. LIGADO por default (só "false" desliga): a coluna
// nova só existe para ser preenchida, e sem preenchimento o Monitor nunca esconde nada
// — desligar é a posição segura, não a inércia. Padrão da casa (ver routeStepConfig).
function acceptanceObserveEnabled() {
  return process.env.SPX_ACCEPTANCE_OBSERVE_ENABLED !== "false";
}

// Janela e ritmo da carona do aceite.
function acceptanceObserveConfig() {
  // Variação do `num` do routeStepConfig com uma guarda a mais: env VAZIA cai no
  // DEFAULT, não em zero. `Number("")` é 0 e passa em `Number.isFinite`, então com
  // `min: 0` um `SPX_ACCEPTANCE_OBSERVE_PAST_DAYS=` no .env (linha declarada e deixada
  // em branco — o jeito mais comum de "não configurar") encolheria silenciosamente a
  // observação de 7 dias para "de hoje em diante". Não é hipótese acadêmica: em prod as
  // lançadas que mais importam são exatamente as que já carregaram e continuam vivas na
  // tela. Env em branco significa "não opinei"; quem quer zero escreve 0.
  const num = (env, def, { min = 0 } = {}) => {
    const raw = String(process.env[env] ?? "").trim();
    if (!raw) return def;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? n : def;
  };
  return {
    // Horizonte PARA TRÁS da consulta do observador. O passo A só olha "carregamento
    // ainda por vir": a carga que carrega hoje às 10:00 sai do recorte dele às 10:01 e,
    // se o observador pegasse carona nas rows dele, a evidência daquela carga
    // congelaria para sempre. 7 dias cobre a lançada que já carregou mas continua viva
    // na tela do operador, sem inflar o conjunto (~90-100 lançadas vivas em prod,
    // medido em 06/08/2026).
    pastDays: num("SPX_ACCEPTANCE_OBSERVE_PAST_DAYS", 7, { min: 0 }),
    // REGRAVAÇÃO da observação. O read model trata evidência mais velha que
    // MONITOR_ACCEPTANCE_EVIDENCE_TTL_HOURS (24h) como DESCONHECIDA — logo o carimbo
    // não pode ser eterno, ou "checado uma vez em 2026" esconderia a linha para sempre.
    // Regravar a cada 60 min mantém viva a evidência da carga ATIVAMENTE observada (o
    // TTL é 24x maior, folga de sobra) e deixa expirar a que saiu do radar — que volta
    // a aparecer, exatamente o desejado. Dentro da janela não reescreve NADA: escrever
    // "checked_at = now()" nas ~90 lançadas a cada 10 min seriam ~13k dead tuples/dia,
    // e este codebase já tem cicatriz de bloat/egress.
    restampMinutes: num("SPX_ACCEPTANCE_RESTAMP_MINUTES", 60, { min: 1 }),
  };
}

// DISJUNTOR do ESCONDER — irmão do massMarkLimits() acima, e pelo mesmo motivo.
//
// Observar e esconder nascem os dois ligados, e o sinal em que o esconder se apoia
// (`acceptance_status = 0` na aba Planejado significar de fato "não aceita") NUNCA foi
// medido em produção. O que foi medido é o oposto: 0 cargas "LT…" jamais marcadas como
// aceitas e 0 eventos de aceite desde 05/08/2026. Se a aba Planejado devolver 0 para as
// ~90 lançadas vivas, a primeira passada carimbaria as 90 e a leitura seguinte
// sumiria com as 90 — repetição exata do incidente do PR #457, agora com "evidência"
// carimbada no banco (e checked_at/accepted_at nunca são limpos: o rollback é UPDATE
// manual). Então: se a fração de conclusivas que dariam ESCONDER passar do teto,
// NÃO grava nada no ciclo, emite UM aviso agregado e deixa a decisão com o operador.
// Ele confere o portal e sobe o teto (ou desliga a carona) com conhecimento de causa.
function acceptanceHideLimits() {
  const abs = Number(process.env.SPX_ACCEPTANCE_MAX_HIDE_ABS);
  const ratio = Number(process.env.SPX_ACCEPTANCE_MAX_HIDE_RATIO);
  return {
    // Mais apertado que o do aspx_missing (5 / 30%): marcar "fora do ASPX" só põe um
    // selo na tela de Cargas; esconder tira a linha do Monitor, que é o incidente já
    // vivido. Com as ~90 conclusivas de prod o teto fica em 18 — a primeira passada
    // "tudo não-aceito" aborta, uma leva normal de recém-lançadas passa.
    abs: Number.isFinite(abs) && abs > 0 ? abs : 5,
    ratio: Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0.2,
  };
}

const trim = (v) => String(v ?? "").trim();

/** `cargas.data` é uma data de CALENDÁRIO (wall-clock BRT), mas o driver pg entrega
 *  DATE como objeto Date — meia-noite LOCAL — e o harness de teste entrega meia-noite
 *  UTC. Ler com o getter errado desloca o rótulo um dia (o off-by-one conhecido).
 *  Regra: hora UTC zerada → a data está em UTC; senão, nos getters locais. */
function toWallClockDateIso(v) {
  if (!v) return "";
  if (typeof v === "string") return v.slice(0, 10);
  if (!(v instanceof Date) || Number.isNaN(v.getTime())) return "";
  const utcMidnight =
    v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0 && v.getUTCMilliseconds() === 0;
  const y = utcMidnight ? v.getUTCFullYear() : v.getFullYear();
  const m = (utcMidnight ? v.getUTCMonth() : v.getMonth()) + 1;
  const d = utcMidnight ? v.getUTCDate() : v.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** `cargas.horario` (TIME) chega como 'HH:MM:SS' — só o HH:MM interessa no aviso. */
function toWallClockTime(v) {
  return trim(v).slice(0, 5);
}

/** "DD/MM/YYYY HH:MM" p/ o corpo do aviso (o operador lê data BR, não ISO). */
function agendaLabel(dateIso, timeHm) {
  if (!dateIso) return "";
  const [y, m, dd] = dateIso.split("-");
  return `${dd}/${m}/${y}${timeHm ? ` ${timeHm}` : ""}`;
}

/**
 * @param {{ correlationId?: string|null, deps?: {
 *   withPgClient?: Function, fetchTripIndex?: typeof fetchTripIndex, now?: () => Date,
 * } }} [args]
 * @returns {Promise<{ ok: boolean, reason?: string, checked: number, marked: number,
 *   cleared: number, renotified: number, notified: number, deferred: number,
 *   routes: { observando: number, rotasRemovidas: number, cargasMarcadas: number,
 *             cargasPreservadas: number, restauradas: number, dryRun: boolean, skipped?: string },
 *   acceptance: { conclusivas: number, aceitas: number, gravadas: number,
 *                 novasAceitas: number, novasOcultacoes: number,
 *                 ocultacoesAbortadas: number, skipped?: string } }>}
 */
export async function detectAspxMissingTrips({ correlationId = null, deps = {} } = {}) {
  const run = deps.withPgClient || withPgClient;
  const getIndex = deps.fetchTripIndex || fetchTripIndex;
  const now = deps.now ? deps.now() : new Date();

  const empty = {
    checked: 0, marked: 0, cleared: 0, renotified: 0, notified: 0, deferred: 0, massMarkAborted: 0,
    routes: { observando: 0, rotasRemovidas: 0, cargasMarcadas: 0, cargasPreservadas: 0, restauradas: 0, dryRun: true },
    acceptance: {
      conclusivas: 0, aceitas: 0, gravadas: 0, novasAceitas: 0,
      novasOcultacoes: 0, ocultacoesAbortadas: 0, skipped: "no_run",
    },
  };

  // 1. Índice das viagens VIVAS no portal (3 abas). Qualquer degradação → no-op.
  let index;
  try {
    index = await getIndex(
      {
        daysBack: DAYS_BACK,
        daysForward: DAYS_FORWARD,
        includeConcluido: true,
        concluidoDaysBack: CONCLUIDO_DAYS_BACK,
      },
      { correlationId },
    );
  } catch (err) {
    logStructuredEvent("warn", "detect-aspx-missing-trips.index-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "spx_unavailable", ...empty };
  }
  // Índice incompleto/vazio/truncado não prova ausência de nada.
  if (index.partial) return { ok: false, reason: "partial_index", ...empty };
  if (index.truncated) return { ok: false, reason: "truncated_index", ...empty };
  if (!index.byNumber || index.byNumber.size === 0) return { ok: false, reason: "empty_index", ...empty };

  const { dateIso: hoje, timeIso: agora } = getSaoPauloWallClock();
  const hours = realertHours();

  let outcome;
  try {
    outcome = await run(async (client) => {
      const { rows } = await client.query(
        // Carregamento AINDA POR VIR (data futura, ou hoje com horário que não passou)
        // e dentro do horizonte do portal. Cancelada/expirada fora — não estão nas telas.
        `SELECT id, lh_manual, data, horario, origem, destino, status,
                aspx_missing_since, aspx_missing_notified_at
           FROM public.cargas
          WHERE sheet_lh IS NULL
            AND COALESCE(lh_manual, '') <> ''
            AND upper(lh_manual) LIKE 'LT%'
            AND COALESCE(is_template, false) = false
            AND status NOT IN ('CANCELLED', 'EXPIRED')
            AND data IS NOT NULL
            AND (data > $1::date OR (data = $1::date AND (horario IS NULL OR horario >= $2::time)))
            AND data <= ($1::date + $3::int)`,
        [hoje, agora, DAYS_FORWARD - FORWARD_MARGIN_DAYS],
      );

      const result = {
        checked: 0,
        marked: 0,
        cleared: 0,
        renotified: 0,
        notified: 0,
        deferred: 0,
        massMarkAborted: 0,
      };

      // 2. CLASSIFICA tudo antes de escrever — o disjuntor de marcação em massa
      //    precisa saber quantas cargas sumiriam de uma vez.
      const toMark = [];
      const toRenotify = [];
      const toClear = [];
      for (const row of rows) {
        const lh = trim(row.lh_manual);
        if (!isSpxTripNumber(lh)) continue; // cinto e suspensório (o LIKE já filtra)
        result.checked += 1;

        const { action } = classifyAspxPresence({
          present: index.byNumber.has(lh),
          missingSince: row.aspx_missing_since,
          notifiedAt: row.aspx_missing_notified_at,
          now,
          realertHours: hours,
        });
        if (action === "mark") toMark.push({ row, lh });
        else if (action === "renotify") toRenotify.push({ row, lh });
        else if (action === "clear") toClear.push({ row, lh });
      }

      // 3. Disjuntor: marcação em massa é sintoma de índice degradado, não de
      //    cancelamento real → não marca ninguém e emite UM aviso agregado.
      const limits = massMarkLimits();
      const massLimit = Math.max(limits.abs, Math.floor(result.checked * limits.ratio));
      const massMark = toMark.length > massLimit;
      if (massMark) {
        result.massMarkAborted = toMark.length;
        toMark.length = 0;
      }

      // 4. Escreve as marcas/limpezas sobreviventes.
      for (const { row, lh } of toMark) {
        await client.query(
          `UPDATE public.cargas
              SET aspx_missing_since = now(),
                  aspx_missing_lh = $2,
                  updated_at = now()
            WHERE id = $1`,
          [row.id, lh],
        );
        result.marked += 1;
      }
      for (const { row } of toClear) {
        await client.query(
          `UPDATE public.cargas
              SET aspx_missing_since = NULL,
                  aspx_missing_lh = NULL,
                  aspx_missing_notified_at = NULL,
                  updated_at = now()
            WHERE id = $1`,
          [row.id],
        );
        result.cleared += 1;
      }
      result.renotified = toRenotify.length;

      // 5. Avisos (sino). Ordem: detecções NOVAS primeiro, depois retornos, depois
      //    re-avisos — o teto por ciclo nunca deixa uma detecção nova esperando
      //    atrás de uma fila de re-avisos. O excedente é pego no próximo tick (o
      //    aviso pendente NÃO marca notified_at, então nada se perde).
      const pending = [
        ...toMark.map((m) => ({ ...m, kind: "aspx_trip_missing", renotify: false })),
        ...toClear.map((m) => ({ ...m, kind: "aspx_trip_restored" })),
        ...toRenotify.map((m) => ({ ...m, kind: "aspx_trip_missing", renotify: true })),
      ];
      const toNotify = pending.slice(0, MAX_NOTIFY_PER_RUN);
      result.deferred = pending.length - toNotify.length;

      // Aviso agregado do disjuntor (1 por janela de re-aviso — não repete a cada tick).
      if (massMark) {
        // Corte calculado aqui (não em SQL) — parâmetro timestamptz é portável e não
        // depende de make_interval.
        const cutoff = new Date(now.getTime() - hours * 3600_000).toISOString();
        const { rows: recent } = await client.query(
          `SELECT 1 FROM public.operator_notifications
            WHERE kind = 'aspx_trip_missing'
              AND metadata->>'bulk' = 'true'
              AND created_at > $1
            LIMIT 1`,
          [cutoff],
        );
        if (recent.length === 0) {
          await client.query(
            `INSERT INTO public.operator_notifications (kind, title, body, metadata)
             VALUES ('aspx_trip_missing', $1, $2, $3::jsonb)`,
            [
              `${result.massMarkAborted} cargas lançadas fora do ASPX — confira o portal`,
              "Muitas viagens sumiram de uma vez: pode ser sessão/estação do portal, não cancelamento. Nada foi marcado.",
              JSON.stringify({
                bulk: true,
                missing: result.massMarkAborted,
                checked: result.checked,
                correlation_id: correlationId || null,
              }),
            ],
          );
          result.notified += 1;
        }
      }

      for (const item of toNotify) {
        const { row, lh, kind } = item;
        const rota = [trim(row.origem), trim(row.destino)].filter(Boolean).join(" → ");
        const dataIso = toWallClockDateIso(row.data);
        const horaHm = toWallClockTime(row.horario);
        const quando = agendaLabel(dataIso, horaHm);
        const restored = kind === "aspx_trip_restored";
        const title = restored
          ? `Viagem voltou ao ASPX: ${lh}`
          : `Carga fora do ASPX: ${lh}`;
        const body = restored
          ? `${rota}${quando ? ` · ${quando}` : ""} · voltou ao Monitor`
          : `${rota}${quando ? ` · ${quando}` : ""} · a viagem saiu do portal Shopee — confira em Cargas`;

        await client.query(
          `INSERT INTO public.operator_notifications (kind, title, body, metadata)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [
            kind,
            title,
            body,
            JSON.stringify({
              lh,
              cargo_id: row.id,
              origem: trim(row.origem) || null,
              destino: trim(row.destino) || null,
              data: dataIso || null,
              horario: horaHm || null,
              status: row.status ?? null,
              missing_since: row.aspx_missing_since ?? null,
              renotify: item.renotify === true,
              correlation_id: correlationId || null,
            }),
          ],
        );
        result.notified += 1;
        if (!restored) {
          await client.query(
            "UPDATE public.cargas SET aspx_missing_notified_at = now() WHERE id = $1",
            [row.id],
          );
        }
      }

      // 6. CARONA — observa o ACEITE das lançadas vivas (CONSULTA PRÓPRIA, mais larga
      //    que o recorte do passo A) e grava o fato. Etapa ISOLADA (try/catch próprio
      //    dentro dela, e nada aqui é transação): esconder linha por não-aceite é uma
      //    decisão do Monitor; derrubar a detecção de "sumiu do ASPX" por causa dela
      //    seria trocar um problema por outro pior.
      result.acceptance = await observeTripAcceptance({ client, index, hoje, now, hours, correlationId });
      if (result.acceptance.avisou) result.notified += 1;

      // 7. PASSO B — rota retirada do ASPX (carga com carregamento JÁ PASSADO).
      //    Roda depois do passo A, com estado próprio e tetos próprios; nunca marca
      //    carga individual e nunca toca status/visibilidade.
      const rotas = await runRouteStep({ client, index, hoje, agora, now, hours, correlationId, result });
      result.routes = rotas;

      return result;
    });
  } catch (err) {
    logStructuredEvent("warn", "detect-aspx-missing-trips.query-failed", {
      correlationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "query_failed", ...empty };
  }

  if (outcome.massMarkAborted) {
    // Nada foi marcado de propósito — sinaliza alto p/ o operador/observabilidade.
    logStructuredEvent("warn", "detect-aspx-missing-trips.mass-mark-aborted", {
      correlationId,
      checked: outcome.checked,
      missing: outcome.massMarkAborted,
    });
  }
  if (outcome.marked || outcome.cleared || outcome.renotified) {
    logStructuredEvent("warn", "detect-aspx-missing-trips.changed", {
      correlationId,
      checked: outcome.checked,
      marked: outcome.marked,
      cleared: outcome.cleared,
      renotified: outcome.renotified,
      deferred: outcome.deferred,
    });
  }

  return { ok: true, ...outcome };
}

/**
 * CARONA — grava o ACEITE observado das cargas lançadas VIVAS.
 *
 * Duas colunas, dois fatos diferentes (migration 20260806150000):
 *   `trip_accepted_at`           = observamos que a viagem ESTÁ aceita. Nunca é limpo
 *                                  nem sobrescrito (o carimbo antigo é o mais honesto).
 *   `trip_acceptance_checked_at` = ÚLTIMA observação CONCLUSIVA daquele LH. É o que
 *                                  autoriza o Monitor a esconder — e é REGRAVADO
 *                                  (a cada `restampMinutes`), porque o read model trata
 *                                  evidência velha como DESCONHECIDA.
 * O Monitor só esconde com evidência fresca (checked_at recente E accepted_at nulo);
 * nunca checado = desconhecido = a linha FICA. Por isso "desconhecido" aqui é silêncio,
 * não escrita: gravar checked_at sem saber o aceite esconderia a linha na base de nada.
 *
 * CONSULTA PRÓPRIA (não pega carona nas rows do passo A): o recorte do passo A é
 * "carregamento ainda por vir" — de propósito, porque é a base sólida da detecção de
 * ausência — e uma carga sai dele no minuto seguinte ao horário de carregamento. Com
 * carona, a evidência dela congelava e nunca mais era revista. Aqui olhamos o mesmo
 * conjunto que o read model do Monitor considera (lançada "LT…", sheet_lh nulo,
 * não-template, status não terminal, não mergeada), incluindo o carregamento de HOJE e
 * o passado recente. Aumentar o recorte do passo A resolveria isto mudando junto o
 * comportamento da detecção de aspx_missing — que não está em discussão.
 *
 * Regras:
 *   - só roda com o índice já validado pelo caller (partial/truncated/vazio abortam o
 *     ciclo inteiro lá em cima — não contornamos isso aqui);
 *   - viagem AUSENTE do índice não é observação: ausência é assunto do aspx_missing e
 *     não prova não-aceite;
 *   - IDEMPOTENTE dentro da janela de regravação: só escreve a linha que MUDA de estado
 *     ou cuja observação envelheceu além de `restampMinutes`;
 *   - DISJUNTOR: esconder em massa não acontece calado (ver acceptanceHideLimits);
 *   - best-effort: qualquer falha (inclusive a coluna não existir ainda, 42703) devolve
 *     `skipped` e deixa o resto do job passar.
 *
 * @returns {Promise<{ conclusivas:number, aceitas:number, gravadas:number,
 *   novasAceitas:number, novasOcultacoes:number, ocultacoesAbortadas:number,
 *   avisou?:boolean, skipped?:string }>} `avisou` = o disjuntor emitiu o sino agregado
 *   (o caller soma no total de avisos do ciclo).
 */
async function observeTripAcceptance({ client, index, hoje, now, hours, correlationId }) {
  const vazio = { conclusivas: 0, aceitas: 0, gravadas: 0, novasAceitas: 0, novasOcultacoes: 0, ocultacoesAbortadas: 0 };
  if (!acceptanceObserveEnabled()) return { ...vazio, skipped: "disabled" };
  const cfg = acceptanceObserveConfig();
  const saida = { ...vazio };

  try {
    // 1. Lançadas VIVAS na janela do observador. O SELECT já traz os dois carimbos —
    //    banco sem a coluna estoura 42703 aqui e o catch abaixo devolve o skip.
    const { rows } = await client.query(
      `SELECT id, lh_manual, trip_accepted_at, trip_acceptance_checked_at
         FROM public.cargas
        WHERE sheet_lh IS NULL
          AND COALESCE(lh_manual, '') <> ''
          AND upper(lh_manual) LIKE 'LT%'
          AND COALESCE(is_template, false) = false
          AND status NOT IN ('CANCELLED', 'EXPIRED', 'DRAFT', 'COMPLETED', 'FAILED')
          AND alloc_merged_into_cargo_id IS NULL
          AND data IS NOT NULL
          AND data >= ($1::date - $2::int)
          AND data <= ($1::date + $3::int)`,
      [hoje, cfg.pastDays, DAYS_FORWARD - FORWARD_MARGIN_DAYS],
    );

    // 2. Classifica ANTES de escrever — o disjuntor precisa saber quantas linhas
    //    sumiriam de uma vez.
    const corteRegravacao = now.getTime() - cfg.restampMinutes * 60_000;
    const promover = [];     // aceita: falta carimbo de aceite ou a observação envelheceu
    const marcarChecado = []; // não aceita: nunca checada ou observação envelhecida
    for (const row of rows) {
      const lh = trim(row.lh_manual);
      if (!isSpxTripNumber(lh)) continue;
      const aceita = index.byNumber.get(lh)?.accepted;
      if (aceita !== true && aceita !== false) continue; // null/ausente = desconhecido
      saida.conclusivas += 1;
      if (aceita) saida.aceitas += 1;

      const checkedRaw = row.trip_acceptance_checked_at;
      const checkedMs = checkedRaw instanceof Date
        ? checkedRaw.getTime()
        : (checkedRaw ? Date.parse(String(checkedRaw)) : NaN);
      const observacaoFresca = Number.isFinite(checkedMs) && checkedMs >= corteRegravacao;
      if (aceita) {
        // "Nova aceita" é só quem AINDA NÃO tinha o carimbo — a regravação da
        // observação de uma já aceita é manutenção, não descoberta (o número vai para
        // o log e não pode inflar).
        if (row.trip_accepted_at == null) saida.novasAceitas += 1;
        if (row.trip_accepted_at == null || !observacaoFresca) promover.push(row.id);
      } else {
        // Linha que NUNCA foi checada e agora ficaria "checada e não aceita" é uma
        // ocultação NOVA no Monitor — é essa fração que o disjuntor vigia. Regravar o
        // carimbo de quem já estava escondida não esconde ninguém a mais.
        if (!Number.isFinite(checkedMs)) saida.novasOcultacoes += 1;
        if (!observacaoFresca) marcarChecado.push(row.id);
      }
    }
    if (saida.conclusivas === 0) return { ...saida, skipped: "sem_conclusivas" };

    // 3. Disjuntor do esconder: acima do teto NÃO grava nada e avisa (1 por janela).
    const limits = acceptanceHideLimits();
    const teto = Math.max(limits.abs, Math.floor(saida.conclusivas * limits.ratio));
    if (saida.novasOcultacoes > teto) {
      saida.ocultacoesAbortadas = saida.novasOcultacoes;
      saida.avisou = await notifyAcceptanceMassHide({ client, saida, teto, now, hours, correlationId });
      logStructuredEvent("warn", "detect-aspx-missing-trips.acceptance-mass-hide-aborted", {
        correlationId,
        conclusivas: saida.conclusivas,
        aceitas: saida.aceitas,
        ocultacoes: saida.novasOcultacoes,
        teto,
      });
      return { ...saida, gravadas: 0, novasAceitas: 0, skipped: "mass_hide_aborted" };
    }

    // 4. Escreve só quem muda de estado (ou cuja observação envelheceu).
    if (promover.length > 0) {
      const ph = promover.map((_, i) => `$${i + 1}`).join(", ");
      await client.query(
        // COALESCE só no ACEITE: o carimbo antigo é o instante REAL em que vimos a
        // viagem aceita — reescrevê-lo apagaria a única pista de "desde quando". Já a
        // OBSERVAÇÃO é sempre a mais recente por definição (é o que a torna evidência).
        `UPDATE public.cargas
            SET trip_accepted_at = COALESCE(trip_accepted_at, now()),
                trip_acceptance_checked_at = now(),
                updated_at = now()
          WHERE id IN (${ph})`,
        promover,
      );
    }
    if (marcarChecado.length > 0) {
      const ph = marcarChecado.map((_, i) => `$${i + 1}`).join(", ");
      await client.query(
        `UPDATE public.cargas
            SET trip_acceptance_checked_at = now(), updated_at = now()
          WHERE id IN (${ph})`,
        marcarChecado,
      );
    }
    saida.gravadas = promover.length + marcarChecado.length;

    // Log AGREGADO (nunca um por carga): em regime só a regravação de 60 min escreve, e
    // um pico aqui é sinal de mudança real no portal.
    if (saida.gravadas > 0) {
      logStructuredEvent("warn", "detect-aspx-missing-trips.acceptance-observed", {
        correlationId,
        conclusivas: saida.conclusivas,
        aceitas: saida.aceitas,
        gravadas: saida.gravadas,
        novasAceitas: saida.novasAceitas,
        novasOcultacoes: saida.novasOcultacoes,
      });
    }
    return saida;
  } catch (err) {
    // 42703 = coluna ainda não existe (migration não aplicada) — é o caminho que roda
    // em produção ENTRE o deploy e o migrate, falha esperada e silenciosa; qualquer
    // outra vira warning. Nos dois casos o job segue (o passo B depende disso).
    if (err?.code !== "42703") {
      logStructuredEvent("warn", "detect-aspx-missing-trips.acceptance-failed", {
        correlationId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return { ...saida, gravadas: 0, novasAceitas: 0, skipped: err?.code === "42703" ? "column_missing" : "failed" };
  }
}

/** UM aviso agregado por janela de re-aviso — o operador não precisa de 90 sinos, e
 *  repetir a cada 10 min transformaria o disjuntor em ruído até ele decidir. */
async function notifyAcceptanceMassHide({ client, saida, teto, now, hours, correlationId }) {
  const cutoff = new Date(now.getTime() - hours * 3600_000).toISOString();
  const { rows: recent } = await client.query(
    `SELECT 1 FROM public.operator_notifications
      WHERE kind = 'spx_acceptance_mass_hide'
        AND created_at > $1
      LIMIT 1`,
    [cutoff],
  );
  if (recent.length > 0) return false;
  await client.query(
    `INSERT INTO public.operator_notifications (kind, title, body, metadata)
     VALUES ('spx_acceptance_mass_hide', $1, $2, $3::jsonb)`,
    [
      `${saida.novasOcultacoes} cargas lançadas apareceriam como NÃO aceitas — nada foi alterado`,
      "O portal respondeu 'não aceita' para muitas viagens de uma vez: pode ser a aba Planejado, não o aceite real. "
        + "Nenhuma linha saiu do Monitor. Confira o portal e, se estiver certo, suba SPX_ACCEPTANCE_MAX_HIDE_ABS.",
      JSON.stringify({
        bulk: true,
        ocultacoes: saida.novasOcultacoes,
        conclusivas: saida.conclusivas,
        aceitas: saida.aceitas,
        teto,
        correlation_id: correlationId || null,
      }),
    ],
  );
  return true;
}

/**
 * PASSO B — rota retirada do ASPX.
 *
 * Cobre o buraco do passo A: viagem que desaparece DEPOIS do horário de carregamento
 * nunca era sinalizada (caso Itaitinga: 34 cargas fantasma ficaram no Monitor sem
 * selo). Para carga já carregada a ausência de UMA viagem não é evidência; a ausência
 * da ROTA INTEIRA é. Só marca quando: portal sem nenhuma viagem do trecho + todas as
 * cargas avaliadas do trecho ausentes + volume mínimo + ausência SUSTENTADA (1º ciclo
 * observa, o seguinte marca) + índice saudável + teto de rotas por ciclo.
 *
 * Nunca marca carga com motorista/reserva: essas estão comprometidas com alguém e a
 * decisão é do operador — mas entram na contagem do aviso, para não ficar silencioso.
 *
 * @returns {Promise<{ skipped?: string, observando: number, rotasRemovidas: number,
 *   cargasMarcadas: number, cargasPreservadas: number, restauradas: number, dryRun: boolean }>}
 */
async function runRouteStep({ client, index, hoje, agora, now, hours, correlationId, result }) {
  const cfg = routeStepConfig();
  const vazio = {
    observando: 0,
    rotasRemovidas: 0,
    cargasMarcadas: 0,
    cargasPreservadas: 0,
    restauradas: 0,
    dryRun: cfg.dryRun,
  };
  if (!cfg.enabled) return { ...vazio, skipped: "disabled" };
  // Índice pequeno não sustenta conclusão sobre rota (a mesma prudência do disjuntor).
  if (index.byNumber.size < cfg.minIndexTrips) return { ...vazio, skipped: "index_too_small" };
  const byRoute = index.byRoute instanceof Map ? index.byRoute : new Map();
  if (byRoute.size === 0) return { ...vazio, skipped: "no_route_index" };

  // Cargas lançadas com carregamento JÁ PASSADO, dentro da janela para trás.
  const { rows } = await client.query(
    `SELECT id, lh_manual, data, horario, origem, destino, status,
            aspx_missing_since,
            COALESCE(alloc_motorista, '') AS motorista,
            (reserved_driver_id IS NOT NULL OR reserved_public_lead_id IS NOT NULL
             OR booked_driver_id IS NOT NULL) AS comprometida
       FROM public.cargas
      WHERE sheet_lh IS NULL
        AND COALESCE(lh_manual, '') <> ''
        AND upper(lh_manual) LIKE 'LT%'
        AND COALESCE(is_template, false) = false
        AND status NOT IN ('CANCELLED', 'EXPIRED')
        AND data IS NOT NULL
        AND data >= ($1::date - $3::int)
        AND (data < $1::date OR (data = $1::date AND horario IS NOT NULL AND horario < $2::time))`,
    [hoje, agora, cfg.pastDays],
  );

  // Agrupa por rota canônica e conta ausentes.
  const rotas = new Map();
  for (const row of rows) {
    const lh = trim(row.lh_manual);
    if (!isSpxTripNumber(lh)) continue;
    const key = routeKeyFromLabels(row.origem, row.destino);
    if (!key) continue;
    if (!rotas.has(key)) {
      rotas.set(key, { key, origem: trim(row.origem), destino: trim(row.destino), cargas: [], ausentes: 0 });
    }
    const r = rotas.get(key);
    const ausente = !index.byNumber.has(lh);
    r.cargas.push({ ...row, lh, ausente });
    if (ausente) r.ausentes += 1;
  }

  const estado = await loadRouteAbsenceState(client, [...rotas.keys()]);
  const saida = { ...vazio };
  const removidas = [];

  for (const rota of rotas.values()) {
    const portalTrips = byRoute.get(rota.key) ?? 0;
    const anterior = estado.get(rota.key) ?? null;
    const { action } = classifyRouteRemoval({
      portalTripsOnRoute: portalTrips,
      launchedOnRoute: rota.cargas.length,
      missingOnRoute: rota.ausentes,
      minLoads: cfg.minLoads,
      firstAbsentAt: anterior?.first_absent_at ?? null,
      now,
      minAbsentHours: cfg.minAbsentHours,
    });

    if (action === "none") {
      // Rota viva (ou recorte pequeno): zera a observação, se existia.
      if (anterior) await clearRouteAbsence(client, rota.key);
      // Rota presente no portal → limpa marcas de route_removed das cargas dela.
      // NÃO depende de haver linha de observação: se o estado da rota se perder
      // (linha apagada, banco restaurado), a marca ficaria presa para sempre — o passo
      // A não cobre carga de carregamento passado. A limpeza é idempotente e o filtro
      // por reason garante que marca do passo A (trip_missing) não é tocada aqui.
      if (portalTrips > 0) {
        saida.restauradas += await restoreRouteMarks(client, rota, { dryRun: cfg.dryRun, correlationId });
      }
      continue;
    }

    if (action === "observing") {
      await upsertRouteAbsence(client, rota, { loads: rota.cargas.length });
      saida.observando += 1;
      continue;
    }

    removidas.push({ rota, anterior });
  }

  // Teto de rotas por ciclo: as mais volumosas primeiro (o excedente é logado, não
  // truncado em silêncio, e entra no próximo tick).
  removidas.sort((a, b) => b.rota.cargas.length - a.rota.cargas.length);
  const aplicar = removidas.slice(0, cfg.maxRoutesPerRun);
  const adiadas = removidas.length - aplicar.length;
  if (adiadas > 0) {
    logStructuredEvent("warn", "detect-aspx-missing-trips.routes-deferred", {
      correlationId,
      deferred: adiadas,
      rotas: removidas.slice(cfg.maxRoutesPerRun).map((x) => x.rota.key),
    });
  }

  for (const { rota, anterior } of aplicar) {
    saida.rotasRemovidas += 1;
    const marcaveis = rota.cargas.filter((c) => !c.motorista.trim() && c.comprometida !== true && !c.aspx_missing_since);
    const preservadas = rota.cargas.filter((c) => c.motorista.trim() || c.comprometida === true);
    saida.cargasPreservadas += preservadas.length;

    if (!cfg.dryRun) {
      for (const c of marcaveis) {
        await client.query(
          `UPDATE public.cargas
              SET aspx_missing_since = now(), aspx_missing_lh = $2,
                  aspx_missing_reason = 'route_removed', aspx_missing_notified_at = now(),
                  updated_at = now()
            WHERE id = $1`,
          [c.id, c.lh],
        );
        saida.cargasMarcadas += 1;
      }
    }

    // UM aviso por rota (nunca um por carga) — respeitando a janela de re-aviso.
    const jaAvisada = anterior?.notified_at
      ? now.getTime() - Date.parse(String(anterior.notified_at)) < hours * 3600_000
      : false;
    if (!jaAvisada) {
      const rotaLabel = `${rota.origem} → ${rota.destino}`;
      const corpo = [
        `${rota.cargas.length} carga(s) lançada(s) sem lastro no portal`,
        preservadas.length ? `${preservadas.length} com motorista/reserva ficaram intactas (decisão sua)` : null,
        cfg.dryRun ? "MODO OBSERVAÇÃO: nenhuma carga foi marcada ainda" : "as cargas saíram do Monitor e estão em Cargas com o selo",
      ].filter(Boolean).join(" · ");
      await client.query(
        `INSERT INTO public.operator_notifications (kind, title, body, metadata)
         VALUES ('aspx_route_missing', $1, $2, $3::jsonb)`,
        [
          `Rota fora do ASPX: ${rotaLabel}`,
          corpo,
          JSON.stringify({
            route_key: rota.key,
            origem: rota.origem,
            destino: rota.destino,
            cargas: rota.cargas.length,
            marcadas: cfg.dryRun ? 0 : marcaveis.length,
            preservadas: preservadas.length,
            dry_run: cfg.dryRun,
            correlation_id: correlationId || null,
          }),
        ],
      );
      result.notified += 1;
      await upsertRouteAbsence(client, rota, { loads: rota.cargas.length, notified: true });
    } else {
      await upsertRouteAbsence(client, rota, { loads: rota.cargas.length });
    }

    logStructuredEvent("warn", "detect-aspx-missing-trips.route-removed", {
      correlationId,
      rota: rota.key,
      cargas: rota.cargas.length,
      marcadas: cfg.dryRun ? 0 : marcaveis.length,
      preservadas: preservadas.length,
      dryRun: cfg.dryRun,
    });
  }

  return saida;
}

/** Estado de observação das rotas ausentes. Tolerante a tabela ausente (migration não
 *  aplicada): sem estado, o passo B nunca sai da fase de observação — falha segura. */
async function loadRouteAbsenceState(client, keys) {
  if (keys.length === 0) return new Map();
  try {
    // Lista IN gerada (portável) em vez de = ANY($1::text[]) — o harness de teste não
    // resolve o array parametrizado, e o conjunto de rotas por ciclo é pequeno.
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await client.query(
      `SELECT route_key, first_absent_at, notified_at, loads_count
         FROM public.aspx_route_absence WHERE route_key IN (${placeholders})`,
      keys,
    );
    return new Map(rows.map((r) => [r.route_key, r]));
  } catch (err) {
    if (err?.code === "42P01") return new Map();
    throw err;
  }
}

/** UPDATE-então-INSERT em vez de ON CONFLICT: mesma semântica, portável (o harness de
 *  teste não suporta o DO UPDATE com referência qualificada à tabela alvo). */
async function upsertRouteAbsence(client, rota, { loads, notified = false } = {}) {
  try {
    const { rowCount } = await client.query(
      `UPDATE public.aspx_route_absence
          SET loads_count = $2, origem = $3, destino = $4,
              notified_at = CASE WHEN $5 THEN now() ELSE notified_at END,
              updated_at = now()
        WHERE route_key = $1`,
      [rota.key, loads ?? 0, rota.origem, rota.destino, notified],
    );
    if (rowCount === 0) {
      await client.query(
        `INSERT INTO public.aspx_route_absence (route_key, origem, destino, loads_count, notified_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() ELSE NULL END)`,
        [rota.key, rota.origem, rota.destino, loads ?? 0, notified],
      );
    }
  } catch (err) {
    if (err?.code !== "42P01") throw err;
  }
}

async function clearRouteAbsence(client, key) {
  try {
    await client.query("DELETE FROM public.aspx_route_absence WHERE route_key = $1", [key]);
  } catch (err) {
    if (err?.code !== "42P01") throw err;
  }
}

/** Rota voltou ao portal: limpa as marcas que ESTE passo criou (reason route_removed) e
 *  avisa. Marcas do passo A (trip_missing) seguem sob a regra por viagem. */
async function restoreRouteMarks(client, rota, { dryRun, correlationId }) {
  const ids = rota.cargas.filter((c) => c.aspx_missing_since).map((c) => c.id);
  if (ids.length === 0) return 0;
  // IN gerado (portável — ver loadRouteAbsenceState).
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
  const { rowCount } = await client.query(
    `UPDATE public.cargas
        SET aspx_missing_since = NULL, aspx_missing_lh = NULL,
            aspx_missing_notified_at = NULL, aspx_missing_reason = NULL, updated_at = now()
      WHERE id IN (${placeholders}) AND aspx_missing_reason = 'route_removed'`,
    ids,
  );
  if (rowCount > 0 && !dryRun) {
    await client.query(
      `INSERT INTO public.operator_notifications (kind, title, body, metadata)
       VALUES ('aspx_route_restored', $1, $2, $3::jsonb)`,
      [
        `Rota voltou ao ASPX: ${rota.origem} → ${rota.destino}`,
        `${rowCount} carga(s) voltaram ao Monitor`,
        JSON.stringify({ route_key: rota.key, cargas: rowCount, correlation_id: correlationId || null }),
      ],
    );
  }
  return rowCount;
}
